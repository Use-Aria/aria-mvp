"""Tests for gmail.watch — Gmail Pub/Sub watch channel lifecycle.

Tests cover: establish_gmail_watch (success, missing topic, historyId storage),
and renew_gmail_watch (delegates to establish).
"""
from unittest.mock import MagicMock, patch, call
import pytest

# Pre-import modules under test so patch targets resolve correctly
import gmail.watch
import gmail.auth
import gmail.fetch


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_watch_response(history_id="98765", expiration=9999999999000):
    """Build a mock Gmail users.watch() response dict."""
    return {
        "historyId": history_id,
        "expiration": expiration,
    }


def _make_gmail_service(watch_response=None):
    """Return a mock Gmail service with users().watch() configured."""
    service = MagicMock()
    if watch_response is None:
        watch_response = _make_watch_response()
    service.users().watch().execute.return_value = watch_response
    return service


# ---------------------------------------------------------------------------
# Tests for establish_gmail_watch
# ---------------------------------------------------------------------------

@patch.dict("os.environ", {"GMAIL_PUBSUB_TOPIC": "projects/aria/topics/gmail-notifications"})
@patch("ai.db._get_supabase")
@patch("gmail.fetch.update_history_id")
@patch("gmail.auth.build_gmail_service")
def test_establish_watch_calls_users_watch_with_correct_topic(mock_build, mock_update_history, mock_supabase):
    """establish_gmail_watch calls users().watch() with the configured Pub/Sub topic."""
    from gmail.watch import establish_gmail_watch

    service = _make_gmail_service()
    mock_build.return_value = service
    mock_supabase.return_value = MagicMock()

    establish_gmail_watch("user-123")

    assert service.users.return_value.watch.called
    watch_kwargs = service.users.return_value.watch.call_args[1]
    assert watch_kwargs.get("userId") == "me"
    body = watch_kwargs.get("body", {})
    assert body["topicName"] == "projects/aria/topics/gmail-notifications"
    assert "INBOX" in body.get("labelIds", [])


@patch.dict("os.environ", {"GMAIL_PUBSUB_TOPIC": "projects/aria/topics/gmail-notifications"})
@patch("ai.db._get_supabase")
@patch("gmail.fetch.update_history_id")
@patch("gmail.auth.build_gmail_service")
def test_establish_watch_stores_history_id(mock_build, mock_update_history, mock_supabase):
    """establish_gmail_watch stores the returned historyId as cursor."""
    from gmail.watch import establish_gmail_watch

    service = _make_gmail_service(_make_watch_response(history_id="54321"))
    mock_build.return_value = service
    mock_supabase.return_value = MagicMock()

    establish_gmail_watch("user-abc")

    mock_update_history.assert_called_once_with("user-abc", "54321")


@patch.dict("os.environ", {"GMAIL_PUBSUB_TOPIC": ""})
def test_establish_watch_returns_empty_dict_when_topic_missing():
    """establish_gmail_watch returns {} and does not call Gmail API when GMAIL_PUBSUB_TOPIC is unset."""
    from gmail.watch import establish_gmail_watch

    result = establish_gmail_watch("user-123")

    assert result == {}


@patch.dict("os.environ", {"GMAIL_PUBSUB_TOPIC": "projects/aria/topics/gmail-notifications"})
@patch("ai.db._get_supabase")
@patch("gmail.fetch.update_history_id")
@patch("gmail.auth.build_gmail_service")
def test_establish_watch_returns_watch_response(mock_build, mock_update_history, mock_supabase):
    """establish_gmail_watch returns the full watch response dict."""
    from gmail.watch import establish_gmail_watch

    response = _make_watch_response(history_id="11111", expiration=9999000000000)
    service = _make_gmail_service(response)
    mock_build.return_value = service
    mock_supabase.return_value = MagicMock()

    result = establish_gmail_watch("user-123")

    assert result["historyId"] == "11111"
    assert result["expiration"] == 9999000000000


# ---------------------------------------------------------------------------
# Tests for renew_gmail_watch
# ---------------------------------------------------------------------------

@patch("gmail.watch.establish_gmail_watch")
def test_renew_gmail_watch_calls_establish(mock_establish):
    """renew_gmail_watch delegates to establish_gmail_watch."""
    from gmail.watch import renew_gmail_watch

    mock_establish.return_value = _make_watch_response()

    renew_gmail_watch("user-123")

    mock_establish.assert_called_once_with("user-123")


@patch("gmail.watch.establish_gmail_watch")
def test_renew_gmail_watch_returns_establish_result(mock_establish):
    """renew_gmail_watch returns the result from establish_gmail_watch."""
    from gmail.watch import renew_gmail_watch

    expected = _make_watch_response(history_id="77777")
    mock_establish.return_value = expected

    result = renew_gmail_watch("user-123")

    assert result == expected
