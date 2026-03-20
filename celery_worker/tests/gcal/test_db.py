"""Tests for gcal.db — calendar_events CRUD and watch channel state.

All Supabase calls are mocked via ai.db._get_supabase (the actual source
of the function used inside each gcal.db function body via lazy import).
"""
from unittest.mock import MagicMock, patch, call
import pytest

# Pre-import to ensure module is loaded before patching
import gcal.db


def _make_table_mock():
    """Return a mock for the table chain: .table().select/update/upsert()...execute()."""
    table_mock = MagicMock()
    table_mock.upsert.return_value = table_mock
    table_mock.update.return_value = table_mock
    table_mock.select.return_value = table_mock
    table_mock.eq.return_value = table_mock
    table_mock.gte.return_value = table_mock
    table_mock.lte.return_value = table_mock
    table_mock.order.return_value = table_mock
    table_mock.execute.return_value = MagicMock(data=[])
    return table_mock


def _make_supabase_mock():
    """Return a mock Supabase client with chainable query methods."""
    client = MagicMock()
    table_mock = _make_table_mock()
    client.table.return_value = table_mock
    return client


# --- Tests for store_calendar_events ---

@patch("ai.db._get_supabase")
def test_store_calendar_events_upserts(mock_get_supabase):
    """store_calendar_events calls upsert for each event and returns count."""
    from gcal.db import store_calendar_events

    client = _make_supabase_mock()
    mock_get_supabase.return_value = client

    events = [
        {"google_event_id": "evt1", "title": "Lecture", "start_time": "2026-03-21T10:00:00Z",
         "end_time": "2026-03-21T11:00:00Z", "type": "class"},
        {"google_event_id": "evt2", "title": "Study", "start_time": "2026-03-22T14:00:00Z",
         "end_time": "2026-03-22T16:00:00Z", "type": "study"},
    ]
    count = store_calendar_events("user-123", events)

    assert count == 2
    assert client.table.called
    # Both calls go to calendar_events table
    for call_args in client.table.call_args_list:
        assert call_args[0][0] == "calendar_events"


@patch("ai.db._get_supabase")
def test_store_calendar_events_includes_user_id(mock_get_supabase):
    """store_calendar_events includes user_id and google_event_id in upsert payload."""
    from gcal.db import store_calendar_events

    client = _make_supabase_mock()
    mock_get_supabase.return_value = client

    events = [
        {"google_event_id": "evt-abc", "title": "Meeting",
         "start_time": "2026-03-21T09:00:00Z", "end_time": "2026-03-21T10:00:00Z", "type": "personal"},
    ]
    store_calendar_events("user-xyz", events)

    upsert_call = client.table.return_value.upsert.call_args
    payload = upsert_call[0][0]
    assert payload["user_id"] == "user-xyz"
    assert payload["google_event_id"] == "evt-abc"


@patch("ai.db._get_supabase")
def test_store_calendar_events_empty_list(mock_get_supabase):
    """store_calendar_events with empty list returns 0 without calling upsert."""
    from gcal.db import store_calendar_events

    client = _make_supabase_mock()
    mock_get_supabase.return_value = client

    count = store_calendar_events("user-123", [])
    assert count == 0
    client.table.return_value.upsert.assert_not_called()


# --- Tests for get_calendar_events ---

@patch("ai.db._get_supabase")
def test_get_calendar_events_queries_date_range(mock_get_supabase):
    """get_calendar_events queries calendar_events with date range filters."""
    from gcal.db import get_calendar_events

    client = _make_supabase_mock()
    expected_data = [
        {"id": "row1", "google_event_id": "evt1", "title": "Lecture",
         "start_time": "2026-03-21T10:00:00Z", "end_time": "2026-03-21T11:00:00Z", "type": "class"},
    ]
    # The chain: .table().select().eq().gte().lte().order().execute()
    # All return table_mock, and execute returns data
    client.table.return_value.select.return_value.eq.return_value.gte.return_value.lte.return_value.order.return_value.execute.return_value = MagicMock(data=expected_data)
    mock_get_supabase.return_value = client

    result = get_calendar_events("user-123", "2026-03-20", "2026-03-27")
    assert result == expected_data


# --- Tests for store_watch_channel ---

@patch("ai.db._get_supabase")
def test_store_watch_channel_writes_to_integrations(mock_get_supabase):
    """store_watch_channel writes channel_id, resource_id, watch_expires_at to integrations."""
    from gcal.db import store_watch_channel

    client = _make_supabase_mock()
    mock_get_supabase.return_value = client

    # 1000000000000 ms = 2001-09-09T01:46:40Z
    store_watch_channel("user-123", "chan-abc", "res-xyz", 1000000000000)

    # Check update was called on integrations table
    assert client.table.call_args_list[0][0][0] == "integrations"
    update_call = client.table.return_value.update.call_args
    payload = update_call[0][0]
    assert payload["channel_id"] == "chan-abc"
    assert payload["resource_id"] == "res-xyz"
    assert "watch_expires_at" in payload


# --- Tests for get_watch_channel ---

@patch("ai.db._get_supabase")
def test_get_watch_channel_returns_dict_when_exists(mock_get_supabase):
    """get_watch_channel returns dict with channel state when channel_id is set."""
    from gcal.db import get_watch_channel

    client = _make_supabase_mock()
    channel_data = {"channel_id": "chan-abc", "resource_id": "res-xyz", "watch_expires_at": "2026-03-27T00:00:00Z"}
    # Chain: .table().select().eq().eq().execute()
    client.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock(data=[channel_data])
    mock_get_supabase.return_value = client

    result = get_watch_channel("user-123")
    assert result is not None
    assert result["channel_id"] == "chan-abc"
    assert result["resource_id"] == "res-xyz"


@patch("ai.db._get_supabase")
def test_get_watch_channel_returns_none_when_no_channel(mock_get_supabase):
    """get_watch_channel returns None when no channel_id in integrations."""
    from gcal.db import get_watch_channel

    client = _make_supabase_mock()
    client.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[{"channel_id": None, "resource_id": None, "watch_expires_at": None}]
    )
    mock_get_supabase.return_value = client

    result = get_watch_channel("user-123")
    assert result is None


@patch("ai.db._get_supabase")
def test_get_watch_channel_returns_none_when_empty_result(mock_get_supabase):
    """get_watch_channel returns None when no Google integration row exists."""
    from gcal.db import get_watch_channel

    client = _make_supabase_mock()
    client.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = MagicMock(data=[])
    mock_get_supabase.return_value = client

    result = get_watch_channel("user-123")
    assert result is None
