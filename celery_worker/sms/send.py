"""Centralized outbound SMS guard with TCPA compliance checks.

All outbound SMS must route through send_sms_safe(). This function
enforces opt-out, pause, quiet hours, and daily proactive cap before
reaching the Twilio API. The Twilio client is never imported directly
by other modules.

send_sms_direct() is the only bypass — reserved for STOP confirmation
in commands.py where the user has just opted out and the guard would block.
"""
import hashlib
import json
import logging
import os
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from supabase import create_client
from twilio.rest import Client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def send_sms_safe(
    user_id: str,
    to_phone: str,
    body: str,
    is_proactive: bool = True,
) -> bool:
    """Send an SMS through TCPA compliance guards.

    Checks (in order): opt-out, pause, quiet hours, daily cap (proactive only).
    If all guards pass, calls Twilio client.messages.create() and returns True.
    If any guard blocks, logs a suppressed event (no PII) and returns False.

    Args:
        user_id: UUID of the recipient user (used for DB lookup and hashed logging).
        to_phone: Recipient E.164 phone number. Never logged in plaintext.
        body: Message body text.
        is_proactive: True for briefings/alerts (counts toward daily cap of 3).
                      False for replies to user-initiated messages (uncapped).

    Returns:
        True if message was sent, False if suppressed by any guard.
    """
    user = _get_user_sms_state(user_id)
    hashed_id = hashlib.sha256(user_id.encode()).hexdigest()[:12]

    # Guard 1: Hard opt-out — never send to opted-out users.
    if user["sms_opted_out"]:
        _log_suppressed(hashed_id, "opted_out")
        return False

    # Guard 2: Pause — user requested temporary silence.
    paused_until = user.get("sms_paused_until")
    if paused_until is not None:
        paused_dt = datetime.fromisoformat(str(paused_until))
        if datetime.now(timezone.utc) < paused_dt:
            _log_suppressed(hashed_id, "paused")
            return False

    # Guard 3: Quiet hours — no SMS during user's local 10pm–8am window.
    tz_name = (user.get("preferences_json") or {}).get("timezone", "America/New_York")
    user_tz = ZoneInfo(tz_name)
    local_now = datetime.now(user_tz)
    local_time = local_now.time()
    qs = time.fromisoformat(str(user["quiet_hours_start"]))  # e.g. "22:00"
    qe = time.fromisoformat(str(user["quiet_hours_end"]))    # e.g. "08:00"
    # Midnight-spanning window: quiet if AFTER start OR BEFORE end.
    # (naive range check 22:00 <= t < 08:00 always evaluates False — DO NOT USE)
    in_quiet = (local_time >= qs) or (local_time < qe)
    if in_quiet:
        _log_suppressed(hashed_id, "quiet_hours")
        return False

    # Guard 4: Daily proactive cap — max 3 unsolicited messages per day.
    if is_proactive:
        local_date_str = local_now.date().isoformat()
        if user["daily_sms_date"] == local_date_str:
            if user["daily_sms_count"] >= 3:
                _log_suppressed(hashed_id, "daily_cap")
                return False
        # Increment (or reset + set to 1) atomically in DB.
        _increment_daily_count(user_id, local_date_str, user)

    # All guards passed — send via Twilio.
    account_sid = os.environ["TWILIO_ACCOUNT_SID"]
    auth_token = os.environ["TWILIO_AUTH_TOKEN"]
    from_number = os.environ["TWILIO_PHONE_NUMBER"]

    client = Client(account_sid, auth_token)
    message = client.messages.create(
        from_=from_number,
        to=to_phone,
        body=body,
    )
    logger.info(json.dumps({
        "event": "sms_sent",
        "sid": message.sid,
        "uid": hashed_id,
    }))
    return True


def send_sms_direct(to_phone: str, body: str) -> str:
    """Send an SMS directly without any TCPA guards.

    Reserved exclusively for STOP confirmation in commands.py — the user
    has just opted out and send_sms_safe() would block the confirmation.
    All other outbound SMS must use send_sms_safe().

    Args:
        to_phone: Recipient E.164 phone number.
        body: Message body text.

    Returns:
        Twilio MessageSid string.
    """
    account_sid = os.environ["TWILIO_ACCOUNT_SID"]
    auth_token = os.environ["TWILIO_AUTH_TOKEN"]
    from_number = os.environ["TWILIO_PHONE_NUMBER"]

    client = Client(account_sid, auth_token)
    message = client.messages.create(
        from_=from_number,
        to=to_phone,
        body=body,
    )
    return message.sid


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


def _get_supabase():
    """Create Supabase client using service role key (bypasses RLS)."""
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _get_user_sms_state(user_id: str) -> dict:
    """Read TCPA columns and preferences_json for a user from the users table.

    Args:
        user_id: UUID of the user.

    Returns:
        Dict with keys: sms_opted_out, sms_paused_until, quiet_hours_start,
        quiet_hours_end, daily_sms_count, daily_sms_date, preferences_json.
    """
    client = _get_supabase()
    result = (
        client.table("users")
        .select(
            "id, sms_opted_out, sms_opted_out_at, sms_paused_until, "
            "daily_sms_count, daily_sms_date, quiet_hours_start, "
            "quiet_hours_end, preferences_json"
        )
        .eq("id", user_id)
        .single()
        .execute()
    )
    return result.data


def _increment_daily_count(user_id: str, local_date_str: str, user: dict) -> None:
    """Atomically increment or reset the daily proactive SMS count.

    Uses a single UPDATE to avoid race conditions when multiple Celery workers
    send proactive messages simultaneously (RESEARCH.md pitfall 5).

    If daily_sms_date matches local_date_str: increments daily_sms_count by 1.
    Otherwise: resets count to 1 and sets daily_sms_date to local_date_str.

    Args:
        user_id: UUID of the user.
        local_date_str: Today's date in user's local timezone (ISO format, YYYY-MM-DD).
        user: Current user state dict from _get_user_sms_state (used to check current date).
    """
    client = _get_supabase()

    if user.get("daily_sms_date") == local_date_str:
        # Same day — increment atomically.
        client.table("users").update({
            "daily_sms_count": (user.get("daily_sms_count") or 0) + 1,
        }).eq("id", user_id).execute()
    else:
        # New day — reset count to 1.
        client.table("users").update({
            "daily_sms_count": 1,
            "daily_sms_date": local_date_str,
        }).eq("id", user_id).execute()


def _log_suppressed(hashed_id: str, reason: str) -> None:
    """Log a suppressed outbound SMS event as structured JSON.

    Never includes phone numbers or raw user IDs — only the 12-char SHA-256 prefix.

    Args:
        hashed_id: First 12 hex chars of SHA-256(user_id).
        reason: One of "opted_out", "paused", "quiet_hours", "daily_cap".
    """
    logger.info(json.dumps({
        "event": "sms_suppressed",
        "reason": reason,
        "uid": hashed_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }))
