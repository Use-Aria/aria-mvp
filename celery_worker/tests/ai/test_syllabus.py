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
