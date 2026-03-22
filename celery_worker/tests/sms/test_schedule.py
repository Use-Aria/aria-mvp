"""Tests for on-demand scheduling logic.

All tests are pure unit tests — no Redis, no Supabase, no GCal calls.
External dependencies are mocked.
"""
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest


# ---------------------------------------------------------------------------
# parse_target_date
# ---------------------------------------------------------------------------

def test_parse_target_date_tomorrow_returns_datetime():
    """'tomorrow' resolves to a timezone-aware datetime in the user's tz."""
    from sms.schedule import parse_target_date
    tz = "America/New_York"
    result = parse_target_date("tomorrow", tz)
    assert result is not None
    assert isinstance(result, datetime)
    assert result.tzinfo is not None


def test_parse_target_date_unparseable_returns_none():
    """Garbage input returns None."""
    from sms.schedule import parse_target_date
    result = parse_target_date("xyzzy florp", "America/New_York")
    assert result is None


def test_parse_target_date_friday_returns_future_date():
    """'Friday' resolves to a future date."""
    from sms.schedule import parse_target_date
    result = parse_target_date("Friday", "America/New_York")
    assert result is not None
    assert result > datetime.now(ZoneInfo("America/New_York"))


# ---------------------------------------------------------------------------
# get_user_tz
# ---------------------------------------------------------------------------

def test_get_user_tz_returns_stored_value():
    """Returns timezone from preferences_json when present."""
    from sms.schedule import get_user_tz
    mock_row = [{"preferences_json": {"timezone": "America/Chicago"}}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        mock_sb.return_value.table.return_value.select.return_value \
            .eq.return_value.execute.return_value.data = mock_row
        result = get_user_tz("user-123")
    assert result == "America/Chicago"


def test_get_user_tz_defaults_to_eastern():
    """Returns 'America/New_York' when timezone not set."""
    from sms.schedule import get_user_tz
    mock_row = [{"preferences_json": {}}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        mock_sb.return_value.table.return_value.select.return_value \
            .eq.return_value.execute.return_value.data = mock_row
        result = get_user_tz("user-123")
    assert result == "America/New_York"


# ---------------------------------------------------------------------------
# Activity preference CRUD
# ---------------------------------------------------------------------------

def test_get_activity_preference_unknown_returns_none():
    """Returns None for an activity type never seen before."""
    from sms.schedule import get_activity_preference
    mock_row = [{"preferences_json": {}}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        mock_sb.return_value.table.return_value.select.return_value \
            .eq.return_value.execute.return_value.data = mock_row
        result = get_activity_preference("user-123", "workout")
    assert result is None


def test_get_activity_preference_returns_stored_value():
    """Returns stored preference string for a known activity."""
    from sms.schedule import get_activity_preference
    prefs = {"activity_preferences": {"workout": {"preference": "morning", "confirmations": 2, "recent_blocks": ["morning", "morning"]}}}
    mock_row = [{"preferences_json": prefs}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        mock_sb.return_value.table.return_value.select.return_value \
            .eq.return_value.execute.return_value.data = mock_row
        result = get_activity_preference("user-123", "workout")
    assert result == "morning"


def test_set_activity_preference_initializes_new_entry():
    """First write creates the full entry structure."""
    from sms.schedule import set_activity_preference
    mock_row = [{"preferences_json": {}}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        execute_mock = mock_sb.return_value.table.return_value
        execute_mock.select.return_value.eq.return_value.execute.return_value.data = mock_row

        set_activity_preference("user-123", "workout", "morning")

        update_call = execute_mock.update.call_args
        written = update_call[0][0]["preferences_json"]
        entry = written["activity_preferences"]["workout"]
        assert entry["preference"] == "morning"
        assert entry["confirmations"] == 0
        assert entry["recent_blocks"] == []


def test_set_activity_preference_preserves_other_activities():
    """Writing one preference does not clobber existing ones."""
    from sms.schedule import set_activity_preference
    existing = {"activity_preferences": {"study": {"preference": "evening", "confirmations": 3, "recent_blocks": ["evening", "evening", "evening"]}}}
    mock_row = [{"preferences_json": existing}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        execute_mock = mock_sb.return_value.table.return_value
        execute_mock.select.return_value.eq.return_value.execute.return_value.data = mock_row

        set_activity_preference("user-123", "workout", "morning")

        update_call = execute_mock.update.call_args
        written = update_call[0][0]["preferences_json"]
        assert written["activity_preferences"]["study"]["preference"] == "evening"
        assert written["activity_preferences"]["workout"]["preference"] == "morning"


# ---------------------------------------------------------------------------
# learn_from_confirmation
# ---------------------------------------------------------------------------

def _prefs_with_activity(activity_type: str, preference: str, recent_blocks: list, confirmations: int = 0) -> dict:
    return {
        "activity_preferences": {
            activity_type: {
                "preference": preference,
                "confirmations": confirmations,
                "recent_blocks": recent_blocks,
            }
        }
    }


def test_learn_appends_to_recent_blocks():
    """Confirmed slot's time-of-day is appended to recent_blocks."""
    from sms.schedule import learn_from_confirmation
    prefs = _prefs_with_activity("study", "evening", ["evening", "evening"])
    mock_row = [{"preferences_json": prefs}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        execute_mock = mock_sb.return_value.table.return_value
        execute_mock.select.return_value.eq.return_value.execute.return_value.data = mock_row

        # 8pm = evening
        learn_from_confirmation("user-123", "study", "2026-03-22T20:00:00-05:00")

        written = execute_mock.update.call_args[0][0]["preferences_json"]
        blocks = written["activity_preferences"]["study"]["recent_blocks"]
        assert blocks[-1] == "evening"


def test_learn_trims_recent_blocks_to_three():
    """recent_blocks never exceeds 3 entries."""
    from sms.schedule import learn_from_confirmation
    prefs = _prefs_with_activity("study", "evening", ["evening", "evening", "evening"])
    mock_row = [{"preferences_json": prefs}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        execute_mock = mock_sb.return_value.table.return_value
        execute_mock.select.return_value.eq.return_value.execute.return_value.data = mock_row

        learn_from_confirmation("user-123", "study", "2026-03-22T20:00:00-05:00")

        written = execute_mock.update.call_args[0][0]["preferences_json"]
        blocks = written["activity_preferences"]["study"]["recent_blocks"]
        assert len(blocks) == 3


def test_learn_updates_preference_when_three_blocks_all_differ():
    """3 consecutive off-preference confirmations silently update the preference."""
    from sms.schedule import learn_from_confirmation
    # Stored preference: evening. Last 2 blocks: morning, morning.
    # After one more morning confirmation → all 3 = morning → preference flips.
    prefs = _prefs_with_activity("workout", "evening", ["morning", "morning"])
    mock_row = [{"preferences_json": prefs}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        execute_mock = mock_sb.return_value.table.return_value
        execute_mock.select.return_value.eq.return_value.execute.return_value.data = mock_row

        # 7am = morning
        learn_from_confirmation("user-123", "workout", "2026-03-22T07:00:00-05:00")

        written = execute_mock.update.call_args[0][0]["preferences_json"]
        assert written["activity_preferences"]["workout"]["preference"] == "morning"


def test_learn_does_not_update_preference_when_blocks_mixed():
    """Preference stays unchanged when recent_blocks are mixed."""
    from sms.schedule import learn_from_confirmation
    prefs = _prefs_with_activity("study", "evening", ["morning", "afternoon"])
    mock_row = [{"preferences_json": prefs}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        execute_mock = mock_sb.return_value.table.return_value
        execute_mock.select.return_value.eq.return_value.execute.return_value.data = mock_row

        learn_from_confirmation("user-123", "study", "2026-03-22T20:00:00-05:00")

        written = execute_mock.update.call_args[0][0]["preferences_json"]
        assert written["activity_preferences"]["study"]["preference"] == "evening"


def test_learn_increments_confirmations():
    """Confirmations counter increments by 1 each call."""
    from sms.schedule import learn_from_confirmation
    prefs = _prefs_with_activity("study", "evening", [], confirmations=4)
    mock_row = [{"preferences_json": prefs}]
    with patch("sms.schedule._get_supabase") as mock_sb:
        execute_mock = mock_sb.return_value.table.return_value
        execute_mock.select.return_value.eq.return_value.execute.return_value.data = mock_row

        learn_from_confirmation("user-123", "study", "2026-03-22T20:00:00-05:00")

        written = execute_mock.update.call_args[0][0]["preferences_json"]
        assert written["activity_preferences"]["study"]["confirmations"] == 5


def test_classify_time_block_before_7am_returns_evening():
    """Hour before 7am (e.g. 3am) is bucketed as 'evening' (late-night rounds down)."""
    from sms.schedule import _classify_time_block
    dt = datetime(2026, 3, 22, 3, 0)  # 3am
    assert _classify_time_block(dt) == "evening"


# ---------------------------------------------------------------------------
# Redis pending state
# ---------------------------------------------------------------------------

def test_store_and_get_pending_schedule():
    """store_pending_schedule round-trips through Redis."""
    from sms.schedule import store_pending_schedule, get_pending_schedule
    data = {"activity_type": "study", "title": "Chem Study", "start": "2026-03-22T20:00:00-05:00", "end": "2026-03-22T22:00:00-05:00", "alternative_slots": []}

    with patch("sms.schedule._get_redis") as mock_redis_fn:
        mock_r = MagicMock()
        mock_redis_fn.return_value = mock_r
        mock_r.get.return_value = __import__("json").dumps(data).encode()

        store_pending_schedule("user-123", data)
        result = get_pending_schedule("user-123")

    assert result["title"] == "Chem Study"
    assert result["activity_type"] == "study"
    # Verify 5-minute TTL was set
    mock_r.setex.assert_called_once()
    call_args = mock_r.setex.call_args[0]
    assert call_args[1] == 300  # _PENDING_TTL = 300s


def test_get_pending_schedule_returns_none_when_missing():
    """Returns None when key is expired or absent."""
    from sms.schedule import get_pending_schedule
    with patch("sms.schedule._get_redis") as mock_redis_fn:
        mock_r = MagicMock()
        mock_redis_fn.return_value = mock_r
        mock_r.get.return_value = None
        result = get_pending_schedule("user-123")
    assert result is None


def test_clear_pending_schedule_deletes_key():
    """clear_pending_schedule calls Redis delete."""
    from sms.schedule import clear_pending_schedule
    with patch("sms.schedule._get_redis") as mock_redis_fn:
        mock_r = MagicMock()
        mock_redis_fn.return_value = mock_r
        clear_pending_schedule("user-123")
        mock_r.delete.assert_called_once_with("aria:pending_schedule:user-123")


def test_store_and_get_pending_preference():
    """store_pending_preference round-trips through Redis."""
    from sms.schedule import store_pending_preference, get_pending_preference
    original = {"action": "schedule", "activity_type": "workout"}

    with patch("sms.schedule._get_redis") as mock_redis_fn:
        mock_r = MagicMock()
        mock_redis_fn.return_value = mock_r
        stored = {"activity_type": "workout", "original_request": original}
        mock_r.get.return_value = __import__("json").dumps(stored).encode()

        store_pending_preference("user-123", "workout", original)
        result = get_pending_preference("user-123")

    assert result["activity_type"] == "workout"


# ---------------------------------------------------------------------------
# handle_schedule_request
# ---------------------------------------------------------------------------

def _make_slot(start_hour: int, end_hour: int, date: str = "2026-03-22") -> dict:
    tz = "-05:00"
    return {
        "start": f"{date}T{start_hour:02d}:00:00{tz}",
        "end":   f"{date}T{end_hour:02d}:00:00{tz}",
        "duration_hours": end_hour - start_hour,
    }


def test_handle_schedule_request_asks_preference_when_unknown():
    """When no preference exists, returns question asking for time of day."""
    from sms.schedule import handle_schedule_request
    with patch("sms.schedule.get_user_tz", return_value="America/New_York"), \
         patch("sms.schedule.parse_target_date", return_value=datetime(2026, 3, 22, tzinfo=ZoneInfo("America/New_York"))), \
         patch("sms.schedule._check_gcal_connected", return_value=True), \
         patch("sms.schedule.get_activity_preference", return_value=None), \
         patch("sms.schedule.store_pending_preference") as mock_store:

        result = handle_schedule_request("user-123", "workout", None, "tomorrow", None)

    assert "morning, afternoon, or evening" in result.lower()
    mock_store.assert_called_once()


def test_handle_schedule_request_returns_confirmation_prompt():
    """With known preference and available slot, returns confirmation prompt."""
    from sms.schedule import handle_schedule_request
    slots = [_make_slot(20, 22), _make_slot(15, 17)]
    with patch("sms.schedule.get_user_tz", return_value="America/New_York"), \
         patch("sms.schedule.parse_target_date", return_value=datetime(2026, 3, 22, tzinfo=ZoneInfo("America/New_York"))), \
         patch("sms.schedule._check_gcal_connected", return_value=True), \
         patch("sms.schedule.get_activity_preference", return_value="evening"), \
         patch("sms.schedule._fetch_slots", return_value=slots), \
         patch("sms.schedule.store_pending_schedule") as mock_store:

        result = handle_schedule_request("user-123", "study", "biochem exam", "tomorrow", None)

    assert "should i add it" in result.lower()
    mock_store.assert_called_once()


def test_handle_schedule_request_no_slots_returns_flow_c():
    """When calendar is full, returns the Flow C message."""
    from sms.schedule import handle_schedule_request
    with patch("sms.schedule.get_user_tz", return_value="America/New_York"), \
         patch("sms.schedule.parse_target_date", return_value=datetime(2026, 3, 22, tzinfo=ZoneInfo("America/New_York"))), \
         patch("sms.schedule._check_gcal_connected", return_value=True), \
         patch("sms.schedule.get_activity_preference", return_value="evening"), \
         patch("sms.schedule._fetch_slots", return_value=[]):

        result = handle_schedule_request("user-123", "study", None, "tonight", None)

    assert "fully booked" in result.lower()


def test_handle_schedule_request_no_gcal_connected():
    """Returns connect prompt when Google Calendar is not linked."""
    from sms.schedule import handle_schedule_request
    with patch("sms.schedule.get_user_tz", return_value="America/New_York"), \
         patch("sms.schedule.parse_target_date", return_value=datetime(2026, 3, 22, tzinfo=ZoneInfo("America/New_York"))), \
         patch("sms.schedule._check_gcal_connected", return_value=False):

        result = handle_schedule_request("user-123", "study", None, "tomorrow", None)

    assert "google calendar" in result.lower()


def test_handle_schedule_request_bad_date():
    """Returns helpful error when date cannot be parsed."""
    from sms.schedule import handle_schedule_request
    with patch("sms.schedule.get_user_tz", return_value="America/New_York"), \
         patch("sms.schedule.parse_target_date", return_value=None):

        result = handle_schedule_request("user-123", "study", None, "xyzzy", None)

    assert "what date" in result.lower()


# ---------------------------------------------------------------------------
# handle_schedule_confirmation
# ---------------------------------------------------------------------------

def test_handle_schedule_confirmation_books_event():
    """Books the event, calls learn, clears pending, returns confirmation."""
    from sms.schedule import handle_schedule_confirmation
    pending = {
        "activity_type": "study",
        "subject": "biochem",
        "title": "Biochem Study",
        "start": "2026-03-22T20:00:00-05:00",
        "end":   "2026-03-22T22:00:00-05:00",
        "alternative_slots": [],
    }
    with patch("sms.schedule.get_pending_schedule", return_value=pending), \
         patch("sms.schedule.clear_pending_schedule") as mock_clear, \
         patch("sms.schedule.learn_from_confirmation") as mock_learn, \
         patch("sms.schedule._book_event", return_value="evt-123"):

        result = handle_schedule_confirmation("user-123")

    assert "biochem study" in result.lower()
    assert "added" in result.lower()
    mock_clear.assert_called_once_with("user-123")
    mock_learn.assert_called_once_with("user-123", "study", "2026-03-22T20:00:00-05:00")


def test_handle_schedule_confirmation_no_pending():
    """Returns graceful message when pending has expired."""
    from sms.schedule import handle_schedule_confirmation
    with patch("sms.schedule.get_pending_schedule", return_value=None):
        result = handle_schedule_confirmation("user-123")
    assert "couldn't find" in result.lower()


# ---------------------------------------------------------------------------
# handle_schedule_decline
# ---------------------------------------------------------------------------

def test_handle_schedule_decline_offers_alternative():
    """Returns next best slot from alternative_slots."""
    from sms.schedule import handle_schedule_decline
    alt = {"start": "2026-03-22T15:00:00-05:00", "end": "2026-03-22T17:00:00-05:00"}
    pending = {
        "activity_type": "study",
        "subject": "biochem",
        "title": "Biochem Study",
        "start": "2026-03-22T20:00:00-05:00",
        "end":   "2026-03-22T22:00:00-05:00",
        "alternative_slots": [alt],
    }
    with patch("sms.schedule.get_pending_schedule", return_value=pending), \
         patch("sms.schedule.store_pending_schedule") as mock_store:

        result = handle_schedule_decline("user-123")

    assert "should i add" in result.lower()
    # Pending updated with alt as new proposed slot
    stored_data = mock_store.call_args[0][1]
    assert stored_data["start"] == alt["start"]
    assert stored_data["alternative_slots"] == []


def test_handle_schedule_decline_no_alternatives():
    """When alternative_slots is empty, clears pending and returns no-more-slots message."""
    from sms.schedule import handle_schedule_decline
    pending = {
        "activity_type": "study",
        "subject": None,
        "title": "Study",
        "start": "2026-03-22T20:00:00-05:00",
        "end":   "2026-03-22T22:00:00-05:00",
        "alternative_slots": [],
    }
    with patch("sms.schedule.get_pending_schedule", return_value=pending), \
         patch("sms.schedule.clear_pending_schedule") as mock_clear:

        result = handle_schedule_decline("user-123")

    assert "no other slots" in result.lower()
    mock_clear.assert_called_once_with("user-123")


def test_handle_schedule_decline_no_pending():
    """Returns graceful message when pending has expired."""
    from sms.schedule import handle_schedule_decline
    with patch("sms.schedule.get_pending_schedule", return_value=None):
        result = handle_schedule_decline("user-123")
    assert "couldn't find" in result.lower() or "expired" in result.lower() or "try again" in result.lower()
