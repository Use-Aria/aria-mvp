"""Tests for gmail.classify and gmail.fetch — email classification and message fetching.

Tests cover: classify_email (Claude Haiku call + JSON parsing + error fallback),
find_matching_deadline (rapidfuzz fuzzy matching), decode_pubsub_message,
and fetch_new_messages (.edu filter).
"""
import base64
import json
from unittest.mock import MagicMock, patch
import pytest


# Pre-import modules under test so patch targets resolve correctly
import gmail.classify
import gmail.fetch


# ---------------------------------------------------------------------------
# classify_email tests
# ---------------------------------------------------------------------------

def _make_haiku_response(is_deadline_change: bool, confidence: float):
    """Build a mock Anthropic messages.create() response for Haiku."""
    msg = MagicMock()
    msg.content = [MagicMock()]
    msg.content[0].text = json.dumps({
        "is_deadline_change": is_deadline_change,
        "confidence": confidence,
    })
    return msg


@patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"})
@patch("gmail.classify.Anthropic")
def test_classify_email_deadline_change_high_confidence(mock_anthropic_cls):
    """classify_email returns is_deadline_change=True with confidence >= 0.8 for clear deadline changes."""
    from gmail.classify import classify_email

    mock_client = MagicMock()
    mock_anthropic_cls.return_value = mock_client
    mock_client.messages.create.return_value = _make_haiku_response(True, 0.92)

    result = classify_email(
        "Exam 2 postponed to next week",
        "Hi class, due to scheduling conflicts, Exam 2 has been moved to next Friday.",
    )

    assert result["is_deadline_change"] is True
    assert result["confidence"] >= 0.8


@patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"})
@patch("gmail.classify.Anthropic")
def test_classify_email_uses_haiku_model(mock_anthropic_cls):
    """classify_email uses the claude-haiku-4-5-20251001 model — not Sonnet or Opus."""
    from gmail.classify import classify_email

    mock_client = MagicMock()
    mock_anthropic_cls.return_value = mock_client
    mock_client.messages.create.return_value = _make_haiku_response(False, 0.3)

    classify_email("Office hours cancelled", "No office hours this week.")

    call_kwargs = mock_client.messages.create.call_args[1]
    assert call_kwargs["model"] == "claude-haiku-4-5-20251001"


@patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"})
@patch("gmail.classify.Anthropic")
def test_classify_email_non_deadline_low_confidence(mock_anthropic_cls):
    """classify_email returns is_deadline_change=False for general announcements."""
    from gmail.classify import classify_email

    mock_client = MagicMock()
    mock_anthropic_cls.return_value = mock_client
    mock_client.messages.create.return_value = _make_haiku_response(False, 0.15)

    result = classify_email(
        "Office hours cancelled",
        "No office hours this week due to travel.",
    )

    assert result["is_deadline_change"] is False
    assert "confidence" in result


@patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"})
@patch("gmail.classify.Anthropic")
def test_classify_email_returns_valid_json_for_ambiguous_emails(mock_anthropic_cls):
    """classify_email always returns a dict with required keys."""
    from gmail.classify import classify_email

    mock_client = MagicMock()
    mock_anthropic_cls.return_value = mock_client
    mock_client.messages.create.return_value = _make_haiku_response(False, 0.5)

    result = classify_email("FYI — course update", "Just a general note.")

    assert "is_deadline_change" in result
    assert "confidence" in result
    assert isinstance(result["confidence"], float)


@patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"})
@patch("gmail.classify.Anthropic")
def test_classify_email_error_fallback(mock_anthropic_cls):
    """classify_email returns safe fallback dict when Anthropic raises."""
    from gmail.classify import classify_email

    mock_client = MagicMock()
    mock_anthropic_cls.return_value = mock_client
    mock_client.messages.create.side_effect = Exception("API timeout")

    result = classify_email("Any subject", "Any snippet")

    assert result == {"is_deadline_change": False, "confidence": 0.0}


# ---------------------------------------------------------------------------
# find_matching_deadline tests
# ---------------------------------------------------------------------------

def _make_deadline(title: str, course: str = "BIOL 101", due_date: str = "2026-04-10") -> dict:
    return {"id": "dl-1", "title": title, "course": course, "due_date": due_date}


def test_find_matching_deadline_returns_match_on_high_similarity():
    """find_matching_deadline returns matching deadline when score >= 70."""
    from gmail.classify import find_matching_deadline

    deadlines = [_make_deadline("Bio Lab Report")]
    result = find_matching_deadline("Bio Lab Report Extended", deadlines)

    assert result is not None
    assert result["title"] == "Bio Lab Report"


def test_find_matching_deadline_returns_none_for_unrelated_subject():
    """find_matching_deadline returns None when best score < 70."""
    from gmail.classify import find_matching_deadline

    deadlines = [_make_deadline("Bio Lab Report")]
    result = find_matching_deadline("Random subject line about pizza", deadlines)

    assert result is None


def test_find_matching_deadline_empty_list_returns_none():
    """find_matching_deadline returns None for empty deadlines list."""
    from gmail.classify import find_matching_deadline

    result = find_matching_deadline("Exam postponed", [])
    assert result is None


def test_find_matching_deadline_matches_on_course_title_combo():
    """find_matching_deadline can match on title+course combination."""
    from gmail.classify import find_matching_deadline

    deadlines = [_make_deadline("Lab Report", course="Organic Chemistry")]
    # Subject includes course name but not full title
    result = find_matching_deadline("Organic Chemistry Lab Report Due Date Change", deadlines)

    assert result is not None


# ---------------------------------------------------------------------------
# decode_pubsub_message tests
# ---------------------------------------------------------------------------

def test_decode_pubsub_message_decodes_base64url_json():
    """decode_pubsub_message correctly decodes base64url-encoded JSON."""
    from gmail.fetch import decode_pubsub_message

    payload = {"emailAddress": "user@yale.edu", "historyId": "12345"}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")

    result = decode_pubsub_message(encoded)

    assert result["emailAddress"] == "user@yale.edu"
    assert result["historyId"] == "12345"


def test_decode_pubsub_message_handles_padding_correctly():
    """decode_pubsub_message adds padding back correctly before decoding."""
    from gmail.fetch import decode_pubsub_message

    payload = {"emailAddress": "test@college.edu", "historyId": "99"}
    # Encode without padding (as Gmail sends it)
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    # Remove any trailing = to simulate Pub/Sub format
    encoded_no_pad = encoded.rstrip("=")

    result = decode_pubsub_message(encoded_no_pad)
    assert result["historyId"] == "99"


# ---------------------------------------------------------------------------
# fetch_new_messages tests
# ---------------------------------------------------------------------------

def _make_gmail_service(messages: list[dict]) -> MagicMock:
    """Build a mock Gmail API service that returns given message list."""
    service = MagicMock()

    # history().list() response
    history_response = {
        "history": [
            {"messagesAdded": [{"message": {"id": msg["id"]}}]}
            for msg in messages
        ]
    }
    service.users().history().list().execute.return_value = history_response

    # messages().get() responses — each call returns next message in sequence
    def get_message_execute_side_effect():
        """Return different message data for each call."""
        call_count = [0]

        def execute():
            idx = call_count[0]
            call_count[0] += 1
            if idx < len(messages):
                return messages[idx]
            return {}

        return execute

    msg_mock = MagicMock()
    msg_mock.execute.side_effect = get_message_execute_side_effect()
    service.users().messages().get.return_value = msg_mock

    return service


def _make_gmail_message(msg_id: str, sender: str, subject: str, snippet: str) -> dict:
    """Build a mock Gmail message resource."""
    return {
        "id": msg_id,
        "snippet": snippet,
        "payload": {
            "headers": [
                {"name": "From", "value": sender},
                {"name": "Subject", "value": subject},
            ]
        },
    }


@patch("gmail.auth.build_gmail_service")
def test_fetch_new_messages_filters_edu_senders_only(mock_build):
    """fetch_new_messages returns only messages from .edu senders."""
    from gmail.fetch import fetch_new_messages

    edu_msg = _make_gmail_message("msg1", "prof@yale.edu", "Assignment extended", "Due date pushed.")
    non_edu_msg = _make_gmail_message("msg2", "friend@gmail.com", "Weekend plans", "Let's hang out.")

    service = MagicMock()
    history_response = {
        "history": [
            {"messagesAdded": [{"message": {"id": "msg1"}}, {"message": {"id": "msg2"}}]}
        ]
    }
    service.users().history().list().execute.return_value = history_response

    # Set up sequential returns for messages().get().execute()
    get_mock = MagicMock()
    get_mock.execute.side_effect = [edu_msg, non_edu_msg]
    service.users().messages().get.return_value = get_mock

    mock_build.return_value = service

    result = fetch_new_messages("user-123", "hist-100")

    assert len(result) == 1
    assert ".edu" in result[0]["sender"]


@patch("gmail.auth.build_gmail_service")
def test_fetch_new_messages_returns_expected_fields(mock_build):
    """fetch_new_messages returns dicts with subject, sender, snippet, message_id."""
    from gmail.fetch import fetch_new_messages

    edu_msg = _make_gmail_message("msg1", "instructor@yale.edu", "Final exam info", "Please review.")

    service = MagicMock()
    history_response = {
        "history": [
            {"messagesAdded": [{"message": {"id": "msg1"}}]}
        ]
    }
    service.users().history().list().execute.return_value = history_response
    service.users().messages().get().execute.return_value = edu_msg
    mock_build.return_value = service

    result = fetch_new_messages("user-123", "hist-100")

    assert len(result) == 1
    msg = result[0]
    assert "subject" in msg
    assert "sender" in msg
    assert "snippet" in msg
    assert "message_id" in msg
    assert msg["subject"] == "Final exam info"


@patch("gmail.auth.build_gmail_service")
def test_fetch_new_messages_returns_empty_on_api_error(mock_build):
    """fetch_new_messages returns [] when history.list raises (e.g. 404 expired historyId)."""
    from gmail.fetch import fetch_new_messages

    service = MagicMock()
    service.users().history().list().execute.side_effect = Exception("404 Not Found")
    mock_build.return_value = service

    result = fetch_new_messages("user-123", "expired-hist-id")

    assert result == []
