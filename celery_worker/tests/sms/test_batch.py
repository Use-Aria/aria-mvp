"""Unit tests for SMS batch queue (sms/batch.py).

Tests use fakeredis to simulate Redis without a real connection.
send_sms_alert and _get_user_sms_state are patched to isolate batch logic.

Requirements tested:
- SMS-10: Multiple alerts within 10-minute window are combined into one SMS.
- SMS-11: No more than 3 texts sent in any 10-minute window per user.
"""
import json
import os
import pytest
import fakeredis
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def env_vars(monkeypatch):
    """Set required environment variables for the batch module."""
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")


@pytest.fixture
def fake_redis():
    """Return a fresh fakeredis.FakeRedis instance per test."""
    return fakeredis.FakeRedis()


@pytest.fixture
def patched_redis(fake_redis):
    """Patch sms.batch._get_redis to return the fake Redis instance."""
    with patch("sms.batch._get_redis", return_value=fake_redis):
        yield fake_redis


@pytest.fixture
def user_state():
    """Return a mock user state dict as returned by _get_user_sms_state."""
    return {
        "phone": "+12025551234",
        "sms_opted_out": False,
        "sms_paused_until": None,
        "preferences_json": {"has_alert_consent": True},
    }


# ---------------------------------------------------------------------------
# Tests: enqueue_alert
# ---------------------------------------------------------------------------

def test_enqueue_first_item_returns_true(patched_redis):
    """enqueue_alert returns True (is_new) for the first item (lock not yet set)."""
    from sms.batch import enqueue_alert

    result = enqueue_alert("user-1", "Assignment due soon", 80)

    assert result is True


def test_enqueue_second_item_returns_false(patched_redis):
    """enqueue_alert returns False for the second item (lock already held)."""
    from sms.batch import enqueue_alert

    enqueue_alert("user-1", "First alert", 80)
    result = enqueue_alert("user-1", "Second alert", 70)

    assert result is False


def test_enqueue_uses_setnx_for_lock(patched_redis):
    """SETNX-based lock prevents race: second enqueue sees existing lock and returns False."""
    from sms.batch import enqueue_alert

    # First call sets lock → is_new = True
    first = enqueue_alert("user-1", "Alert A", 90)
    # Second call: lock already set → is_new = False
    second = enqueue_alert("user-1", "Alert B", 85)

    assert first is True
    assert second is False

    # Both items are still in the queue
    key = "sms_batch:user-1"
    assert patched_redis.llen(key) == 2


def test_enqueue_different_users_each_get_own_lock(patched_redis):
    """Two different users each see their first item as is_new=True."""
    from sms.batch import enqueue_alert

    result_user1 = enqueue_alert("user-1", "Alert for user 1", 80)
    result_user2 = enqueue_alert("user-2", "Alert for user 2", 80)

    assert result_user1 is True
    assert result_user2 is True


def test_enqueue_items_stored_in_redis(patched_redis):
    """Enqueued items are stored as JSON in the sms_batch:{user_id} key."""
    from sms.batch import enqueue_alert

    enqueue_alert("user-1", "First alert", 90)
    enqueue_alert("user-1", "Second alert", 70)

    raw = patched_redis.lrange("sms_batch:user-1", 0, -1)
    assert len(raw) == 2

    items = [json.loads(r) for r in raw]
    assert items[0]["text"] == "First alert"
    assert items[0]["priority"] == 90
    assert items[1]["text"] == "Second alert"
    assert items[1]["priority"] == 70


def test_enqueue_batch_key_outlives_flush_countdown(patched_redis):
    """sms_batch:{user_id} TTL must exceed the flush countdown (BATCH_TTL) so a
    lone alert is still present when flush_sms_batch runs (regression)."""
    from sms.batch import enqueue_alert, BATCH_TTL

    enqueue_alert("user-1", "Alert text", 80)

    ttl = patched_redis.ttl("sms_batch:user-1")
    assert ttl > BATCH_TTL


def test_enqueue_lock_key_has_ttl(patched_redis):
    """sms_batch_lock:{user_id} key has a TTL of 600 seconds."""
    from sms.batch import enqueue_alert, BATCH_TTL

    enqueue_alert("user-1", "Alert text", 80)

    ttl = patched_redis.ttl("sms_batch_lock:user-1")
    assert ttl > 0
    assert ttl <= BATCH_TTL


# ---------------------------------------------------------------------------
# Tests: flush_batch
# ---------------------------------------------------------------------------

def test_flush_batch_empty_queue_is_noop(patched_redis, user_state):
    """flush_batch with empty queue returns None and does not send SMS."""
    from sms.batch import flush_batch

    with patch("sms.send.send_sms_alert") as mock_send, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    assert result is None
    mock_send.assert_not_called()


def test_flush_batch_single_item_sends_directly(patched_redis, user_state):
    """flush_batch with 1 item sends the text directly (no numbered list)."""
    from sms.batch import enqueue_alert, flush_batch

    enqueue_alert("user-1", "CS 101 midterm due tomorrow!", 90)

    with patch("sms.send.send_sms_alert") as mock_send, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    assert result == "CS 101 midterm due tomorrow!"
    mock_send.assert_called_once_with("user-1", user_state["phone"], "CS 101 midterm due tomorrow!")


def test_flush_batch_multi_item_sends_numbered_list(patched_redis, user_state):
    """flush_batch with 3 items sends a numbered list sorted by priority descending."""
    from sms.batch import enqueue_alert, flush_batch

    enqueue_alert("user-1", "Low priority alert", 50)
    enqueue_alert("user-1", "High priority alert", 90)
    enqueue_alert("user-1", "Medium priority alert", 70)

    with patch("sms.send.send_sms_alert") as mock_send, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    assert result is not None
    # Should be sorted: 90, 70, 50
    assert "1) High priority alert" in result
    assert "2) Medium priority alert" in result
    assert "3) Low priority alert" in result
    assert result.startswith("3 updates:")


def test_flush_batch_truncates_to_3_items(patched_redis, user_state):
    """flush_batch with 5 items enforces SMS-11 cap: sends only top-3 by priority."""
    from sms.batch import enqueue_alert, flush_batch, MAX_TEXTS_PER_WINDOW

    assert MAX_TEXTS_PER_WINDOW == 3

    # Enqueue 5 items with distinct priorities
    enqueue_alert("user-1", "Priority 60", 60)
    enqueue_alert("user-1", "Priority 95", 95)
    enqueue_alert("user-1", "Priority 80", 80)
    enqueue_alert("user-1", "Priority 40", 40)  # should be dropped
    enqueue_alert("user-1", "Priority 75", 75)

    with patch("sms.send.send_sms_alert") as mock_send, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    assert result is not None
    # Top-3 by priority: 95, 80, 75
    assert "Priority 95" in result
    assert "Priority 80" in result
    assert "Priority 75" in result
    # Low-priority items dropped
    assert "Priority 60" not in result
    assert "Priority 40" not in result
    # Exactly 3 items in the numbered list
    assert result.startswith("3 updates:")
    mock_send.assert_called_once()


def test_flush_batch_cleans_up_redis_keys(patched_redis, user_state):
    """flush_batch deletes both sms_batch:{user_id} and sms_batch_lock:{user_id} after sending."""
    from sms.batch import enqueue_alert, flush_batch

    enqueue_alert("user-1", "Some alert", 80)

    # Confirm keys exist before flush
    assert patched_redis.exists("sms_batch:user-1") == 1
    assert patched_redis.exists("sms_batch_lock:user-1") == 1

    with patch("sms.send.send_sms_alert"), \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        flush_batch("user-1")

    # Both keys must be gone after flush
    assert patched_redis.exists("sms_batch:user-1") == 0
    assert patched_redis.exists("sms_batch_lock:user-1") == 0


def test_flush_batch_sorted_descending_by_priority(patched_redis, user_state):
    """flush_batch always sends highest-priority items first (descending order)."""
    from sms.batch import enqueue_alert, flush_batch

    # Enqueue in ascending order intentionally
    enqueue_alert("user-1", "Alert priority 30", 30)
    enqueue_alert("user-1", "Alert priority 85", 85)
    enqueue_alert("user-1", "Alert priority 55", 55)

    with patch("sms.send.send_sms_alert") as mock_send, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    body = mock_send.call_args[0][2]
    lines = body.strip().split("\n")
    # First item should be priority 85, last is 30
    assert "Alert priority 85" in lines[1]
    assert "Alert priority 55" in lines[2]
    assert "Alert priority 30" in lines[3]


def test_flush_batch_no_user_state_returns_none(patched_redis):
    """flush_batch returns None (no SMS sent) if _get_user_sms_state returns None."""
    from sms.batch import enqueue_alert, flush_batch

    enqueue_alert("user-ghost", "Some alert", 80)

    with patch("sms.send.send_sms_alert") as mock_send, \
         patch("sms.send._get_user_sms_state", return_value=None):
        result = flush_batch("user-ghost")

    assert result is None
    mock_send.assert_not_called()


def test_lone_alert_survives_until_flush(patched_redis, user_state):
    """Regression: a single batched alert is still delivered when flush runs at
    countdown=BATCH_TTL (key must not expire first)."""
    from sms.batch import enqueue_alert, flush_batch, BATCH_TTL

    enqueue_alert("user-1", "Lone alert", 90)
    # Advance fake time to the flush moment.
    patched_redis.expire("sms_batch:user-1", patched_redis.ttl("sms_batch:user-1") - BATCH_TTL)
    assert patched_redis.exists("sms_batch:user-1") == 1

    with patch("sms.send.send_sms_alert", return_value=True) as mock_send, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    assert result == "Lone alert"
    mock_send.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: flush_batch TCPA guard routing (regression)
# ---------------------------------------------------------------------------

def test_flush_batch_paused_user_sends_nothing(patched_redis, user_state):
    """PAUSE is honored even for immediate-tier alerts with consent."""
    from datetime import datetime, timedelta, timezone
    from sms.batch import enqueue_alert, flush_batch

    user_state["sms_paused_until"] = (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()
    enqueue_alert("user-1", "Urgent", 95)

    with patch("sms.send.send_sms_alert") as mock_alert, \
         patch("sms.send.send_sms_safe") as mock_safe, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    assert result is None
    mock_alert.assert_not_called()
    mock_safe.assert_not_called()


def test_flush_batch_below_immediate_tier_uses_safe_path(patched_redis, user_state):
    """Top priority < 80 routes through send_sms_safe (quiet hours / daily cap apply)."""
    from sms.batch import enqueue_alert, flush_batch

    enqueue_alert("user-1", "Gap analysis digest", 75)

    with patch("sms.send.send_sms_alert") as mock_alert, \
         patch("sms.send.send_sms_safe", return_value=True) as mock_safe, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    assert result == "Gap analysis digest"
    mock_alert.assert_not_called()
    mock_safe.assert_called_once_with("user-1", user_state["phone"], "Gap analysis digest", is_proactive=True)


def test_flush_batch_immediate_tier_without_consent_uses_safe_path(patched_redis, user_state):
    """Top priority >= 80 but no alert consent → no quiet-hours bypass."""
    from sms.batch import enqueue_alert, flush_batch

    user_state["preferences_json"] = {}
    enqueue_alert("user-1", "Urgent", 95)

    with patch("sms.send.send_sms_alert") as mock_alert, \
         patch("sms.send.send_sms_safe", return_value=False) as mock_safe, \
         patch("sms.send._get_user_sms_state", return_value=user_state):
        result = flush_batch("user-1")

    assert result is None  # suppressed by guard
    mock_alert.assert_not_called()
    mock_safe.assert_called_once()
