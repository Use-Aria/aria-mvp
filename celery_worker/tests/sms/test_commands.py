"""Unit tests for celery_worker/sms/commands.py.

All tests mock:
- sms.commands._get_supabase — avoid real DB calls
- sms.commands.send_sms_direct — capture STOP confirmation calls
- sms.commands.send_sms_safe — capture START/PAUSE/HELP calls
- datetime.now — freeze time for PAUSE timestamp verification
"""
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch, call
import pytest

# Pre-import so patch("sms.commands.*") can resolve the module via sys.modules
import sms.commands  # noqa: F401


FROZEN_NOW = datetime(2026, 3, 19, 12, 0, 0, tzinfo=timezone.utc)
FROZEN_PAUSED_UNTIL = FROZEN_NOW + timedelta(hours=24)

USER_ID = "user-abc-123"
PHONE = "+15555550100"


def _make_mock_supabase():
    """Return a MagicMock mimicking supabase-py client update chain."""
    mock = MagicMock()
    # table().update().eq().execute() — universal chain
    mock.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock()
    return mock


# ---------------------------------------------------------------------------
# STOP tests
# ---------------------------------------------------------------------------

class TestStopCommand:
    def test_stop_sets_opted_out(self):
        """STOP updates sms_opted_out=True and sms_opted_out_at on users table."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe") as mock_safe,
        ):
            from sms.commands import dispatch_command
            dispatch_command("STOP", USER_ID, PHONE)

        update_call = mock_sb.table.return_value.update.call_args
        data = update_call.args[0]
        assert data["sms_opted_out"] is True
        assert data["sms_opted_out_at"] is not None

    def test_stop_sends_confirmation_direct(self):
        """STOP calls send_sms_direct (not send_sms_safe) with correct body."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe") as mock_safe,
        ):
            from sms.commands import dispatch_command
            dispatch_command("STOP", USER_ID, PHONE)

        mock_direct.assert_called_once()
        args = mock_direct.call_args.args
        assert args[0] == PHONE
        body = args[1]
        assert "unsubscribed" in body.lower()
        assert "START" in body
        # Must NOT use send_sms_safe for STOP confirmation
        mock_safe.assert_not_called()

    def test_stop_returns_true(self):
        """dispatch_command returns True for STOP."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct"),
            patch("sms.commands.send_sms_safe"),
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("STOP", USER_ID, PHONE)

        assert result is True


# ---------------------------------------------------------------------------
# START tests
# ---------------------------------------------------------------------------

class TestStartCommand:
    def test_start_clears_opted_out(self):
        """START updates sms_opted_out=False and sms_opted_out_at=None."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct"),
            patch("sms.commands.send_sms_safe"),
        ):
            from sms.commands import dispatch_command
            dispatch_command("START", USER_ID, PHONE)

        update_call = mock_sb.table.return_value.update.call_args
        data = update_call.args[0]
        assert data["sms_opted_out"] is False
        assert data["sms_opted_out_at"] is None

    def test_start_sends_confirmation(self):
        """START calls send_sms_safe with is_proactive=False and 'Welcome back'."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe") as mock_safe,
        ):
            from sms.commands import dispatch_command
            dispatch_command("START", USER_ID, PHONE)

        mock_safe.assert_called_once()
        kwargs = mock_safe.call_args
        assert kwargs.kwargs.get("is_proactive") is False or (
            len(kwargs.args) >= 4 and kwargs.args[3] is False
        )
        body = kwargs.args[2]
        assert "welcome back" in body.lower()
        mock_direct.assert_not_called()

    def test_start_returns_true(self):
        """dispatch_command returns True for START."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct"),
            patch("sms.commands.send_sms_safe"),
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("START", USER_ID, PHONE)

        assert result is True


# ---------------------------------------------------------------------------
# PAUSE tests
# ---------------------------------------------------------------------------

class TestPauseCommand:
    def test_pause_sets_paused_until(self):
        """PAUSE sets sms_paused_until to approximately now + 24 hours."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct"),
            patch("sms.commands.send_sms_safe"),
            patch("sms.commands.datetime") as mock_dt,
        ):
            mock_dt.now.return_value = FROZEN_NOW
            mock_dt.side_effect = lambda *a, **k: datetime(*a, **k)
            from sms.commands import dispatch_command
            dispatch_command("PAUSE", USER_ID, PHONE)

        update_call = mock_sb.table.return_value.update.call_args
        data = update_call.args[0]
        assert "sms_paused_until" in data
        assert data["sms_paused_until"] is not None
        # Verify it's the frozen time + 24h isoformat
        assert FROZEN_PAUSED_UNTIL.isoformat() in data["sms_paused_until"]

    def test_pause_sends_confirmation(self):
        """PAUSE sends confirmation SMS mentioning '24 hours'."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe") as mock_safe,
            patch("sms.commands.datetime") as mock_dt,
        ):
            mock_dt.now.return_value = FROZEN_NOW
            mock_dt.side_effect = lambda *a, **k: datetime(*a, **k)
            from sms.commands import dispatch_command
            dispatch_command("PAUSE", USER_ID, PHONE)

        mock_safe.assert_called_once()
        body = mock_safe.call_args.args[2]
        assert "24 hours" in body

    def test_pause_returns_true(self):
        """dispatch_command returns True for PAUSE."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct"),
            patch("sms.commands.send_sms_safe"),
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("PAUSE", USER_ID, PHONE)

        assert result is True


# ---------------------------------------------------------------------------
# HELP tests
# ---------------------------------------------------------------------------

class TestHelpCommand:
    def test_help_sends_command_list(self):
        """HELP sends SMS listing STOP, START, PAUSE, HELP keywords."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe") as mock_safe,
        ):
            from sms.commands import dispatch_command
            dispatch_command("HELP", USER_ID, PHONE)

        mock_safe.assert_called_once()
        body = mock_safe.call_args.args[2]
        assert "STOP" in body
        assert "START" in body
        assert "PAUSE" in body
        assert "HELP" in body
        mock_direct.assert_not_called()

    def test_help_returns_true(self):
        """dispatch_command returns True for HELP."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct"),
            patch("sms.commands.send_sms_safe"),
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("HELP", USER_ID, PHONE)

        assert result is True


# ---------------------------------------------------------------------------
# Normalization tests (case-insensitive, trimmed)
# ---------------------------------------------------------------------------

class TestNormalization:
    def test_case_insensitive_lower(self):
        """dispatch_command('stop', ...) dispatches as STOP."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe"),
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("stop", USER_ID, PHONE)

        assert result is True
        mock_direct.assert_called_once()  # STOP uses send_sms_direct

    def test_case_insensitive_mixed(self):
        """dispatch_command('Stop', ...) dispatches as STOP."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe"),
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("Stop", USER_ID, PHONE)

        assert result is True
        mock_direct.assert_called_once()

    def test_trimmed_whitespace(self):
        """dispatch_command('  STOP  ', ...) dispatches correctly after trim."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe"),
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("  STOP  ", USER_ID, PHONE)

        assert result is True
        mock_direct.assert_called_once()


# ---------------------------------------------------------------------------
# Unknown / empty body tests
# ---------------------------------------------------------------------------

class TestUnknownCommands:
    def test_unknown_returns_false(self):
        """dispatch_command with non-command body returns False."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe") as mock_safe,
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("hello there", USER_ID, PHONE)

        assert result is False
        mock_direct.assert_not_called()
        mock_safe.assert_not_called()

    def test_empty_returns_false(self):
        """dispatch_command with empty body returns False."""
        mock_sb = _make_mock_supabase()
        with (
            patch("sms.commands._get_supabase", return_value=mock_sb),
            patch("sms.commands.send_sms_direct") as mock_direct,
            patch("sms.commands.send_sms_safe") as mock_safe,
        ):
            from sms.commands import dispatch_command
            result = dispatch_command("", USER_ID, PHONE)

        assert result is False
        mock_direct.assert_not_called()
        mock_safe.assert_not_called()
