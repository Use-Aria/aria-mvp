"""GCal push notification watch channel management.

Manages the lifecycle of GCal push notification channels:
- establish_watch: register a new push channel for a user's primary calendar
- stop_watch: cancel an existing channel
- renew_watch: stop old channel and establish a new one (called by Beat)

Watch channels expire after 7 days. The Celery Beat job renew_watch_channels
checks every 6 hours for channels expiring within 48 hours and renews them.
"""
import os
import uuid
import logging
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)


def establish_watch(user_id: str) -> dict:
    """Register a GCal push notification channel for user's primary calendar.

    Creates a new watch channel with 7-day expiry and stores the channel
    state (channel_id, resource_id, watch_expires_at) in the integrations table.

    Args:
        user_id: UUID of the user. Used as X-Goog-Channel-Token so webhook
            can route the notification back to the correct user.

    Returns:
        GCal watch response dict with keys: id, resourceId, expiration, kind.

    Raises:
        ValueError: If no Google integration exists for the user.
        Exception: On GCal API errors (channel quota exceeded, etc.).
    """
    from gcal.auth import build_gcal_service
    from gcal.db import store_watch_channel

    service = build_gcal_service(user_id)
    channel_id = str(uuid.uuid4())
    expiration = int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp() * 1000)

    body = {
        "id": channel_id,
        "type": "web_hook",
        "address": f"{os.environ['APP_BASE_URL']}/api/gcal/webhook",
        "token": user_id,  # returned in X-Goog-Channel-Token header on each push
        "expiration": expiration,
    }
    result = service.events().watch(calendarId="primary", body=body).execute()
    store_watch_channel(user_id, result["id"], result["resourceId"], result["expiration"])

    logger.info(
        "GCal watch established for user %s, channel %s, expires %s",
        user_id, result["id"], result["expiration"],
    )
    return result


def stop_watch(user_id: str, channel_id: str, resource_id: str) -> None:
    """Stop an existing GCal push notification channel.

    Args:
        user_id: UUID of the user (for loading auth credentials).
        channel_id: GCal channel ID to stop.
        resource_id: GCal resource ID associated with the channel.

    Raises:
        Exception: If the API call fails (channel already expired, etc.).
            Caller should handle this gracefully during renewal.
    """
    from gcal.auth import build_gcal_service

    service = build_gcal_service(user_id)
    service.channels().stop(body={"id": channel_id, "resourceId": resource_id}).execute()
    logger.info("GCal watch stopped: channel %s for user %s", channel_id, user_id)


def renew_watch(user_id: str) -> dict | None:
    """Renew a GCal watch channel: stop old one (if exists) and establish a new one.

    Called by the renew_watch_channels Celery Beat task for channels expiring
    within 48 hours. Gracefully handles stop failures (channel may already be
    expired on Google's side) and always attempts to establish a new channel.

    Args:
        user_id: UUID of the user.

    Returns:
        New watch response dict from establish_watch(), or None on failure.
    """
    from gcal.db import get_watch_channel

    existing = get_watch_channel(user_id)
    if existing and existing.get("channel_id"):
        try:
            stop_watch(user_id, existing["channel_id"], existing["resource_id"])
        except Exception as e:
            logger.warning(
                "Failed to stop old watch channel %s for user %s: %s",
                existing.get("channel_id"), user_id, e,
            )

    return establish_watch(user_id)
