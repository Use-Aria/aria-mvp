"""Normalize raw Todoist task dicts into internal task format."""

_PRIORITY_MAP = {4: "urgent", 3: "high", 2: "medium", 1: "normal"}


def parse_tasks(raw_tasks: list[dict]) -> list[dict]:
    """Normalize Todoist API tasks to internal format.

    Filters out tasks with no due date. For tasks with due dates:
    - Prefers due.datetime (timezone-aware) over due.date (date-only)
    - Date-only strings (no "T") are normalized to end-of-day: T23:59:59Z
    - Todoist priority is inverted: 4=urgent, 3=high, 2=medium, 1=normal

    Args:
        raw_tasks: List of raw task dicts from Todoist REST API v2.
    Returns:
        List of normalized dicts with keys:
            title, due_date, todoist_id, priority_label
    """
    result = []
    for t in raw_tasks:
        due = t.get("due")
        if not due:
            continue

        # Prefer datetime (timezone-aware) over date-only
        due_str = due.get("datetime") or due.get("date", "")
        if due_str and "T" not in due_str:
            # Date-only — normalize to end of day UTC
            due_str = f"{due_str}T23:59:59Z"

        priority = t.get("priority", 1)
        priority_label = _PRIORITY_MAP.get(priority, "normal")

        result.append({
            "title": t["content"],
            "due_date": due_str,
            "todoist_id": t["id"],
            "priority_label": priority_label,
        })
    return result
