"""Tests for todoist.sync — sync orchestrator.

Tests verify:
- ingest_canonical_event called for each parsed task with correct args
- mark_synced called after ingest loop
- 403 HTTPError marks integration revoked and stops (no ingest calls)
- course_id is always None for Todoist tasks
"""
import sys
import types
import requests
from unittest.mock import patch, MagicMock, call


def _make_http_error(status_code: int) -> requests.HTTPError:
    """Build a requests.HTTPError with a mock response."""
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    err = requests.HTTPError(response=mock_resp)
    return err


def _stub_priority_ingest(mock_ingest_fn):
    """Inject a stub priority.ingest module so lazy import in sync.py resolves."""
    mock_module = types.ModuleType("priority.ingest")
    mock_module.ingest_canonical_event = mock_ingest_fn
    # Also ensure priority package is stubbed
    if "priority" not in sys.modules:
        mock_pkg = types.ModuleType("priority")
        sys.modules["priority"] = mock_pkg
    sys.modules["priority.ingest"] = mock_module
    return mock_module


class TestSyncTodoistUser:
    def test_sync_todoist_user_calls_ingest_for_each_task(self):
        """ingest_canonical_event called N times with source='todoist', grade_weight=0.0."""
        parsed_tasks = [
            {"title": "Task A", "due_date": "2026-04-01T23:59:59Z", "todoist_id": "1", "priority_label": "normal"},
            {"title": "Task B", "due_date": "2026-04-05T10:00:00Z", "todoist_id": "2", "priority_label": "high"},
        ]
        mock_ingest = MagicMock()
        _stub_priority_ingest(mock_ingest)

        with patch("todoist.db.get_todoist_token", return_value="tok123"), \
             patch("todoist.fetch.get_active_tasks", return_value=[{"raw": "data"}]), \
             patch("todoist.parse.parse_tasks", return_value=parsed_tasks), \
             patch("todoist.db.mark_synced"), \
             patch("todoist.db.mark_integration_revoked"):
            # Force reimport to pick up fresh patches
            if "todoist.sync" in sys.modules:
                del sys.modules["todoist.sync"]
            from todoist.sync import sync_todoist_user
            sync_todoist_user("user-abc")

        assert mock_ingest.call_count == 2
        for c in mock_ingest.call_args_list:
            assert c.kwargs.get("source") == "todoist"
            assert c.kwargs.get("grade_weight") == 0.0
            assert c.kwargs.get("event_type") == "task"

    def test_sync_todoist_user_calls_mark_synced(self):
        """mark_synced called once after the ingest loop completes."""
        parsed_tasks = [
            {"title": "Task A", "due_date": "2026-04-01T23:59:59Z", "todoist_id": "1", "priority_label": "normal"},
        ]
        mock_ingest = MagicMock()
        _stub_priority_ingest(mock_ingest)

        with patch("todoist.db.get_todoist_token", return_value="tok123"), \
             patch("todoist.fetch.get_active_tasks", return_value=[]), \
             patch("todoist.parse.parse_tasks", return_value=parsed_tasks), \
             patch("todoist.db.mark_synced") as mock_mark_synced, \
             patch("todoist.db.mark_integration_revoked"):
            if "todoist.sync" in sys.modules:
                del sys.modules["todoist.sync"]
            from todoist.sync import sync_todoist_user
            sync_todoist_user("user-abc")

        mock_mark_synced.assert_called_once_with("user-abc")

    def test_sync_todoist_user_403_marks_revoked(self):
        """403 HTTPError marks integration revoked — no ingest calls made."""
        mock_ingest = MagicMock()
        _stub_priority_ingest(mock_ingest)

        with patch("todoist.db.get_todoist_token", return_value="tok123"), \
             patch("todoist.fetch.get_active_tasks", side_effect=_make_http_error(403)), \
             patch("todoist.db.mark_synced"), \
             patch("todoist.db.mark_integration_revoked") as mock_revoke:
            if "todoist.sync" in sys.modules:
                del sys.modules["todoist.sync"]
            from todoist.sync import sync_todoist_user
            result = sync_todoist_user("user-abc")

        mock_revoke.assert_called_once_with("user-abc")
        mock_ingest.assert_not_called()
        assert result["status"] == "token_revoked"

    def test_sync_todoist_user_passes_course_id_none(self):
        """ingest_canonical_event always called with course_id=None for Todoist."""
        parsed_tasks = [
            {"title": "Task A", "due_date": "2026-04-01T23:59:59Z", "todoist_id": "1", "priority_label": "normal"},
        ]
        mock_ingest = MagicMock()
        _stub_priority_ingest(mock_ingest)

        with patch("todoist.db.get_todoist_token", return_value="tok123"), \
             patch("todoist.fetch.get_active_tasks", return_value=[]), \
             patch("todoist.parse.parse_tasks", return_value=parsed_tasks), \
             patch("todoist.db.mark_synced"), \
             patch("todoist.db.mark_integration_revoked"):
            if "todoist.sync" in sys.modules:
                del sys.modules["todoist.sync"]
            from todoist.sync import sync_todoist_user
            sync_todoist_user("user-abc")

        assert mock_ingest.call_count == 1
        assert mock_ingest.call_args.kwargs.get("course_id") is None
