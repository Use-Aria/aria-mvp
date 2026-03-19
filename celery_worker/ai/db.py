"""Shared Supabase queries for AI briefing and reply modules."""
import os
from datetime import datetime, timedelta, timezone
from supabase import create_client


def _get_supabase():
    """Create Supabase client using service role key (bypasses RLS)."""
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def get_deadlines_for_briefing(user_id: str, days_ahead: int = 7) -> list[dict]:
    """Fetch active, non-snoozed deadlines for a user within days_ahead window.

    Returns deadlines ordered by due_date ascending. Filters out:
    - deleted (deleted_at IS NOT NULL)
    - completed (status = 'completed')
    - snoozed (snoozed_until > now)

    Args:
        user_id: UUID of the user.
        days_ahead: Number of days ahead to include deadlines (default 7).

    Returns:
        List of deadline dicts with keys: id, title, due_date, course, type,
        grade_weight, status, priority, snoozed_until.
    """
    client = _get_supabase()
    now = datetime.now(timezone.utc)
    cutoff = (now + timedelta(days=days_ahead)).isoformat()
    result = (
        client.table("deadlines")
        .select("id, title, due_date, course, type, grade_weight, status, priority, snoozed_until")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .neq("status", "completed")
        .lte("due_date", cutoff)
        .order("due_date", desc=False)
        .execute()
    )
    # Filter snoozed in Python (snoozed_until > now)
    active = []
    for d in result.data:
        snoozed = d.get("snoozed_until")
        if snoozed:
            snooze_dt = datetime.fromisoformat(str(snoozed))
            if now < snooze_dt:
                continue
        active.append(d)
    return active


def get_conversation_history(user_id: str, limit: int = 10) -> list[dict]:
    """Fetch last N messages (both in/out) for conversation context.

    Returns rows ordered by sent_at DESC (caller should reverse for chronological).
    Limit=10 gives ~5 exchanges (5 in + 5 out).

    Args:
        user_id: UUID of the user.
        limit: Maximum number of messages to return (default 10).

    Returns:
        List of message dicts with keys: body, direction, sent_at.
    """
    client = _get_supabase()
    result = (
        client.table("messages")
        .select("body, direction, sent_at")
        .eq("user_id", user_id)
        .order("sent_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data


def briefing_sent_today(user_id: str, user_local_date_str: str) -> bool:
    """Check if a briefing or welcome_briefing was already sent today.

    Args:
        user_id: UUID of the user.
        user_local_date_str: Today's date in user's local TZ, ISO format (YYYY-MM-DD).

    Returns:
        True if a message with trigger_type in ('briefing', 'welcome_briefing')
        exists for today's date.
    """
    client = _get_supabase()
    # Query messages sent today with briefing trigger types
    start = f"{user_local_date_str}T00:00:00+00:00"
    end = f"{user_local_date_str}T23:59:59+00:00"
    result = (
        client.table("messages")
        .select("id")
        .eq("user_id", user_id)
        .in_("trigger_type", ["briefing", "welcome_briefing"])
        .gte("sent_at", start)
        .lte("sent_at", end)
        .limit(1)
        .execute()
    )
    return len(result.data) > 0


def write_outbound_message(user_id: str, body: str, trigger_type: str) -> None:
    """Write an outbound message record to the messages table.

    Args:
        user_id: UUID of the user.
        body: Message text sent.
        trigger_type: One of 'briefing', 'welcome_briefing', 'reply'.
    """
    client = _get_supabase()
    client.table("messages").insert({
        "user_id": user_id,
        "direction": "out",
        "body": body,
        "trigger_type": trigger_type,
    }).execute()
