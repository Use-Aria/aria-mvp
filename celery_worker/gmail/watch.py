"""Gmail push notification watch channel management.

Manages the lifecycle of Gmail Pub/Sub watch channels:
- establish_gmail_watch: register a new watch for a user's inbox
- renew_gmail_watch: renew expiring watch (called by Celery Beat)

Gmail watch channels expire after 7 days. The Celery Beat job renew_watch_channels
checks every 6 hours for channels expiring within 48 hours and renews Gmail watches
alongside GCal watches.

Per CLAUDE.md: Google OAuth tokens expire in 1 hour — always refresh before API calls.
"""
import os
import logging

logger = logging.getLogger(__name__)


def establish_gmail_watch(user_id: str) -> dict:
    """Establish Gmail watch via users.watch() with Pub/Sub topic.

    Registers a push notification channel that sends Pub/Sub messages to the
    configured topic whenever new emails arrive in the user's inbox.
    Stores initial historyId in integrations.history_id as the cursor for
    future history.list calls.

    Watch expires in 7 days — must be renewed before expiry.

    Args:
        user_id: UUID of the user to set up Gmail watch for.

    Returns:
        Gmail watch response dict with 'historyId' and 'expiration' keys.
        Returns empty dict if GMAIL_PUBSUB_TOPIC is not configured.
    """
    from gmail.auth import build_gmail_service
    from gmail.fetch import update_history_id

    topic = os.environ.get("GMAIL_PUBSUB_TOPIC", "")
    if not topic:
        logger.error("GMAIL_PUBSUB_TOPIC not set — cannot establish watch")
        return {}

    service = build_gmail_service(user_id)
    result = service.users().watch(
        userId="me",
        body={
            "topicName": topic,
            "labelIds": ["INBOX"],
        },
    ).execute()

    # Store historyId as starting point for future history.list calls
    history_id = str(result.get("historyId", ""))
    if history_id:
        update_history_id(user_id, history_id)

    # Store expiration for renewal tracking in integrations table
    expiration = result.get("expiration", 0)
    if expiration:
        from ai.db import _get_supabase
        from datetime import datetime, timezone

        client = _get_supabase()
        expires_at = datetime.fromtimestamp(int(expiration) / 1000, tz=timezone.utc).isoformat()
        client.table("integrations").update({
            "watch_expires_at": expires_at,
        }).eq("user_id", user_id).eq("platform", "google").execute()

    logger.info(
        "Gmail watch established for user %s, historyId %s",
        user_id, history_id,
    )
    return result


def renew_gmail_watch(user_id: str) -> dict:
    """Renew Gmail watch — simply call watch() again (Gmail handles replacement).

    Gmail automatically replaces an existing watch when watch() is called again
    for the same topic. No stop() call needed unlike GCal channels.

    Args:
        user_id: UUID of the user whose watch to renew.

    Returns:
        New watch response dict from establish_gmail_watch().
    """
    return establish_gmail_watch(user_id)
