"""Todoist sync orchestrator: fetch -> parse -> ingest pipeline."""
import requests
from todoist.fetch import get_active_tasks
from todoist.parse import parse_tasks
from todoist.db import get_todoist_token, mark_synced, mark_integration_revoked


def sync_todoist_user(user_id: str) -> dict:
    """Fetch all active Todoist tasks for a user and ingest into canonical_events.

    Pipeline:
    1. Fetch access token from Supabase (never passed via Redis)
    2. Fetch active tasks with due dates from Todoist REST API
    3. Parse/normalize tasks to internal format
    4. Ingest each task via ingest_canonical_event (source='todoist')
    5. Mark integration synced_at

    403 handling: revokes token and returns early — Celery will NOT retry.

    Args:
        user_id: UUID of the user to sync.
    Returns:
        Dict with user_id, status/synced count.
    """
    from priority.ingest import ingest_canonical_event

    access_token = get_todoist_token(user_id)
    if not access_token:
        return {"user_id": user_id, "status": "no_token"}

    try:
        raw_tasks = get_active_tasks(access_token)
    except requests.HTTPError as e:
        if e.response is not None and e.response.status_code == 403:
            mark_integration_revoked(user_id)
            return {"user_id": user_id, "status": "token_revoked"}
        raise  # re-raise for Celery retry on non-403 errors

    parsed = parse_tasks(raw_tasks)
    for t in parsed:
        ingest_canonical_event(
            user_id=user_id,
            source="todoist",
            event_type="task",
            title=t["title"],
            due_at=t["due_date"],
            course_id=None,
            grade_weight=0.0,
        )
    mark_synced(user_id)
    return {"user_id": user_id, "synced": len(parsed)}
