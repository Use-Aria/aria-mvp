"""Google OAuth token storage and retrieval with Fernet encryption.

Tokens are NEVER written to Supabase as plaintext. Both access_token and
refresh_token are encrypted with encrypt_token() before any DB write, and
decrypted with decrypt_token() on load.

Per CLAUDE.md: Google OAuth tokens expire in 1 hour — always refresh before API calls.
"""
from datetime import datetime, timezone

from ai.db import _get_supabase
from google_auth.encryption import encrypt_token, decrypt_token


def store_google_tokens(user_id: str, access_token: str, refresh_token: str) -> None:
    """Encrypt and upsert Google OAuth tokens into the integrations table.

    Both tokens are encrypted via Fernet before any DB write. This function
    is always called from the encrypt_and_store_tokens Celery task — tokens
    arrive as plaintext task args and are encrypted before hitting Supabase.

    Args:
        user_id: UUID of the user whose tokens are being stored.
        access_token: Plaintext Google OAuth access token.
        refresh_token: Plaintext Google OAuth refresh token.
    """
    client = _get_supabase()
    client.table("integrations").upsert(
        {
            "user_id": user_id,
            "platform": "google",
            "access_token": encrypt_token(access_token),
            "refresh_token": encrypt_token(refresh_token),
            "connected_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="user_id,platform",
    ).execute()


def load_google_tokens(user_id: str) -> dict | None:
    """Load and decrypt Google OAuth tokens from the integrations table.

    Args:
        user_id: UUID of the user whose tokens should be loaded.

    Returns:
        Dict with keys "access_token" and "refresh_token" (both decrypted),
        or None if no Google integration exists for this user.
    """
    client = _get_supabase()
    result = (
        client.table("integrations")
        .select("access_token, refresh_token")
        .eq("user_id", user_id)
        .eq("platform", "google")
        .execute()
    )
    if not result.data:
        return None

    row = result.data[0]
    return {
        "access_token": decrypt_token(row["access_token"]),
        "refresh_token": decrypt_token(row["refresh_token"]),
    }
