"""GCal event creation for study blocks.

Creates, deletes, and intelligently schedules study blocks on a user's
primary Google Calendar. Study block placement respects user's study_preference
(morning/afternoon/evening) via find_free_slots.

Exports: create_study_block, delete_study_block, schedule_study_block
"""
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)


def create_study_block(
    user_id: str,
    title: str,
    start_dt: datetime,
    end_dt: datetime,
) -> str:
    """Create a study block event on user's primary Google Calendar.

    Args:
        user_id: UUID of the user whose calendar to write to.
        title: Event title (e.g., "Bio Lab Study").
        start_dt: Start datetime (timezone-aware).
        end_dt: End datetime (timezone-aware).

    Returns:
        Google Calendar event ID string (for undo support via delete_study_block).
    """
    from gcal.auth import build_gcal_service

    service = build_gcal_service(user_id)
    event = {
        "summary": title,
        "start": {"dateTime": start_dt.isoformat(), "timeZone": "UTC"},
        "end": {"dateTime": end_dt.isoformat(), "timeZone": "UTC"},
        "description": "Created by Aria — your AI study assistant",
    }
    created = service.events().insert(calendarId="primary", body=event).execute()
    event_id = created["id"]
    logger.info("Study block created for user %s: %s (%s)", user_id, title, event_id)
    return event_id


def delete_study_block(user_id: str, event_id: str) -> bool:
    """Delete a study block from Google Calendar (undo support).

    Args:
        user_id: UUID of the user whose calendar to modify.
        event_id: Google Calendar event ID to delete.

    Returns:
        True if deleted successfully, False on error.
    """
    from gcal.auth import build_gcal_service

    try:
        service = build_gcal_service(user_id)
        service.events().delete(calendarId="primary", eventId=event_id).execute()
        logger.info("Study block deleted for user %s: %s", user_id, event_id)
        return True
    except Exception as e:
        logger.error("Failed to delete study block %s for user %s: %s", event_id, user_id, e)
        return False


def schedule_study_block(
    user_id: str,
    title: str,
    duration_hours: int,
    target_date: datetime,
    study_preference: str = "evening",
    user_tz: str = "America/New_York",
) -> dict | None:
    """Find a free slot and create a study block on user's calendar.

    Uses find_free_slots to locate gaps in the target date, creates the
    event in the first available slot that matches the user's preference.

    Args:
        user_id: UUID of the user.
        title: Study block title (e.g., "Chem 220 Study").
        duration_hours: Desired study block length in hours.
        target_date: Date to search for a free slot.
        study_preference: One of 'morning', 'afternoon', 'evening' (default 'evening').
        user_tz: IANA timezone string (default 'America/New_York').

    Returns:
        Dict with {event_id, start, end, title} if a slot was found and event created,
        or None if no slot was available.
    """
    from gcal.db import get_calendar_events
    from gcal.slots import find_free_slots

    date_str = target_date.strftime("%Y-%m-%dT00:00:00+00:00")
    end_str = target_date.strftime("%Y-%m-%dT23:59:59+00:00")
    events = get_calendar_events(user_id, date_str, end_str)

    slots = find_free_slots(
        events=events,
        date=target_date,
        min_duration_hours=duration_hours,
        study_preference=study_preference,
        user_tz=user_tz,
    )

    if not slots:
        logger.info(
            "No free slot for study block on %s for user %s",
            target_date.date(), user_id,
        )
        return None

    # Use the first (most preferred) slot
    slot = slots[0]
    start_dt = datetime.fromisoformat(slot["start"])
    end_dt = start_dt + timedelta(hours=duration_hours)

    event_id = create_study_block(user_id, title, start_dt, end_dt)
    return {
        "event_id": event_id,
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat(),
        "title": title,
    }
