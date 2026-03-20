"""GCal events.list wrapper for 7-day rolling window.

Fetches events from the user's primary Google Calendar, filters out
declined and transparent events, and normalizes to a standard dict format.

Per CLAUDE.md: Claude context limit — pass only 7 days of calendar per request.
"""
import logging
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)


def fetch_gcal_events(user_id: str, days: int = 7) -> list[dict]:
    """Fetch GCal events for 7-day rolling window.

    Filters out declined events (where user's attendee has responseStatus=declined)
    and transparent events (free/busy status=transparent). Normalizes to dict format.

    Args:
        user_id: UUID of the user whose Google Calendar to fetch.
        days: Number of days ahead to fetch (default 7).

    Returns:
        List of event dicts with keys: google_event_id, title, start_time,
        end_time, type (inferred from title), source ('gcal').
    """
    from gcal.auth import build_gcal_service

    service = build_gcal_service(user_id)
    now = datetime.now(timezone.utc)
    time_max = now + timedelta(days=days)

    events_result = service.events().list(
        calendarId="primary",
        timeMin=now.isoformat(),
        timeMax=time_max.isoformat(),
        singleEvents=True,
        orderBy="startTime",
        showDeleted=False,
    ).execute()

    items = events_result.get("items", [])
    normalized = []

    for e in items:
        # Skip transparent (free) events — user is free, not busy
        if e.get("transparency") == "transparent":
            continue

        # Skip events user has declined
        attendees = e.get("attendees", [])
        if any(a.get("self") and a.get("responseStatus") == "declined" for a in attendees):
            continue

        # Normalize start/end — handle dateTime and date (all-day) formats
        start_raw = e.get("start", {})
        end_raw = e.get("end", {})
        start_time = start_raw.get("dateTime") or start_raw.get("date")
        end_time = end_raw.get("dateTime") or end_raw.get("date")

        # Infer event type from title keywords
        title = e.get("summary", "Untitled")
        event_type = _infer_type(title)

        normalized.append({
            "google_event_id": e["id"],
            "title": title,
            "start_time": start_time,
            "end_time": end_time,
            "type": event_type,
            "source": "gcal",
        })

    logger.info("Fetched %d GCal events for user %s", len(normalized), user_id)
    return normalized


def _infer_type(title: str) -> str:
    """Infer event type from title keywords.

    Args:
        title: Event title string.

    Returns:
        One of 'exam', 'class', 'study', or 'personal'.
    """
    lower = title.lower()
    if any(kw in lower for kw in ("exam", "midterm", "final", "quiz", "test")):
        return "exam"
    if any(kw in lower for kw in ("lecture", "class", "section", "seminar", "lab")):
        return "class"
    if any(kw in lower for kw in ("study", "review", "homework", "pset")):
        return "study"
    return "personal"
