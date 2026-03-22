"""Conversational SMS reply handler using Claude Sonnet.

Handles deadline queries and task management (mark complete, snooze, set priority).
Uses a two-step approach:
1. Claude extracts structured intent (action + task_hint) as JSON
2. Python performs DB mutation based on intent
3. Claude generates friendly confirmation/response

Called from process_inbound_sms Celery task — never inline in webhooks.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import requests
from anthropic import Anthropic

from ai.db import get_deadlines_for_briefing, get_conversation_history

logger = logging.getLogger(__name__)

INTENT_SYSTEM_PROMPT = """You are Aria's intent classifier.
Given a student's SMS, return ONLY valid JSON (no markdown, no explanation):
{
  "action": "query" | "mark_complete" | "snooze" | "set_priority" | "todoist_create" | "todoist_complete" | "todoist_update_due" | "todoist_delete" | "schedule" | "off_topic",
  "task_hint": "<partial task name, lowercase, or null>",
  "priority_value": "high" | "normal" | null,
  "due_string": "<natural language due date, e.g. 'Friday', 'tomorrow at 3pm', or null>",
  "activity_type": "<normalized: study | workout | meal | personal | other lowercase word, or null>",
  "subject": "<specific topic/course/task, e.g. 'biochem exam', 'chest day', or null>",
  "target_date_string": "<natural language date: 'tomorrow', 'Friday', 'tonight', or null>",
  "duration_hours": <integer hours or null>
}

Rules:
- "query" for deadline questions ("what's due?", "do I have anything tomorrow?")
- "mark_complete" for done/finished/completed ("mark bio lab done", "finished econ pset")
- "snooze" for snooze/remind me later ("snooze chem hw", "not now for bio")
- "set_priority" for priority changes ("high priority econ pset", "urgent: calc midterm")
- "todoist_create" for adding new personal tasks ("add buy textbook due friday", "remind me to email prof tomorrow")
- "todoist_complete" for completing Todoist tasks ("done with buy textbook", "finished grocery run")
- "todoist_update_due" for rescheduling Todoist tasks ("move buy textbook to Monday", "push grocery to next week")
- "todoist_delete" for removing Todoist tasks ("delete buy textbook", "remove grocery run from my list")
- "schedule" for scheduling/blocking time requests ("find me time to study", "schedule a workout", "block 2 hours for biochem", "when can I go to the gym tomorrow")
- "off_topic" for anything not deadline or scheduling related
- task_hint: extract the course/assignment name fragment, lowercase (for non-schedule actions)
- due_string: extract date hint for create/update — use Todoist natural language format; null if not mentioned
- activity_type normalization: study/review/homework/exam prep → "study"; workout/gym/run/lift/exercise/yoga → "workout"; lunch/dinner/breakfast/eat/meal → "meal"; anything else → pass through lowercase
- duration_hours: extract if student specifies ("2 hours", "an hour") — null otherwise
- subject: for schedule action, extract what specifically (course name, exam, topic); null if not mentioned
- target_date_string: for schedule action, the date/time requested; null if not mentioned
- If "todoist_create" but no due date mentioned, still classify as todoist_create with due_string=null"""

REPLY_SYSTEM_PROMPT = """You are Aria, a smart personal assistant for college students.
You're replying to a student's SMS about their deadlines.

TONE: Warm, casual, like a text from a knowledgeable friend. Use contractions.
FORMAT: Under 800 characters. Conversational, not robotic. No bullet points unless listing multiple items.
If the student asked about deadlines, summarize what's relevant.
If you performed an action (marked done, snoozed, set priority), confirm specifically what you did.
If the message is off-topic, redirect: "I can help with your deadlines! Try: 'what's due this week?', 'mark bio lab done', or 'snooze econ pset'."

Do not mention Canvas or data sources. Do not use jargon."""

OFF_TOPIC_RESPONSE = (
    "I can help with your deadlines! Try: 'what's due this week?', "
    "'mark bio lab done', or 'snooze econ pset'."
)


def build_history_messages(history_rows: list[dict]) -> list[dict]:
    """Convert DB message rows (DESC order) to SDK message format (ASC, alternating roles).

    Args:
        history_rows: Rows from get_conversation_history (sent_at DESC order).

    Returns:
        List of {"role": "user"|"assistant", "content": "..."} in chronological order.
        Consecutive same-role entries are deduplicated (keep most recent in original order).
    """
    role_map = {"in": "user", "out": "assistant"}
    # Reverse to chronological (oldest first)
    chronological = list(reversed(history_rows))
    messages = []
    for row in chronological:
        role = role_map.get(row.get("direction"))
        if not role:
            continue
        content = row.get("body") or ""
        # Deduplicate consecutive same-role entries
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] = content  # keep most recent
        else:
            messages.append({"role": role, "content": content})
    return messages


def _find_best_match(task_hint: str, deadlines: list[dict]) -> dict | None:
    """Find the soonest-due deadline whose title contains the task_hint.

    Args:
        task_hint: Partial task name (lowercase) from Claude intent extraction.
        deadlines: Active deadlines sorted by due_date ascending.

    Returns:
        Best matching deadline dict, or None if no match found.
    """
    if not task_hint:
        return None
    hint_lower = task_hint.lower()
    matches = [
        d for d in deadlines
        if hint_lower in (d.get("title") or "").lower()
        or hint_lower in (d.get("course") or "").lower()
    ]
    # Deadlines are already sorted by due_date ASC — first match is soonest
    return matches[0] if matches else None


def _apply_mutation(action: str, deadline: dict, priority_value: str | None) -> str:
    """Apply a task management mutation to the database.

    Args:
        action: One of 'mark_complete', 'snooze', 'set_priority'.
        deadline: The matched deadline dict (must have 'id').
        priority_value: 'high' or 'normal' (only used for set_priority).

    Returns:
        Description of what was done, for Claude to confirm.
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    deadline_id = deadline["id"]
    title = deadline.get("title", "task")
    course = deadline.get("course", "")

    if action == "mark_complete":
        client.table("deadlines").update(
            {"status": "completed"}
        ).eq("id", deadline_id).execute()
        return f"Marked '{title}' ({course}) as done"

    elif action == "snooze":
        snooze_until = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        client.table("deadlines").update(
            {"snoozed_until": snooze_until}
        ).eq("id", deadline_id).execute()
        return f"Snoozed '{title}' ({course}) for 24 hours"

    elif action == "set_priority":
        pv = priority_value or "high"
        client.table("deadlines").update(
            {"priority": pv}
        ).eq("id", deadline_id).execute()
        return f"Set '{title}' ({course}) to {pv} priority"

    return ""


_STUDY_PREF_KEYWORDS = frozenset({
    "morning", "mornings", "afternoon", "afternoons", "evening", "evenings",
})


def _handle_study_preference_reply(user_id: str, body: str) -> str | None:
    """Intercept a study preference reply and store it in preferences_json.

    Called before the main intent-extraction / Claude path. Returns a
    confirmation string if the reply is a study preference answer AND the
    user hasn't set one yet; returns None otherwise (pass through to Claude).

    The preference is normalized: "mornings" -> "morning", etc.

    Args:
        user_id: UUID of the sender.
        body: Raw inbound SMS text.

    Returns:
        Confirmation reply string if preference was captured, else None.
    """
    from ai.db import _get_supabase

    reply_lower = body.strip().lower()
    if reply_lower not in _STUDY_PREF_KEYWORDS:
        return None

    client = _get_supabase()
    user_row = (
        client.table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (user_row[0].get("preferences_json") or {}) if user_row else {}

    # Only capture if not already set
    if prefs.get("study_preference"):
        return None

    # Normalize: "mornings" -> "morning", etc.
    pref = reply_lower.rstrip("s") if reply_lower.endswith("s") else reply_lower
    prefs["study_preference"] = pref
    client.table("users").update({"preferences_json": prefs}).eq("id", user_id).execute()

    return (
        f"Got it -- {pref} study sessions it is! "
        "I'll keep that in mind when suggesting study blocks."
    )


def _apply_todoist_mutation(
    action: str, task_hint: str, due_string: Optional[str], user_id: str
) -> str:
    """Apply a Todoist CRUD mutation via the Todoist REST API.

    Args:
        action: One of 'todoist_create', 'todoist_complete', 'todoist_update_due', 'todoist_delete'.
        task_hint: Task name/partial name extracted by intent classifier.
        due_string: Natural language due date string (e.g. 'Friday', 'tomorrow'), or None.
        user_id: UUID of the user — used to fetch the Todoist access token.

    Returns:
        Description of the action taken, for Claude to incorporate into its reply.
    """
    from todoist.db import get_todoist_token
    from todoist.fetch import (
        create_task,
        close_task,
        get_active_tasks,
        update_task,
        delete_task,
    )

    token = get_todoist_token(user_id)
    if not token:
        return "You'll need to connect Todoist first — head to Preferences in the app."

    try:
        if action == "todoist_create":
            if due_string is None:
                return "When should that be due? Give me a date like 'Friday' or 'next Tuesday'."
            create_task(token, task_hint, due_string)
            return f"Done — added '{task_hint}' to Todoist, due {due_string}."

        # For complete/update/delete: find task by title match in active tasks
        active_tasks = get_active_tasks(token)
        hint_lower = task_hint.lower()
        matched = next(
            (t for t in active_tasks if hint_lower in t.get("content", "").lower()),
            None,
        )

        if action == "todoist_complete":
            if not matched:
                return f"Couldn't find a Todoist task matching '{task_hint}'."
            close_task(token, matched["id"])
            return f"Marked '{matched['content']}' complete in Todoist."

        elif action == "todoist_update_due":
            if not matched:
                return f"Couldn't find a Todoist task matching '{task_hint}'."
            update_task(token, matched["id"], due_string)
            return f"Moved '{matched['content']}' to {due_string} in Todoist."

        elif action == "todoist_delete":
            if not matched:
                return f"Couldn't find a Todoist task matching '{task_hint}'."
            delete_task(token, matched["id"])
            return f"Deleted '{matched['content']}' from Todoist."

    except requests.HTTPError:
        return "Something went wrong updating Todoist. Try again in a bit."

    return ""



def handle_reply(user_id: str, body: str) -> str:
    """Handle an inbound SMS by extracting intent, mutating DB if needed, and generating a reply.

    Before the main intent path, checks for a study preference reply (morning/afternoon/evening).
    If the user is answering the study preference question for the first time, stores the
    preference and returns a confirmation without invoking Claude.

    Args:
        user_id: UUID of the sender.
        body: Raw inbound SMS text.

    Returns:
        Reply text string, guaranteed <= 800 characters.
    """
    from sms.schedule import (
        get_pending_preference, clear_pending_preference,
        set_activity_preference, handle_schedule_request,
        get_pending_schedule,
        handle_schedule_confirmation, handle_schedule_decline,
    )

    # Step 1: Pending preference intercept (Flow A answer: morning/afternoon/evening)
    pending_pref = get_pending_preference(user_id)
    if pending_pref is not None:
        answer = body.strip().lower().rstrip("s")  # normalize "mornings" → "morning"
        if answer in ("morning", "afternoon", "evening"):
            set_activity_preference(user_id, pending_pref["activity_type"], answer)
            clear_pending_preference(user_id)
            req = pending_pref["original_request"]
            return handle_schedule_request(
                user_id,
                activity_type=req.get("activity_type", "personal"),
                subject=req.get("subject"),
                target_date_string=req.get("target_date_string", "today"),
                duration_hours=req.get("duration_hours"),
            )
        # Unrecognized answer — re-ask
        label = pending_pref["activity_type"].replace("_", " ")
        return f"Just reply morning, afternoon, or evening — when do you usually like to {label}?"

    # Step 2: Pending schedule intercept (confirmation / decline)
    _AFFIRMATIVES = {"yes", "sure", "ok", "okay", "yeah", "yep", "yup", "add it", "confirm", "sounds good", "do it", "go ahead", "book it"}
    _NEGATIVES    = {"no", "nope", "skip", "cancel", "different", "earlier", "later", "another"}
    pending_sched = get_pending_schedule(user_id)
    if pending_sched is not None:
        normalized = body.strip().lower().rstrip(".")
        if normalized in _AFFIRMATIVES:
            return handle_schedule_confirmation(user_id)
        if normalized in _NEGATIVES:
            return handle_schedule_decline(user_id)
        # Unrecognized — fall through with pending still alive

    # Step 3: Existing study preference intercept (only when no Redis keys present)
    study_pref_reply = _handle_study_preference_reply(user_id, body)
    if study_pref_reply is not None:
        return study_pref_reply

    # Step 4: Claude intent extraction (continues below)

    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    hashed_id = hashlib.sha256(user_id.encode()).hexdigest()[:12]

    # Fetch context
    deadlines = get_deadlines_for_briefing(user_id, days_ahead=14)
    history_rows = get_conversation_history(user_id, limit=10)
    history_messages = build_history_messages(history_rows)

    # Step 1: Extract intent via Claude
    start_time = time.monotonic()
    intent_response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=100,
        system=INTENT_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": body}],
    )
    intent_text = intent_response.content[0].text.strip()

    try:
        intent = json.loads(intent_text)
    except json.JSONDecodeError:
        intent = {"action": "off_topic", "task_hint": None, "priority_value": None}

    action = intent.get("action", "off_topic")
    task_hint = intent.get("task_hint")
    priority_value = intent.get("priority_value")
    due_string = intent.get("due_string")

    # Step 2: Apply mutation if needed
    mutation_result = ""
    if action in ("mark_complete", "snooze", "set_priority"):
        matched = _find_best_match(task_hint, deadlines)
        if matched:
            mutation_result = _apply_mutation(action, matched, priority_value)
        else:
            mutation_result = f"Couldn't find a matching deadline for '{task_hint}'"

    # Todoist mutations
    if action in ("todoist_create", "todoist_complete", "todoist_update_due", "todoist_delete"):
        mutation_result = _apply_todoist_mutation(
            action, task_hint or body, due_string, user_id
        )

    # Schedule action
    if action == "schedule":
        from sms.schedule import handle_schedule_request
        return handle_schedule_request(
            user_id,
            activity_type=intent.get("activity_type") or "personal",
            subject=intent.get("subject"),
            target_date_string=intent.get("target_date_string") or "today",
            duration_hours=int(intent["duration_hours"]) if intent.get("duration_hours") else None,
        )

    # Step 3: Handle off-topic directly (no second Claude call needed)
    if action == "off_topic":
        latency_ms = int((time.monotonic() - start_time) * 1000)
        logger.info(json.dumps({
            "event": "claude_reply",
            "uid": hashed_id,
            "action": "off_topic",
            "latency_ms": latency_ms,
        }))
        return OFF_TOPIC_RESPONSE

    # Step 4: Generate reply via Claude with full context
    # Build deadline context
    deadline_context = "Current deadlines:\n"
    if deadlines:
        for d in deadlines[:10]:  # cap at 10 for context size
            due = datetime.fromisoformat(str(d["due_date"]))
            deadline_context += f"- {d['title']} | {d.get('course', '?')} | Due: {due.strftime('%a %b %d')}\n"
    else:
        deadline_context += "No upcoming deadlines.\n"

    if mutation_result:
        deadline_context += f"\nAction taken: {mutation_result}\n"

    # Build messages array: history + current message
    messages = list(history_messages)  # copy
    messages.append({"role": "user", "content": f"{body}\n\n[Context for Aria]\n{deadline_context}"})

    reply_response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=300,
        system=REPLY_SYSTEM_PROMPT,
        messages=messages,
    )
    latency_ms = int((time.monotonic() - start_time) * 1000)

    logger.info(json.dumps({
        "event": "claude_reply",
        "uid": hashed_id,
        "action": action,
        "task_hint": task_hint,
        "mutation": mutation_result or None,
        "input_tokens": reply_response.usage.input_tokens,
        "output_tokens": reply_response.usage.output_tokens,
        "latency_ms": latency_ms,
    }))

    text = reply_response.content[0].text
    if len(text) > 800:
        text = text[:797] + "..."
    return text
