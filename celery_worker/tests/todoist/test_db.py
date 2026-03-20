"""Unit tests for celery_worker/todoist/db.py.

All tests mock _get_supabase() to avoid hitting a real Supabase instance.
"""
from unittest.mock import MagicMock, patch


def _make_mock_client():
    """Return a MagicMock that mimics the supabase-py client chain."""
    return MagicMock()


class TestGetAllTodoistIntegrations:
    def test_get_all_todoist_integrations_queries_platform_todoist(self):
        """Query integrations table filtering by platform='todoist'."""
        mock_client = _make_mock_client()
        mock_execute = MagicMock()
        mock_execute.data = [
            {"user_id": "user-1"},
            {"user_id": "user-2"},
        ]

        # Chain: table().select().eq("platform", "todoist").not_.is_(...).execute()
        mock_not = MagicMock()
        mock_not.is_.return_value.execute.return_value = mock_execute
        mock_eq = MagicMock()
        mock_eq.not_ = mock_not
        mock_select = MagicMock()
        mock_select.eq.return_value = mock_eq
        mock_client.table.return_value.select.return_value = mock_select

        with patch("todoist.db._get_supabase", return_value=mock_client):
            from todoist.db import get_all_todoist_integrations
            result = get_all_todoist_integrations()

        mock_client.table.assert_called_once_with("integrations")
        mock_select.eq.assert_called_once_with("platform", "todoist")
        assert result == mock_execute.data


class TestGetTodoistToken:
    def test_get_todoist_token_returns_access_token(self):
        """Returns access_token string for the user's todoist integration."""
        mock_client = _make_mock_client()
        mock_execute = MagicMock()
        mock_execute.data = [{"access_token": "tok123"}]

        # Chain: table().select().eq(user_id).eq(platform).execute()
        mock_eq2 = MagicMock()
        mock_eq2.execute.return_value = mock_execute
        mock_eq1 = MagicMock()
        mock_eq1.eq.return_value = mock_eq2
        mock_select = MagicMock()
        mock_select.eq.return_value = mock_eq1
        mock_client.table.return_value.select.return_value = mock_select

        with patch("todoist.db._get_supabase", return_value=mock_client):
            from todoist.db import get_todoist_token
            result = get_todoist_token("user-1")

        assert result == "tok123"
        mock_eq1.eq.assert_called_once_with("platform", "todoist")


class TestMarkSynced:
    def test_mark_synced_updates_synced_at(self):
        """Updates integrations.synced_at with platform='todoist' filter."""
        mock_client = _make_mock_client()

        # Chain: table().update({...}).eq("user_id", ...).eq("platform", "todoist").execute()
        mock_eq2 = MagicMock()
        mock_eq2.execute.return_value = MagicMock()
        mock_eq1 = MagicMock()
        mock_eq1.eq.return_value = mock_eq2
        mock_update = MagicMock()
        mock_update.eq.return_value = mock_eq1
        mock_client.table.return_value.update.return_value = mock_update

        with patch("todoist.db._get_supabase", return_value=mock_client):
            from todoist.db import mark_synced
            mark_synced("user-1")

        # Verify update was called with synced_at key
        mock_client.table.return_value.update.assert_called_once()
        update_data = mock_client.table.return_value.update.call_args.args[0]
        assert "synced_at" in update_data

        # Verify .eq("platform", "todoist") was called
        mock_eq1.eq.assert_called_once_with("platform", "todoist")


class TestMarkIntegrationRevoked:
    def test_mark_integration_revoked_deletes_token(self):
        """Sets access_token to None for user's todoist integration."""
        mock_client = _make_mock_client()

        # Chain: table().update({...}).eq("user_id", ...).eq("platform", "todoist").execute()
        mock_eq2 = MagicMock()
        mock_eq2.execute.return_value = MagicMock()
        mock_eq1 = MagicMock()
        mock_eq1.eq.return_value = mock_eq2
        mock_update = MagicMock()
        mock_update.eq.return_value = mock_eq1
        mock_client.table.return_value.update.return_value = mock_update

        with patch("todoist.db._get_supabase", return_value=mock_client):
            from todoist.db import mark_integration_revoked
            mark_integration_revoked("user-1")

        # Verify update was called with access_token=None
        mock_client.table.return_value.update.assert_called_once()
        update_data = mock_client.table.return_value.update.call_args.args[0]
        assert update_data.get("access_token") is None

        # Verify .eq("platform", "todoist") was called
        mock_eq1.eq.assert_called_once_with("platform", "todoist")
