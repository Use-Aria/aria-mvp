"""Keyword command dispatch for inbound SMS messages.

Handles STOP, START, PAUSE, and HELP commands per TCPA carrier compliance
requirements. All commands are case-insensitive exact matches on trimmed body.

STOP/START are non-negotiable carrier requirements for 10DLC registration.
PAUSE and HELP are user convenience commands.
"""
import os
from datetime import datetime, timedelta, timezone

from supabase import create_client

from sms.send import send_sms_direct, send_sms_safe

# Recognized command keywords
_COMMANDS = {"STOP", "START", "PAUSE", "HELP"}


def dispatch_command(body: str, user_id: str, to_phone: str) -> bool:
    """Dispatch an inbound SMS body to the appropriate command handler.

    Args:
        body: Raw inbound SMS body (strip + upper applied internally).
        user_id: UUID string of the sender (looked up by webhook before enqueueing).
        to_phone: The user's phone number to reply to.

    Returns:
        True if the body matched a recognized command and was handled.
        False if the body is not a recognized command (caller may route elsewhere).
    """
    normalized = body.strip().upper()

    if normalized not in _COMMANDS:
        return False

    if normalized == "STOP":
        _handle_stop(user_id, to_phone)
    elif normalized == "START":
        _handle_start(user_id, to_phone)
    elif normalized == "PAUSE":
        _handle_pause(user_id, to_phone)
    elif normalized == "HELP":
        _handle_help(user_id, to_phone)

    return True


def _handle_stop(user_id: str, to_phone: str) -> None:
    """Process STOP command — opt user out and send final confirmation.

    CRITICAL: Uses send_sms_direct (not send_sms_safe) because the user has
    just opted out; the TCPA guard in send_sms_safe would suppress this
    required confirmation message.
    """
    _get_supabase().table("users").update(
        {
            "sms_opted_out": True,
            "sms_opted_out_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("id", user_id).execute()

    send_sms_direct(
        to_phone,
        "You've been unsubscribed from Aria. Text START to resubscribe.",
    )


def _handle_start(user_id: str, to_phone: str) -> None:
    """Process START command — re-opt user in and confirm."""
    _get_supabase().table("users").update(
        {
            "sms_opted_out": False,
            "sms_opted_out_at": None,
        }
    ).eq("id", user_id).execute()

    send_sms_safe(
        user_id,
        to_phone,
        "Welcome back to Aria.",
        is_proactive=False,
    )


def _handle_pause(user_id: str, to_phone: str) -> None:
    """Process PAUSE command — silence proactive messages for 24 hours."""
    paused_until = datetime.now(timezone.utc) + timedelta(hours=24)

    _get_supabase().table("users").update(
        {"sms_paused_until": paused_until.isoformat()}
    ).eq("id", user_id).execute()

    send_sms_safe(
        user_id,
        to_phone,
        "Aria is paused for 24 hours. Text START to resume anytime.",
        is_proactive=False,
    )


def _handle_help(user_id: str, to_phone: str) -> None:
    """Process HELP command — reply with a list of available commands."""
    send_sms_safe(
        user_id,
        to_phone,
        (
            "Aria commands:\n"
            "STOP - Unsubscribe from all messages\n"
            "START - Resubscribe\n"
            "PAUSE - Pause messages for 24 hours\n"
            "HELP - Show this list"
        ),
        is_proactive=False,
    )


def _get_supabase():
    """Create Supabase client using service role key (bypasses RLS)."""
    url = os.environ.get("SUPABASE_URL") or os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)
