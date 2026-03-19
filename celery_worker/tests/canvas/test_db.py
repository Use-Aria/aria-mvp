"""Unit tests for celery_worker/canvas/db.py.

All tests mock _get_supabase() to avoid hitting a real Supabase instance.
"""
from unittest.mock import MagicMock, patch, call


def _make_mock_client():
    """Return a MagicMock that mimics the supabase-py client chain."""
    return MagicMock()


class TestGetAllCanvasIntegrations:
    def test_get_all_canvas_integrations(self):
        mock_client = _make_mock_client()
        mock_execute = MagicMock()
        mock_execute.data = [
            {"user_id": "user-1", "ical_url": "https://canvas.example.com/feeds/calendars/user_abc.ics"},
            {"user_id": "user-2", "ical_url": "https://canvas.example.com/feeds/calendars/user_def.ics"},
        ]

        # Build the chain: table().select().eq().not_.is_().execute()
        mock_not = MagicMock()
        mock_not.is_.return_value.execute.return_value = mock_execute
        mock_eq = MagicMock()
        mock_eq.not_ = mock_not
        mock_select = MagicMock()
        mock_select.eq.return_value = mock_eq
        mock_client.table.return_value.select.return_value = mock_select

        with patch("canvas.db._get_supabase", return_value=mock_client):
            from canvas.db import get_all_canvas_integrations
            result = get_all_canvas_integrations()

        # Verify table, select, eq("platform", "canvas"), not_.is_("ical_url", "null")
        mock_client.table.assert_called_once_with("integrations")
        mock_select.eq.assert_called_once_with("platform", "canvas")
        mock_not.is_.assert_called_once_with("ical_url", "null")
        assert result == mock_execute.data


class TestLoadCurrentDeadlines:
    def test_load_current_deadlines_keys_by_canvas_uid(self):
        mock_client = _make_mock_client()
        mock_execute = MagicMock()
        mock_execute.data = [
            {"canvas_uid": "uid-1", "title": "HW1", "due_date": "2026-03-20T23:59:59+00:00", "course": "CS101", "type": "assignment"},
            {"canvas_uid": "uid-2", "title": "Exam", "due_date": "2026-03-25T23:59:59+00:00", "course": "CS102", "type": "exam"},
        ]

        # Chain: table().select().eq(user_id).is_(deleted_at, null).execute()
        mock_is = MagicMock()
        mock_is.execute.return_value = mock_execute
        mock_eq = MagicMock()
        mock_eq.is_.return_value = mock_is
        mock_select = MagicMock()
        mock_select.eq.return_value = mock_eq
        mock_client.table.return_value.select.return_value = mock_select

        with patch("canvas.db._get_supabase", return_value=mock_client):
            from canvas.db import load_current_deadlines
            result = load_current_deadlines("user-1")

        # Verify .is_("deleted_at", "null") was called — filters active deadlines only
        mock_eq.is_.assert_called_once_with("deleted_at", "null")

        # Verify result is keyed by canvas_uid
        assert "uid-1" in result
        assert "uid-2" in result
        assert result["uid-1"]["title"] == "HW1"
        assert result["uid-2"]["type"] == "exam"


class TestApplyDiff:
    def test_apply_diff_upserts_added(self):
        mock_client = _make_mock_client()

        # Set up upsert chain: table().upsert(..., on_conflict=...).execute()
        mock_upsert_result = MagicMock()
        mock_upsert_result.execute.return_value = MagicMock()
        mock_client.table.return_value.upsert.return_value = mock_upsert_result

        # Set up update chain for removed (empty list in this test)
        mock_update_chain = MagicMock()
        mock_client.table.return_value.update.return_value = mock_update_chain

        diff = {
            "added": [
                {
                    "canvas_uid": "uid-new",
                    "title": "New Assignment",
                    "due_date": "2026-04-01T23:59:59+00:00",
                    "course": "CS101",
                    "type": "assignment",
                }
            ],
            "changed": [],
            "removed": [],
        }

        with patch("canvas.db._get_supabase", return_value=mock_client):
            from canvas.db import apply_diff
            apply_diff("user-1", diff)

        # Verify upsert was called with on_conflict="canvas_uid,user_id"
        mock_client.table.return_value.upsert.assert_called_once()
        call_kwargs = mock_client.table.return_value.upsert.call_args

        # on_conflict is a keyword arg
        assert call_kwargs.kwargs.get("on_conflict") == "canvas_uid,user_id"

        # Verify "deleted_at": None is set (clears prior soft-delete on re-add)
        upsert_data = call_kwargs.args[0]
        assert upsert_data["deleted_at"] is None
        assert upsert_data["canvas_uid"] == "uid-new"

    def test_apply_diff_soft_deletes_removed(self):
        mock_client = _make_mock_client()

        # Set up update chain: table().update({...}).eq(user_id).eq(canvas_uid).execute()
        mock_eq2 = MagicMock()
        mock_eq2.execute.return_value = MagicMock()
        mock_eq1 = MagicMock()
        mock_eq1.eq.return_value = mock_eq2
        mock_update = MagicMock()
        mock_update.eq.return_value = mock_eq1
        mock_client.table.return_value.update.return_value = mock_update

        # No upserts needed
        mock_client.table.return_value.upsert.return_value.execute.return_value = MagicMock()

        diff = {
            "added": [],
            "changed": [],
            "removed": ["uid-deleted"],
        }

        with patch("canvas.db._get_supabase", return_value=mock_client):
            from canvas.db import apply_diff
            apply_diff("user-1", diff)

        # Verify update was called with a dict containing deleted_at
        mock_client.table.return_value.update.assert_called_once()
        update_data = mock_client.table.return_value.update.call_args.args[0]
        assert "deleted_at" in update_data
        assert update_data["deleted_at"] is not None  # timestamp, not None

        # Verify .eq("user_id", "user-1") and .eq("canvas_uid", "uid-deleted")
        mock_update.eq.assert_called_once_with("user_id", "user-1")
        mock_eq1.eq.assert_called_once_with("canvas_uid", "uid-deleted")


class TestMarkSynced:
    def test_mark_synced_updates_integrations(self):
        mock_client = _make_mock_client()

        # Chain: table().update({...}).eq("user_id", ...).eq("platform", "canvas").execute()
        mock_eq2 = MagicMock()
        mock_eq2.execute.return_value = MagicMock()
        mock_eq1 = MagicMock()
        mock_eq1.eq.return_value = mock_eq2
        mock_update = MagicMock()
        mock_update.eq.return_value = mock_eq1
        mock_client.table.return_value.update.return_value = mock_update

        with patch("canvas.db._get_supabase", return_value=mock_client):
            from canvas.db import mark_synced
            mark_synced("user-1")

        # Verify update was called with synced_at key
        mock_client.table.return_value.update.assert_called_once()
        update_data = mock_client.table.return_value.update.call_args.args[0]
        assert "synced_at" in update_data

        # Verify .eq("platform", "canvas") was called
        mock_eq1.eq.assert_called_once_with("platform", "canvas")
