"""Tests for process_inbound_sms Celery task."""
import pytest
from unittest.mock import patch


def test_process_inbound_sms_dispatches_stop():
    """STOP command is dispatched to command handler."""
    with patch("sms.commands.dispatch_command", return_value=True) as mock_dispatch, \
         patch("sms.send._get_user_sms_state", return_value={"phone": "+15551234567"}):
        from tasks import process_inbound_sms
        result = process_inbound_sms("SM123", "STOP", "user-uuid-123")
        assert result["command_dispatched"] is True
        mock_dispatch.assert_called_once_with("STOP", "user-uuid-123", "+15551234567")


def test_process_inbound_sms_non_command_stubs():
    """Non-command messages return dispatched=False (Phase 4 stub)."""
    with patch("sms.commands.dispatch_command", return_value=False) as mock_dispatch, \
         patch("sms.send._get_user_sms_state", return_value={"phone": "+15551234567"}):
        from tasks import process_inbound_sms
        result = process_inbound_sms("SM456", "what's due tomorrow?", "user-uuid-456")
        assert result["command_dispatched"] is False
        mock_dispatch.assert_called_once_with(
            "what's due tomorrow?", "user-uuid-456", "+15551234567"
        )


def test_process_inbound_sms_no_phone():
    """User with no phone number returns error without dispatching."""
    with patch("sms.send._get_user_sms_state", return_value={"phone": ""}):
        from tasks import process_inbound_sms
        result = process_inbound_sms("SM789", "HELP", "user-uuid-789")
        assert result.get("error") == "no_phone"
        assert result["command_dispatched"] is False
