"""Supabase read/write operations for Canvas deadlines and integrations."""
import os
from datetime import datetime, timezone
from supabase import create_client


def _get_supabase():
    """Create Supabase client using service role key (bypasses RLS)."""
    url = os.environ.get("SUPABASE_URL") or os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def get_all_canvas_integrations() -> list[dict]:
    """Return all integrations with platform='canvas' that have an ical_url."""
    client = _get_supabase()
    result = (
        client.table("integrations")
        .select("user_id, ical_url")
        .eq("platform", "canvas")
        .not_.is_("ical_url", "null")
        .execute()
    )
    return result.data


def load_current_deadlines(user_id: str) -> dict:
    """Load active (non-deleted) deadlines for a user, keyed by canvas_uid.

    Returns:
        Dict of {canvas_uid: {"due_date": "...", "title": "...", ...}}
    """
    client = _get_supabase()
    result = (
        client.table("deadlines")
        .select("canvas_uid, title, due_date, course, type")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .execute()
    )
    return {row["canvas_uid"]: row for row in result.data if row.get("canvas_uid")}


def apply_diff(user_id: str, diff: dict) -> None:
    """Write added/changed deadlines via upsert, soft-delete removed deadlines.

    Args:
        user_id: UUID of the user.
        diff: Output of compute_diff() — {"added": [...], "changed": [...], "removed": [uid, ...]}.
    """
    client = _get_supabase()
    now = datetime.now(timezone.utc).isoformat()

    # Upsert added + changed deadlines
    for event in diff["added"] + diff["changed"]:
        client.table("deadlines").upsert(
            {
                "user_id": user_id,
                "canvas_uid": event["canvas_uid"],
                "title": event["title"],
                "due_date": event["due_date"],
                "course": event.get("course"),
                "type": event.get("type"),
                "last_synced": now,
                "deleted_at": None,  # clear any prior soft-delete on re-add
            },
            on_conflict="canvas_uid,user_id",
        ).execute()

    # Soft-delete removed deadlines
    for uid in diff["removed"]:
        client.table("deadlines").update(
            {"deleted_at": now}
        ).eq("user_id", user_id).eq("canvas_uid", uid).execute()


def mark_synced(user_id: str) -> None:
    """Update integrations.synced_at for the user's Canvas integration.

    IMPORTANT: Only call this AFTER apply_diff succeeds.
    """
    client = _get_supabase()
    now = datetime.now(timezone.utc).isoformat()
    client.table("integrations").update(
        {"synced_at": now}
    ).eq("user_id", user_id).eq("platform", "canvas").execute()
