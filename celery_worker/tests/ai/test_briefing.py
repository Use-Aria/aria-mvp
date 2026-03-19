"""Unit tests for the daily briefing generator.

All tests are pure unit tests — no Supabase calls, no Twilio calls, no Claude calls.
Anthropic client is mocked throughout. datetime.now is mocked for window/touchpoint tests.
"""
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

from ai.briefing import (
    EXAM_TOUCHPOINTS,
    compute_load_score,
    generate_briefing,
    get_exam_touchpoints,
    is_in_briefing_window,
)


# ---------------------------------------------------------------------------
# compute_load_score tests
# ---------------------------------------------------------------------------


def test_compute_load_score_green_zero():
    """0 deadlines in 48h returns 'green'."""
    assert compute_load_score([]) == "green"


def test_compute_load_score_green_one():
    """1 deadline in 48h returns 'green'."""
    assert compute_load_score([{"title": "hw1"}]) == "green"


def test_compute_load_score_yellow_two():
    """2 deadlines returns 'yellow'."""
    assert compute_load_score([{"title": "hw1"}, {"title": "hw2"}]) == "yellow"


def test_compute_load_score_yellow_three():
    """3 deadlines returns 'yellow'."""
    deadlines = [{"title": f"hw{i}"} for i in range(3)]
    assert compute_load_score(deadlines) == "yellow"


def test_compute_load_score_red_four():
    """4 deadlines returns 'red'."""
    deadlines = [{"title": f"hw{i}"} for i in range(4)]
    assert compute_load_score(deadlines) == "red"


def test_compute_load_score_red_ten():
    """10 deadlines returns 'red'."""
    deadlines = [{"title": f"hw{i}"} for i in range(10)]
    assert compute_load_score(deadlines) == "red"


# ---------------------------------------------------------------------------
# get_exam_touchpoints tests
# ---------------------------------------------------------------------------


def _make_exam(days_from_now: int, tz: ZoneInfo, type_: str = "exam") -> dict:
    """Build a fake deadline dict with due_date set to N days from now in UTC."""
    from datetime import timedelta
    now_local = datetime.now(tz)
    target_local = now_local.replace(hour=23, minute=59, second=59, microsecond=0)
    target_date = target_local.date()
    # Add days to the local date, then express at 23:59:59 in that timezone
    from datetime import date
    target_local_dt = datetime(
        target_date.year, target_date.month, target_date.day,
        23, 59, 59, tzinfo=tz
    )
    due_dt = target_local_dt + timedelta(days=days_from_now)
    return {
        "title": f"Exam T-{days_from_now}",
        "course": "PHYS 101",
        "type": type_,
        "due_date": due_dt.isoformat(),
    }


def test_get_exam_touchpoints_t7():
    """Exam 7 days out returns entry with days_until=7."""
    tz = ZoneInfo("America/New_York")
    deadline = _make_exam(7, tz)
    results = get_exam_touchpoints([deadline], tz)
    assert len(results) == 1
    assert results[0]["days_until"] == 7


def test_get_exam_touchpoints_t0():
    """Exam today (0 days) returns entry with days_until=0."""
    tz = ZoneInfo("America/New_York")
    deadline = _make_exam(0, tz)
    results = get_exam_touchpoints([deadline], tz)
    assert len(results) == 1
    assert results[0]["days_until"] == 0


def test_get_exam_touchpoints_non_exam_ignored():
    """Non-exam deadline 7 days out returns empty list."""
    tz = ZoneInfo("America/New_York")
    deadline = _make_exam(7, tz, type_="assignment")
    results = get_exam_touchpoints([deadline], tz)
    assert results == []


def test_get_exam_touchpoints_t4_not_touchpoint():
    """Exam 4 days out returns empty list (4 is not in {7,5,3,1,0})."""
    tz = ZoneInfo("America/New_York")
    deadline = _make_exam(4, tz)
    results = get_exam_touchpoints([deadline], tz)
    assert results == []


def test_exam_touchpoint_timezone_aware():
    """Exam at 23:59:59 UTC on March 26 2026 should be 7 days from March 19 2026 in EST.

    This tests the timezone-aware date comparison — using user's local date
    prevents off-by-one errors for all-day events stored as 23:59:59 UTC.
    """
    tz = ZoneInfo("America/New_York")
    deadline = {
        "title": "Big Physics Exam",
        "course": "PHYS 101",
        "type": "exam",
        "due_date": "2026-03-26T23:59:59+00:00",
    }
    # Mock datetime.now to return March 19 2026 at 8am EST
    mock_now = datetime(2026, 3, 19, 8, 0, 0, tzinfo=tz)
    with patch("ai.briefing.datetime") as mock_dt:
        mock_dt.now.return_value = mock_now
        mock_dt.fromisoformat = datetime.fromisoformat
        results = get_exam_touchpoints([deadline], tz)
    assert len(results) == 1
    assert results[0]["days_until"] == 7


# ---------------------------------------------------------------------------
# is_in_briefing_window tests
# ---------------------------------------------------------------------------


def test_is_in_briefing_window_true():
    """User in America/New_York at local hour 8 returns True."""
    tz = ZoneInfo("America/New_York")
    mock_now = datetime(2026, 3, 19, 8, 30, 0, tzinfo=tz)
    with patch("ai.briefing.datetime") as mock_dt:
        mock_dt.now.return_value = mock_now
        result = is_in_briefing_window({"timezone": "America/New_York"})
    assert result is True


def test_is_in_briefing_window_false():
    """User in America/New_York at local hour 9 returns False."""
    tz = ZoneInfo("America/New_York")
    mock_now = datetime(2026, 3, 19, 9, 0, 0, tzinfo=tz)
    with patch("ai.briefing.datetime") as mock_dt:
        mock_dt.now.return_value = mock_now
        result = is_in_briefing_window({"timezone": "America/New_York"})
    assert result is False


# ---------------------------------------------------------------------------
# generate_briefing tests
# ---------------------------------------------------------------------------


def _mock_anthropic_response(text: str) -> MagicMock:
    """Build a mock Anthropic client.messages.create() return value."""
    mock_content = MagicMock()
    mock_content.text = text

    mock_usage = MagicMock()
    mock_usage.input_tokens = 100
    mock_usage.output_tokens = 50

    mock_response = MagicMock()
    mock_response.content = [mock_content]
    mock_response.usage = mock_usage
    return mock_response


def test_monday_uses_7day_window():
    """When is_monday=True, generate_briefing is called with no 48h-only filtering.

    We verify this indirectly: on Monday the deadlines window is 7 days, so deadlines
    further than 2 days are included in the context passed to Claude.
    The plan test verifies days_ahead=7 is passed to get_deadlines_for_briefing,
    but since generate_briefing takes pre-fetched deadlines, we verify the Monday
    prompt is used by checking MONDAY_EXTENDED_SYSTEM_PROMPT is in the system arg.
    """
    from ai.briefing import MONDAY_EXTENDED_SYSTEM_PROMPT
    deadlines = []
    mock_resp = _mock_anthropic_response("Have a great Monday!")

    with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.return_value = mock_resp

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = generate_briefing("user-123", deadlines, is_monday=True)

        call_kwargs = mock_client.messages.create.call_args.kwargs
        assert call_kwargs["system"] == MONDAY_EXTENDED_SYSTEM_PROMPT


def test_weekday_uses_2day_window():
    """When is_monday=False, the standard briefing prompt is used."""
    from ai.briefing import BRIEFING_SYSTEM_PROMPT
    deadlines = []
    mock_resp = _mock_anthropic_response("Clear day!")

    with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.return_value = mock_resp

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = generate_briefing("user-123", deadlines, is_monday=False)

        call_kwargs = mock_client.messages.create.call_args.kwargs
        assert call_kwargs["system"] == BRIEFING_SYSTEM_PROMPT


def test_generate_briefing_calls_claude():
    """Mock Anthropic client; verify messages.create called with correct model and system containing 'Aria'."""
    mock_resp = _mock_anthropic_response("Hey! Clear day ahead.")

    with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.return_value = mock_resp

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            generate_briefing("user-abc", [])

        mock_client.messages.create.assert_called_once()
        call_kwargs = mock_client.messages.create.call_args.kwargs
        assert call_kwargs["model"] == "claude-sonnet-4-6"
        assert "Aria" in call_kwargs["system"]


def test_generate_briefing_returns_text():
    """Mock Anthropic returns 'Hey! Clear day ahead.', verify function returns that string."""
    expected = "Hey! Clear day ahead."
    mock_resp = _mock_anthropic_response(expected)

    with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.return_value = mock_resp

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = generate_briefing("user-abc", [])

    assert result == expected


def test_briefing_truncates_over_800():
    """Mock Anthropic returns 900-char string, verify output is <= 800 chars."""
    long_text = "A" * 900
    mock_resp = _mock_anthropic_response(long_text)

    with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.return_value = mock_resp

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = generate_briefing("user-abc", [])

    assert len(result) <= 800
    assert result.endswith("...")
