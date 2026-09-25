"""Regression tests for gmail.fetch.fetch_new_messages and the history cursor
handling in tasks.gmail_process_notification.

- Only a 404 (expired historyId) is swallowed; other errors propagate.
- history.list pagination (nextPageToken) is followed.
- The history cursor advances only after messages are processed.
"""
from unittest.mock import MagicMock, patch

import httplib2
import pytest
from googleapiclient.errors import HttpError

import gmail.fetch  # noqa: F401


def _http_error(status: int) -> HttpError:
    return HttpError(httplib2.Response({"status": status}), b"error")


def _service_with_history_pages(pages, message_headers=None):
    """Mock Gmail service whose history().list().execute() yields `pages` in order."""
    service = MagicMock()
    history_list = service.users.return_value.history.return_value.list
    history_list.return_value.execute.side_effect = pages
    message_headers = message_headers or {}

    def _get(userId, id, format, metadataHeaders):
        req = MagicMock()
        req.execute.return_value = {
            "snippet": f"snippet {id}",
            "payload": {"headers": [
                {"name": "From", "value": message_headers.get(id, "prof@yale.edu")},
                {"name": "Subject", "value": f"subject {id}"},
            ]},
        }
        return req

    service.users.return_value.messages.return_value.get.side_effect = _get
    return service, history_list


def _page(msg_ids, next_token=None):
    page = {"history": [{"messagesAdded": [{"message": {"id": m}} for m in msg_ids]}]}
    if next_token:
        page["nextPageToken"] = next_token
    return page


def test_fetch_new_messages_404_returns_empty():
    from gmail.fetch import fetch_new_messages

    service, _ = _service_with_history_pages([_http_error(404)])
    with patch("gmail.auth.build_gmail_service", return_value=service):
        assert fetch_new_messages("user-1", "100") == []


def test_fetch_new_messages_non_404_error_propagates():
    from gmail.fetch import fetch_new_messages

    service, _ = _service_with_history_pages([_http_error(500)])
    with patch("gmail.auth.build_gmail_service", return_value=service):
        with pytest.raises(HttpError):
            fetch_new_messages("user-1", "100")


def test_fetch_new_messages_follows_next_page_token():
    from gmail.fetch import fetch_new_messages

    service, history_list = _service_with_history_pages(
        [_page(["m1"], next_token="tok-2"), _page(["m2"])]
    )
    with patch("gmail.auth.build_gmail_service", return_value=service):
        result = fetch_new_messages("user-1", "100")

    assert [m["message_id"] for m in result] == ["m1", "m2"]
    page_tokens = [c.kwargs.get("pageToken") for c in history_list.call_args_list]
    assert page_tokens == [None, "tok-2"]


def test_gmail_process_notification_does_not_advance_cursor_on_fetch_error():
    with patch("gmail.fetch.get_stored_history_id", return_value="100"), \
         patch("gmail.fetch.fetch_new_messages", side_effect=_http_error(500)), \
         patch("gmail.fetch.update_history_id") as mock_update:
        from tasks import gmail_process_notification
        with pytest.raises(HttpError):
            gmail_process_notification("user-1", "200")

    mock_update.assert_not_called()


def test_gmail_process_notification_does_not_advance_cursor_on_processing_error():
    msgs = [{"subject": "s", "sender": "prof@yale.edu", "snippet": "x", "message_id": "m1"}]
    client = MagicMock()
    with patch("gmail.fetch.get_stored_history_id", return_value="100"), \
         patch("gmail.fetch.fetch_new_messages", return_value=msgs), \
         patch("ai.db._get_supabase", return_value=client), \
         patch("gmail.classify.classify_email", side_effect=RuntimeError("claude down")), \
         patch("gmail.fetch.update_history_id") as mock_update:
        from tasks import gmail_process_notification
        with pytest.raises(RuntimeError):
            gmail_process_notification("user-1", "200")

    mock_update.assert_not_called()


def test_gmail_process_notification_advances_cursor_after_processing():
    msgs = [{"subject": "s", "sender": "prof@yale.edu", "snippet": "x", "message_id": "m1"}]
    client = MagicMock()
    with patch("gmail.fetch.get_stored_history_id", return_value="100"), \
         patch("gmail.fetch.fetch_new_messages", return_value=msgs), \
         patch("ai.db._get_supabase", return_value=client), \
         patch("gmail.classify.classify_email", return_value={"is_deadline_change": False, "confidence": 0.1}), \
         patch("gmail.fetch.update_history_id") as mock_update:
        from tasks import gmail_process_notification
        result = gmail_process_notification("user-1", "200")

    assert result["processed"] == 1
    mock_update.assert_called_once_with("user-1", "200")
