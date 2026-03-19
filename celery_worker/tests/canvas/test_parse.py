"""Tests for canvas.parse.parse_vevents — CANV-01 coverage.

Tests verify:
- Timezone-aware DATETIME events are converted to UTC
- All-day DATE events are normalized to end-of-day UTC (23:59:59Z)
- UID and SUMMARY are extracted correctly
- Non-VEVENT components are skipped
- VEVENT records missing DTSTART are skipped
"""
from canvas.parse import parse_vevents


def _make_vcal(vevent_body: str) -> bytes:
    """Wrap a VEVENT body string in a minimal valid VCALENDAR."""
    return (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//Canvas//iCal//EN\r\n"
        f"{vevent_body}"
        "END:VCALENDAR\r\n"
    ).encode("utf-8")


def test_parse_tz_aware_datetime_to_utc():
    """DTSTART;TZID=America/New_York:20260401T235900 should convert to 2026-04-02T03:59:00+00:00 (EDT = UTC-4)."""
    raw = _make_vcal(
        "BEGIN:VEVENT\r\n"
        "UID:event-assignment_tz@instructure.com\r\n"
        "SUMMARY:Midterm Paper - ENGL 115\r\n"
        "DTSTART;TZID=America/New_York:20260401T235900\r\n"
        "END:VEVENT\r\n"
    )
    result = parse_vevents(raw)
    assert len(result) == 1
    assert result[0]["due_date"] == "2026-04-02T03:59:00+00:00"


def test_allday_date_to_utc():
    """DTSTART;VALUE=DATE:20260401 should normalize to 2026-04-01T23:59:59+00:00."""
    raw = _make_vcal(
        "BEGIN:VEVENT\r\n"
        "UID:event-assignment_allday@instructure.com\r\n"
        "SUMMARY:PSET 4 - CPSC 201\r\n"
        "DTSTART;VALUE=DATE:20260401\r\n"
        "END:VEVENT\r\n"
    )
    result = parse_vevents(raw)
    assert len(result) == 1
    assert result[0]["due_date"] == "2026-04-01T23:59:59+00:00"


def test_parse_extracts_uid_and_summary():
    """UID and SUMMARY fields should be extracted into canvas_uid and title."""
    raw = _make_vcal(
        "BEGIN:VEVENT\r\n"
        "UID:event-assignment_123@instructure.com\r\n"
        "SUMMARY:PSET 3 - CPSC 201\r\n"
        "DTSTART;VALUE=DATE:20260415\r\n"
        "END:VEVENT\r\n"
    )
    result = parse_vevents(raw)
    assert len(result) == 1
    assert result[0]["canvas_uid"] == "event-assignment_123@instructure.com"
    assert result[0]["title"] == "PSET 3 - CPSC 201"


def test_parse_skips_non_vevent():
    """VTODO components should be ignored — parse_vevents returns empty list."""
    raw = (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "PRODID:-//Canvas//iCal//EN\r\n"
        "BEGIN:VTODO\r\n"
        "UID:todo-123@instructure.com\r\n"
        "SUMMARY:Some Task\r\n"
        "DUE;VALUE=DATE:20260401\r\n"
        "END:VTODO\r\n"
        "END:VCALENDAR\r\n"
    ).encode("utf-8")
    result = parse_vevents(raw)
    assert result == []


def test_parse_skips_missing_dtstart():
    """VEVENT without DTSTART should be silently skipped."""
    raw = _make_vcal(
        "BEGIN:VEVENT\r\n"
        "UID:event-no-dtstart@instructure.com\r\n"
        "SUMMARY:Assignment Without Date\r\n"
        "END:VEVENT\r\n"
    )
    result = parse_vevents(raw)
    assert result == []
