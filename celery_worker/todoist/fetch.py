"""Fetch and write Todoist tasks via REST API v2."""
import requests

TODOIST_BASE = "https://api.todoist.com/rest/v2"


def _headers(access_token: str) -> dict:
    """Return Authorization header dict for Todoist API requests."""
    return {"Authorization": f"Bearer {access_token}"}


def get_active_tasks(access_token: str) -> list[dict]:
    """Fetch all active Todoist tasks that have a due date.

    Args:
        access_token: Todoist OAuth access token.
    Returns:
        List of task dicts with due field set (None-due tasks excluded).
    Raises:
        requests.HTTPError: On 4xx/5xx responses (including 403 revocation).
    """
    resp = requests.get(
        f"{TODOIST_BASE}/tasks",
        headers=_headers(access_token),
        timeout=15,
    )
    resp.raise_for_status()
    tasks = resp.json()
    return [t for t in tasks if t.get("due")]


def create_task(access_token: str, content: str, due_string: str) -> dict:
    """Create a new Todoist task with a natural language due string.

    Args:
        access_token: Todoist OAuth access token.
        content: Task title/content.
        due_string: Natural language due string (e.g. "Friday", "tomorrow").
    Returns:
        Created task dict from Todoist API.
    Raises:
        requests.HTTPError: On API error.
    """
    resp = requests.post(
        f"{TODOIST_BASE}/tasks",
        headers=_headers(access_token),
        json={"content": content, "due_string": due_string},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def close_task(access_token: str, task_id: str) -> bool:
    """Mark a Todoist task as completed.

    Args:
        access_token: Todoist OAuth access token.
        task_id: Todoist task ID string.
    Returns:
        True on success.
    Raises:
        requests.HTTPError: On API error.
    """
    resp = requests.post(
        f"{TODOIST_BASE}/tasks/{task_id}/close",
        headers=_headers(access_token),
        timeout=10,
    )
    resp.raise_for_status()
    return True


def update_task(access_token: str, task_id: str, due_string: str) -> dict:
    """Update a Todoist task's due date.

    Args:
        access_token: Todoist OAuth access token.
        task_id: Todoist task ID string.
        due_string: New natural language due string.
    Returns:
        Updated task dict from Todoist API.
    Raises:
        requests.HTTPError: On API error.
    """
    resp = requests.post(
        f"{TODOIST_BASE}/tasks/{task_id}",
        headers=_headers(access_token),
        json={"due_string": due_string},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def delete_task(access_token: str, task_id: str) -> bool:
    """Delete a Todoist task permanently.

    Args:
        access_token: Todoist OAuth access token.
        task_id: Todoist task ID string.
    Returns:
        True on success.
    Raises:
        requests.HTTPError: On API error.
    """
    resp = requests.delete(
        f"{TODOIST_BASE}/tasks/{task_id}",
        headers=_headers(access_token),
        timeout=10,
    )
    resp.raise_for_status()
    return True
