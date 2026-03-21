"""Unit tests for syllabus_context enrichment in briefing — generate_briefing and generate_daily_briefing_user.

Tests cover:
- generate_briefing with syllabus_context includes EXAM TOPIC HINTS in Claude prompt
- generate_briefing with syllabus_context=None produces identical behavior (backwards compatible)
- generate_briefing on Monday with syllabus_context includes coverage_summaries
- generate_briefing on non-Monday with syllabus_context does NOT include coverage_summaries
- generate_daily_briefing_user calls get_syllabus_context and passes result through
"""
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch, call
from zoneinfo import ZoneInfo

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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
# generate_briefing syllabus_context enrichment
# ---------------------------------------------------------------------------


def test_briefing_includes_syllabus_context():
    """generate_briefing includes EXAM TOPIC HINTS in Claude prompt when syllabus_context provided."""
    from ai.briefing import generate_briefing

    mock_resp = _mock_anthropic_response("Your exams are coming up!")

    syllabus_context = {
        "exam_topic_hints": ["BIOL 201: Krebs cycle, glycolysis, ATP synthesis"],
        "coverage_summaries": [],
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
                    syllabus_context=syllabus_context,
                )

            call_kwargs = mock_client.messages.create.call_args.kwargs
            context_text = call_kwargs["messages"][0]["content"]

            assert "EXAM TOPIC HINTS" in context_text
            assert "BIOL 201" in context_text
            assert "Krebs cycle" in context_text


def test_briefing_no_syllabus_context_unchanged():
    """generate_briefing with syllabus_context=None produces identical behavior to before."""
    from ai.briefing import generate_briefing

    mock_resp = _mock_anthropic_response("Looking good!")

    with patch("ai.briefing._count_items_due_today", return_value=(0, [])):
        with patch("ai.briefing.Anthropic") as mock_anthropic_cls:
            mock_client = MagicMock()
            mock_anthropic_cls.return_value = mock_client
            mock_client.messages.create.return_value = mock_resp

            with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
                result = generate_briefing(
                    "user-123",
                    [],
                    is_monday=True,
                    syllabus_context=None,
                )

            call_kwargs = mock_client.messages.create.call_args.kwargs
            context_text = call_kwargs["messages"][0]["content"]

            # No syllabus sections should appear when context is None
            assert "EXAM TOPIC HINTS" not in context_text
            assert "EXAM TOPIC COVERAGE" not in context_text
            assert result == "Looking good!"


def test_briefing_monday_includes_coverage_summaries():
    """generate_briefing on Monday with coverage_summaries includes EXAM TOPIC COVERAGE in prompt."""
    from ai.briefing import generate_briefing

    mock_resp = _mock_anthropic_response("Big week ahead!")

    syllabus_context = {
        "exam_topic_hints": ["BIOL 201: Krebs cycle, glycolysis"],
        "coverage_summaries": ["BIOL 201 Midterm: covers Krebs cycle, glycolysis, ATP synthesis"],
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
                    syllabus_context=syllabus_context,
                )

            call_kwargs = mock_client.messages.create.call_args.kwargs
            context_text = call_kwargs["messages"][0]["content"]

            assert "EXAM TOPIC HINTS" in context_text
            assert "EXAM TOPIC COVERAGE" in context_text
            assert "Krebs cycle" in context_text


def test_briefing_non_monday_skips_coverage_summaries():
    """generate_briefing on non-Monday with coverage_summaries does NOT include EXAM TOPIC COVERAGE."""
    from ai.briefing import generate_briefing

    mock_resp = _mock_anthropic_response("Busy day ahead!")

    syllabus_context = {
        "exam_topic_hints": ["BIOL 201: Krebs cycle"],
        "coverage_summaries": ["BIOL 201 Midterm: covers Krebs cycle, glycolysis"],
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
                    syllabus_context=syllabus_context,
                )

            call_kwargs = mock_client.messages.create.call_args.kwargs
            context_text = call_kwargs["messages"][0]["content"]

            # Hints included but NOT coverage summaries on non-Monday
            assert "EXAM TOPIC HINTS" in context_text
            assert "EXAM TOPIC COVERAGE" not in context_text


# ---------------------------------------------------------------------------
# generate_daily_briefing_user wiring
# ---------------------------------------------------------------------------


def test_generate_daily_briefing_user_calls_get_syllabus_context():
    """generate_daily_briefing_user calls get_syllabus_context and passes result to generate_briefing."""
    from celery_app import celery_app

    mock_syllabus_context = {
        "exam_topic_hints": ["BIOL 201: Krebs cycle"],
        "coverage_summaries": [],
    }

    mock_user = {
        "phone": "+12035551234",
        "preferences_json": {"timezone": "America/New_York"},
        "opt_in": True,
        "quiet_start": None,
        "quiet_end": None,
        "daily_count": 0,
    }

    mock_events = []

    with patch("sms.send._get_user_sms_state", return_value=mock_user):
        with patch("ai.briefing.is_in_briefing_window", return_value=True):
            with patch("ai.db.briefing_sent_today", return_value=False):
                with patch("ai.db.get_events_for_briefing", return_value=mock_events):
                    with patch("ai.briefing.get_briefing_gcal_context", return_value=None):
                        with patch("ai.syllabus.get_syllabus_context", return_value=mock_syllabus_context) as mock_get_ctx:
                            with patch("ai.briefing.generate_briefing", return_value="Hello!") as mock_gen:
                                with patch("sms.send.send_sms_safe", return_value=True):
                                    with patch("ai.db.write_outbound_message"):
                                        from tasks import generate_daily_briefing_user
                                        result = generate_daily_briefing_user.apply(
                                            args=["user-123"]
                                        ).get()

    # get_syllabus_context must have been called
    assert mock_get_ctx.called
    # generate_briefing must have been called with syllabus_context kwarg
    assert mock_gen.called
    call_kwargs = mock_gen.call_args.kwargs
    assert "syllabus_context" in call_kwargs
    assert call_kwargs["syllabus_context"] == mock_syllabus_context
