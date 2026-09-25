"""Integration tests for AI-related Celery tasks: briefing fan-out, welcome briefing, and reply routing."""
from unittest.mock import MagicMock, patch, call


# ---------------------------------------------------------------------------
# generate_daily_briefings_all tests
# ---------------------------------------------------------------------------


def test_generate_daily_briefings_all_dispatches_per_user():
    """Mock get_all_canvas_integrations to return 3 users; verify generate_daily_briefing_user.delay called 3 times."""
    integrations = [
        {"user_id": "user-001"},
        {"user_id": "user-002"},
        {"user_id": "user-003"},
    ]

    with patch("canvas.db.get_all_canvas_integrations", return_value=integrations), \
         patch("tasks.generate_daily_briefing_user") as mock_task:
        from tasks import generate_daily_briefings_all
        result = generate_daily_briefings_all()

    assert result["dispatched"] == 3
    assert mock_task.delay.call_count == 3
    mock_task.delay.assert_any_call("user-001")
    mock_task.delay.assert_any_call("user-002")
    mock_task.delay.assert_any_call("user-003")


# ---------------------------------------------------------------------------
# generate_daily_briefing_user tests
# ---------------------------------------------------------------------------


def test_generate_daily_briefing_user_skips_outside_window():
    """Mock is_in_briefing_window to return False; verify no Claude call and status='skipped'."""
    with patch("ai.briefing.is_in_briefing_window", return_value=False), \
         patch("sms.send._get_user_sms_state", return_value={
             "phone": "+15551234567",
             "preferences_json": {"timezone": "America/New_York"},
         }), \
         patch("ai.briefing.generate_briefing") as mock_generate:
        from tasks import generate_daily_briefing_user
        result = generate_daily_briefing_user("user-001")

    assert result["status"] == "skipped"
    assert result["reason"] == "not_in_window"
    mock_generate.assert_not_called()


def test_generate_daily_briefing_user_skips_if_already_sent():
    """Mock is_in_briefing_window True + briefing_sent_today True; verify no Claude call and reason='already_sent'."""
    with patch("ai.briefing.is_in_briefing_window", return_value=True), \
         patch("ai.db.briefing_sent_today", return_value=True), \
         patch("sms.send._get_user_sms_state", return_value={
             "phone": "+15551234567",
             "preferences_json": {"timezone": "America/New_York"},
         }), \
         patch("ai.briefing.generate_briefing") as mock_generate:
        from tasks import generate_daily_briefing_user
        result = generate_daily_briefing_user("user-001")

    assert result["status"] == "skipped"
    assert result["reason"] == "already_sent"
    mock_generate.assert_not_called()


def test_generate_daily_briefing_user_sends_on_valid_window():
    """Mock all deps; verify send_sms_safe and write_outbound_message called."""
    with patch("ai.briefing.is_in_briefing_window", return_value=True), \
         patch("ai.db.briefing_sent_today", return_value=False), \
         patch("ai.db.get_events_for_briefing", return_value=[]), \
         patch("ai.syllabus.get_syllabus_context", return_value=None), \
         patch("ai.briefing.generate_briefing", return_value="Good morning! Clear day ahead."), \
         patch("sms.send._get_user_sms_state", return_value={
             "phone": "+15551234567",
             "preferences_json": {"timezone": "America/New_York"},
         }), \
         patch("sms.send.send_sms_safe", return_value=True) as mock_send, \
         patch("ai.db.write_outbound_message") as mock_write:
        from tasks import generate_daily_briefing_user
        result = generate_daily_briefing_user("user-001")

    assert result["status"] == "sent"
    mock_send.assert_called_once()
    mock_write.assert_called_once_with("user-001", "Good morning! Clear day ahead.", "briefing")


# ---------------------------------------------------------------------------
# welcome_briefing tests
# ---------------------------------------------------------------------------


def test_welcome_briefing_sends_with_welcome_flag():
    """Mock deps; verify generate_briefing called with is_welcome=True."""
    with patch("sms.send._get_user_sms_state", return_value={
             "phone": "+15551234567",
             "preferences_json": {"timezone": "America/New_York"},
         }), \
         patch("ai.db.welcome_briefing_sent", return_value=False), \
         patch("ai.db.get_events_for_briefing", return_value=[]), \
         patch("ai.briefing.generate_briefing", return_value="Hey, I'm Aria! Here's what I see...") as mock_gen, \
         patch("sms.send.send_sms_safe", return_value=True), \
         patch("ai.db.write_outbound_message"):
        from tasks import welcome_briefing
        result = welcome_briefing("user-new-001")

    # Verify is_welcome=True was passed
    call_kwargs = mock_gen.call_args.kwargs
    assert call_kwargs.get("is_welcome") is True


def test_welcome_briefing_writes_welcome_trigger_type():
    """Mock deps; verify write_outbound_message called with trigger_type='welcome_briefing'."""
    with patch("sms.send._get_user_sms_state", return_value={
             "phone": "+15551234567",
             "preferences_json": {"timezone": "America/New_York"},
         }), \
         patch("ai.db.welcome_briefing_sent", return_value=False), \
         patch("ai.db.get_events_for_briefing", return_value=[]), \
         patch("ai.briefing.generate_briefing", return_value="Hey, I'm Aria! Here's what I see..."), \
         patch("sms.send.send_sms_safe", return_value=True), \
         patch("ai.db.write_outbound_message") as mock_write:
        from tasks import welcome_briefing
        result = welcome_briefing("user-new-001")

    mock_write.assert_called_once_with(
        "user-new-001", "Hey, I'm Aria! Here's what I see...", "welcome_briefing"
    )


# ---------------------------------------------------------------------------
# canvas_sync_user welcome trigger tests
# ---------------------------------------------------------------------------


def test_canvas_sync_user_never_triggers_welcome_briefing():
    """Regression: welcome briefing is fired only by /api/onboarding/complete,
    never by Canvas sync (even on the first sync)."""
    with patch("canvas.fetch.fetch_ical", return_value=b"BEGIN:VCALENDAR\nEND:VCALENDAR"), \
         patch("canvas.parse.parse_vevents", return_value=[]), \
         patch("canvas.db.load_current_deadlines", return_value={}), \
         patch("canvas.diff.compute_diff", return_value={"added": [], "changed": [], "removed": []}), \
         patch("canvas.db.apply_diff"), \
         patch("canvas.db.mark_synced") as mock_mark, \
         patch("tasks.detect_conflicts_user"), \
         patch("tasks.welcome_briefing") as mock_welcome:
        from tasks import canvas_sync_user
        canvas_sync_user("user-new-001", "https://canvas.yale.edu/feeds/calendars/user_abc.ics")

    mock_welcome.delay.assert_not_called()
    mock_mark.assert_called_once_with("user-new-001")


def test_welcome_briefing_is_idempotent():
    """Regression: a second welcome_briefing call for the same user sends nothing."""
    with patch("ai.db.welcome_briefing_sent", return_value=True), \
         patch("sms.send._get_user_sms_state") as mock_state, \
         patch("ai.briefing.generate_briefing") as mock_gen, \
         patch("sms.send.send_sms_safe") as mock_send, \
         patch("ai.db.write_outbound_message") as mock_write:
        from tasks import welcome_briefing
        result = welcome_briefing("user-new-001")

    assert result["status"] == "skipped"
    assert result["reason"] == "already_sent"
    mock_gen.assert_not_called()
    mock_send.assert_not_called()
    mock_write.assert_not_called()


def test_welcome_briefing_sent_queries_welcome_trigger_type():
    """welcome_briefing_sent checks messages for trigger_type='welcome_briefing'."""
    chain = MagicMock()
    chain.select.return_value = chain
    chain.eq.return_value = chain
    chain.limit.return_value = chain
    chain.execute.return_value = MagicMock(data=[{"id": "m1"}])
    client = MagicMock()
    client.table.return_value = chain

    with patch("ai.db._get_supabase", return_value=client):
        from ai.db import welcome_briefing_sent
        assert welcome_briefing_sent("user-1") is True

    client.table.assert_called_with("messages")
    chain.eq.assert_any_call("trigger_type", "welcome_briefing")


# ---------------------------------------------------------------------------
# process_inbound_sms reply routing test
# ---------------------------------------------------------------------------


def test_process_inbound_sms_routes_to_claude_reply():
    """Mock dispatch_command returning False; mock handle_reply; verify reply handler called."""
    with patch("sms.commands.dispatch_command", return_value=False), \
         patch("sms.send._get_user_sms_state", return_value={"phone": "+15551234567"}), \
         patch("ai.replies.handle_reply", return_value="Here's what's due!") as mock_reply, \
         patch("ai.db.write_outbound_message") as mock_write, \
         patch("sms.send.send_sms_safe", return_value=True) as mock_send:
        from tasks import process_inbound_sms
        result = process_inbound_sms("SM456", "what's due?", "user-uuid-456")

    assert result["command_dispatched"] is False
    mock_reply.assert_called_once_with("user-uuid-456", "what's due?")
    mock_send.assert_called_once_with("user-uuid-456", "+15551234567", "Here's what's due!", is_proactive=False)
    mock_write.assert_called_once_with("user-uuid-456", "Here's what's due!", "reply")


# ---------------------------------------------------------------------------
# Beat schedule test
# ---------------------------------------------------------------------------


def test_beat_schedule_has_briefing_entry():
    """Verify celery_app.conf.beat_schedule contains 'generate-daily-briefings' with crontab schedule."""
    from celery_app import celery_app
    from celery.schedules import crontab

    schedule = celery_app.conf.beat_schedule
    assert "generate-daily-briefings" in schedule, (
        f"'generate-daily-briefings' not found in beat_schedule. Keys: {list(schedule.keys())}"
    )
    entry = schedule["generate-daily-briefings"]
    assert entry["task"] == "tasks.generate_daily_briefings_all"
    assert isinstance(entry["schedule"], crontab), (
        f"Expected crontab schedule, got {type(entry['schedule'])}"
    )
