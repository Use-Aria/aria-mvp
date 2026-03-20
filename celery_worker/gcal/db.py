"""Supabase CRUD for calendar_events table and GCal watch channel state.

Provides upsert/fetch for calendar_events and read/write for the
watch channel state stored in the integrations table.
"""
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def store_calendar_events(user_id: str, events: list[dict]) -> int:
    """Upsert GCal events into calendar_events table.

    Uses UNIQUE(user_id, google_event_id) on_conflict for idempotent upsert.
    Safe to call on re-synced events — updates title, times, and type.

    Args:
        user_id: UUID of the owning user.
        events: List of event dicts from fetch_gcal_events() with keys:
            google_event_id, title, start_time, end_time, type.

    Returns:
        Count of events stored (upserted).
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    count = 0
    for e in events:
        payload = {
            "user_id": user_id,
            "google_event_id": e["google_event_id"],
            "title": e["title"],
            "start_time": e["start_time"],
            "end_time": e["end_time"],
            "type": e["type"],
        }
        client.table("calendar_events").upsert(
            payload, on_conflict="user_id,google_event_id"
        ).execute()
        count += 1

    return count


def get_calendar_events(user_id: str, start_date: str, end_date: str) -> list[dict]:
    """Fetch calendar_events for user within a date range.

    Args:
        user_id: UUID of the user.
        start_date: ISO timestamp — inclusive lower bound on start_time.
        end_date: ISO timestamp — inclusive upper bound on start_time.

    Returns:
        List of event row dicts ordered by start_time ascending.
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    result = (
        client.table("calendar_events")
        .select("id, google_event_id, title, start_time, end_time, type")
        .eq("user_id", user_id)
        .gte("start_time", start_date)
        .lte("start_time", end_date)
        .order("start_time", desc=False)
        .execute()
    )
    return result.data


def store_watch_channel(
    user_id: str, channel_id: str, resource_id: str, expiration_ms: int
) -> None:
    """Store GCal push notification watch channel state in integrations table.

    Args:
        user_id: UUID of the user.
        channel_id: GCal watch channel ID (UUID string from watch response).
        resource_id: GCal resource ID from watch response.
        expiration_ms: Watch expiration in milliseconds since epoch (from watch response).
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    expires_at = datetime.fromtimestamp(expiration_ms / 1000, tz=timezone.utc).isoformat()
    client.table("integrations").update({
        "channel_id": channel_id,
        "resource_id": resource_id,
        "watch_expires_at": expires_at,
    }).eq("user_id", user_id).eq("platform", "google").execute()

    logger.info(
        "Stored watch channel for user %s: channel=%s, expires=%s",
        user_id, channel_id, expires_at,
    )


def get_watch_channel(user_id: str) -> dict | None:
    """Get GCal watch channel state from integrations table.

    Args:
        user_id: UUID of the user.

    Returns:
        Dict with channel_id, resource_id, watch_expires_at if a channel is active,
        or None if no channel is registered (channel_id is NULL or row missing).
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    result = (
        client.table("integrations")
        .select("channel_id, resource_id, watch_expires_at")
        .eq("user_id", user_id)
        .eq("platform", "google")
        .execute()
    )
    if result.data and result.data[0].get("channel_id"):
        return result.data[0]
    return None
