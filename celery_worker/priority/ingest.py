"""Canonical event ingest entry point for all integrations.

All integration sources (Canvas, GCal, Gmail, Todoist) write events through
ingest_canonical_event(). This function scores, routes, and persists each event
to the canonical_events table. High-priority events (score >= 80) dispatch an
immediate SMS alert via the send_priority_alert Celery task.

Phase 6 integrations call ingest_canonical_event() directly — no other code path
should write to canonical_events.
"""
from datetime import datetime, timezone


def ingest_canonical_event(
    user_id: str,
    source: str,
    event_type: str | None,
    title: str,
    due_at: str | datetime,
    course_id: str | None = None,
    grade_weight: float | None = None,
    skip_routing: bool = False,
) -> dict:
    """Score, route, and upsert a canonical event.

    This is the single entry point for all event writes to canonical_events.
    Idempotent via UNIQUE(user_id, source, title, due_at) — safe to call on
    re-synced events (updates priority_score and delivery_status).

    Args:
        user_id: UUID of the owning user.
        source: Event source ('canvas', 'gcal', 'gmail', 'todoist').
        event_type: Event type string (e.g. 'assignment', 'exam'). May be None.
        title: Event title (required).
        due_at: Due datetime — ISO string or datetime object. Naive datetimes
            are treated as UTC.
        course_id: Course identifier string (e.g. 'CPSC 365'). May be None.
        grade_weight: Raw grade weight as percentage (e.g. 25.0 for 25%) or
            normalized fraction (e.g. 0.25). Values > 1 are divided by 100.
            None is treated as 0 (syllabus parsing not yet done).
        skip_routing: If True, override delivery_status to 'silent' regardless
            of priority score. Use for backfill to prevent alert spam for
            already-known events.

    Returns:
        The upserted canonical_events row dict from Supabase.
    """
    from priority.engine import score_event
    from priority.router import route_event
    from ai.db import _get_supabase

    # Step 1: Coerce due_at to UTC datetime
    if isinstance(due_at, str):
        due_dt = datetime.fromisoformat(due_at)
    else:
        due_dt = due_at
    if due_dt.tzinfo is None:
        due_dt = due_dt.replace(tzinfo=timezone.utc)

    # Step 2: Compute days remaining
    days_remaining = (due_dt - datetime.now(timezone.utc)).total_seconds() / 86400

    # Step 3: Normalize grade_weight (percentage → fraction)
    if grade_weight is not None and grade_weight > 1:
        gw = grade_weight / 100.0
    else:
        gw = grade_weight if grade_weight is not None else 0.0

    # Step 4: Score and route
    priority_score = score_event(gw, days_remaining, source)
    delivery_status = route_event(priority_score)

    # Step 5: Backfill safety — override routing to silent
    if skip_routing:
        delivery_status = "silent"

    # Step 6: Upsert into canonical_events
    client = _get_supabase()
    payload = {
        "user_id": user_id,
        "source": source,
        "type": event_type,
        "title": title,
        "due_at": due_dt.isoformat(),
        "course_id": course_id,
        "grade_weight": gw,
        "priority_score": priority_score,
        "delivery_status": delivery_status,
    }
    result = (
        client.table("canonical_events")
        .upsert(payload, on_conflict="user_id,source,title,due_at")
        .execute()
    )
    event = result.data[0] if result.data else payload

    # Step 7: Dispatch immediate alert for high-priority non-backfill events
    if delivery_status == "immediate" and not skip_routing:
        # Lazy import to avoid circular dependency (tasks.py imports from priority)
        from tasks import send_priority_alert
        send_priority_alert.delay(user_id, event.get("id", ""))

    return event
