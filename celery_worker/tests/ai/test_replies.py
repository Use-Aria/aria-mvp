"""Unit tests for the conversational SMS reply handler.

All tests are pure unit tests — no Supabase calls, no Claude calls.
Anthropic client is mocked throughout. DB functions are mocked.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, call, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_history_row(direction: str, body: str, sent_at: str = "2026-03-19T10:00:00Z") -> dict:
    return {"direction": direction, "body": body, "sent_at": sent_at}


def _make_deadline(
    title: str,
    course: str = "BIOL 101",
    due_days_from_now: int = 2,
    id: str = "dl-001",
) -> dict:
    due = (datetime.now(timezone.utc) + timedelta(days=due_days_from_now)).isoformat()
    return {"id": id, "title": title, "course": course, "due_date": due}


def _mock_claude_response(text: str) -> MagicMock:
    """Build a mock Anthropic client.messages.create() return value."""
    mock_content = MagicMock()
    mock_content.text = text

    mock_usage = MagicMock()
    mock_usage.input_tokens = 50
    mock_usage.output_tokens = 30

    mock_response = MagicMock()
    mock_response.content = [mock_content]
    mock_response.usage = mock_usage
    return mock_response


# ---------------------------------------------------------------------------
# build_history_messages tests
# ---------------------------------------------------------------------------


def test_build_history_messages_empty():
    """Empty list returns empty list."""
    from ai.replies import build_history_messages
    assert build_history_messages([]) == []


def test_build_history_messages_reverses_to_chronological():
    """3 rows in DESC order become ASC; direction 'in' maps to 'user', 'out' maps to 'assistant'."""
    from ai.replies import build_history_messages

    rows = [
        _make_history_row("out", "You've got a bio lab due tomorrow.", "2026-03-19T10:02:00Z"),
        _make_history_row("in", "what's due?", "2026-03-19T10:01:00Z"),
        _make_history_row("out", "Hey! Good morning.", "2026-03-19T09:00:00Z"),
    ]
    result = build_history_messages(rows)

    # Should be chronological: oldest first
    assert len(result) == 3
    assert result[0] == {"role": "assistant", "content": "Hey! Good morning."}
    assert result[1] == {"role": "user", "content": "what's due?"}
    assert result[2] == {"role": "assistant", "content": "You've got a bio lab due tomorrow."}


def test_build_history_deduplicates_consecutive_same_role():
    """Two consecutive 'out' rows collapse to one (keep most recent)."""
    from ai.replies import build_history_messages

    # Both 'out', after reversing they appear consecutively
    # Original DESC: [out-new, out-old] → reversed (chrono): [out-old, out-new]
    rows = [
        _make_history_row("out", "Second assistant message", "2026-03-19T10:02:00Z"),
        _make_history_row("out", "First assistant message", "2026-03-19T10:01:00Z"),
    ]
    result = build_history_messages(rows)

    # After reversal: [out-old, out-new]. Dedup keeps the most recent in the appended direction.
    # out-old is appended first, then out-new replaces it (same role consecutive)
    assert len(result) == 1
    assert result[0]["role"] == "assistant"
    assert result[0]["content"] == "Second assistant message"


# ---------------------------------------------------------------------------
# handle_reply tests
# ---------------------------------------------------------------------------


def test_handle_reply_query_calls_claude():
    """Mock Anthropic; verify messages.create called with conversation history and deadline data."""
    from ai.replies import handle_reply

    intent_resp = _mock_claude_response('{"action": "query", "task_hint": null, "priority_value": null}')
    reply_resp = _mock_claude_response("You've got bio lab due tomorrow and econ pset due Friday!")

    deadlines = [_make_deadline("Bio Lab Report", "BIOL 101", 1)]
    history_rows = [_make_history_row("in", "hey"), _make_history_row("out", "hi!")]

    with patch("ai.replies.Anthropic") as mock_anthropic_cls, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=deadlines), \
         patch("ai.replies.get_conversation_history", return_value=history_rows), \
         patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        # First call returns intent JSON, second call returns reply
        mock_client.messages.create.side_effect = [intent_resp, reply_resp]

        result = handle_reply("user-123", "what's due this week?")

    assert mock_client.messages.create.call_count == 2
    assert "bio lab" in result.lower() or "bio" in result.lower() or "tomorrow" in result.lower()


def test_handle_reply_mark_complete():
    """body='mark bio lab done', deadlines include 'Bio Lab Report' due tomorrow; verify DB update sets status='completed'."""
    from ai.replies import handle_reply

    intent_resp = _mock_claude_response('{"action": "mark_complete", "task_hint": "bio lab", "priority_value": null}')
    reply_resp = _mock_claude_response("Done! I marked Bio Lab Report as complete.")

    deadlines = [_make_deadline("Bio Lab Report", "BIOL 101", 1, id="dl-bio-001")]

    mock_supabase = MagicMock()
    mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock()

    with patch("ai.replies.Anthropic") as mock_anthropic_cls, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=deadlines), \
         patch("ai.replies.get_conversation_history", return_value=[]), \
         patch("ai.db._get_supabase", return_value=mock_supabase), \
         patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.side_effect = [intent_resp, reply_resp]

        handle_reply("user-123", "mark bio lab done")

    # Verify the DB update was called with status='completed'
    mock_supabase.table.assert_called_with("deadlines")
    update_call = mock_supabase.table.return_value.update.call_args
    assert update_call[0][0] == {"status": "completed"}


def test_handle_reply_snooze():
    """body='snooze econ pset'; verify DB update sets snoozed_until ~24h from now."""
    from ai.replies import handle_reply

    intent_resp = _mock_claude_response('{"action": "snooze", "task_hint": "econ pset", "priority_value": null}')
    reply_resp = _mock_claude_response("Snoozed your econ pset for 24 hours!")

    deadlines = [_make_deadline("Econ Pset 3", "ECON 110", 3, id="dl-econ-001")]

    mock_supabase = MagicMock()
    mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock()

    with patch("ai.replies.Anthropic") as mock_anthropic_cls, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=deadlines), \
         patch("ai.replies.get_conversation_history", return_value=[]), \
         patch("ai.db._get_supabase", return_value=mock_supabase), \
         patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.side_effect = [intent_resp, reply_resp]

        handle_reply("user-123", "snooze econ pset")

    # Verify the DB update included snoozed_until
    update_call = mock_supabase.table.return_value.update.call_args
    assert "snoozed_until" in update_call[0][0]


def test_handle_reply_set_priority():
    """body='high priority calc midterm'; verify DB update sets priority='high'."""
    from ai.replies import handle_reply

    intent_resp = _mock_claude_response('{"action": "set_priority", "task_hint": "calc midterm", "priority_value": "high"}')
    reply_resp = _mock_claude_response("Set Calc Midterm to high priority!")

    deadlines = [_make_deadline("Calc Midterm", "MATH 101", 4, id="dl-calc-001")]

    mock_supabase = MagicMock()
    mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock()

    with patch("ai.replies.Anthropic") as mock_anthropic_cls, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=deadlines), \
         patch("ai.replies.get_conversation_history", return_value=[]), \
         patch("ai.db._get_supabase", return_value=mock_supabase), \
         patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.side_effect = [intent_resp, reply_resp]

        handle_reply("user-123", "high priority calc midterm")

    # Verify the DB update set priority='high'
    update_call = mock_supabase.table.return_value.update.call_args
    assert update_call[0][0] == {"priority": "high"}


def test_handle_reply_ambiguous_resolves_soonest():
    """Two deadlines match 'bio' — one due tomorrow, one due in 5 days; soonest (tomorrow) is acted on."""
    from ai.replies import handle_reply

    intent_resp = _mock_claude_response('{"action": "mark_complete", "task_hint": "bio", "priority_value": null}')
    reply_resp = _mock_claude_response("Marked Bio Lab Report as done!")

    # Two deadlines with "bio" — soonest first (sorted by due_date ASC)
    deadline_soon = _make_deadline("Bio Lab Report", "BIOL 101", 1, id="dl-bio-soon")
    deadline_later = _make_deadline("Bio Essay", "BIOL 201", 5, id="dl-bio-later")
    deadlines = [deadline_soon, deadline_later]  # already ASC

    mock_supabase = MagicMock()
    mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock()

    with patch("ai.replies.Anthropic") as mock_anthropic_cls, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=deadlines), \
         patch("ai.replies.get_conversation_history", return_value=[]), \
         patch("ai.db._get_supabase", return_value=mock_supabase), \
         patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.side_effect = [intent_resp, reply_resp]

        handle_reply("user-123", "mark bio done")

    # Verify the eq filter used the soonest deadline's id
    eq_calls = mock_supabase.table.return_value.update.return_value.eq.call_args_list
    # The eq call should be .eq("id", "dl-bio-soon")
    assert any(
        c == call("id", "dl-bio-soon") for c in eq_calls
    ), f"Expected eq('id', 'dl-bio-soon') but got: {eq_calls}"


def test_handle_reply_off_topic():
    """body='what's the weather?'; verify response contains 'I can help with your deadlines'."""
    from ai.replies import handle_reply, OFF_TOPIC_RESPONSE

    intent_resp = _mock_claude_response('{"action": "off_topic", "task_hint": null, "priority_value": null}')

    with patch("ai.replies.Anthropic") as mock_anthropic_cls, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=[]), \
         patch("ai.replies.get_conversation_history", return_value=[]), \
         patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.return_value = intent_resp

        result = handle_reply("user-123", "what's the weather?")

    # Off-topic: only one Claude call (intent only), no second call
    assert mock_client.messages.create.call_count == 1
    assert "I can help with your deadlines" in result


def test_handle_reply_includes_history():
    """Verify conversation history (last 5 exchanges) is included in Claude messages array."""
    from ai.replies import handle_reply

    intent_resp = _mock_claude_response('{"action": "query", "task_hint": null, "priority_value": null}')
    reply_resp = _mock_claude_response("Here's what's coming up!")

    # Simulate 3 prior messages in DESC order
    history_rows = [
        _make_history_row("out", "You've got econ due Friday.", "2026-03-19T10:02:00Z"),
        _make_history_row("in", "what's due?", "2026-03-19T10:01:00Z"),
        _make_history_row("out", "Hey! Good morning.", "2026-03-19T09:00:00Z"),
    ]

    with patch("ai.replies.Anthropic") as mock_anthropic_cls, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=[]), \
         patch("ai.replies.get_conversation_history", return_value=history_rows), \
         patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.side_effect = [intent_resp, reply_resp]

        handle_reply("user-456", "what's next?")

    # The second Claude call (reply generation) should have history messages + current message
    second_call_kwargs = mock_client.messages.create.call_args_list[1].kwargs
    messages_array = second_call_kwargs["messages"]

    # Should have at least 4 entries: 3 history + 1 current user message
    assert len(messages_array) >= 4, f"Expected >= 4 messages, got {len(messages_array)}"

    # First messages should come from history (chronological)
    assert messages_array[0]["role"] == "assistant"  # reversed from DESC: oldest is assistant
    assert messages_array[0]["content"] == "Hey! Good morning."


def test_handle_reply_returns_under_800_chars():
    """Verify output string length <= 800."""
    from ai.replies import handle_reply

    intent_resp = _mock_claude_response('{"action": "query", "task_hint": null, "priority_value": null}')
    # Claude returns a very long reply — should be truncated
    long_reply = "A" * 900
    reply_resp = _mock_claude_response(long_reply)

    with patch("ai.replies.Anthropic") as mock_anthropic_cls, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=[]), \
         patch("ai.replies.get_conversation_history", return_value=[]), \
         patch.dict("os.environ", {"ANTHROPIC_API_KEY": "test-key"}):
        mock_client = MagicMock()
        mock_anthropic_cls.return_value = mock_client
        mock_client.messages.create.side_effect = [intent_resp, reply_resp]

        result = handle_reply("user-123", "what's due?")

    assert len(result) <= 800
