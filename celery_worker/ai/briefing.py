"""Daily briefing generator using Claude Sonnet.

Generates conversational prose SMS briefings from Canvas deadline data.
Called by Celery tasks — never inline in API routes.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from anthropic import Anthropic

logger = logging.getLogger(__name__)

EXAM_TOUCHPOINTS = {7, 5, 3, 1, 0}

BRIEFING_SYSTEM_PROMPT = """You are Aria, a smart personal assistant for college students.
Your job is to send a morning briefing SMS summarizing upcoming deadlines.

TONE: Warm, casual, like a text from a knowledgeable friend. Use contractions.
Abbreviate course names naturally (e.g. "bio lab" not "BIOL 101 Lab Report").
Add brief context for high-stakes items (e.g. "the big one", "worth 20%").

FORMAT RULES:
- MUST be under 800 characters total. Count carefully before responding.
- No bullet points. Conversational prose, 2-4 sentences.
- End with load score line: "Light day ahead!" / "Busy day - stay on top of it." / "Heavy one - you've got this."
- If an exam is within 7 days, include on its own line: "EXAM IN X DAYS: [Course] - [Date]"
- If nothing is due in 48h: send a short cheerful message. Never send nothing.

Do not mention sources (Canvas), do not use jargon, do not sound like a robot."""

MONDAY_EXTENDED_SYSTEM_PROMPT = """You are Aria, a smart personal assistant for college students.
Your job is to send a Monday morning briefing covering the full week ahead.

TONE: Warm, casual, like a text from a knowledgeable friend. Use contractions.
Abbreviate course names naturally.

FORMAT RULES:
- MUST be under 800 characters total. Count carefully before responding.
- Cover all deadlines in the next 7 days. Group by day if helpful.
- Include daily load score summary.
- If any exams this week, highlight with: "EXAM IN X DAYS: [Course] - [Date]"
- Conversational prose, 3-5 sentences. No bullet points.
- End with a motivational one-liner for the week.

Do not mention sources (Canvas), do not use jargon, do not sound like a robot."""

WELCOME_INTRO = "Hey, I'm Aria! Here's what I see for you:\n\n"


def compute_load_score(deadlines_48h: list[dict]) -> str:
    """Return 'green', 'yellow', or 'red' based on deadline count in next 48h.

    Args:
        deadlines_48h: List of deadline dicts due within the next 48 hours.

    Returns:
        'green' (0-1 deadlines), 'yellow' (2-3), or 'red' (4+).
    """
    count = len(deadlines_48h)
    if count <= 1:
        return "green"
    elif count <= 3:
        return "yellow"
    else:
        return "red"


def get_exam_touchpoints(deadlines: list[dict], user_tz: ZoneInfo) -> list[dict]:
    """Return exam deadlines that fall on a countdown touchpoint (T-7,5,3,1,0).

    Both now and due_date are converted to the user's local timezone before
    computing days_until to avoid off-by-one errors with all-day events
    stored as 23:59:59 UTC.

    Args:
        deadlines: All deadlines (not just exams) — non-exams are filtered out.
        user_tz: The user's local timezone (ZoneInfo instance).

    Returns:
        List of exam deadline dicts with added 'days_until' key.
    """
    now_local = datetime.now(user_tz)
    results = []
    for d in deadlines:
        if d.get("type") != "exam":
            continue
        due_str = str(d["due_date"])
        due_utc = datetime.fromisoformat(due_str)
        if due_utc.tzinfo is None:
            due_utc = due_utc.replace(tzinfo=timezone.utc)
        due_local = due_utc.astimezone(user_tz)
        days_until = (due_local.date() - now_local.date()).days
        if days_until in EXAM_TOUCHPOINTS:
            results.append({**d, "days_until": days_until})
    return results


def is_in_briefing_window(preferences_json: dict | None) -> bool:
    """Check if the user's local time is currently in the 8am hour (8:00-8:59).

    Args:
        preferences_json: User's preferences dict (may contain 'timezone' key).

    Returns:
        True if the user's local hour is 8 (aligned with quiet hours end).
    """
    tz_name = (preferences_json or {}).get("timezone", "America/New_York")
    local_now = datetime.now(ZoneInfo(tz_name))
    return local_now.hour == 8


def get_briefing_gcal_context(user_id: str) -> dict:
    """Get GCal enrichment data for Monday briefing.

    Returns conflict warnings and best available study windows for the next 7 days.
    Only returns data if the user has Google Calendar connected.

    Args:
        user_id: UUID of the user.

    Returns:
        Dict with {conflicts: list[str], study_windows: list[str]}, or empty dict
        if user has no Google integration.
    """
    from ai.db import _get_supabase
    from gcal.db import get_calendar_events
    from gcal.slots import find_free_slots
    from datetime import timedelta

    client = _get_supabase()

    # Check if user has Google connected
    integration = (
        client.table("integrations")
        .select("user_id")
        .eq("user_id", user_id)
        .eq("platform", "google")
        .execute()
    ).data
    if not integration:
        return {}

    now = datetime.now(timezone.utc)
    week_end = now + timedelta(days=7)

    # Get active conflicts for the week
    conflicts_raw = (
        client.table("conflict_alerts")
        .select("deadline_id, gcal_event_id, deadline_due_at, gcal_event_date")
        .eq("user_id", user_id)
        .gte("gcal_event_date", now.strftime("%Y-%m-%d"))
        .lte("gcal_event_date", week_end.strftime("%Y-%m-%d"))
        .execute()
    ).data

    conflict_strs = []
    for c in conflicts_raw:
        dl = (
            client.table("deadlines")
            .select("title, course")
            .eq("id", c["deadline_id"])
            .execute()
        ).data
        ev = (
            client.table("calendar_events")
            .select("title, start_time, end_time")
            .eq("google_event_id", c["gcal_event_id"])
            .eq("user_id", user_id)
            .execute()
        ).data
        if dl and ev:
            conflict_strs.append(
                f"{dl[0]['title']} due {c['gcal_event_date']} — you have {ev[0]['title']} that day"
            )

    # Get user preferences
    user = (
        client.table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
    ).data
    study_pref = "evening"
    user_tz_str = "America/New_York"
    if user:
        prefs = user[0].get("preferences_json") or {}
        study_pref = prefs.get("study_preference", "evening")
        user_tz_str = prefs.get("timezone") or "America/New_York"

    # Find best study windows across the week (top 3, deterministic from calendar data)
    events = get_calendar_events(
        user_id,
        now.strftime("%Y-%m-%dT00:00:00+00:00"),
        week_end.strftime("%Y-%m-%dT23:59:59+00:00"),
    )

    all_slots = []
    for day_offset in range(7):
        day = now + timedelta(days=day_offset)
        day_date_str = day.strftime("%Y-%m-%d")
        day_events = [e for e in events if e["start_time"][:10] == day_date_str]
        slots = find_free_slots(
            day_events,
            day,
            min_duration_hours=2,
            study_preference=study_pref,
            user_tz=user_tz_str,
        )
        for s in slots:
            start = datetime.fromisoformat(s["start"])
            day_name = start.strftime("%A")
            # Cross-platform time formatting: strip leading zero from hour
            hour_str = start.strftime("%I%p").lstrip("0").lower()
            end_dt = datetime.fromisoformat(s["end"])
            end_str = end_dt.strftime("%I%p").lstrip("0").lower()
            all_slots.append(f"{day_name} {hour_str}-{end_str} free ({s['duration_hours']}h)")

    return {
        "conflicts": conflict_strs,
        "study_windows": all_slots[:3],  # top 3 best windows
    }


def _count_items_due_today(user_id: str, briefing_time: datetime) -> tuple[int, list[dict]]:
    """Count canonical_events due within 24h of briefing_time.

    Counts ALL non-deleted events regardless of delivery_status
    (avoids double-counting pitfall from RESEARCH.md Pitfall 6).

    Args:
        user_id: UUID of the user.
        briefing_time: The reference time for the 24h window start.

    Returns:
        Tuple of (total_count, top_2_items_by_priority_score).
    """
    from ai.db import _get_supabase
    client = _get_supabase()
    window_end = (briefing_time + timedelta(hours=24)).isoformat()
    result = (
        client.table("canonical_events")
        .select("id, title, due_at, priority_score, source")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .gte("due_at", briefing_time.isoformat())
        .lte("due_at", window_end)
        .order("priority_score", desc=True)
        .execute()
    )
    items = result.data or []
    return len(items), items[:2]


def generate_briefing(
    user_id: str,
    deadlines: list[dict],
    is_monday: bool = False,
    is_welcome: bool = False,
    user_tz: ZoneInfo | None = None,
    gcal_context: dict | None = None,
    syllabus_context: dict | None = None,  # NEW -- Phase 7
) -> str:
    """Generate a daily briefing via Claude Sonnet.

    Args:
        user_id: UUID (hashed for logging only, never sent to Claude).
        deadlines: Active deadlines from get_deadlines_for_briefing().
        is_monday: If True, use extended 7-day prompt.
        is_welcome: If True, prepend welcome intro line.
        user_tz: User's timezone for exam countdown. Defaults to America/New_York.
        gcal_context: Optional dict with {conflicts: list[str], study_windows: list[str]}
            from get_briefing_gcal_context(). When provided and non-empty, appended
            to the Claude prompt for Monday briefings.
        syllabus_context: Optional dict with {exam_topic_hints: list[str], coverage_summaries: list[str]}
            from get_syllabus_context(). When provided, exam topic hints are appended daily;
            coverage summaries are appended on Monday only.

    Returns:
        Briefing text string, guaranteed <= 800 characters.
    """
    if user_tz is None:
        user_tz = ZoneInfo("America/New_York")

    # Compute load score from 48h deadlines
    now = datetime.now(timezone.utc)
    cutoff_48h = now + timedelta(hours=48)
    deadlines_48h = []
    for d in deadlines:
        due_str = str(d["due_date"])
        due_dt = datetime.fromisoformat(due_str)
        if due_dt.tzinfo is None:
            due_dt = due_dt.replace(tzinfo=timezone.utc)
        if due_dt <= cutoff_48h:
            deadlines_48h.append(d)
    load_score = compute_load_score(deadlines_48h)

    # Get exam touchpoints
    exam_touchpoints = get_exam_touchpoints(deadlines, user_tz)

    # Build context text for Claude
    context_parts = []
    context_parts.append(f"Today: {now.strftime('%A, %B %d, %Y')}")
    context_parts.append(f"Daily load: {load_score.upper()} ({len(deadlines_48h)} deadlines in 48h)")

    if deadlines:
        context_parts.append("\nUpcoming deadlines:")
        for d in deadlines:
            due = datetime.fromisoformat(str(d["due_date"]))
            priority_marker = " [HIGH PRIORITY]" if d.get("priority") == "high" else ""
            weight = f" ({d['grade_weight']}% of grade)" if d.get("grade_weight") else ""
            context_parts.append(
                f"- {d['title']} | {d.get('course', 'Unknown')} | Due: {due.strftime('%a %b %d %I:%M%p')}{weight}{priority_marker}"
            )
    else:
        context_parts.append("\nNo upcoming deadlines.")

    if exam_touchpoints:
        context_parts.append("\nExam countdown alerts:")
        for e in exam_touchpoints:
            context_parts.append(f"- EXAM IN {e['days_until']} DAYS: {e.get('course', 'Unknown')} - {e['title']}")

    # Monday GCal enrichment: append conflict warnings and study windows (AI-08)
    if gcal_context and is_monday:
        conflicts = gcal_context.get("conflicts") or []
        study_windows = gcal_context.get("study_windows") or []
        if conflicts:
            context_parts.append("\nSCHEDULING CONFLICTS THIS WEEK:")
            for c in conflicts:
                context_parts.append(f"- {c}")
        if study_windows:
            context_parts.append("\nBEST AVAILABLE STUDY WINDOWS:")
            for w in study_windows:
                context_parts.append(f"- {w}")

    # Phase 7: Syllabus enrichment -- exam topic hints and Monday coverage summaries
    if syllabus_context:
        exam_hints = syllabus_context.get("exam_topic_hints") or []
        if exam_hints:
            context_parts.append("\nEXAM TOPIC HINTS (from syllabus):")
            for hint in exam_hints:
                context_parts.append(f"- {hint}")
        if is_monday:
            coverage_summaries = syllabus_context.get("coverage_summaries") or []
            if coverage_summaries:
                context_parts.append("\nEXAM TOPIC COVERAGE (next 14 days):")
                for s in coverage_summaries:
                    context_parts.append(f"- {s}")

    context_text = "\n".join(context_parts)

    # Select prompt based on day
    system_prompt = MONDAY_EXTENDED_SYSTEM_PROMPT if is_monday else BRIEFING_SYSTEM_PROMPT

    # Call Claude
    client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    hashed_id = hashlib.sha256(user_id.encode()).hexdigest()[:12]

    start_time = time.monotonic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=300,
        system=system_prompt,
        messages=[{"role": "user", "content": context_text}],
    )
    latency_ms = int((time.monotonic() - start_time) * 1000)

    logger.info(json.dumps({
        "event": "claude_briefing",
        "uid": hashed_id,
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "latency_ms": latency_ms,
        "is_monday": is_monday,
        "load_score": load_score,
    }))

    text = response.content[0].text

    # Overload detection — prepend warning if 5+ items due in 24h
    overload_count, top_items = _count_items_due_today(user_id, now)
    if overload_count >= 5:
        top_titles = ", ".join(t["title"] for t in top_items)
        overload_line = f"Heavy day — {overload_count} items due today. Prioritize: {top_titles}.\n\n"
        text = overload_line + text

    # Enforce 800 char limit — truncate with ellipsis if Claude exceeded
    if len(text) > 800:
        text = text[:797] + "..."

    # Prepend welcome intro if applicable
    if is_welcome:
        text = WELCOME_INTRO + text
        if len(text) > 800:
            text = text[:797] + "..."

    return text
