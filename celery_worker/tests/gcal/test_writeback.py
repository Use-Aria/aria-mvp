"""Unit tests for gcal.writeback — study block creation, deletion, and scheduling.

Tests cover: create_study_block calls events().insert(), delete_study_block
calls events().delete(), schedule_study_block finds slot and creates event,
and schedule_study_block returns None when no slot available.
"""
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch, call

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

UTC = timezone.utc
START = datetime(2026, 3, 24, 18, 0, 0, tzinfo=UTC)   # 6pm UTC
END = datetime(2026, 3, 24, 20, 0, 0, tzinfo=UTC)     # 8pm UTC


def _make_gcal_service(event_id="gcal-event-123"):
    """Return a mock GCal API service."""
    service = MagicMock()
    service.events.return_value.insert.return_value.execute.return_value = {"id": event_id}
    service.events.return_value.delete.return_value.execute.return_value = {}
    return service


# ---------------------------------------------------------------------------
# create_study_block
# ---------------------------------------------------------------------------


@patch("gcal.auth.build_gcal_service")
def test_create_study_block_calls_events_insert(mock_build):
    """create_study_block calls events().insert() with correct body."""
    from gcal.writeback import create_study_block

    service = _make_gcal_service()
    mock_build.return_value = service

    result = create_study_block("user-123", "Bio Study", START, END)

    # Verify events().insert() was called
    assert service.events.return_value.insert.called
    call_kwargs = service.events.return_value.insert.call_args[1]
    assert call_kwargs["calendarId"] == "primary"
    body = call_kwargs["body"]
    assert body["summary"] == "Bio Study"
    assert "dateTime" in body["start"]
    assert "dateTime" in body["end"]


@patch("gcal.auth.build_gcal_service")
def test_create_study_block_returns_event_id(mock_build):
    """create_study_block returns the Google Calendar event ID."""
    from gcal.writeback import create_study_block

    service = _make_gcal_service(event_id="gcal-abc-456")
    mock_build.return_value = service

    event_id = create_study_block("user-123", "Chem Study", START, END)

    assert event_id == "gcal-abc-456"


@patch("gcal.auth.build_gcal_service")
def test_create_study_block_includes_aria_description(mock_build):
    """create_study_block event body includes 'Aria' in description."""
    from gcal.writeback import create_study_block

    service = _make_gcal_service()
    mock_build.return_value = service

    create_study_block("user-123", "Study Block", START, END)

    body = service.events.return_value.insert.call_args[1]["body"]
    assert "Aria" in body.get("description", "")


# ---------------------------------------------------------------------------
# delete_study_block
# ---------------------------------------------------------------------------


@patch("gcal.auth.build_gcal_service")
def test_delete_study_block_calls_events_delete(mock_build):
    """delete_study_block calls events().delete() with correct calendarId and eventId."""
    from gcal.writeback import delete_study_block

    service = _make_gcal_service()
    mock_build.return_value = service

    result = delete_study_block("user-123", "gcal-event-abc")

    assert service.events.return_value.delete.called
    call_kwargs = service.events.return_value.delete.call_args[1]
    assert call_kwargs["calendarId"] == "primary"
    assert call_kwargs["eventId"] == "gcal-event-abc"
    assert result is True


@patch("gcal.auth.build_gcal_service")
def test_delete_study_block_returns_false_on_error(mock_build):
    """delete_study_block returns False if delete raises an exception."""
    from gcal.writeback import delete_study_block

    service = _make_gcal_service()
    service.events.return_value.delete.return_value.execute.side_effect = Exception("Not found")
    mock_build.return_value = service

    result = delete_study_block("user-123", "gcal-event-bad")

    assert result is False


# ---------------------------------------------------------------------------
# schedule_study_block
# ---------------------------------------------------------------------------


@patch("gcal.writeback.create_study_block")
@patch("gcal.slots.find_free_slots")
@patch("gcal.db.get_calendar_events")
def test_schedule_study_block_creates_event_in_first_slot(
    mock_get_events, mock_find_slots, mock_create
):
    """schedule_study_block calls create_study_block with the first preferred slot."""
    from gcal.writeback import schedule_study_block
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("America/New_York")
    target_date = datetime(2026, 3, 24, 12, 0, 0, tzinfo=tz)

    mock_get_events.return_value = []
    mock_find_slots.return_value = [
        {
            "start": "2026-03-24T18:00:00-04:00",  # 6pm EDT
            "end": "2026-03-24T22:00:00-04:00",    # 10pm EDT
            "duration_hours": 4.0,
        }
    ]
    mock_create.return_value = "new-event-id"

    result = schedule_study_block(
        user_id="user-123",
        title="Bio Study",
        duration_hours=2,
        target_date=target_date,
    )

    assert result is not None
    assert result["event_id"] == "new-event-id"
    assert result["title"] == "Bio Study"
    mock_create.assert_called_once()


@patch("gcal.writeback.create_study_block")
@patch("gcal.slots.find_free_slots")
@patch("gcal.db.get_calendar_events")
def test_schedule_study_block_returns_none_when_no_slot(
    mock_get_events, mock_find_slots, mock_create
):
    """schedule_study_block returns None when no free slot is available."""
    from gcal.writeback import schedule_study_block
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("America/New_York")
    target_date = datetime(2026, 3, 24, 12, 0, 0, tzinfo=tz)

    mock_get_events.return_value = []
    mock_find_slots.return_value = []  # no slots

    result = schedule_study_block(
        user_id="user-123",
        title="Bio Study",
        duration_hours=2,
        target_date=target_date,
    )

    assert result is None
    mock_create.assert_not_called()


@patch("gcal.writeback.create_study_block")
@patch("gcal.slots.find_free_slots")
@patch("gcal.db.get_calendar_events")
def test_schedule_study_block_uses_study_preference(
    mock_get_events, mock_find_slots, mock_create
):
    """schedule_study_block passes study_preference to find_free_slots."""
    from gcal.writeback import schedule_study_block
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("America/New_York")
    target_date = datetime(2026, 3, 24, 12, 0, 0, tzinfo=tz)

    mock_get_events.return_value = []
    mock_find_slots.return_value = [
        {
            "start": "2026-03-24T07:00:00-04:00",
            "end": "2026-03-24T12:00:00-04:00",
            "duration_hours": 5.0,
        }
    ]
    mock_create.return_value = "event-id-morning"

    schedule_study_block(
        user_id="user-123",
        title="Morning Study",
        duration_hours=2,
        target_date=target_date,
        study_preference="morning",
    )

    # Verify find_free_slots was called with the correct study_preference
    call_kwargs = mock_find_slots.call_args[1]
    assert call_kwargs.get("study_preference") == "morning"
