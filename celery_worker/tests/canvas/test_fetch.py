"""Tests for canvas.fetch.fetch_ical — CANV-05 coverage.

Tests verify:
- Successful 200 response returns raw bytes
- HTTP 429 raises requests.HTTPError (enabling Celery retry)
- HTTP 500 raises requests.HTTPError
- timeout=30 is passed to requests.get
"""
import requests
from unittest.mock import patch, MagicMock
from canvas.fetch import fetch_ical


def _make_mock_response(status_code: int, content: bytes = b"") -> MagicMock:
    """Build a mock requests.Response with raise_for_status behavior."""
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    mock_resp.content = content
    if status_code >= 400:
        mock_resp.raise_for_status.side_effect = requests.HTTPError(
            response=mock_resp
        )
    else:
        mock_resp.raise_for_status.return_value = None
    return mock_resp


def test_fetch_returns_bytes():
    """Successful 200 response returns the raw iCal bytes."""
    expected = b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
    with patch("canvas.fetch.requests.get") as mock_get:
        mock_get.return_value = _make_mock_response(200, expected)
        result = fetch_ical("https://canvas.yale.edu/feeds/calendars/user_abc.ics")
    assert result == expected


def test_429_raises_http_error():
    """HTTP 429 (rate limit) must raise requests.HTTPError so Celery can retry."""
    with patch("canvas.fetch.requests.get") as mock_get:
        mock_get.return_value = _make_mock_response(429)
        try:
            fetch_ical("https://canvas.yale.edu/feeds/calendars/user_abc.ics")
            assert False, "Expected requests.HTTPError to be raised"
        except requests.HTTPError:
            pass


def test_500_raises_http_error():
    """HTTP 500 must raise requests.HTTPError."""
    with patch("canvas.fetch.requests.get") as mock_get:
        mock_get.return_value = _make_mock_response(500)
        try:
            fetch_ical("https://canvas.yale.edu/feeds/calendars/user_abc.ics")
            assert False, "Expected requests.HTTPError to be raised"
        except requests.HTTPError:
            pass


def test_fetch_uses_timeout():
    """requests.get must be called with timeout=30 (default)."""
    with patch("canvas.fetch.requests.get") as mock_get:
        mock_get.return_value = _make_mock_response(200, b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
        fetch_ical("https://canvas.yale.edu/feeds/calendars/user_abc.ics")
    mock_get.assert_called_once_with(
        "https://canvas.yale.edu/feeds/calendars/user_abc.ics",
        timeout=30,
    )
