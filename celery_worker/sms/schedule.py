"""On-demand scheduling via SMS — activity preferences + slot booking.

Owns: Redis pending state, per-activity preference learning,
      natural language date parsing, schedule flow orchestration.

Called from: ai/replies.py (handle_reply)
Calls: gcal.slots.find_free_slots, gcal.writeback.create_study_block,
       gcal.db.get_calendar_events
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import dateparser
import redis

logger = logging.getLogger(__name__)

DEFAULT_TZ = "America/New_York"

# Redis key templates
_PENDING_SCHEDULE_KEY = "aria:pending_schedule:{user_id}"
_PENDING_PREFERENCE_KEY = "aria:pending_preference:{user_id}"
_PENDING_TTL = 300  # 5 minutes


def _get_redis() -> redis.Redis:
    """Create Redis client from REDIS_URL env var."""
    return redis.from_url(os.environ["REDIS_URL"])


def _get_supabase():
    """Create Supabase client using service role key."""
    from supabase import create_client
    return create_client(
        os.environ.get("SUPABASE_URL") or os.environ["NEXT_PUBLIC_SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def parse_target_date(date_string: str, user_tz: str) -> datetime | None:
    """Parse a natural language date string into a timezone-aware datetime.

    Args:
        date_string: e.g. 'tomorrow', 'Friday', 'tonight', 'next week'
        user_tz: IANA timezone string, e.g. 'America/New_York'

    Returns:
        Timezone-aware datetime, or None if dateparser cannot parse the input.
    """
    result = dateparser.parse(
        date_string,
        settings={
            "PREFER_DATES_FROM": "future",
            "TIMEZONE": user_tz,
            "RETURN_AS_TIMEZONE_AWARE": True,
        },
    )
    return result


def get_user_tz(user_id: str) -> str:
    """Read user's timezone from preferences_json. Defaults to America/New_York.

    Args:
        user_id: UUID of the user.

    Returns:
        IANA timezone string.
    """
    rows = (
        _get_supabase()
        .table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (rows[0].get("preferences_json") or {}) if rows else {}
    return prefs.get("timezone", DEFAULT_TZ)


def get_activity_preference(user_id: str, activity_type: str) -> str | None:
    """Return stored time-of-day preference for this activity type, or None if unseen.

    Args:
        user_id: UUID of the user.
        activity_type: e.g. 'study', 'workout', 'meal'

    Returns:
        'morning', 'afternoon', 'evening', or None.
    """
    rows = (
        _get_supabase()
        .table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (rows[0].get("preferences_json") or {}) if rows else {}
    activity_prefs = prefs.get("activity_preferences", {})
    entry = activity_prefs.get(activity_type)
    if not entry:
        return None
    return entry.get("preference")


def set_activity_preference(user_id: str, activity_type: str, preference: str) -> None:
    """Write a time-of-day preference for an activity type.

    Initializes entry with confirmations=0 and recent_blocks=[] on first write.
    Preserves all other activity preferences.

    Args:
        user_id: UUID of the user.
        activity_type: e.g. 'workout'
        preference: 'morning', 'afternoon', or 'evening'
    """
    client = _get_supabase()
    rows = (
        client.table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (rows[0].get("preferences_json") or {}) if rows else {}
    activity_prefs = prefs.setdefault("activity_preferences", {})

    existing = activity_prefs.get(activity_type, {})
    activity_prefs[activity_type] = {
        "preference": preference,
        "confirmations": existing.get("confirmations", 0),
        "recent_blocks": existing.get("recent_blocks", []),
    }

    client.table("users").update(
        {"preferences_json": prefs}
    ).eq("id", user_id).execute()


# Time-of-day block boundaries (hour, inclusive start)
_TIME_BLOCKS = [
    ("morning",   7, 12),
    ("afternoon", 12, 17),
    ("evening",   17, 23),
]


def _classify_time_block(dt: datetime) -> str:
    """Return 'morning', 'afternoon', or 'evening' for a given datetime."""
    hour = dt.hour
    for name, start, end in _TIME_BLOCKS:
        if start <= hour < end:
            return name
    return "evening"  # before 7am or 11pm+ rounds to evening


def learn_from_confirmation(user_id: str, activity_type: str, confirmed_start_iso: str) -> None:
    """Update activity preference based on a confirmed booking.

    Steps:
    1. Classify confirmed_start_iso into a time-of-day block
    2. Append to recent_blocks (trim to last 3)
    3. Increment confirmations
    4. If all 3 recent_blocks differ from stored preference, update preference
       to the most common value in recent_blocks

    Args:
        user_id: UUID of the user.
        activity_type: e.g. 'study', 'workout'
        confirmed_start_iso: ISO datetime string of the confirmed slot start.
    """
    client = _get_supabase()
    rows = (
        client.table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (rows[0].get("preferences_json") or {}) if rows else {}
    activity_prefs = prefs.setdefault("activity_preferences", {})
    entry = activity_prefs.setdefault(activity_type, {
        "preference": "evening",
        "confirmations": 0,
        "recent_blocks": [],
    })

    confirmed_dt = datetime.fromisoformat(confirmed_start_iso)
    block = _classify_time_block(confirmed_dt)

    recent = entry.get("recent_blocks", [])
    recent.append(block)
    recent = recent[-3:]  # trim to last 3

    entry["recent_blocks"] = recent
    entry["confirmations"] = entry.get("confirmations", 0) + 1

    # Update preference if all 3 recent blocks agree and differ from stored
    if len(recent) == 3 and len(set(recent)) == 1 and recent[0] != entry["preference"]:
        entry["preference"] = recent[0]

    client.table("users").update(
        {"preferences_json": prefs}
    ).eq("id", user_id).execute()


def store_pending_schedule(user_id: str, data: dict) -> None:
    """Store a pending schedule confirmation in Redis with 5-minute TTL."""
    r = _get_redis()
    r.setex(
        _PENDING_SCHEDULE_KEY.format(user_id=user_id),
        _PENDING_TTL,
        json.dumps(data),
    )


def get_pending_schedule(user_id: str) -> dict | None:
    """Retrieve pending schedule from Redis. Returns None if expired or absent."""
    r = _get_redis()
    raw = r.get(_PENDING_SCHEDULE_KEY.format(user_id=user_id))
    return json.loads(raw) if raw else None


def clear_pending_schedule(user_id: str) -> None:
    """Remove pending schedule key from Redis."""
    _get_redis().delete(_PENDING_SCHEDULE_KEY.format(user_id=user_id))


def store_pending_preference(user_id: str, activity_type: str, original_request: dict) -> None:
    """Store Flow A context (waiting for morning/afternoon/evening answer) in Redis."""
    r = _get_redis()
    r.setex(
        _PENDING_PREFERENCE_KEY.format(user_id=user_id),
        _PENDING_TTL,
        json.dumps({"activity_type": activity_type, "original_request": original_request}),
    )


def get_pending_preference(user_id: str) -> dict | None:
    """Retrieve pending preference context from Redis. Returns None if expired or absent."""
    r = _get_redis()
    raw = r.get(_PENDING_PREFERENCE_KEY.format(user_id=user_id))
    return json.loads(raw) if raw else None


def clear_pending_preference(user_id: str) -> None:
    """Remove pending preference key from Redis."""
    _get_redis().delete(_PENDING_PREFERENCE_KEY.format(user_id=user_id))


# Duration defaults per activity type
_DURATION_DEFAULTS: dict[str, int] = {
    "study": 2,
    "workout": 1,
    "meal": 1,
}


def _format_time(iso: str) -> str:
    """Format ISO datetime to '8:00pm' style."""
    dt = datetime.fromisoformat(iso)
    return dt.strftime("%I:%M%p").lstrip("0").lower()


def _format_date_label(target: datetime) -> str:
    """Return 'tomorrow', 'tonight', or 'Friday' etc. relative label."""
    from datetime import date, timedelta
    today = date.today()
    target_date = target.date()
    if target_date == today:
        return "today"
    if target_date == today + timedelta(days=1):
        return "tomorrow"
    return target.strftime("%A")  # e.g. "Friday"


def _check_gcal_connected(user_id: str) -> bool:
    """Return True if user has a linked Google Calendar integration."""
    rows = (
        _get_supabase()
        .table("integrations")
        .select("id")
        .eq("user_id", user_id)
        .eq("platform", "google")
        .execute()
        .data
    )
    return bool(rows)


def _fetch_slots(user_id: str, target: datetime, duration_hours: int, preference: str, user_tz: str) -> list[dict]:
    """Fetch calendar events and return free slots for the target date."""
    from gcal.db import get_calendar_events
    from gcal.slots import find_free_slots

    # Bound the query by the user's LOCAL day (converted to UTC), not the UTC day,
    # so evening events that fall on the next UTC date are not missed.
    local_start = datetime.combine(target.date(), time.min, tzinfo=ZoneInfo(user_tz))
    local_end = local_start + timedelta(days=1) - timedelta(seconds=1)
    day_start = local_start.astimezone(timezone.utc).isoformat()
    day_end   = local_end.astimezone(timezone.utc).isoformat()
    events = get_calendar_events(user_id, day_start, day_end)
    return find_free_slots(
        events=events,
        date=target,
        min_duration_hours=duration_hours,
        study_preference=preference,
        user_tz=user_tz,
    )


def handle_schedule_request(
    user_id: str,
    activity_type: str,
    subject: Optional[str],
    target_date_string: str,
    duration_hours: Optional[int],
) -> str:
    """Orchestrate a scheduling request from SMS.

    Handles: GCal connected check, date parsing, preference lookup/ask,
    slot-finding, pending state storage, confirmation prompt generation.

    Args:
        user_id: UUID of the user.
        activity_type: Normalized activity type from intent (e.g. 'study', 'workout').
        subject: Optional subject/topic (e.g. 'biochem exam').
        target_date_string: Natural language date from student ('tomorrow', 'Friday').
        duration_hours: Desired duration override, or None to use activity default.

    Returns:
        SMS reply string.
    """
    user_tz = get_user_tz(user_id)

    # Parse date
    target = parse_target_date(target_date_string or "today", user_tz)
    if not target:
        return "What date did you have in mind? Try something like 'tomorrow' or 'Friday'."

    # Check Google Calendar connected
    if not _check_gcal_connected(user_id):
        return (
            "You'll need to connect Google Calendar first — "
            "head to Preferences in the app."
        )

    # Resolve duration
    dur = duration_hours or _DURATION_DEFAULTS.get(activity_type, 1)

    # Preference lookup / ask
    preference = get_activity_preference(user_id, activity_type)
    if preference is None:
        # Flow A: ask first
        original_request = {
            "activity_type": activity_type,
            "subject": subject,
            "target_date_string": target_date_string,
            "duration_hours": duration_hours,
        }
        store_pending_preference(user_id, activity_type, original_request)
        label = activity_type.replace("_", " ")
        return (
            f"When do you usually like to {label} — "
            "morning, afternoon, or evening?"
        )

    # Find slots
    slots = _fetch_slots(user_id, target, dur, preference, user_tz)
    if not slots:
        date_label = _format_date_label(target)
        return (
            f"Your calendar's fully booked {date_label} — text me "
            f"'find time to {activity_type} tomorrow' to check then."
        )

    # Build event title
    if activity_type == "study" and subject:
        title = f"{subject.title()} Study"
    else:
        title = activity_type.replace("_", " ").title()

    # Store pending (top slot + up to 2 alternatives). Free slots span the whole
    # gap; book only the requested duration from the slot start
    # (matches gcal.writeback.schedule_study_block).
    def _trim(slot: dict) -> dict:
        start_dt = datetime.fromisoformat(slot["start"])
        return {**slot, "end": (start_dt + timedelta(hours=dur)).isoformat(), "duration_hours": dur}

    top = _trim(slots[0])
    alts = [_trim(s) for s in slots[1:3]]
    store_pending_schedule(user_id, {
        "activity_type": activity_type,
        "subject": subject,
        "title": title,
        "start": top["start"],
        "end": top["end"],
        "alternative_slots": alts,
    })

    date_label = _format_date_label(target)
    time_str = f"{_format_time(top['start'])}–{_format_time(top['end'])}"
    return f"Best window {date_label} is {time_str}. Should I add it?"


def _book_event(user_id: str, title: str, start_iso: str, end_iso: str) -> str:
    """Create a calendar event. Returns the Google Calendar event ID."""
    from gcal.writeback import create_study_block
    start_dt = datetime.fromisoformat(start_iso)
    end_dt   = datetime.fromisoformat(end_iso)
    return create_study_block(user_id, title, start_dt, end_dt)


def handle_schedule_confirmation(user_id: str) -> str:
    """Book the pending schedule when the student confirms.

    Args:
        user_id: UUID of the user.

    Returns:
        SMS confirmation string, or graceful error if pending expired.
    """
    pending = get_pending_schedule(user_id)
    if not pending:
        return "I couldn't find that request — it may have expired. Try again!"

    _book_event(user_id, pending["title"], pending["start"], pending["end"])
    learn_from_confirmation(user_id, pending["activity_type"], pending["start"])
    clear_pending_schedule(user_id)

    time_str = f"{_format_time(pending['start'])}–{_format_time(pending['end'])}"
    return f"Done — {pending['title']} added for {time_str}."


def handle_schedule_decline(user_id: str) -> str:
    """Offer the next alternative slot when the student declines.

    Args:
        user_id: UUID of the user.

    Returns:
        New confirmation prompt with alternative slot, or no-more-slots message.
    """
    pending = get_pending_schedule(user_id)
    if not pending:
        return "I couldn't find that request — it may have expired. Try again!"

    alternatives = pending.get("alternative_slots", [])
    if not alternatives:
        clear_pending_schedule(user_id)
        return (
            "No other slots available that day — text me "
            f"'find time to {pending['activity_type']} tomorrow' to check a different day."
        )

    # Promote first alternative to proposed slot
    next_slot = alternatives[0]
    remaining  = alternatives[1:]
    store_pending_schedule(user_id, {
        **pending,
        "start": next_slot["start"],
        "end":   next_slot["end"],
        "alternative_slots": remaining,
    })

    time_str = f"{_format_time(next_slot['start'])}–{_format_time(next_slot['end'])}"
    return f"Next best is {time_str}. Should I add that instead?"
