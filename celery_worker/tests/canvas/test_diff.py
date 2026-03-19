"""Tests for canvas.diff.compute_diff — CANV-04 coverage.

Tests verify:
- Added deadlines are detected (canvas_uid in feed but not in DB)
- Changed deadlines are detected (same canvas_uid, different due_date)
- Removed deadlines are detected (canvas_uid in DB but not in feed)
- Title-only changes do NOT appear in diff output
- Mixed operations work in a single diff call
"""
from canvas.diff import compute_diff


def test_detect_added():
    """canvas_uid in fresh but not in current → appears in diff['added']."""
    current = {}
    fresh = [{"canvas_uid": "a", "due_date": "2026-04-01T00:00:00+00:00", "title": "Exam"}]
    diff = compute_diff(current, fresh)
    assert len(diff["added"]) == 1
    assert diff["added"][0]["canvas_uid"] == "a"
    assert diff["changed"] == []
    assert diff["removed"] == []


def test_detect_changed():
    """Same canvas_uid with different due_date → appears in diff['changed']."""
    current = {"a": {"due_date": "2026-04-01T00:00:00+00:00", "title": "Exam"}}
    fresh = [{"canvas_uid": "a", "due_date": "2026-04-02T00:00:00+00:00", "title": "Exam"}]
    diff = compute_diff(current, fresh)
    assert len(diff["changed"]) == 1
    assert diff["changed"][0]["canvas_uid"] == "a"
    assert diff["changed"][0]["due_date"] == "2026-04-02T00:00:00+00:00"
    assert diff["added"] == []
    assert diff["removed"] == []


def test_detect_removed():
    """canvas_uid in current but not in fresh → appears in diff['removed']."""
    current = {"a": {"due_date": "2026-04-01T00:00:00+00:00"}}
    fresh = []
    diff = compute_diff(current, fresh)
    assert diff["removed"] == ["a"]
    assert diff["added"] == []
    assert diff["changed"] == []


def test_title_only_no_diff():
    """Same canvas_uid and same due_date but different title → no diff generated."""
    current = {
        "a": {"due_date": "2026-04-01T00:00:00+00:00", "title": "Old Title"}
    }
    fresh = [
        {"canvas_uid": "a", "due_date": "2026-04-01T00:00:00+00:00", "title": "New Title"}
    ]
    diff = compute_diff(current, fresh)
    assert diff["added"] == []
    assert diff["changed"] == []
    assert diff["removed"] == []


def test_multiple_operations():
    """Mix of added, changed, and removed in a single diff call."""
    current = {
        "existing-unchanged": {"due_date": "2026-04-01T00:00:00+00:00"},
        "existing-changed": {"due_date": "2026-04-01T00:00:00+00:00"},
        "to-be-removed": {"due_date": "2026-04-05T00:00:00+00:00"},
    }
    fresh = [
        # unchanged — same due_date
        {"canvas_uid": "existing-unchanged", "due_date": "2026-04-01T00:00:00+00:00", "title": "A"},
        # changed — different due_date
        {"canvas_uid": "existing-changed", "due_date": "2026-04-03T00:00:00+00:00", "title": "B"},
        # added — new uid
        {"canvas_uid": "brand-new", "due_date": "2026-04-10T00:00:00+00:00", "title": "C"},
        # "to-be-removed" is absent from fresh
    ]
    diff = compute_diff(current, fresh)

    assert len(diff["added"]) == 1
    assert diff["added"][0]["canvas_uid"] == "brand-new"

    assert len(diff["changed"]) == 1
    assert diff["changed"][0]["canvas_uid"] == "existing-changed"

    assert diff["removed"] == ["to-be-removed"]
