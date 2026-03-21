"""Unit tests for syllabus parsing module (celery_worker/ai/syllabus.py).

All tests are pure unit tests — no Supabase calls, no Anthropic calls.
Anthropic client is mocked throughout via @patch("ai.syllabus.Anthropic").
Supabase client is mocked via @patch("ai.db._get_supabase").
"""
import json
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_anthropic_text_response(text: str) -> MagicMock:
    """Build a mock Anthropic messages.create() return value."""
    mock_content = MagicMock()
    mock_content.text = text

    mock_response = MagicMock()
    mock_response.content = [mock_content]
    return mock_response


VALID_PARSED_JSON = {
    "course_name": "CPSC 223",
    "exams": [
        {
            "title": "Midterm",
            "date_str": "October 15",
            "topics": ["sorting", "graphs"],
            "weight_pct": 25,
        }
    ],
    "assignments": [
        {"type": "Problem Set", "weight_pct": 40}
    ],
    "total_tracked_weight_pct": 65,
}


# ---------------------------------------------------------------------------
# parse_syllabus_pdf tests
# ---------------------------------------------------------------------------


def test_parse_syllabus_calls_opus():
    """parse_syllabus_pdf calls Claude Opus via document block API and returns valid parsed dict."""
    from ai.syllabus import parse_syllabus_pdf

    pdf_bytes = b"%PDF fake content"
    response_text = json.dumps(VALID_PARSED_JSON)

    with patch("ai.syllabus.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.messages.create.return_value = _mock_anthropic_text_response(response_text)

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = parse_syllabus_pdf(pdf_bytes)

    assert result is not None
    mock_client.messages.create.assert_called_once()
    call_kwargs = mock_client.messages.create.call_args.kwargs
    assert call_kwargs["model"] == "claude-opus-4-6"

    # Verify document block is present in messages
    messages = call_kwargs["messages"]
    assert len(messages) == 1
    assert messages[0]["role"] == "user"
    content_blocks = messages[0]["content"]
    doc_block = next((b for b in content_blocks if b.get("type") == "document"), None)
    assert doc_block is not None, "document block must be in message content"
    assert doc_block["source"]["type"] == "base64"
    assert doc_block["source"]["media_type"] == "application/pdf"


def test_parse_syllabus_returns_valid_schema():
    """parse_syllabus_pdf returns dict with required schema keys."""
    from ai.syllabus import parse_syllabus_pdf

    pdf_bytes = b"%PDF fake content"
    response_text = json.dumps(VALID_PARSED_JSON)

    with patch("ai.syllabus.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.messages.create.return_value = _mock_anthropic_text_response(response_text)

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = parse_syllabus_pdf(pdf_bytes)

    assert isinstance(result, dict)
    assert "course_name" in result
    assert "exams" in result
    assert "assignments" in result
    assert "total_tracked_weight_pct" in result


def test_parse_syllabus_strips_markdown_fences():
    """parse_syllabus_pdf strips markdown code fences before json.loads."""
    from ai.syllabus import parse_syllabus_pdf

    pdf_bytes = b"%PDF fake content"
    # Claude sometimes wraps JSON in code fences
    response_text = f"```json\n{json.dumps(VALID_PARSED_JSON)}\n```"

    with patch("ai.syllabus.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.messages.create.return_value = _mock_anthropic_text_response(response_text)

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = parse_syllabus_pdf(pdf_bytes)

    assert result is not None
    assert result["course_name"] == "CPSC 223"


def test_parse_syllabus_handles_bad_json():
    """parse_syllabus_pdf returns None when Claude response is not valid JSON."""
    from ai.syllabus import parse_syllabus_pdf

    pdf_bytes = b"%PDF fake content"

    with patch("ai.syllabus.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.messages.create.return_value = _mock_anthropic_text_response(
            "This is not valid JSON at all!"
        )

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = parse_syllabus_pdf(pdf_bytes)

    assert result is None


def test_parse_syllabus_handles_anthropic_exception():
    """parse_syllabus_pdf returns None when Anthropic client raises an exception."""
    from ai.syllabus import parse_syllabus_pdf

    pdf_bytes = b"%PDF fake content"

    with patch("ai.syllabus.Anthropic") as mock_cls:
        mock_client = MagicMock()
        mock_cls.return_value = mock_client
        mock_client.messages.create.side_effect = Exception("API error")

        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
            result = parse_syllabus_pdf(pdf_bytes)

    assert result is None


# ---------------------------------------------------------------------------
# upsert_syllabus tests
# ---------------------------------------------------------------------------


def test_upsert_syllabus_idempotent():
    """upsert_syllabus calls supabase.table("syllabi").upsert() with on_conflict="user_id,course_name"."""
    from ai.syllabus import upsert_syllabus

    mock_supabase = MagicMock()

    with patch("ai.db._get_supabase", return_value=mock_supabase):
        upsert_syllabus("user-123", "CPSC 223", VALID_PARSED_JSON)

    mock_supabase.table.assert_called_once_with("syllabi")
    upsert_call = mock_supabase.table.return_value.upsert
    upsert_call.assert_called_once()
    call_args = upsert_call.call_args
    # on_conflict must be "user_id,course_name"
    assert call_args.kwargs.get("on_conflict") == "user_id,course_name"
    # upsert payload must include user_id and course_name
    payload = call_args.args[0]
    assert payload["user_id"] == "user-123"
    assert payload["course_name"] == "CPSC 223"
    assert payload["parsed_json"] == VALID_PARSED_JSON


def test_upsert_syllabus_sets_uploaded_at():
    """upsert_syllabus sets uploaded_at to a non-None UTC timestamp string."""
    from ai.syllabus import upsert_syllabus

    mock_supabase = MagicMock()

    with patch("ai.db._get_supabase", return_value=mock_supabase):
        upsert_syllabus("user-123", "CPSC 223", VALID_PARSED_JSON)

    upsert_call = mock_supabase.table.return_value.upsert
    payload = upsert_call.call_args.args[0]
    assert "uploaded_at" in payload
    assert payload["uploaded_at"] is not None
    # Should be an ISO 8601 string containing UTC indicator
    assert isinstance(payload["uploaded_at"], str)
    assert "+" in payload["uploaded_at"] or payload["uploaded_at"].endswith("Z")


# ---------------------------------------------------------------------------
# check_existing_syllabus tests
# ---------------------------------------------------------------------------


def test_check_existing_syllabus_returns_parsed_json_when_row_exists():
    """check_existing_syllabus returns parsed_json dict when row exists with non-null parsed_json."""
    from ai.syllabus import check_existing_syllabus

    mock_supabase = MagicMock()
    mock_supabase.table.return_value.select.return_value \
        .eq.return_value.eq.return_value \
        .not_.is_.return_value.limit.return_value \
        .execute.return_value.data = [{"parsed_json": VALID_PARSED_JSON}]

    with patch("ai.db._get_supabase", return_value=mock_supabase):
        result = check_existing_syllabus("user-123", "CPSC 223")

    assert result == VALID_PARSED_JSON


def test_check_existing_syllabus_returns_none_when_no_row():
    """check_existing_syllabus returns None when no row exists."""
    from ai.syllabus import check_existing_syllabus

    mock_supabase = MagicMock()
    mock_supabase.table.return_value.select.return_value \
        .eq.return_value.eq.return_value \
        .not_.is_.return_value.limit.return_value \
        .execute.return_value.data = []

    with patch("ai.db._get_supabase", return_value=mock_supabase):
        result = check_existing_syllabus("user-123", "CPSC 223")

    assert result is None


# ---------------------------------------------------------------------------
# get_gap_topics tests
# ---------------------------------------------------------------------------


def _make_syllabi_supabase_mock(parsed_json_data):
    """Build a mock Supabase client for syllabi queries (get_gap_topics / get_syllabus_context)."""
    mock_supabase = MagicMock()
    chain = MagicMock()
    chain.data = parsed_json_data
    chain.execute.return_value = chain
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.ilike.return_value = chain
    chain.limit.return_value = chain
    chain.not_ = MagicMock()
    chain.not_.is_.return_value = chain
    mock_supabase.table.return_value = chain
    return mock_supabase


def test_get_gap_topics_returns_top3_topics_for_upcoming_exam():
    """get_gap_topics returns up to 3 topics (sorted by weight_pct desc) when syllabus exists."""
    from ai.syllabus import get_gap_topics

    parsed_json = {
        "course_name": "BIOL 201",
        "exams": [
            {
                "title": "Midterm",
                "date_str": "March 15",
                "topics": ["Krebs cycle", "glycolysis", "ATP synthesis", "electron transport"],
                "weight_pct": 25,
            }
        ],
        "assignments": [],
        "total_tracked_weight_pct": 25,
    }

    mock_supabase = _make_syllabi_supabase_mock([{"parsed_json": parsed_json}])

    with patch("ai.db._get_supabase", return_value=mock_supabase):
        result = get_gap_topics("user-123", "BIOL 201")

    assert len(result) == 3
    assert all("topic" in t for t in result)
    assert result[0]["topic"] == "Krebs cycle"


def test_get_gap_topics_returns_empty_when_no_syllabus():
    """get_gap_topics returns [] when no syllabus exists for the course (graceful degradation)."""
    from ai.syllabus import get_gap_topics

    mock_supabase = _make_syllabi_supabase_mock([])

    with patch("ai.db._get_supabase", return_value=mock_supabase):
        result = get_gap_topics("user-123", "MATH 101")

    assert result == []


def test_get_gap_topics_uses_ilike_for_course_matching():
    """get_gap_topics uses ILIKE (case-insensitive) query against syllabi.course_name."""
    from ai.syllabus import get_gap_topics

    mock_supabase = MagicMock()
    chain = MagicMock()
    chain.data = []
    chain.execute.return_value = chain
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.ilike.return_value = chain
    chain.limit.return_value = chain
    mock_supabase.table.return_value = chain

    with patch("ai.db._get_supabase", return_value=mock_supabase):
        get_gap_topics("user-123", "biol 201")

    # Verify ilike was called (case-insensitive course matching)
    assert chain.ilike.called


# ---------------------------------------------------------------------------
# build_gap_alert_body tests
# ---------------------------------------------------------------------------


def test_gap_alert_body_format():
    """build_gap_alert_body produces SMS with course, exam title, days_until, and topics."""
    from ai.syllabus import build_gap_alert_body

    topics = [
        {"topic": "Krebs cycle", "weight_pct": 25},
        {"topic": "glycolysis", "weight_pct": 25},
        {"topic": "ATP synthesis", "weight_pct": 25},
    ]
    body = build_gap_alert_body("BIOL 201", 5, "Midterm", topics)

    assert "BIOL 201" in body
    assert "Midterm" in body
    assert "5" in body
    assert "Krebs cycle" in body
    assert len(body) <= 800


def test_gap_alert_body_truncates_to_800_chars():
    """build_gap_alert_body truncates to 800 chars with '...' when body exceeds limit."""
    from ai.syllabus import build_gap_alert_body

    # Use a very long course name and topics to exceed 800 chars
    long_course = "A" * 400
    topics = [
        {"topic": "T" * 200, "weight_pct": 25},
        {"topic": "U" * 200, "weight_pct": 25},
        {"topic": "V" * 200, "weight_pct": 25},
    ]
    body = build_gap_alert_body(long_course, 5, "Final Exam", topics)

    assert len(body) == 800
    assert body.endswith("...")


# ---------------------------------------------------------------------------
# gap_analysis_all_users + run_gap_analysis_task tests
# ---------------------------------------------------------------------------


def test_gap_analysis_all_users_dispatches_per_exam():
    """gap_analysis_all_users queries canonical_events for T-5 exams and dispatches run_gap_analysis_task per match."""
    from celery_app import celery_app

    exam_rows = [
        {"id": "evt-001", "user_id": "user-001", "title": "Midterm", "course_id": "BIOL 201", "due_at": "2026-03-26T23:59:59+00:00"},
        {"id": "evt-002", "user_id": "user-002", "title": "Final", "course_id": "CPSC 223", "due_at": "2026-03-26T23:59:59+00:00"},
    ]

    mock_supabase = MagicMock()
    chain = MagicMock()
    chain.data = exam_rows
    chain.execute.return_value = chain
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.gte.return_value = chain
    chain.lte.return_value = chain
    mock_supabase.table.return_value = chain

    with patch("ai.db._get_supabase", return_value=mock_supabase):
        with patch("tasks.run_gap_analysis_task") as mock_task:
            mock_task.delay = MagicMock()
            from tasks import gap_analysis_all_users
            result = gap_analysis_all_users()

    assert result["status"] == "ok"
    assert result["dispatched"] == 2
    assert mock_task.delay.call_count == 2


def test_gap_analysis_skips_no_syllabus():
    """run_gap_analysis_task skips silently (no SMS) when get_gap_topics returns empty list."""
    with patch("ai.syllabus.get_gap_topics", return_value=[]):
        with patch("sms.batch.enqueue_alert") as mock_enqueue:
            from tasks import run_gap_analysis_task
            # Use apply() to run synchronously without Celery
            result = run_gap_analysis_task.apply(
                args=["user-123", "evt-001", "MATH 101", "Final"]
            ).get()

    assert result["status"] == "skipped"
    mock_enqueue.assert_not_called()


def test_gap_analysis_enqueues_alert_with_priority_75():
    """run_gap_analysis_task calls enqueue_alert with priority_score=75 when topics exist."""
    topics = [{"topic": "Krebs cycle", "weight_pct": 25}]

    with patch("ai.syllabus.get_gap_topics", return_value=topics):
        with patch("ai.syllabus.build_gap_alert_body", return_value="Gap alert body text"):
            with patch("sms.batch.enqueue_alert", return_value=False) as mock_enqueue:
                with patch("tasks.flush_sms_batch") as mock_flush:
                    mock_flush.apply_async = MagicMock()
                    from tasks import run_gap_analysis_task
                    result = run_gap_analysis_task.apply(
                        args=["user-123", "evt-001", "BIOL 201", "Midterm"]
                    ).get()

    assert result["status"] == "queued"
    mock_enqueue.assert_called_once()
    call_kwargs = mock_enqueue.call_args
    # Check priority_score=75
    assert call_kwargs.kwargs.get("priority_score") == 75 or call_kwargs.args[2] == 75
