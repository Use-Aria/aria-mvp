"""Tests for todoist.fetch — Todoist REST API v2 calls.

Tests verify:
- get_active_tasks filters tasks without due dates
- 403 raises requests.HTTPError with correct status_code
- Bearer token header is passed correctly
- create_task sends content and due_string
- close_task posts to the /close endpoint
- update_task sends due_string
- delete_task sends DELETE request
"""
import requests
from unittest.mock import patch, MagicMock
from todoist.fetch import (
    get_active_tasks,
    create_task,
    close_task,
    update_task,
    delete_task,
)


def _make_mock_response(status_code: int, json_data=None) -> MagicMock:
    """Build a mock requests.Response with raise_for_status behavior."""
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    mock_resp.json.return_value = json_data or {}
    if status_code >= 400:
        mock_resp.raise_for_status.side_effect = requests.HTTPError(
            response=mock_resp
        )
    else:
        mock_resp.raise_for_status.return_value = None
    return mock_resp


class TestGetActiveTasks:
    def test_get_active_tasks_returns_only_tasks_with_due(self):
        """Tasks without due field are filtered out."""
        raw_tasks = [
            {"id": "1", "content": "Task A", "due": {"date": "2026-04-01"}},
            {"id": "2", "content": "Task B", "due": {"datetime": "2026-04-02T10:00:00Z"}},
            {"id": "3", "content": "Task C", "due": None},
        ]
        with patch("todoist.fetch.requests.get") as mock_get:
            mock_get.return_value = _make_mock_response(200, raw_tasks)
            result = get_active_tasks("test_token")
        assert len(result) == 2

    def test_get_active_tasks_403_raises_http_error(self):
        """403 response raises requests.HTTPError with status_code 403."""
        with patch("todoist.fetch.requests.get") as mock_get:
            mock_get.return_value = _make_mock_response(403)
            try:
                get_active_tasks("revoked_token")
                assert False, "Expected requests.HTTPError to be raised"
            except requests.HTTPError as e:
                assert e.response.status_code == 403

    def test_get_active_tasks_passes_bearer_token(self):
        """Authorization header must use Bearer scheme."""
        with patch("todoist.fetch.requests.get") as mock_get:
            mock_get.return_value = _make_mock_response(200, [])
            get_active_tasks("test_token")
        call_kwargs = mock_get.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs.args[1] if len(call_kwargs.args) > 1 else {}
        # Check headers kwarg
        assert mock_get.called
        actual_headers = mock_get.call_args.kwargs.get("headers", {})
        assert actual_headers == {"Authorization": "Bearer test_token"}


class TestCreateTask:
    def test_create_task_sends_content_and_due_string(self):
        """create_task posts json with content and due_string."""
        with patch("todoist.fetch.requests.post") as mock_post:
            mock_post.return_value = _make_mock_response(200, {"id": "new-1"})
            create_task("tok", "Buy textbook", "Friday")
        call_json = mock_post.call_args.kwargs.get("json", {})
        assert call_json == {"content": "Buy textbook", "due_string": "Friday"}


class TestCloseTask:
    def test_close_task_posts_to_close_endpoint(self):
        """close_task POSTs to /tasks/{task_id}/close."""
        with patch("todoist.fetch.requests.post") as mock_post:
            mock_post.return_value = _make_mock_response(204)
            mock_post.return_value.raise_for_status.return_value = None
            close_task("tok", "123")
        called_url = mock_post.call_args.args[0]
        assert called_url.endswith("/tasks/123/close")


class TestUpdateTask:
    def test_update_task_sends_due_string(self):
        """update_task posts json with due_string."""
        with patch("todoist.fetch.requests.post") as mock_post:
            mock_post.return_value = _make_mock_response(200, {"id": "task-1"})
            update_task("tok", "task-1", "Monday")
        call_json = mock_post.call_args.kwargs.get("json", {})
        assert call_json == {"due_string": "Monday"}


class TestDeleteTask:
    def test_delete_task_sends_delete_request(self):
        """delete_task sends DELETE to /tasks/{task_id}."""
        with patch("todoist.fetch.requests.delete") as mock_delete:
            mock_delete.return_value = _make_mock_response(204)
            mock_delete.return_value.raise_for_status.return_value = None
            delete_task("tok", "456")
        called_url = mock_delete.call_args.args[0]
        assert called_url.endswith("/tasks/456")
