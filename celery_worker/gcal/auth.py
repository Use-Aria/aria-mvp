"""Google Calendar API service builder with auto-refreshing credentials.

Loads OAuth tokens from the integrations table (decrypted via Fernet),
builds a google-api-python-client Calendar service, and auto-refreshes
if the access token is expired or expiring within 5 minutes.

Per CLAUDE.md: Google OAuth tokens expire in 1 hour — always refresh before API calls.
"""
import os
import logging
from datetime import datetime, timezone, timedelta
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

logger = logging.getLogger(__name__)


def build_gcal_service(user_id: str):
    """Build Google Calendar API service with auto-refreshing credentials.

    Loads tokens from integrations table (decrypted), refreshes if expiring
    within 5 minutes, stores refreshed token back to Supabase.

    Args:
        user_id: UUID of the user whose Google tokens to load.

    Returns:
        Google Calendar API service resource object.

    Raises:
        ValueError: If no Google integration exists for the user.
    """
    from google_auth.tokens import load_google_tokens, store_google_tokens

    creds_data = load_google_tokens(user_id)
    if creds_data is None:
        raise ValueError(f"No Google integration for user {user_id}")

    creds = Credentials(
        token=creds_data["access_token"],
        refresh_token=creds_data["refresh_token"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    )

    # Refresh if expired or expiring within 5 minutes
    needs_refresh = creds.expired or (
        creds.expiry is not None
        and (creds.expiry - datetime.now(timezone.utc)).total_seconds() < 300
    )
    if needs_refresh:
        logger.info("Refreshing Google token for user %s", user_id)
        creds.refresh(Request())
        store_google_tokens(user_id, creds.token, creds.refresh_token)

    return build("calendar", "v3", credentials=creds)
