"""Shared Supabase queries for AI briefing and reply modules."""
import os
from datetime import datetime, timedelta, timezone
from supabase import create_client



def _get_supabase():
    """Create Supabase client using service role key (bypasses RLS)."""
    url = os.environ.get("SUPABASE_URL") or os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


# DEPRECATED: Use get_events_for_briefing() which reads from canonical_events.
# Kept until Phase 6 confirms canonical_events has full coverage.
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


def get_events_for_briefing(user_id: str, days_ahead: int = 7) -> list[dict]:
    """Fetch active digest/immediate events from canonical_events for briefing.

    Replaces get_deadlines_for_briefing() — reads canonical_events going forward.
    Returns events ordered by due_at ascending. Filters out:
    - deleted (deleted_at IS NOT NULL)
    - snoozed (snoozed_until > now, filtered in Python)
    - silent events (only digest and immediate included)

    After fetching, marks all returned digest events as 'sent' to prevent
    re-inclusion in future briefings.

    Field mapping shim: appends due_date=due_at and course=course_id so existing
    briefing code (generate_briefing) works without modification.

    Args:
        user_id: UUID of the user.
        days_ahead: Number of days ahead to include events (default 7).

    Returns:
        List of event dicts with keys: id, title, due_at, course_id, type,
        grade_weight, priority_score, delivery_status, snoozed_until,
        plus due_date and course aliases for backwards compatibility.
    """
    client = _get_supabase()
    now = datetime.now(timezone.utc)
    cutoff = (now + timedelta(days=days_ahead)).isoformat()
    result = (
        client.table("canonical_events")
        .select("id, title, due_at, course_id, type, grade_weight, priority_score, delivery_status, snoozed_until")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .in_("delivery_status", ["digest", "immediate"])
        .lte("due_at", cutoff)
        .order("due_at", desc=False)
        .execute()
    )
    active = []
    for e in result.data:
        snoozed = e.get("snoozed_until")
        if snoozed:
            snooze_dt = datetime.fromisoformat(str(snoozed))
            if now < snooze_dt:
                continue
        # Field mapping shim — generate_briefing uses due_date and course keys
        e["due_date"] = e["due_at"]
        e["course"] = e.get("course_id")
        active.append(e)

    # Mark digest events as 'sent' to prevent re-inclusion in future briefings
    digest_ids = [e["id"] for e in active if e.get("delivery_status") == "digest"]
    if digest_ids:
        for eid in digest_ids:
            client.table("canonical_events").update(
                {"delivery_status": "sent"}
            ).eq("id", eid).execute()

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
