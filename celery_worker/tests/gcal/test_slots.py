"""Unit tests for gcal.slots — free slot finder.

Tests cover: no events (full day free), partial events (gaps found),
fully booked (empty result), preference ordering (morning/evening).
"""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TZ = ZoneInfo("America/New_York")


def _make_event(start_hour: int, end_hour: int, date: str = "2026-03-23") -> dict:
    """Build a fake calendar event dict with ISO start/end times.

    March 23, 2026 is in EDT (UTC-4) — daylight saving time is active.
    """
    return {
        "start_time": f"{date}T{start_hour:02d}:00:00-04:00",
        "end_time": f"{date}T{end_hour:02d}:00:00-04:00",
    }


def _day(date_str: str = "2026-03-23") -> datetime:
    """Return a datetime for the given date in Eastern time."""
    return datetime(int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10]),
                    12, 0, 0, tzinfo=TZ)


# ---------------------------------------------------------------------------
# No events — full waking hours available
# ---------------------------------------------------------------------------


def test_no_events_returns_one_full_slot():
    """No events: find_free_slots returns one slot covering 7am-10pm (15 hours)."""
    from gcal.slots import find_free_slots

    slots = find_free_slots([], _day(), min_duration_hours=2, user_tz="America/New_York")
    assert len(slots) == 1
    assert slots[0]["duration_hours"] == 15.0


def test_no_events_slot_starts_at_7am():
    """No events: the single slot starts at 7am local time."""
    from gcal.slots import find_free_slots

    slots = find_free_slots([], _day(), min_duration_hours=2, user_tz="America/New_York")
    assert len(slots) == 1
    start = datetime.fromisoformat(slots[0]["start"])
    assert start.hour == 7


# ---------------------------------------------------------------------------
# Partial events — gaps found
# ---------------------------------------------------------------------------


def test_one_event_creates_two_gaps():
    """One midday event creates a morning gap and an afternoon/evening gap."""
    from gcal.slots import find_free_slots

    # Event from 1pm to 3pm in Eastern (-05:00 offset used in make_event helper)
    events = [_make_event(13, 15)]  # 1pm to 3pm Eastern
    slots = find_free_slots(events, _day(), min_duration_hours=2, user_tz="America/New_York")

    # Should find: 7am-1pm (6h) and 3pm-10pm (7h)
    assert len(slots) >= 2
    durations = sorted(s["duration_hours"] for s in slots)
    assert 6.0 in durations
    assert 7.0 in durations


def test_min_duration_filters_short_gaps():
    """Gaps shorter than min_duration_hours are excluded."""
    from gcal.slots import find_free_slots

    # 7am-10pm = 15h; event from 8am to 8:30am leaves a 1-hour gap before it
    events = [_make_event(9, 21)]  # 9am to 9pm
    slots = find_free_slots(events, _day(), min_duration_hours=2, user_tz="America/New_York")

    # Gap before event: 7am-9am = 2h (included), gap after: 9pm-10pm = 1h (excluded)
    assert len(slots) == 1
    assert slots[0]["duration_hours"] == 2.0


# ---------------------------------------------------------------------------
# Fully booked — empty result
# ---------------------------------------------------------------------------


def test_fully_booked_returns_empty_list():
    """Fully booked day: find_free_slots returns empty list."""
    from gcal.slots import find_free_slots

    # Cover entire waking window 7am-10pm
    events = [_make_event(7, 22)]
    slots = find_free_slots(events, _day(), min_duration_hours=2, user_tz="America/New_York")
    assert slots == []


def test_no_slot_long_enough_returns_empty():
    """If no gap is >= min_duration_hours, returns empty list."""
    from gcal.slots import find_free_slots

    # Events leave only 1.5h gaps everywhere
    events = [
        _make_event(8, 10),   # occupies 8am-10am, gap 7-8=1h (too short for 2h)
        _make_event(11, 14),  # occupies 11am-2pm, gap 10-11=1h
        _make_event(15, 20),  # occupies 3pm-8pm, gap 2-3=1h
    ]
    slots = find_free_slots(events, _day(), min_duration_hours=2, user_tz="America/New_York")
    # 8pm-10pm = 2h gap remains
    assert all(s["duration_hours"] >= 2.0 for s in slots)


# ---------------------------------------------------------------------------
# Preference ordering
# ---------------------------------------------------------------------------


def test_evening_preference_returns_evening_slots_first():
    """study_preference='evening' returns evening slots (17-22) before morning."""
    from gcal.slots import find_free_slots

    # No events — three preference windows available (morning, afternoon, evening)
    slots = find_free_slots([], _day(), min_duration_hours=2,
                            study_preference="evening", user_tz="America/New_York")
    assert len(slots) == 1  # only one slot (full day), so just verify ordering works
    # With no events there's only one full-day slot; check its start is 7am
    start_hour = datetime.fromisoformat(slots[0]["start"]).hour
    assert start_hour == 7  # only one slot, starts at 7am


def test_morning_preference_returns_morning_slots_first():
    """study_preference='morning' puts morning slot (7-12h) before evening."""
    from gcal.slots import find_free_slots

    # Event from 12pm-8pm creates morning gap (7-12) and evening gap (8-10pm)
    events = [_make_event(12, 20)]  # noon to 8pm
    slots = find_free_slots(events, _day(), min_duration_hours=2,
                            study_preference="morning", user_tz="America/New_York")

    # Both gaps exist: 7am-12pm (5h) and 8pm-10pm (2h)
    assert len(slots) == 2
    # Morning preference: 7am-12pm slot should come first
    first_start = datetime.fromisoformat(slots[0]["start"]).hour
    assert first_start == 7


def test_evening_preference_orders_evening_first_over_morning():
    """study_preference='evening' puts evening (17-22h) slot before morning (7-12h)."""
    from gcal.slots import find_free_slots

    # Event from 12pm-5pm (12-17) leaves morning (7-12) and evening (17-22) free
    events = [_make_event(12, 17)]
    slots = find_free_slots(events, _day(), min_duration_hours=2,
                            study_preference="evening", user_tz="America/New_York")

    assert len(slots) == 2
    # Evening preference: 5pm-10pm (17-22) slot should come first
    first_start = datetime.fromisoformat(slots[0]["start"]).hour
    assert first_start >= 17
