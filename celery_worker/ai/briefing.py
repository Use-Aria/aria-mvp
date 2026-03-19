"""Daily briefing generator using Claude Sonnet.

Generates conversational prose SMS briefings from Canvas deadline data.
Called by Celery tasks — never inline in API routes.
"""
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


def generate_briefing(
    user_id: str,
    deadlines: list[dict],
    is_monday: bool = False,
    is_welcome: bool = False,
    user_tz: ZoneInfo | None = None,
) -> str:
    """Generate a daily briefing via Claude Sonnet.

    Args:
        user_id: UUID (hashed for logging only, never sent to Claude).
        deadlines: Active deadlines from get_deadlines_for_briefing().
        is_monday: If True, use extended 7-day prompt.
        is_welcome: If True, prepend welcome intro line.
        user_tz: User's timezone for exam countdown. Defaults to America/New_York.

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

    # Enforce 800 char limit — truncate with ellipsis if Claude exceeded
    if len(text) > 800:
        text = text[:797] + "..."

    # Prepend welcome intro if applicable
    if is_welcome:
        text = WELCOME_INTRO + text
        if len(text) > 800:
            text = text[:797] + "..."

    return text
