"""Unit tests for send_sms_safe() TCPA compliance guard.

Each test mocks _get_user_sms_state() to control DB state,
mocks the Twilio Client to capture calls, and mocks datetime.now
to control timezone-aware time for quiet-hours and daily-cap checks.

Phone numbers are never logged — only hashed user_id (uid).
"""
import json
import logging
import os
from datetime import datetime, timezone, timedelta, time
from unittest.mock import MagicMock, patch, call
import pytest

_TWILIO_ENV = {
    "TWILIO_ACCOUNT_SID": "ACtest123",
    "TWILIO_AUTH_TOKEN": "auth_token_test",
    "TWILIO_PHONE_NUMBER": "+15005550006",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _base_state(**overrides) -> dict:
    """Return a default user state that passes all guards."""
    state = {
        "sms_opted_out": False,
        "sms_paused_until": None,
        "quiet_hours_start": "22:00",
        "quiet_hours_end": "08:00",
        "daily_sms_count": 0,
        "daily_sms_date": None,
        "preferences_json": {"timezone": "America/New_York"},
    }
    state.update(overrides)
    return state


def _make_local_now(hour: int, minute: int = 0, date_str: str = "2026-03-19"):
    """Return a timezone-aware datetime in America/New_York at the given time."""
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("America/New_York")
    return datetime(2026, 3, 19, hour, minute, 0, tzinfo=tz)


# ---------------------------------------------------------------------------
# Test: happy path
# ---------------------------------------------------------------------------

@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._increment_daily_count")
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_send_happy_path(mock_client_cls, mock_get_state, mock_increment):
    """All guards pass: Twilio client.messages.create called with correct args, returns True."""
    from sms.send import send_sms_safe

    mock_get_state.return_value = _base_state()
    mock_message = MagicMock()
    mock_message.sid = "SM123"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    # Patch datetime.now so local time is 09:00 (not quiet hours), date is today
    local_now = _make_local_now(9)
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe(
            user_id="user-uuid-1234",
            to_phone="+12025551234",
            body="hello",
            is_proactive=True,
        )

    assert result is True
    mock_client_cls.return_value.messages.create.assert_called_once()
    call_kwargs = mock_client_cls.return_value.messages.create.call_args
    assert call_kwargs.kwargs["to"] == "+12025551234"
    assert call_kwargs.kwargs["body"] == "hello"
    assert "TWILIO_PHONE_NUMBER" in str(call_kwargs) or call_kwargs.kwargs.get("from_") is not None


# ---------------------------------------------------------------------------
# Test: opted out blocks
# ---------------------------------------------------------------------------

@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_opted_out_blocks(mock_client_cls, mock_get_state):
    """sms_opted_out=True: returns False, Twilio client never called."""
    from sms.send import send_sms_safe

    mock_get_state.return_value = _base_state(sms_opted_out=True)

    result = send_sms_safe("user-1", "+12025551234", "hello")

    assert result is False
    mock_client_cls.return_value.messages.create.assert_not_called()


# ---------------------------------------------------------------------------
# Test: paused blocks
# ---------------------------------------------------------------------------

@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_paused_blocks(mock_client_cls, mock_get_state):
    """sms_paused_until is in the future: returns False, Twilio not called."""
    from sms.send import send_sms_safe

    future = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()
    mock_get_state.return_value = _base_state(sms_paused_until=future)

    result = send_sms_safe("user-1", "+12025551234", "hello")

    assert result is False
    mock_client_cls.return_value.messages.create.assert_not_called()


# ---------------------------------------------------------------------------
# Test: paused with past timestamp allows
# ---------------------------------------------------------------------------

@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._increment_daily_count")
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_paused_expired_allows(mock_client_cls, mock_get_state, mock_increment):
    """sms_paused_until is in the past: pause expired, proceed to send."""
    from sms.send import send_sms_safe
    from zoneinfo import ZoneInfo

    # Fixed "now" in UTC for both computing past and for mock
    fixed_utc_now = datetime(2026, 3, 19, 14, 0, 0, tzinfo=timezone.utc)
    past = (fixed_utc_now - timedelta(hours=2)).isoformat()
    mock_get_state.return_value = _base_state(sms_paused_until=past)
    mock_message = MagicMock()
    mock_message.sid = "SM_expired"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    local_now = _make_local_now(9)  # 9am ET = 14:00 UTC

    def _mock_now(tz=None):
        if tz is timezone.utc:
            return fixed_utc_now
        return local_now

    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.side_effect = _mock_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-1", "+12025551234", "hello", is_proactive=True)

    assert result is True
    mock_client_cls.return_value.messages.create.assert_called_once()


# ---------------------------------------------------------------------------
# Test: quiet hours at 11pm
# ---------------------------------------------------------------------------

@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_quiet_hours_blocks_11pm(mock_client_cls, mock_get_state):
    """Local time 23:00 is within quiet window 22:00–08:00: returns False."""
    from sms.send import send_sms_safe

    mock_get_state.return_value = _base_state()

    local_now = _make_local_now(23)
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-1", "+12025551234", "hello")

    assert result is False
    mock_client_cls.return_value.messages.create.assert_not_called()


# ---------------------------------------------------------------------------
# Test: quiet hours at 3am (midnight-spanning)
# ---------------------------------------------------------------------------

@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_quiet_hours_blocks_3am(mock_client_cls, mock_get_state):
    """Local time 03:00 is within midnight-spanning quiet window: returns False."""
    from sms.send import send_sms_safe

    mock_get_state.return_value = _base_state()

    local_now = _make_local_now(3)
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-1", "+12025551234", "hello")

    assert result is False
    mock_client_cls.return_value.messages.create.assert_not_called()


# ---------------------------------------------------------------------------
# Test: allows 9am
# ---------------------------------------------------------------------------

@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._increment_daily_count")
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_quiet_hours_allows_9am(mock_client_cls, mock_get_state, mock_increment):
    """Local time 09:00 is outside quiet window: proceeds to send."""
    from sms.send import send_sms_safe

    mock_get_state.return_value = _base_state()
    mock_message = MagicMock()
    mock_message.sid = "SM_9am"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    local_now = _make_local_now(9)
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-1", "+12025551234", "hello", is_proactive=True)

    assert result is True
    mock_client_cls.return_value.messages.create.assert_called_once()


# ---------------------------------------------------------------------------
# Test: allows 9pm
# ---------------------------------------------------------------------------

@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._increment_daily_count")
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_quiet_hours_allows_9pm(mock_client_cls, mock_get_state, mock_increment):
    """Local time 21:00 is before quiet start (22:00): proceeds to send."""
    from sms.send import send_sms_safe

    mock_get_state.return_value = _base_state()
    mock_message = MagicMock()
    mock_message.sid = "SM_9pm"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    local_now = _make_local_now(21)
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-1", "+12025551234", "hello", is_proactive=True)

    assert result is True
    mock_client_cls.return_value.messages.create.assert_called_once()


# ---------------------------------------------------------------------------
# Test: daily cap blocks 4th proactive
# ---------------------------------------------------------------------------

@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_daily_cap_blocks_4th_proactive(mock_client_cls, mock_get_state):
    """daily_sms_count=3 and today's date matches: proactive send blocked."""
    from sms.send import send_sms_safe

    today_local = "2026-03-19"
    mock_get_state.return_value = _base_state(
        daily_sms_count=3,
        daily_sms_date=today_local,
    )

    local_now = _make_local_now(9)
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-1", "+12025551234", "hello", is_proactive=True)

    assert result is False
    mock_client_cls.return_value.messages.create.assert_not_called()


# ---------------------------------------------------------------------------
# Test: daily cap allows reply even at count 3
# ---------------------------------------------------------------------------

@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_daily_cap_allows_reply(mock_client_cls, mock_get_state):
    """daily_sms_count=3 but is_proactive=False: replies are uncapped, send proceeds."""
    from sms.send import send_sms_safe

    today_local = "2026-03-19"
    mock_get_state.return_value = _base_state(
        daily_sms_count=3,
        daily_sms_date=today_local,
    )
    mock_message = MagicMock()
    mock_message.sid = "SM_reply"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    local_now = _make_local_now(9)
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-1", "+12025551234", "hello", is_proactive=False)

    assert result is True
    mock_client_cls.return_value.messages.create.assert_called_once()


# ---------------------------------------------------------------------------
# Test: daily cap resets on new day
# ---------------------------------------------------------------------------

@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._increment_daily_count")
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_daily_cap_resets_new_day(mock_client_cls, mock_get_state, mock_increment):
    """daily_sms_date is yesterday: count is stale, send allowed."""
    from sms.send import send_sms_safe

    mock_get_state.return_value = _base_state(
        daily_sms_count=3,
        daily_sms_date="2026-03-18",  # yesterday
    )
    mock_message = MagicMock()
    mock_message.sid = "SM_new_day"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    local_now = _make_local_now(9)  # 2026-03-19 09:00
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-1", "+12025551234", "hello", is_proactive=True)

    assert result is True
    mock_client_cls.return_value.messages.create.assert_called_once()
    # _increment_daily_count should have been called with today's date
    mock_increment.assert_called_once()
    args = mock_increment.call_args[0]
    assert args[1] == "2026-03-19"


# ---------------------------------------------------------------------------
# Test: daily count incremented after successful proactive send
# ---------------------------------------------------------------------------

@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._increment_daily_count")
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_daily_count_incremented(mock_client_cls, mock_get_state, mock_increment):
    """After successful proactive send, _increment_daily_count called with local date."""
    from sms.send import send_sms_safe

    mock_get_state.return_value = _base_state(daily_sms_count=0, daily_sms_date=None)
    mock_message = MagicMock()
    mock_message.sid = "SM_incr"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    local_now = _make_local_now(9)
    with patch("sms.send.datetime") as mock_dt:
        mock_dt.now.return_value = local_now
        mock_dt.fromisoformat = datetime.fromisoformat
        result = send_sms_safe("user-2", "+12025559999", "briefing!", is_proactive=True)

    assert result is True
    mock_increment.assert_called_once()
    args = mock_increment.call_args[0]
    assert args[0] == "user-2"
    assert args[1] == "2026-03-19"


# ---------------------------------------------------------------------------
# Test: suppressed log for opted_out has correct JSON fields
# ---------------------------------------------------------------------------

@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_suppressed_log_opted_out(mock_client_cls, mock_get_state, caplog):
    """When blocked by opted_out, logger.info called with JSON event=sms_suppressed, reason=opted_out, uid=12-char hash."""
    from sms.send import send_sms_safe
    import hashlib

    user_id = "user-uuid-log-test"
    expected_uid = hashlib.sha256(user_id.encode()).hexdigest()[:12]

    mock_get_state.return_value = _base_state(sms_opted_out=True)

    with caplog.at_level(logging.INFO, logger="sms.send"):
        send_sms_safe(user_id, "+12025551234", "hello")

    # Find the suppressed log entry
    suppressed_logs = [r for r in caplog.records if "sms_suppressed" in r.getMessage()]
    assert len(suppressed_logs) >= 1

    log_data = json.loads(suppressed_logs[0].getMessage())
    assert log_data["event"] == "sms_suppressed"
    assert log_data["reason"] == "opted_out"
    assert log_data["uid"] == expected_uid
    assert "timestamp" in log_data


# ---------------------------------------------------------------------------
# Test: suppressed log never contains raw phone number or user_id
# ---------------------------------------------------------------------------

@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_suppressed_log_no_phone(mock_client_cls, mock_get_state, caplog):
    """Log output must never contain raw phone number or plain user_id."""
    from sms.send import send_sms_safe

    user_id = "user-pii-check-9999"
    phone = "+12025558888"

    mock_get_state.return_value = _base_state(sms_opted_out=True)

    with caplog.at_level(logging.INFO, logger="sms.send"):
        send_sms_safe(user_id, phone, "hello")

    log_text = " ".join(r.getMessage() for r in caplog.records)
    assert phone not in log_text, "Raw phone number found in log output"
    assert user_id not in log_text, "Raw user_id found in log output"


# ---------------------------------------------------------------------------
# Tests: send_sms_alert — bypasses quiet hours / cap, checks opt-out
# ---------------------------------------------------------------------------

@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_send_sms_alert_active_user(mock_client_cls, mock_get_state):
    """send_sms_alert returns True and calls Twilio for opted-in user."""
    from sms.send import send_sms_alert

    mock_get_state.return_value = _base_state()
    mock_message = MagicMock()
    mock_message.sid = "SM_alert_123"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    result = send_sms_alert("user-uuid-alert", "+12025551234", "URGENT: your assignment is due!")

    assert result is True
    mock_client_cls.return_value.messages.create.assert_called_once()
    call_kwargs = mock_client_cls.return_value.messages.create.call_args
    assert call_kwargs.kwargs.get("to") == "+12025551234"
    assert call_kwargs.kwargs.get("body") == "URGENT: your assignment is due!"


@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_send_sms_alert_opted_out(mock_client_cls, mock_get_state):
    """send_sms_alert returns False and does NOT call Twilio for opted-out user."""
    from sms.send import send_sms_alert

    mock_get_state.return_value = _base_state(sms_opted_out=True)

    result = send_sms_alert("user-uuid-optout", "+12025551234", "URGENT: due soon!")

    assert result is False
    mock_client_cls.return_value.messages.create.assert_not_called()


@patch.dict(os.environ, _TWILIO_ENV)
@patch("sms.send._get_user_sms_state")
@patch("sms.send.Client")
def test_alert_bypasses_guards(mock_client_cls, mock_get_state):
    """send_sms_alert ignores quiet hours, pause, and daily cap — sends anyway."""
    from sms.send import send_sms_alert
    from datetime import timedelta

    # User has pause active, is in quiet hours, and has hit daily cap —
    # send_sms_alert should still send because it bypasses all these guards.
    future_pause = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()
    mock_get_state.return_value = _base_state(
        sms_paused_until=future_pause,
        quiet_hours_start="22:00",
        quiet_hours_end="08:00",
        daily_sms_count=3,
        daily_sms_date="2026-03-19",
    )
    mock_message = MagicMock()
    mock_message.sid = "SM_bypass_test"
    mock_client_cls.return_value.messages.create.return_value = mock_message

    result = send_sms_alert("user-uuid-bypass", "+12025551234", "URGENT: overdue exam!")

    assert result is True
    mock_client_cls.return_value.messages.create.assert_called_once()
