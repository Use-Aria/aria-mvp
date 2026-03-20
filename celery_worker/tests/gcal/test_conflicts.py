"""Unit tests for gcal.conflicts — conflict detection between Canvas deadlines and GCal events.

Tests cover: same-day conflict fires, different-day skips, deduplication,
re-fire on date change, SMS body format.
"""
from unittest.mock import MagicMock, patch, call

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_supabase_mock(deadlines=None, events=None, existing=None):
    """Build a mock Supabase client that returns the given data for each table query."""
    deadlines = deadlines or []
    events = events or []
    existing = existing or []

    client = MagicMock()

    # We need to handle chained calls like:
    # client.table("deadlines").select(...).eq(...).is_(...).neq(...).execute()
    # and similarly for "calendar_events", "conflict_alerts"

    def _table_side_effect(name):
        mock_table = MagicMock()
        # Default: return empty
        mock_result = MagicMock()
        mock_result.data = []

        # Each query chain returns a mock that ultimately has .execute()
        # We'll build a fluent chain mock
        def make_chain(data):
            chain = MagicMock()
            chain.data = data
            chain.execute.return_value = chain
            chain.select.return_value = chain
            chain.eq.return_value = chain
            chain.is_.return_value = chain
            chain.neq.return_value = chain
            chain.insert.return_value = chain
            chain.update.return_value = chain
            return chain

        if name == "deadlines":
            chain = make_chain(deadlines)
            mock_table.select.return_value = chain
            mock_table.insert.return_value = make_chain([])
        elif name == "calendar_events":
            chain = make_chain(events)
            mock_table.select.return_value = chain
        elif name == "conflict_alerts":
            chain = make_chain(existing)
            mock_table.select.return_value = chain
            mock_table.insert.return_value = make_chain([])
        else:
            chain = make_chain([])
            mock_table.select.return_value = chain
            mock_table.insert.return_value = make_chain([])

        return mock_table

    client.table.side_effect = _table_side_effect
    return client


def _make_deadline(
    id_="dl-001",
    title="Bio Lab Report",
    due_date="2026-03-25T23:59:59+00:00",
    course="BIOL 101",
):
    return {"id": id_, "title": title, "due_date": due_date, "course": course}


def _make_event(
    google_event_id="gcal-001",
    title="Study Group",
    start_time="2026-03-25T14:00:00+00:00",
    end_time="2026-03-25T16:00:00+00:00",
):
    return {
        "id": "ce-001",
        "google_event_id": google_event_id,
        "title": title,
        "start_time": start_time,
        "end_time": end_time,
    }


# ---------------------------------------------------------------------------
# Same-day conflict fires
# ---------------------------------------------------------------------------


@patch("sms.batch.enqueue_alert")
@patch("ai.db._get_supabase")
def test_same_day_conflict_fires(mock_get_sb, mock_enqueue):
    """detect_conflicts_user returns conflict when deadline and event are on same day."""
    from gcal.conflicts import detect_conflicts_user

    dl = _make_deadline(due_date="2026-03-25T23:59:59+00:00")
    ev = _make_event(start_time="2026-03-25T14:00:00+00:00", end_time="2026-03-25T16:00:00+00:00")

    mock_get_sb.return_value = _make_supabase_mock(
        deadlines=[dl],
        events=[ev],
        existing=[],
    )
    mock_enqueue.return_value = False  # not first

    result = detect_conflicts_user("user-123")

    assert len(result) == 1
    assert result[0]["deadline"] == "Bio Lab Report"
    assert result[0]["event"] == "Study Group"


# ---------------------------------------------------------------------------
# Different-day does NOT fire
# ---------------------------------------------------------------------------


@patch("sms.batch.enqueue_alert")
@patch("ai.db._get_supabase")
def test_different_day_no_conflict(mock_get_sb, mock_enqueue):
    """detect_conflicts_user returns empty list when deadline and event are on different days."""
    from gcal.conflicts import detect_conflicts_user

    dl = _make_deadline(due_date="2026-03-25T23:59:59+00:00")
    ev = _make_event(start_time="2026-03-26T14:00:00+00:00", end_time="2026-03-26T16:00:00+00:00")

    mock_get_sb.return_value = _make_supabase_mock(
        deadlines=[dl],
        events=[ev],
        existing=[],
    )

    result = detect_conflicts_user("user-123")

    assert result == []
    mock_enqueue.assert_not_called()


# ---------------------------------------------------------------------------
# Deduplication — skip already-fired pairs with same due date
# ---------------------------------------------------------------------------


@patch("sms.batch.enqueue_alert")
@patch("ai.db._get_supabase")
def test_dedup_skips_existing_alert(mock_get_sb, mock_enqueue):
    """detect_conflicts_user skips firing when same (deadline_id, gcal_event_id, due_date) exists."""
    from gcal.conflicts import detect_conflicts_user

    dl = _make_deadline(due_date="2026-03-25T23:59:59+00:00")
    ev = _make_event(start_time="2026-03-25T14:00:00+00:00", end_time="2026-03-25T16:00:00+00:00")

    existing = [{
        "deadline_id": "dl-001",
        "gcal_event_id": "gcal-001",
        "deadline_due_at": "2026-03-25T23:59:59+00:00",
    }]

    mock_get_sb.return_value = _make_supabase_mock(
        deadlines=[dl],
        events=[ev],
        existing=existing,
    )

    result = detect_conflicts_user("user-123")

    assert result == []
    mock_enqueue.assert_not_called()


# ---------------------------------------------------------------------------
# Re-fire when deadline date has changed
# ---------------------------------------------------------------------------


@patch("sms.batch.enqueue_alert")
@patch("ai.db._get_supabase")
def test_refires_when_deadline_date_changed(mock_get_sb, mock_enqueue):
    """detect_conflicts_user re-fires when deadline due_date has changed since last alert."""
    from gcal.conflicts import detect_conflicts_user

    # Deadline now due on March 26
    dl = _make_deadline(due_date="2026-03-26T23:59:59+00:00")
    ev = _make_event(start_time="2026-03-26T14:00:00+00:00", end_time="2026-03-26T16:00:00+00:00")

    # Previous alert was for March 25 (old due date)
    existing = [{
        "deadline_id": "dl-001",
        "gcal_event_id": "gcal-001",
        "deadline_due_at": "2026-03-25T23:59:59+00:00",  # old date
    }]

    mock_get_sb.return_value = _make_supabase_mock(
        deadlines=[dl],
        events=[ev],
        existing=existing,
    )
    mock_enqueue.return_value = False

    result = detect_conflicts_user("user-123")

    # Should fire because the deadline date changed
    assert len(result) == 1


# ---------------------------------------------------------------------------
# SMS body format
# ---------------------------------------------------------------------------


@patch("sms.batch.enqueue_alert")
@patch("ai.db._get_supabase")
def test_conflict_sms_contains_required_fields(mock_get_sb, mock_enqueue):
    """Conflict SMS body contains assignment title, day, event name, and duration."""
    from gcal.conflicts import detect_conflicts_user

    dl = _make_deadline(
        title="Organic Chemistry Problem Set",
        due_date="2026-03-25T23:59:59+00:00",  # Wednesday
        course="CHEM 220",
    )
    # 2-hour event
    ev = _make_event(
        title="Soccer Practice",
        start_time="2026-03-25T15:00:00+00:00",
        end_time="2026-03-25T17:00:00+00:00",
    )

    mock_get_sb.return_value = _make_supabase_mock(
        deadlines=[dl],
        events=[ev],
        existing=[],
    )
    mock_enqueue.return_value = False

    detect_conflicts_user("user-123")

    mock_enqueue.assert_called_once()
    call_args = mock_enqueue.call_args
    sms_body = call_args[0][1]  # positional arg 1 is the text

    assert "Organic Chemistry Problem Set" in sms_body
    assert "Soccer Practice" in sms_body
    assert "Heads up:" in sms_body
    # Should mention the day name
    assert "Wednesday" in sms_body


# ---------------------------------------------------------------------------
# No deadlines / no events — no-op
# ---------------------------------------------------------------------------


@patch("sms.batch.enqueue_alert")
@patch("ai.db._get_supabase")
def test_no_deadlines_returns_empty(mock_get_sb, mock_enqueue):
    """detect_conflicts_user returns empty list if user has no deadlines."""
    from gcal.conflicts import detect_conflicts_user

    mock_get_sb.return_value = _make_supabase_mock(deadlines=[], events=[_make_event()])

    result = detect_conflicts_user("user-123")
    assert result == []
    mock_enqueue.assert_not_called()


@patch("sms.batch.enqueue_alert")
@patch("ai.db._get_supabase")
def test_no_events_returns_empty(mock_get_sb, mock_enqueue):
    """detect_conflicts_user returns empty list if user has no GCal events."""
    from gcal.conflicts import detect_conflicts_user

    mock_get_sb.return_value = _make_supabase_mock(deadlines=[_make_deadline()], events=[])

    result = detect_conflicts_user("user-123")
    assert result == []
    mock_enqueue.assert_not_called()
