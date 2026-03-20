"""Supabase read/write helpers for Todoist integrations."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional


def _get_supabase():
    """Create Supabase client using service role key (bypasses RLS).

    Delegated to ai.db to avoid duplicating client factory logic.
    """
    from ai.db import _get_supabase as _ai_get_supabase
    return _ai_get_supabase()


def get_all_todoist_integrations() -> list[dict]:
    """Return all users with an active Todoist integration (access_token not null).

    Returns user_id only — access_token is NOT selected here to avoid
    leaking tokens into memory more than necessary.

    Returns:
        List of dicts with user_id key.
    """
    client = _get_supabase()
    result = (
        client.table("integrations")
        .select("user_id")
        .eq("platform", "todoist")
        .not_.is_("access_token", "null")
        .execute()
    )
    return result.data


def get_todoist_token(user_id: str) -> Optional[str]:
    """Fetch Todoist access token for a user from Supabase.

    Access tokens are fetched here (inside task body) so they are never
    passed through Redis as Celery task arguments.

    Args:
        user_id: UUID of the user.
    Returns:
        Access token string, or None if not found.
    """
    client = _get_supabase()
    result = (
        client.table("integrations")
        .select("access_token")
        .eq("user_id", user_id)
        .eq("platform", "todoist")
        .execute()
    )
    if result.data:
        return result.data[0].get("access_token")
    return None


def mark_synced(user_id: str) -> None:
    """Update integrations.synced_at to now for the user's Todoist integration.

    IMPORTANT: Only call this AFTER the sync loop succeeds.

    Args:
        user_id: UUID of the user.
    """
    client = _get_supabase()
    now = datetime.now(timezone.utc).isoformat()
    client.table("integrations").update(
        {"synced_at": now}
    ).eq("user_id", user_id).eq("platform", "todoist").execute()


def mark_integration_revoked(user_id: str) -> None:
    """Clear access_token when Todoist returns 403 (token revoked).

    Sets access_token to None so future fan-out jobs skip this user
    without retrying endlessly on a permanently revoked token.

    Args:
        user_id: UUID of the user.
    """
    client = _get_supabase()
    client.table("integrations").update(
        {"access_token": None}
    ).eq("user_id", user_id).eq("platform", "todoist").execute()
