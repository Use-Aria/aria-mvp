# On-Demand Scheduling with Activity Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `schedule` SMS intent that lets students ask Aria to find and book calendar time for any activity, with per-activity time preferences learned silently over time.

**Architecture:** A new `sms/schedule.py` module owns all scheduling logic (Redis state, preference learning, slot orchestration). `ai/replies.py` is modified only at the intent routing layer — the 4-step intercept order and a new `schedule` branch. All GCal slot-finding and writeback is reused untouched from `gcal/slots.py` and `gcal/writeback.py`.

**Tech Stack:** Python, Redis (`redis.from_url`), `dateparser`, Supabase JSONB, existing `gcal.slots.find_free_slots`, `gcal.writeback.create_study_block`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `celery_worker/sms/schedule.py` | **Create** | All scheduling logic: Redis state, preference CRUD, learning, date parsing, flow orchestration |
| `celery_worker/ai/replies.py` | **Modify** | Add `schedule` intent to prompt + 4-step intercept order + `schedule` action branch |
| `celery_worker/requirements.txt` | **Modify** | Add `dateparser>=1.2.0` |
| `celery_worker/tests/sms/test_schedule.py` | **Create** | All tests for `schedule.py` |
| `celery_worker/tests/ai/test_replies.py` | **Modify** | Add intercept order + schedule routing tests |

**Untouched (reused as-is):**
- `celery_worker/gcal/slots.py` — `find_free_slots()`
- `celery_worker/gcal/writeback.py` — `create_study_block()`
- `celery_worker/gcal/db.py` — `get_calendar_events()`

---

## Task 1: Add `dateparser` dependency

**Files:**
- Modify: `celery_worker/requirements.txt`

- [ ] **Step 1: Add dateparser to requirements**

Open `celery_worker/requirements.txt` and append:
```
dateparser>=1.2.0
```

- [ ] **Step 2: Verify it installs**

```bash
cd celery_worker
pip install dateparser>=1.2.0
```
Expected: installs without error

- [ ] **Step 3: Commit**

```bash
git add celery_worker/requirements.txt
git commit -m "chore: add dateparser for natural language date parsing"
```

---

## Task 2: `parse_target_date` + `get_user_tz`

**Files:**
- Create: `celery_worker/sms/schedule.py`
- Create: `celery_worker/tests/sms/test_schedule.py`

- [ ] **Step 0: Ensure test package exists**

```bash
ls celery_worker/tests/sms/__init__.py 2>/dev/null || touch celery_worker/tests/sms/__init__.py
```
Expected: file exists (already present from prior phases — this is a no-op if so)

- [ ] **Step 1: Write failing tests**

Create `celery_worker/tests/sms/test_schedule.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py::test_parse_target_date_tomorrow_returns_datetime tests/sms/test_schedule.py::test_get_user_tz_returns_stored_value -v
```
Expected: `ModuleNotFoundError: No module named 'sms.schedule'`

- [ ] **Step 3: Create `sms/schedule.py` with these two functions**

```python
"""On-demand scheduling via SMS — activity preferences + slot booking.

Owns: Redis pending state, per-activity preference learning,
      natural language date parsing, schedule flow orchestration.

Called from: ai/replies.py (handle_reply)
Calls: gcal.slots.find_free_slots, gcal.writeback.create_study_block,
       gcal.db.get_calendar_events
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Optional

import dateparser
import redis

logger = logging.getLogger(__name__)

DEFAULT_TZ = "America/New_York"

# Redis key templates
_PENDING_SCHEDULE_KEY = "aria:pending_schedule:{user_id}"
_PENDING_PREFERENCE_KEY = "aria:pending_preference:{user_id}"
_PENDING_TTL = 300  # 5 minutes


def _get_redis() -> redis.Redis:
    """Create Redis client from REDIS_URL env var."""
    return redis.from_url(os.environ["REDIS_URL"])


def _get_supabase():
    """Create Supabase client using service role key."""
    from supabase import create_client
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )


def parse_target_date(date_string: str, user_tz: str) -> datetime | None:
    """Parse a natural language date string into a timezone-aware datetime.

    Args:
        date_string: e.g. 'tomorrow', 'Friday', 'tonight', 'next week'
        user_tz: IANA timezone string, e.g. 'America/New_York'

    Returns:
        Timezone-aware datetime, or None if dateparser cannot parse the input.
    """
    result = dateparser.parse(
        date_string,
        settings={
            "PREFER_DATES_FROM": "future",
            "TIMEZONE": user_tz,
            "RETURN_AS_TIMEZONE_AWARE": True,
        },
    )
    return result


def get_user_tz(user_id: str) -> str:
    """Read user's timezone from preferences_json. Defaults to America/New_York.

    Args:
        user_id: UUID of the user.

    Returns:
        IANA timezone string.
    """
    rows = (
        _get_supabase()
        .table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (rows[0].get("preferences_json") or {}) if rows else {}
    return prefs.get("timezone", DEFAULT_TZ)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py::test_parse_target_date_tomorrow_returns_datetime tests/sms/test_schedule.py::test_parse_target_date_unparseable_returns_none tests/sms/test_schedule.py::test_parse_target_date_friday_returns_future_date tests/sms/test_schedule.py::test_get_user_tz_returns_stored_value tests/sms/test_schedule.py::test_get_user_tz_defaults_to_eastern -v
```
Expected: all 5 PASS

- [ ] **Step 5: Commit**

```bash
git add celery_worker/sms/schedule.py celery_worker/tests/sms/test_schedule.py
git commit -m "feat: add parse_target_date and get_user_tz to schedule module"
```

---

## Task 3: Activity preference CRUD

**Files:**
- Modify: `celery_worker/sms/schedule.py`
- Modify: `celery_worker/tests/sms/test_schedule.py`

- [ ] **Step 1: Write failing tests — append to `test_schedule.py`**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py::test_get_activity_preference_unknown_returns_none tests/sms/test_schedule.py::test_set_activity_preference_initializes_new_entry -v
```
Expected: `ImportError` or `AttributeError`

- [ ] **Step 3: Add preference CRUD functions to `schedule.py`**

```python
def get_activity_preference(user_id: str, activity_type: str) -> str | None:
    """Return stored time-of-day preference for this activity type, or None if unseen.

    Args:
        user_id: UUID of the user.
        activity_type: e.g. 'study', 'workout', 'meal'

    Returns:
        'morning', 'afternoon', 'evening', or None.
    """
    rows = (
        _get_supabase()
        .table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (rows[0].get("preferences_json") or {}) if rows else {}
    activity_prefs = prefs.get("activity_preferences", {})
    entry = activity_prefs.get(activity_type)
    if not entry:
        return None
    return entry.get("preference")


def set_activity_preference(user_id: str, activity_type: str, preference: str) -> None:
    """Write a time-of-day preference for an activity type.

    Initializes entry with confirmations=0 and recent_blocks=[] on first write.
    Preserves all other activity preferences.

    Args:
        user_id: UUID of the user.
        activity_type: e.g. 'workout'
        preference: 'morning', 'afternoon', or 'evening'
    """
    client = _get_supabase()
    rows = (
        client.table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (rows[0].get("preferences_json") or {}) if rows else {}
    activity_prefs = prefs.setdefault("activity_preferences", {})

    existing = activity_prefs.get(activity_type, {})
    activity_prefs[activity_type] = {
        "preference": preference,
        "confirmations": existing.get("confirmations", 0),
        "recent_blocks": existing.get("recent_blocks", []),
    }

    client.table("users").update(
        {"preferences_json": prefs}
    ).eq("id", user_id).execute()
```

- [ ] **Step 4: Run tests**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "preference" -v
```
Expected: all preference tests PASS

- [ ] **Step 5: Commit**

```bash
git add celery_worker/sms/schedule.py celery_worker/tests/sms/test_schedule.py
git commit -m "feat: add activity preference CRUD to schedule module"
```

---

## Task 4: Preference learning (`learn_from_confirmation`)

**Files:**
- Modify: `celery_worker/sms/schedule.py`
- Modify: `celery_worker/tests/sms/test_schedule.py`

- [ ] **Step 1: Write failing tests — append to `test_schedule.py`**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "learn" -v
```
Expected: `ImportError`

- [ ] **Step 3: Add `learn_from_confirmation` to `schedule.py`**

```python
# Time-of-day block boundaries (hour, inclusive start)
_TIME_BLOCKS = [
    ("morning",   7, 12),
    ("afternoon", 12, 17),
    ("evening",   17, 23),
]


def _classify_time_block(dt: datetime) -> str:
    """Return 'morning', 'afternoon', or 'evening' for a given datetime."""
    hour = dt.hour
    for name, start, end in _TIME_BLOCKS:
        if start <= hour < end:
            return name
    return "evening"  # before 7am or 11pm+ rounds to evening


def learn_from_confirmation(user_id: str, activity_type: str, confirmed_start_iso: str) -> None:
    """Update activity preference based on a confirmed booking.

    Steps:
    1. Classify confirmed_start_iso into a time-of-day block
    2. Append to recent_blocks (trim to last 3)
    3. Increment confirmations
    4. If all 3 recent_blocks differ from stored preference, update preference
       to the most common value in recent_blocks

    Args:
        user_id: UUID of the user.
        activity_type: e.g. 'study', 'workout'
        confirmed_start_iso: ISO datetime string of the confirmed slot start.
    """
    client = _get_supabase()
    rows = (
        client.table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (rows[0].get("preferences_json") or {}) if rows else {}
    activity_prefs = prefs.setdefault("activity_preferences", {})
    entry = activity_prefs.setdefault(activity_type, {
        "preference": "evening",
        "confirmations": 0,
        "recent_blocks": [],
    })

    confirmed_dt = datetime.fromisoformat(confirmed_start_iso)
    block = _classify_time_block(confirmed_dt)

    recent = entry.get("recent_blocks", [])
    recent.append(block)
    recent = recent[-3:]  # trim to last 3

    entry["recent_blocks"] = recent
    entry["confirmations"] = entry.get("confirmations", 0) + 1

    # Update preference if all 3 recent blocks agree and differ from stored
    if len(recent) == 3 and len(set(recent)) == 1 and recent[0] != entry["preference"]:
        entry["preference"] = recent[0]

    client.table("users").update(
        {"preferences_json": prefs}
    ).eq("id", user_id).execute()
```

- [ ] **Step 4: Run tests**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "learn" -v
```
Expected: all 5 PASS

- [ ] **Step 5: Commit**

```bash
git add celery_worker/sms/schedule.py celery_worker/tests/sms/test_schedule.py
git commit -m "feat: add preference learning to schedule module"
```

---

## Task 5: Redis pending state

**Files:**
- Modify: `celery_worker/sms/schedule.py`
- Modify: `celery_worker/tests/sms/test_schedule.py`

- [ ] **Step 1: Write failing tests — append to `test_schedule.py`**

```python
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
        mock_r.get.return_value = json.dumps(data).encode()

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
        mock_r.get.return_value = json.dumps(stored).encode()

        store_pending_preference("user-123", "workout", original)
        result = get_pending_preference("user-123")

    assert result["activity_type"] == "workout"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "pending" -v
```
Expected: `ImportError`

- [ ] **Step 3: Add Redis state functions to `schedule.py`**

```python
def store_pending_schedule(user_id: str, data: dict) -> None:
    """Store a pending schedule confirmation in Redis with 5-minute TTL."""
    r = _get_redis()
    r.setex(
        _PENDING_SCHEDULE_KEY.format(user_id=user_id),
        _PENDING_TTL,
        json.dumps(data),
    )


def get_pending_schedule(user_id: str) -> dict | None:
    """Retrieve pending schedule from Redis. Returns None if expired or absent."""
    r = _get_redis()
    raw = r.get(_PENDING_SCHEDULE_KEY.format(user_id=user_id))
    return json.loads(raw) if raw else None


def clear_pending_schedule(user_id: str) -> None:
    """Remove pending schedule key from Redis."""
    _get_redis().delete(_PENDING_SCHEDULE_KEY.format(user_id=user_id))


def store_pending_preference(user_id: str, activity_type: str, original_request: dict) -> None:
    """Store Flow A context (waiting for morning/afternoon/evening answer) in Redis."""
    r = _get_redis()
    r.setex(
        _PENDING_PREFERENCE_KEY.format(user_id=user_id),
        _PENDING_TTL,
        json.dumps({"activity_type": activity_type, "original_request": original_request}),
    )


def get_pending_preference(user_id: str) -> dict | None:
    """Retrieve pending preference context from Redis. Returns None if expired or absent."""
    r = _get_redis()
    raw = r.get(_PENDING_PREFERENCE_KEY.format(user_id=user_id))
    return json.loads(raw) if raw else None


def clear_pending_preference(user_id: str) -> None:
    """Remove pending preference key from Redis."""
    _get_redis().delete(_PENDING_PREFERENCE_KEY.format(user_id=user_id))
```

- [ ] **Step 4: Run tests**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "pending" -v
```
Expected: all 4 PASS

- [ ] **Step 5: Commit**

```bash
git add celery_worker/sms/schedule.py celery_worker/tests/sms/test_schedule.py
git commit -m "feat: add Redis pending state to schedule module"
```

---

## Task 6: `handle_schedule_request` (main orchestrator)

**Files:**
- Modify: `celery_worker/sms/schedule.py`
- Modify: `celery_worker/tests/sms/test_schedule.py`

- [ ] **Step 1: Write failing tests — append to `test_schedule.py`**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "handle_schedule_request" -v
```
Expected: `ImportError`

- [ ] **Step 3: Add `handle_schedule_request` and helpers to `schedule.py`**

```python
# Duration defaults per activity type
_DURATION_DEFAULTS: dict[str, int] = {
    "study": 2,
    "workout": 1,
    "meal": 1,
}

# Formatting helpers
def _format_time(iso: str) -> str:
    """Format ISO datetime to '8:00pm' style."""
    dt = datetime.fromisoformat(iso)
    return dt.strftime("%I:%M%p").lstrip("0").lower()


def _format_date_label(target: datetime) -> str:
    """Return 'tomorrow', 'tonight', or 'Friday' etc. relative label."""
    from datetime import date
    today = date.today()
    target_date = target.date()
    if target_date == today:
        return "today"
    from datetime import timedelta
    if target_date == today + timedelta(days=1):
        return "tomorrow"
    return target.strftime("%A")  # e.g. "Friday"


def _check_gcal_connected(user_id: str) -> bool:
    """Return True if user has a linked Google Calendar integration."""
    rows = (
        _get_supabase()
        .table("integrations")
        .select("id")
        .eq("user_id", user_id)
        .eq("platform", "google")
        .execute()
        .data
    )
    return bool(rows)


def _fetch_slots(user_id: str, target: datetime, duration_hours: int, preference: str, user_tz: str) -> list[dict]:
    """Fetch calendar events and return free slots for the target date."""
    from gcal.db import get_calendar_events
    from gcal.slots import find_free_slots

    day_start = target.strftime("%Y-%m-%dT00:00:00+00:00")
    day_end   = target.strftime("%Y-%m-%dT23:59:59+00:00")
    events = get_calendar_events(user_id, day_start, day_end)
    return find_free_slots(
        events=events,
        date=target,
        min_duration_hours=duration_hours,
        study_preference=preference,
        user_tz=user_tz,
    )


def handle_schedule_request(
    user_id: str,
    activity_type: str,
    subject: Optional[str],
    target_date_string: str,
    duration_hours: Optional[int],
) -> str:
    """Orchestrate a scheduling request from SMS.

    Handles: GCal connected check, date parsing, preference lookup/ask,
    slot-finding, pending state storage, confirmation prompt generation.

    Args:
        user_id: UUID of the user.
        activity_type: Normalized activity type from intent (e.g. 'study', 'workout').
        subject: Optional subject/topic (e.g. 'biochem exam').
        target_date_string: Natural language date from student ('tomorrow', 'Friday').
        duration_hours: Desired duration override, or None to use activity default.

    Returns:
        SMS reply string.
    """
    user_tz = get_user_tz(user_id)

    # Parse date
    target = parse_target_date(target_date_string or "today", user_tz)
    if not target:
        return "What date did you have in mind? Try something like 'tomorrow' or 'Friday'."

    # Check Google Calendar connected
    if not _check_gcal_connected(user_id):
        return (
            "You'll need to connect Google Calendar first — "
            "head to Preferences in the app."
        )

    # Resolve duration
    dur = duration_hours or _DURATION_DEFAULTS.get(activity_type, 1)

    # Preference lookup / ask
    preference = get_activity_preference(user_id, activity_type)
    if preference is None:
        # Flow A: ask first
        original_request = {
            "activity_type": activity_type,
            "subject": subject,
            "target_date_string": target_date_string,
            "duration_hours": duration_hours,
        }
        store_pending_preference(user_id, activity_type, original_request)
        label = activity_type.replace("_", " ")
        return (
            f"When do you usually like to {label} — "
            "morning, afternoon, or evening?"
        )

    # Find slots
    slots = _fetch_slots(user_id, target, dur, preference, user_tz)
    if not slots:
        date_label = _format_date_label(target)
        return (
            f"Your calendar's fully booked {date_label} — text me "
            f"'find time to {activity_type} tomorrow' to check then."
        )

    # Build event title
    if activity_type == "study" and subject:
        title = f"{subject.title()} Study"
    else:
        title = activity_type.replace("_", " ").title()

    # Store pending (top slot + up to 2 alternatives)
    top = slots[0]
    alts = slots[1:3]
    store_pending_schedule(user_id, {
        "activity_type": activity_type,
        "subject": subject,
        "title": title,
        "start": top["start"],
        "end": top["end"],
        "alternative_slots": alts,
    })

    date_label = _format_date_label(target)
    time_str = f"{_format_time(top['start'])}–{_format_time(top['end'])}"
    return f"Best window {date_label} is {time_str}. Should I add it?"
```

- [ ] **Step 4: Run tests**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "handle_schedule_request" -v
```
Expected: all 5 PASS

- [ ] **Step 5: Commit**

```bash
git add celery_worker/sms/schedule.py celery_worker/tests/sms/test_schedule.py
git commit -m "feat: add handle_schedule_request orchestrator"
```

---

## Task 7: `handle_schedule_confirmation` + `handle_schedule_decline`

**Files:**
- Modify: `celery_worker/sms/schedule.py`
- Modify: `celery_worker/tests/sms/test_schedule.py`

- [ ] **Step 1: Write failing tests — append to `test_schedule.py`**

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "confirmation or decline" -v
```
Expected: `ImportError`

- [ ] **Step 3: Add both functions to `schedule.py`**

```python
def _book_event(user_id: str, title: str, start_iso: str, end_iso: str) -> str:
    """Create a calendar event. Returns the Google Calendar event ID."""
    from gcal.writeback import create_study_block
    start_dt = datetime.fromisoformat(start_iso)
    end_dt   = datetime.fromisoformat(end_iso)
    return create_study_block(user_id, title, start_dt, end_dt)


def handle_schedule_confirmation(user_id: str) -> str:
    """Book the pending schedule when the student confirms.

    Args:
        user_id: UUID of the user.

    Returns:
        SMS confirmation string, or graceful error if pending expired.
    """
    pending = get_pending_schedule(user_id)
    if not pending:
        return "I couldn't find that request — it may have expired. Try again!"

    _book_event(user_id, pending["title"], pending["start"], pending["end"])
    learn_from_confirmation(user_id, pending["activity_type"], pending["start"])
    clear_pending_schedule(user_id)

    time_str = f"{_format_time(pending['start'])}–{_format_time(pending['end'])}"
    return f"Done — {pending['title']} added for {time_str}."


def handle_schedule_decline(user_id: str) -> str:
    """Offer the next alternative slot when the student declines.

    Args:
        user_id: UUID of the user.

    Returns:
        New confirmation prompt with alternative slot, or no-more-slots message.
    """
    pending = get_pending_schedule(user_id)
    if not pending:
        return "I couldn't find that request — it may have expired. Try again!"

    alternatives = pending.get("alternative_slots", [])
    if not alternatives:
        clear_pending_schedule(user_id)
        return (
            "No other slots available that day — text me "
            f"'find time to {pending['activity_type']} tomorrow' to check a different day."
        )

    # Promote first alternative to proposed slot
    next_slot = alternatives[0]
    remaining  = alternatives[1:]
    store_pending_schedule(user_id, {
        **pending,
        "start": next_slot["start"],
        "end":   next_slot["end"],
        "alternative_slots": remaining,
    })

    time_str = f"{_format_time(next_slot['start'])}–{_format_time(next_slot['end'])}"
    return f"Next best is {time_str}. Should I add that instead?"
```

- [ ] **Step 4: Run tests**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -k "confirmation or decline" -v
```
Expected: all 4 PASS

- [ ] **Step 5: Run all schedule tests**

```bash
cd celery_worker
python -m pytest tests/sms/test_schedule.py -v
```
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add celery_worker/sms/schedule.py celery_worker/tests/sms/test_schedule.py
git commit -m "feat: add schedule confirmation and decline handlers"
```

---

## Task 8: Wire into `replies.py` — intent prompt + intercept order + routing

**Files:**
- Modify: `celery_worker/ai/replies.py`
- Modify: `celery_worker/tests/ai/test_replies.py`

- [ ] **Step 1: Write failing tests — append to `test_replies.py`**

```python
# ---------------------------------------------------------------------------
# Intercept order + schedule routing
# ---------------------------------------------------------------------------

def test_pending_preference_intercept_fires_before_claude():
    """When pending_preference Redis key exists and answer is 'morning', stores preference and finds slots."""
    from ai.replies import handle_reply
    pending_pref = {
        "activity_type": "workout",
        "original_request": {"activity_type": "workout", "subject": None, "target_date_string": "tomorrow", "duration_hours": None}
    }
    with patch("sms.schedule.get_pending_preference", return_value=pending_pref), \
         patch("sms.schedule.set_activity_preference") as mock_set, \
         patch("sms.schedule.clear_pending_preference") as mock_clear, \
         patch("sms.schedule.handle_schedule_request", return_value="Best window is 7–9am. Should I add it?") as mock_req, \
         patch("ai.replies.get_conversation_history", return_value=[]):

        result = handle_reply("user-123", "morning")

    mock_set.assert_called_once_with("user-123", "workout", "morning")
    mock_clear.assert_called_once()
    mock_req.assert_called_once()
    assert "should i add it" in result.lower()


def test_pending_schedule_affirmative_routes_to_confirmation():
    """'yes' with a pending schedule calls handle_schedule_confirmation."""
    from ai.replies import handle_reply
    from unittest.mock import patch
    with patch("sms.schedule.get_pending_preference", return_value=None), \
         patch("sms.schedule.get_pending_schedule", return_value={"title": "Biochem Study", "start": "2026-03-22T20:00:00-05:00", "end": "2026-03-22T22:00:00-05:00", "activity_type": "study", "alternative_slots": []}), \
         patch("sms.schedule.handle_schedule_confirmation", return_value="Done — Biochem Study added.") as mock_confirm, \
         patch("ai.replies.get_conversation_history", return_value=[]):

        result = handle_reply("user-123", "yes")

    mock_confirm.assert_called_once_with("user-123")
    assert "done" in result.lower()


def test_pending_schedule_negative_routes_to_decline():
    """'no' with a pending schedule calls handle_schedule_decline."""
    from ai.replies import handle_reply
    with patch("sms.schedule.get_pending_preference", return_value=None), \
         patch("sms.schedule.get_pending_schedule", return_value={"title": "Study", "start": "x", "end": "y", "activity_type": "study", "alternative_slots": []}), \
         patch("sms.schedule.handle_schedule_decline", return_value="Next best is 3–5pm.") as mock_decline, \
         patch("ai.replies.get_conversation_history", return_value=[]):

        result = handle_reply("user-123", "no")

    mock_decline.assert_called_once_with("user-123")


def test_pending_schedule_unmatched_reply_falls_through():
    """An unrecognized reply while pending exists falls through to Claude intent extraction.
    Pending key must survive (clear_pending_schedule NOT called) so confirmation still works.
    """
    from ai.replies import handle_reply
    intent_json = '{"action":"query","task_hint":null,"priority_value":null,"due_string":null}'
    with patch("sms.schedule.get_pending_preference", return_value=None), \
         patch("sms.schedule.get_pending_schedule", return_value={"title": "Study"}), \
         patch("sms.schedule.clear_pending_schedule") as mock_clear, \
         patch("ai.replies.get_deadlines_for_briefing", return_value=[]), \
         patch("ai.replies.get_conversation_history", return_value=[]), \
         patch("ai.replies.Anthropic") as mock_anthropic:

        mock_client = MagicMock()
        mock_anthropic.return_value = mock_client
        mock_client.messages.create.side_effect = [
            _mock_claude_response(intent_json),
            _mock_claude_response("You have no upcoming deadlines."),
        ]
        result = handle_reply("user-123", "what is the meaning of life")

    # Claude was called (fell through to intent path)
    assert mock_client.messages.create.call_count >= 1
    # Pending key must NOT be cleared — confirmation flow must still be available
    mock_clear.assert_not_called()


def test_schedule_intent_routes_to_handle_schedule_request():
    """Intent 'schedule' routes to handle_schedule_request."""
    from ai.replies import handle_reply
    intent_json = '{"action":"schedule","activity_type":"study","subject":"biochem","target_date_string":"tomorrow","duration_hours":null}'
    with patch("sms.schedule.get_pending_preference", return_value=None), \
         patch("sms.schedule.get_pending_schedule", return_value=None), \
         patch("ai.replies._handle_study_preference_reply", return_value=None), \
         patch("ai.replies.get_deadlines_for_briefing", return_value=[]), \
         patch("ai.replies.get_conversation_history", return_value=[]), \
         patch("ai.replies.Anthropic") as mock_anthropic, \
         patch("sms.schedule.handle_schedule_request", return_value="Best window is 8–10pm. Should I add it?") as mock_req:

        mock_client = MagicMock()
        mock_anthropic.return_value = mock_client
        mock_client.messages.create.return_value = _mock_claude_response(intent_json)

        result = handle_reply("user-123", "find me time to study biochem tomorrow")

    mock_req.assert_called_once_with(
        "user-123",
        activity_type="study",
        subject="biochem",
        target_date_string="tomorrow",
        duration_hours=None,
    )
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd celery_worker
python -m pytest tests/ai/test_replies.py -k "pending or schedule_intent" -v
```
Expected: FAIL (schedule module not wired in yet)

- [ ] **Step 3: Update `INTENT_SYSTEM_PROMPT` in `replies.py`**

Find the `INTENT_SYSTEM_PROMPT` string and add the `schedule` action. Locate the `"action"` line and extend it:

```python
INTENT_SYSTEM_PROMPT = """You are Aria's intent classifier.
Given a student's SMS, return ONLY valid JSON (no markdown, no explanation):
{
  "action": "query" | "mark_complete" | "snooze" | "set_priority" | "todoist_create" | "todoist_complete" | "todoist_update_due" | "todoist_delete" | "schedule" | "off_topic",
  "task_hint": "<partial task name, lowercase, or null>",
  "priority_value": "high" | "normal" | null,
  "due_string": "<natural language due date, e.g. 'Friday', 'tomorrow at 3pm', or null>",
  "activity_type": "<normalized: study | workout | meal | personal | other lowercase word, or null>",
  "subject": "<specific topic/course/task, e.g. 'biochem exam', 'chest day', or null>",
  "target_date_string": "<natural language date: 'tomorrow', 'Friday', 'tonight', or null>",
  "duration_hours": <integer hours or null>
}

Rules:
- "query" for deadline questions ("what's due?", "do I have anything tomorrow?")
- "mark_complete" for done/finished/completed ("mark bio lab done", "finished econ pset")
- "snooze" for snooze/remind me later ("snooze chem hw", "not now for bio")
- "set_priority" for priority changes ("high priority econ pset", "urgent: calc midterm")
- "todoist_create" for adding new personal tasks ("add buy textbook due friday", "remind me to email prof tomorrow")
- "todoist_complete" for completing Todoist tasks ("done with buy textbook", "finished grocery run")
- "todoist_update_due" for rescheduling Todoist tasks ("move buy textbook to Monday", "push grocery to next week")
- "todoist_delete" for removing Todoist tasks ("delete buy textbook", "remove grocery run from my list")
- "schedule" for scheduling/blocking time requests ("find me time to study", "schedule a workout", "block 2 hours for biochem", "when can I go to the gym tomorrow")
- "off_topic" for anything not deadline or scheduling related
- task_hint: extract the course/assignment name fragment, lowercase (for non-schedule actions)
- due_string: extract date hint for create/update — use Todoist natural language format; null if not mentioned
- activity_type normalization: study/review/homework/exam prep → "study"; workout/gym/run/lift/exercise/yoga → "workout"; lunch/dinner/breakfast/eat/meal → "meal"; anything else → pass through lowercase
- duration_hours: extract if student specifies ("2 hours", "an hour") — null otherwise
- subject: for schedule action, extract what specifically (course name, exam, topic); null if not mentioned
- target_date_string: for schedule action, the date/time requested; null if not mentioned
- If "todoist_create" but no due date mentioned, still classify as todoist_create with due_string=null"""
```

- [ ] **Step 4: Add 4-step intercept order to `handle_reply()`**

At the top of `handle_reply()`, replace the existing single `_handle_study_preference_reply` call with the 4-step sequence. Find this block:

```python
    # Intercept study preference reply before Claude processing
    study_pref_reply = _handle_study_preference_reply(user_id, body)
    if study_pref_reply is not None:
        return study_pref_reply
```

Replace with:

```python
    from sms.schedule import (
        get_pending_preference, clear_pending_preference,
        set_activity_preference, handle_schedule_request,
        get_pending_schedule,
        handle_schedule_confirmation, handle_schedule_decline,
    )

    # Step 1: Pending preference intercept (Flow A answer: morning/afternoon/evening)
    pending_pref = get_pending_preference(user_id)
    if pending_pref is not None:
        answer = body.strip().lower().rstrip("s")  # normalize "mornings" → "morning"
        if answer in ("morning", "afternoon", "evening"):
            set_activity_preference(user_id, pending_pref["activity_type"], answer)
            clear_pending_preference(user_id)
            req = pending_pref["original_request"]
            return handle_schedule_request(
                user_id,
                activity_type=req.get("activity_type", "personal"),
                subject=req.get("subject"),
                target_date_string=req.get("target_date_string", "today"),
                duration_hours=req.get("duration_hours"),
            )
        # Unrecognized answer — re-ask
        label = pending_pref["activity_type"].replace("_", " ")
        return f"Just reply morning, afternoon, or evening — when do you usually like to {label}?"

    # Step 2: Pending schedule intercept (confirmation / decline)
    _AFFIRMATIVES = {"yes", "sure", "ok", "okay", "yeah", "yep", "yup", "add it", "confirm", "sounds good", "do it", "go ahead", "book it"}
    _NEGATIVES    = {"no", "nope", "skip", "cancel", "different", "earlier", "later", "another"}
    pending_sched = get_pending_schedule(user_id)
    if pending_sched is not None:
        normalized = body.strip().lower().rstrip(".")
        if normalized in _AFFIRMATIVES:
            return handle_schedule_confirmation(user_id)
        if normalized in _NEGATIVES:
            return handle_schedule_decline(user_id)
        # Unrecognized — fall through with pending still alive

    # Step 3: Existing study preference intercept (only when no Redis keys present)
    study_pref_reply = _handle_study_preference_reply(user_id, body)
    if study_pref_reply is not None:
        return study_pref_reply

    # Step 4: Claude intent extraction (continues below)
```

- [ ] **Step 5: Add `schedule` branch to the action router in `handle_reply()`**

Find the section that checks action values and add after the Todoist block:

```python
    # Schedule action
    if action == "schedule":
        from sms.schedule import handle_schedule_request
        return handle_schedule_request(
            user_id,
            activity_type=intent.get("activity_type") or "personal",
            subject=intent.get("subject"),
            target_date_string=intent.get("target_date_string") or "today",
            duration_hours=int(intent["duration_hours"]) if intent.get("duration_hours") else None,
        )
```

- [ ] **Step 6: Run new tests**

```bash
cd celery_worker
python -m pytest tests/ai/test_replies.py -k "pending or schedule_intent" -v
```
Expected: all 5 new tests PASS

- [ ] **Step 7: Run full test suite to check no regressions**

```bash
cd celery_worker
python -m pytest tests/ -v --tb=short
```
Expected: all tests PASS (242+ existing + new)

- [ ] **Step 8: Commit**

```bash
git add celery_worker/ai/replies.py celery_worker/tests/ai/test_replies.py
git commit -m "feat: wire on-demand scheduling into SMS reply handler"
```

---

## Task 9: Add Phase 13 (Voice Redesign) to roadmap + Notion

**Files:**
- Modify: `.planning/ROADMAP.md`

- [ ] **Step 0: Verify ROADMAP.md path**

```bash
ls .planning/ROADMAP.md
```
Expected: file exists. If not, check `PROGRESS.md → Key File Locations` for the correct path.

- [ ] **Step 1: Add Phase 13 to ROADMAP.md**

Open `.planning/ROADMAP.md` and append to the phases list under v1.1:

```markdown
#### Phase 13: Conversational Voice Mode (v1.2)
**Goal**: Replace the two-tap voice input with a fully conversational voice interface — auto-detects when the user stops speaking, responds verbally, and shows live visual feedback of actions being taken (calendar blocks filling, tasks being created).
**Depends on**: Phase 12 (App Store launch complete)
**Requirements**: Voice Activity Detection, Text-to-Speech output, dedicated full-screen voice canvas UI, live action animations (calendar, task list), on-demand scheduling integration
**Success Criteria**:
  1. User opens voice mode to a dedicated blank-canvas screen (not a home page button)
  2. Aria detects end-of-speech automatically — no tap required to stop
  3. Aria responds verbally within 3 seconds of detecting silence
  4. Scheduling requests show a live calendar animation of the block being placed
  5. Voice mode is fully functional end-to-end: "find me time to study biochem tomorrow" → verbal response + visual calendar block
**Status**: Planned (v1.2 — post App Store launch)
```

- [ ] **Step 2: Update Notion roadmap page**

The Notion MVP Progress Log should reflect Phase 13. Add a row to the status table and a note in the push log.

- [ ] **Step 3: Commit**

```bash
git add .planning/ROADMAP.md
git commit -m "docs: add Phase 13 conversational voice mode to roadmap (v1.2)"
```

---

## Final Verification

- [ ] **Run complete test suite one last time**

```bash
cd celery_worker
python -m pytest tests/ -v --tb=short 2>&1 | tail -20
```
Expected: all tests PASS, no regressions

- [ ] **Confirm schedule module is importable**

```bash
cd celery_worker
python -c "from sms.schedule import handle_schedule_request, handle_schedule_confirmation, handle_schedule_decline; print('OK')"
```
Expected: `OK`
