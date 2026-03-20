"""Tests for gcal.fetch — GCal event fetching, filtering, and normalization.

Tests use mocked build_gcal_service to avoid real API calls.
build_gcal_service is imported lazily inside fetch_gcal_events via
'from gcal.auth import build_gcal_service'. We ensure the modules are
imported first, then patch at gcal.auth.build_gcal_service.
"""
from unittest.mock import MagicMock, patch
import pytest

# Pre-import the module under test so patch targets resolve correctly
import gcal.auth
import gcal.fetch


# --- Fixtures ---

def _make_event(
    event_id="evt1",
    summary="Team Meeting",
    start="2026-03-21T10:00:00Z",
    end="2026-03-21T11:00:00Z",
    transparency=None,
    attendees=None,
):
    """Build a mock GCal event dict."""
    e = {
        "id": event_id,
        "summary": summary,
        "start": {"dateTime": start},
        "end": {"dateTime": end},
    }
    if transparency:
        e["transparency"] = transparency
    if attendees:
        e["attendees"] = attendees
    return e


def _make_service(events):
    """Return a mock GCal service with events().list().execute() returning given items."""
    service = MagicMock()
    service.events().list().execute.return_value = {"items": events}
    return service


# --- Tests for fetch_gcal_events ---

@patch("gcal.auth.build_gcal_service")
def test_fetch_returns_normalized_dicts(mock_build):
    """fetch_gcal_events returns list of dicts with required keys."""
    from gcal.fetch import fetch_gcal_events

    mock_build.return_value = _make_service([
        _make_event(event_id="evt1", summary="Class Lecture"),
    ])
    result = fetch_gcal_events("user-123")

    assert len(result) == 1
    evt = result[0]
    assert "google_event_id" in evt
    assert "title" in evt
    assert "start_time" in evt
    assert "end_time" in evt
    assert "type" in evt
    assert evt["google_event_id"] == "evt1"
    assert evt["title"] == "Class Lecture"
    assert evt["source"] == "gcal"


@patch("gcal.auth.build_gcal_service")
def test_fetch_filters_transparent_events(mock_build):
    """fetch_gcal_events drops events with transparency=transparent."""
    from gcal.fetch import fetch_gcal_events

    mock_build.return_value = _make_service([
        _make_event(event_id="evt1", summary="Free Time", transparency="transparent"),
        _make_event(event_id="evt2", summary="Real Meeting"),
    ])
    result = fetch_gcal_events("user-123")

    assert len(result) == 1
    assert result[0]["google_event_id"] == "evt2"


@patch("gcal.auth.build_gcal_service")
def test_fetch_filters_declined_events(mock_build):
    """fetch_gcal_events drops events the user has declined."""
    from gcal.fetch import fetch_gcal_events

    declined_attendees = [
        {"self": True, "responseStatus": "declined"},
        {"self": False, "responseStatus": "accepted"},
    ]
    accepted_attendees = [
        {"self": True, "responseStatus": "accepted"},
    ]
    mock_build.return_value = _make_service([
        _make_event(event_id="evt1", summary="Declined Meeting", attendees=declined_attendees),
        _make_event(event_id="evt2", summary="Accepted Meeting", attendees=accepted_attendees),
    ])
    result = fetch_gcal_events("user-123")

    assert len(result) == 1
    assert result[0]["google_event_id"] == "evt2"


@patch("gcal.auth.build_gcal_service")
def test_fetch_handles_allday_events(mock_build):
    """fetch_gcal_events normalizes all-day events (date key, not dateTime)."""
    from gcal.fetch import fetch_gcal_events

    allday_event = {
        "id": "evt-allday",
        "summary": "All Day Event",
        "start": {"date": "2026-03-21"},
        "end": {"date": "2026-03-22"},
    }
    mock_build.return_value = _make_service([allday_event])
    result = fetch_gcal_events("user-123")

    assert len(result) == 1
    assert result[0]["start_time"] == "2026-03-21"
    assert result[0]["end_time"] == "2026-03-22"


@patch("gcal.auth.build_gcal_service")
def test_fetch_returns_empty_for_no_events(mock_build):
    """fetch_gcal_events returns empty list when no events."""
    from gcal.fetch import fetch_gcal_events

    mock_build.return_value = _make_service([])
    result = fetch_gcal_events("user-123")
    assert result == []


# --- Tests for _infer_type ---

def test_infer_type_exam():
    from gcal.fetch import _infer_type
    assert _infer_type("Midterm Exam") == "exam"
    assert _infer_type("Final") == "exam"
    assert _infer_type("Quiz 3") == "exam"


def test_infer_type_class():
    from gcal.fetch import _infer_type
    assert _infer_type("CPSC 365 Lecture") == "class"
    assert _infer_type("Lab Section") == "class"
    assert _infer_type("Seminar") == "class"


def test_infer_type_study():
    from gcal.fetch import _infer_type
    assert _infer_type("Study Group") == "study"
    assert _infer_type("Homework Review") == "study"


def test_infer_type_personal():
    from gcal.fetch import _infer_type
    assert _infer_type("Coffee with friend") == "personal"
    assert _infer_type("Doctor appointment") == "personal"
