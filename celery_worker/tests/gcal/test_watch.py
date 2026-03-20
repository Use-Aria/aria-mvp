"""Tests for gcal.watch — push notification watch lifecycle.

Tests cover: establish_watch, stop_watch, renew_watch including
graceful failure on stop during renewal.
"""
from unittest.mock import MagicMock, patch, call
import pytest

# Pre-import to ensure modules are loadable
import gcal.db
import gcal.auth


def _make_watch_response(channel_id="chan-test", resource_id="res-test", expiration=9999999999000):
    """Build a mock GCal events.watch() response dict."""
    return {
        "id": channel_id,
        "resourceId": resource_id,
        "expiration": expiration,
        "kind": "api#channel",
    }


def _make_service():
    """Return a mock GCal service."""
    service = MagicMock()
    service.events().watch().execute.return_value = _make_watch_response()
    service.channels().stop().execute.return_value = {}
    return service


# --- Tests for establish_watch ---

@patch.dict("os.environ", {"APP_BASE_URL": "https://aria.example.com"})
@patch("gcal.db.store_watch_channel")
@patch("gcal.auth.build_gcal_service")
def test_establish_watch_calls_events_watch(mock_build, mock_store):
    """establish_watch calls events().watch() with correct body structure."""
    from gcal.watch import establish_watch

    service = _make_service()
    mock_build.return_value = service

    result = establish_watch("user-123")

    # Verify watch was called
    assert service.events.return_value.watch.called
    watch_call_kwargs = service.events.return_value.watch.call_args[1]
    assert watch_call_kwargs.get("calendarId") == "primary"

    # Verify body has required fields
    body = watch_call_kwargs.get("body", {})
    assert "id" in body
    assert body["type"] == "web_hook"
    assert "address" in body
    assert body["token"] == "user-123"  # user_id used as token


@patch.dict("os.environ", {"APP_BASE_URL": "https://aria.example.com"})
@patch("gcal.db.store_watch_channel")
@patch("gcal.auth.build_gcal_service")
def test_establish_watch_stores_channel_state(mock_build, mock_store):
    """establish_watch calls store_watch_channel with channel data from response."""
    from gcal.watch import establish_watch

    service = _make_service()
    response = _make_watch_response(channel_id="chan-abc", resource_id="res-xyz", expiration=9999000000000)
    service.events().watch().execute.return_value = response
    mock_build.return_value = service

    establish_watch("user-123")

    mock_store.assert_called_once_with("user-123", "chan-abc", "res-xyz", 9999000000000)


@patch.dict("os.environ", {"APP_BASE_URL": "https://aria.example.com"})
@patch("gcal.db.store_watch_channel")
@patch("gcal.auth.build_gcal_service")
def test_establish_watch_returns_result(mock_build, mock_store):
    """establish_watch returns the watch response dict."""
    from gcal.watch import establish_watch

    service = _make_service()
    response = _make_watch_response()
    service.events().watch().execute.return_value = response
    mock_build.return_value = service

    result = establish_watch("user-123")
    assert result["id"] == response["id"]
    assert result["resourceId"] == response["resourceId"]


# --- Tests for stop_watch ---

@patch("gcal.auth.build_gcal_service")
def test_stop_watch_calls_channels_stop(mock_build):
    """stop_watch calls channels().stop() with correct body."""
    from gcal.watch import stop_watch

    service = _make_service()
    mock_build.return_value = service

    stop_watch("user-123", "chan-abc", "res-xyz")

    assert service.channels.return_value.stop.called
    stop_call_kwargs = service.channels.return_value.stop.call_args[1]
    body = stop_call_kwargs.get("body", {})
    assert body["id"] == "chan-abc"
    assert body["resourceId"] == "res-xyz"


# --- Tests for renew_watch ---

@patch("gcal.watch.establish_watch")
@patch("gcal.watch.stop_watch")
@patch("gcal.db.get_watch_channel")
def test_renew_watch_stops_old_then_establishes_new(mock_get_channel, mock_stop, mock_establish):
    """renew_watch stops old channel before establishing new one."""
    from gcal.watch import renew_watch

    mock_get_channel.return_value = {
        "channel_id": "old-chan",
        "resource_id": "old-res",
        "watch_expires_at": "2026-03-25T00:00:00Z",
    }
    mock_establish.return_value = _make_watch_response(channel_id="new-chan")

    result = renew_watch("user-123")

    mock_stop.assert_called_once_with("user-123", "old-chan", "old-res")
    mock_establish.assert_called_once_with("user-123")
    assert result["id"] == "new-chan"


@patch("gcal.watch.establish_watch")
@patch("gcal.watch.stop_watch")
@patch("gcal.db.get_watch_channel")
def test_renew_watch_handles_stop_failure_gracefully(mock_get_channel, mock_stop, mock_establish):
    """renew_watch logs warning and continues if stop_watch raises an exception."""
    from gcal.watch import renew_watch

    mock_get_channel.return_value = {
        "channel_id": "old-chan",
        "resource_id": "old-res",
        "watch_expires_at": "2026-03-25T00:00:00Z",
    }
    mock_stop.side_effect = Exception("Channel already expired")
    mock_establish.return_value = _make_watch_response(channel_id="new-chan")

    # Should not raise — logs warning and proceeds
    result = renew_watch("user-123")

    mock_establish.assert_called_once_with("user-123")
    assert result is not None


@patch("gcal.watch.establish_watch")
@patch("gcal.watch.stop_watch")
@patch("gcal.db.get_watch_channel")
def test_renew_watch_when_no_existing_channel(mock_get_channel, mock_stop, mock_establish):
    """renew_watch skips stop if no existing channel and establishes new one."""
    from gcal.watch import renew_watch

    mock_get_channel.return_value = None
    mock_establish.return_value = _make_watch_response(channel_id="new-chan")

    result = renew_watch("user-123")

    mock_stop.assert_not_called()
    mock_establish.assert_called_once_with("user-123")
