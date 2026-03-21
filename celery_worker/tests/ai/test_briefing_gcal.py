"""Unit tests for GCal enrichment in briefing — get_briefing_gcal_context and generate_briefing.

Tests cover:
- get_briefing_gcal_context returns empty dict when no Google integration
- get_briefing_gcal_context returns conflicts and study_windows when connected
- generate_briefing includes conflict text when gcal_context provided
- generate_briefing includes study_windows when gcal_context provided
- generate_briefing skips gcal_context on non-Monday
"""
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch, call
from zoneinfo import ZoneInfo

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_supabase_mock(has_google=True, conflicts=None, deadlines=None, events=None, users=None):
    """Build a mock Supabase client for get_briefing_gcal_context tests."""
    conflicts = conflicts or []
    deadlines = deadlines or []
    events = events or []
    users = users or []

    client = MagicMock()

    def make_chain(data):
        chain = MagicMock()
        chain.data = data
        chain.execute.return_value = chain
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.gte.return_value = chain
        chain.lte.return_value = chain
        return chain

    def _table(name):
        mock_table = MagicMock()
        if name == "integrations":
            data = [{"user_id": "user-123"}] if has_google else []
            mock_table.select.return_value = make_chain(data)
        elif name == "conflict_alerts":
            mock_table.select.return_value = make_chain(conflicts)
        elif name == "deadlines":
            mock_table.select.return_value = make_chain(deadlines)
        elif name == "calendar_events":
            mock_table.select.return_value = make_chain(events)
        elif name == "users":
            mock_table.select.return_value = make_chain(users)
        else:
            mock_table.select.return_value = make_chain([])
        return mock_table

    client.table.side_effect = _table
    return client


def _mock_anthropic_response(text: str) -> MagicMock:
    """Build a mock Anthropic response."""
    mock_content = MagicMock()
    mock_content.text = text
    mock_usage = MagicMock()
    mock_usage.input_tokens = 100
    mock_usage.output_tokens = 50
    mock_response = MagicMock()
    mock_response.content = [mock_content]
    mock_response.usage = mock_usage
    return mock_response


# ---------------------------------------------------------------------------
# get_briefing_gcal_context
# ---------------------------------------------------------------------------


@patch("ai.db._get_supabase")
def test_gcal_context_no_integration_returns_empty(mock_get_sb):
    """get_briefing_gcal_context returns empty dict if user has no Google integration."""
    from ai.briefing import get_briefing_gcal_context

    mock_get_sb.return_value = _make_supabase_mock(has_google=False)

    result = get_briefing_gcal_context("user-123")

    assert result == {}


@patch("gcal.db.get_calendar_events")
@patch("ai.db._get_supabase")
def test_gcal_context_returns_empty_conflicts_when_none(mock_get_sb, mock_get_events):
    """get_briefing_gcal_context returns empty conflicts list when none active."""
    from ai.briefing import get_briefing_gcal_context

    mock_get_sb.return_value = _make_supabase_mock(
        has_google=True,
        conflicts=[],
        users=[{"preferences_json": {"study_preference": "evening"}, "timezone": "America/New_York"}],
    )
    mock_get_events.return_value = []

    result = get_briefing_gcal_context("user-123")

    assert "conflicts" in result
    assert result["conflicts"] == []
    assert "study_windows" in result


@patch("gcal.db.get_calendar_events")
@patch("ai.db._get_supabase")
def test_gcal_context_returns_conflicts_list(mock_get_sb, mock_get_events):
    """get_briefing_gcal_context returns formatted conflict strings."""
    from ai.briefing import get_briefing_gcal_context

    conflicts_raw = [{
        "deadline_id": "dl-001",
        "gcal_event_id": "gcal-001",
        "deadline_due_at": "2026-03-25T23:59:59+00:00",
        "gcal_event_date": "2026-03-25",
    }]
    deadlines = [{"title": "Bio Lab Report", "course": "BIOL 101"}]
    events = [{"title": "Soccer Practice", "start_time": "2026-03-25T14:00:00+00:00", "end_time": "2026-03-25T16:00:00+00:00"}]
    users = [{"preferences_json": {"study_preference": "evening"}, "timezone": "America/New_York"}]

    mock_get_sb.return_value = _make_supabase_mock(
        has_google=True,
        conflicts=conflicts_raw,
        deadlines=deadlines,
        events=events,
        users=users,
    )
    mock_get_events.return_value = []

    result = get_briefing_gcal_context("user-123")

    assert len(result["conflicts"]) == 1
    assert "Bio Lab Report" in result["conflicts"][0]
    assert "2026-03-25" in result["conflicts"][0]


@patch("gcal.slots.find_free_slots")
@patch("gcal.db.get_calendar_events")
@patch("ai.db._get_supabase")
def test_gcal_context_caps_study_windows_at_three(mock_get_sb, mock_get_events, mock_find_slots):
    """get_briefing_gcal_context returns at most 3 study windows."""
    from ai.briefing import get_briefing_gcal_context

    mock_get_sb.return_value = _make_supabase_mock(
        has_google=True,
        conflicts=[],
        users=[{"preferences_json": {"study_preference": "evening"}, "timezone": "America/New_York"}],
    )
    mock_get_events.return_value = []

    # Return 2 slots per day * 7 days = 14 total, should cap at 3
    mock_find_slots.return_value = [
        {"start": "2026-03-23T07:00:00-04:00", "end": "2026-03-23T12:00:00-04:00", "duration_hours": 5.0},
        {"start": "2026-03-23T17:00:00-04:00", "end": "2026-03-23T22:00:00-04:00", "duration_hours": 5.0},
    ]

    result = get_briefing_gcal_context("user-123")

    assert len(result["study_windows"]) <= 3


# ---------------------------------------------------------------------------
# generate_briefing with gcal_context
# ---------------------------------------------------------------------------


def test_generate_briefing_includes_conflicts_in_prompt():
    """generate_briefing includes SCHEDULING CONFLICTS in Claude prompt when gcal_context provided."""
    from ai.briefing import generate_briefing

    mock_resp = _mock_anthropic_response("Your week looks busy!")

    gcal_context = {
        "conflicts": ["Bio Lab Report due 2026-03-25 — you have Soccer Practice that day"],
        "study_windows": ["Wednesday 6pm-10pm free (4h)"],
    }

    with patch("ai.briefing._count_items_due_today", return_value=(0, [])):
        with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
            mock_client = MagicMock()
            mock_anthropic_cls.return_value = mock_client
            mock_client.messages.create.return_value = mock_resp

            with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
                generate_briefing(
                    "user-123",
                    [],
                    is_monday=True,
                    gcal_context=gcal_context,
                )

            call_kwargs = mock_client.messages.create.call_args.kwargs
            context_text = call_kwargs["messages"][0]["content"]

            assert "SCHEDULING CONFLICTS THIS WEEK" in context_text
            assert "Bio Lab Report" in context_text


def test_generate_briefing_includes_study_windows_in_prompt():
    """generate_briefing includes BEST AVAILABLE STUDY WINDOWS in Claude prompt."""
    from ai.briefing import generate_briefing

    mock_resp = _mock_anthropic_response("Here's your week!")

    gcal_context = {
        "conflicts": [],
        "study_windows": ["Monday 6pm-10pm free (4h)", "Tuesday 7am-12pm free (5h)"],
    }

    with patch("ai.briefing._count_items_due_today", return_value=(0, [])):
        with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
            mock_client = MagicMock()
            mock_anthropic_cls.return_value = mock_client
            mock_client.messages.create.return_value = mock_resp

            with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
                generate_briefing(
                    "user-123",
                    [],
                    is_monday=True,
                    gcal_context=gcal_context,
                )

            call_kwargs = mock_client.messages.create.call_args.kwargs
            context_text = call_kwargs["messages"][0]["content"]

            assert "BEST AVAILABLE STUDY WINDOWS" in context_text
            assert "Monday 6pm-10pm free" in context_text


def test_generate_briefing_skips_gcal_context_on_non_monday():
    """generate_briefing does NOT include gcal_context in prompt when is_monday=False."""
    from ai.briefing import generate_briefing

    mock_resp = _mock_anthropic_response("Clear day ahead!")

    gcal_context = {
        "conflicts": ["Bio Lab Report due tomorrow"],
        "study_windows": ["Tonight 6pm-10pm free"],
    }

    with patch("ai.briefing._count_items_due_today", return_value=(0, [])):
        with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
            mock_client = MagicMock()
            mock_anthropic_cls.return_value = mock_client
            mock_client.messages.create.return_value = mock_resp

            with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
                generate_briefing(
                    "user-123",
                    [],
                    is_monday=False,
                    gcal_context=gcal_context,
                )

            call_kwargs = mock_client.messages.create.call_args.kwargs
            context_text = call_kwargs["messages"][0]["content"]

            # Should NOT include conflict/study window sections on non-Monday
            assert "SCHEDULING CONFLICTS THIS WEEK" not in context_text
            assert "BEST AVAILABLE STUDY WINDOWS" not in context_text


def test_generate_briefing_works_without_gcal_context():
    """generate_briefing works normally with gcal_context=None (backwards compatible)."""
    from ai.briefing import generate_briefing

    mock_resp = _mock_anthropic_response("Looking good!")

    with patch("ai.briefing._count_items_due_today", return_value=(0, [])):
        with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
            mock_client = MagicMock()
            mock_anthropic_cls.return_value = mock_client
            mock_client.messages.create.return_value = mock_resp

            with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
                result = generate_briefing("user-123", [], is_monday=True, gcal_context=None)

    assert result == "Looking good!"
