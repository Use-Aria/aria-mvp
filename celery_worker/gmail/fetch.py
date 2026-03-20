"""Gmail history-based message fetcher.

Fetches new messages via history.list API since a given historyId.
Filters to .edu senders only — professor emails only, no spam.
Returns only metadata (subject, sender, snippet) — NEVER stores full email body.

Per CLAUDE.md privacy rules: full email content is NEVER stored.
"""
import base64
import json
import logging

logger = logging.getLogger(__name__)


def decode_pubsub_message(data: str) -> dict:
    """Decode base64url Pub/Sub data field to {emailAddress, historyId}.

    Gmail Pub/Sub messages encode the payload as base64url without padding.
    This function adds back the required padding before decoding.

    Args:
        data: Base64url-encoded string from Pub/Sub message.data field.

    Returns:
        Decoded dict with keys 'emailAddress' and 'historyId'.
    """
    # Add back padding stripped by Pub/Sub
    padded = data + "=" * (4 - len(data) % 4)
    return json.loads(base64.urlsafe_b64decode(padded).decode())


def fetch_new_messages(user_id: str, start_history_id: str) -> list[dict]:
    """Fetch messages added since start_history_id.

    Uses history.list API to get only new messages since the stored historyId.
    Fetches only metadata format (subject + sender) — NEVER store full body.
    Filters to .edu senders only (professor emails).

    Args:
        user_id: UUID of the user whose Gmail to fetch.
        start_history_id: The last processed historyId to start from.

    Returns:
        List of dicts with keys: subject, sender, snippet, message_id.
        Only messages from .edu senders are included.
        Returns [] on any API error (e.g. 404 expired historyId).
    """
    from gmail.auth import build_gmail_service

    service = build_gmail_service(user_id)
    try:
        result = service.users().history().list(
            userId="me",
            startHistoryId=start_history_id,
            historyTypes=["messageAdded"],
            labelId="INBOX",
        ).execute()
    except Exception as e:
        # 404 means historyId is too old — need full re-sync
        logger.error("Gmail history.list failed for %s: %s", user_id, e)
        return []

    messages = []
    for history in result.get("history", []):
        for msg_added in history.get("messagesAdded", []):
            msg_id = msg_added["message"]["id"]
            # Fetch metadata only — NEVER store full body
            msg = service.users().messages().get(
                userId="me",
                id=msg_id,
                format="metadata",
                metadataHeaders=["From", "Subject"],
            ).execute()

            headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
            sender = headers.get("From", "")
            subject = headers.get("Subject", "")
            snippet = msg.get("snippet", "")

            # Filter to .edu senders only — professors, not spam (locked decision)
            if ".edu" not in sender.lower():
                continue

            messages.append({
                "subject": subject,
                "sender": sender,
                "snippet": snippet,
                "message_id": msg_id,
            })

    return messages


def get_stored_history_id(user_id: str) -> str | None:
    """Get last processed historyId from integrations table.

    Args:
        user_id: UUID of the user.

    Returns:
        The stored historyId string, or None if not set.
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    result = (
        client.table("integrations")
        .select("history_id")
        .eq("user_id", user_id)
        .eq("platform", "google")
        .execute()
    )
    if result.data and result.data[0].get("history_id"):
        return result.data[0]["history_id"]
    return None


def update_history_id(user_id: str, history_id: str) -> None:
    """Update last processed historyId in integrations table.

    Args:
        user_id: UUID of the user.
        history_id: The new historyId to store as the new cursor.
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    client.table("integrations").update(
        {"history_id": history_id}
    ).eq("user_id", user_id).eq("platform", "google").execute()
