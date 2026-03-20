"""Tests for todoist.parse — task normalization.

Tests verify:
- datetime field is preferred over date-only
- date-only tasks are normalized to T23:59:59Z
- tasks without due are excluded
- priority inversion mapping (Todoist 4=urgent, 1=normal)
- todoist_id is extracted from task id field
"""
from todoist.parse import parse_tasks


class TestParseTasks:
    def test_parse_datetime_field(self):
        """due.datetime is used when present."""
        tasks = [
            {
                "id": "t1",
                "content": "Review notes",
                "priority": 2,
                "due": {"datetime": "2026-04-01T17:00:00Z", "date": "2026-04-01"},
            }
        ]
        result = parse_tasks(tasks)
        assert len(result) == 1
        assert result[0]["due_date"] == "2026-04-01T17:00:00Z"

    def test_parse_date_only_normalizes_to_eod(self):
        """date-only due (no datetime key) normalized to T23:59:59Z."""
        tasks = [
            {
                "id": "t2",
                "content": "Submit essay",
                "priority": 3,
                "due": {"date": "2026-04-01"},
            }
        ]
        result = parse_tasks(tasks)
        assert len(result) == 1
        assert result[0]["due_date"] == "2026-04-01T23:59:59Z"

    def test_parse_skips_tasks_without_due(self):
        """Tasks with due=None are excluded from output."""
        tasks = [
            {"id": "t3", "content": "No due task", "priority": 1, "due": None},
        ]
        result = parse_tasks(tasks)
        assert len(result) == 0

    def test_parse_priority_inversion(self):
        """Todoist priority 4 maps to urgent, priority 1 maps to normal."""
        tasks = [
            {
                "id": "t4",
                "content": "Urgent task",
                "priority": 4,
                "due": {"date": "2026-04-10"},
            },
            {
                "id": "t5",
                "content": "Normal task",
                "priority": 1,
                "due": {"date": "2026-04-10"},
            },
        ]
        result = parse_tasks(tasks)
        urgent = next(r for r in result if r["todoist_id"] == "t4")
        normal = next(r for r in result if r["todoist_id"] == "t5")
        assert urgent["priority_label"] == "urgent"
        assert normal["priority_label"] == "normal"

    def test_parse_extracts_todoist_id(self):
        """todoist_id is taken from the task's id field."""
        tasks = [
            {
                "id": "abc123",
                "content": "Read chapter",
                "priority": 2,
                "due": {"date": "2026-04-05"},
            }
        ]
        result = parse_tasks(tasks)
        assert result[0]["todoist_id"] == "abc123"
