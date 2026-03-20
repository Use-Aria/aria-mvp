"""Free slot finder for waking hours.

Computes gaps in a user's calendar within waking hours (7am-10pm),
sorted by the user's study preference (morning/afternoon/evening).

Used by: Monday briefing enrichment, study block scheduling.
"""
from datetime import datetime, timedelta, time, timezone
from zoneinfo import ZoneInfo

WAKING_START = time(7, 0)   # 7am
WAKING_END = time(22, 0)    # 10pm

# Preference order: each tuple is (start_hour, end_hour) for a time block.
# First entry in the list = highest priority window.
PREFERENCE_ORDER = {
    "morning": [(7, 12), (12, 17), (17, 22)],    # morning first, then afternoon, then evening
    "afternoon": [(12, 17), (7, 12), (17, 22)],  # afternoon first
    "evening": [(17, 22), (12, 17), (7, 12)],    # evening first (default)
}


def find_free_slots(
    events: list[dict],
    date: datetime,
    min_duration_hours: int = 2,
    study_preference: str = "evening",
    user_tz: str = "America/New_York",
) -> list[dict]:
    """Find free time slots of at least min_duration_hours in waking hours.

    Returns list of {start: str, end: str, duration_hours: float}
    sorted by preference (study_preference ordering). Slots shorter than
    min_duration_hours are excluded.

    Args:
        events: List of dicts with start_time and end_time (ISO strings).
        date: The date to search for slots (only the date portion is used).
        min_duration_hours: Minimum gap length in hours to include (default 2).
        study_preference: One of 'morning', 'afternoon', 'evening' (default 'evening').
        user_tz: IANA timezone string for the user (default 'America/New_York').

    Returns:
        List of free slot dicts with keys: start (ISO str), end (ISO str),
        duration_hours (float, rounded to 1 decimal). Sorted by study_preference.
    """
    tz = ZoneInfo(user_tz)
    day_start = datetime.combine(date.date(), WAKING_START, tzinfo=tz)
    day_end = datetime.combine(date.date(), WAKING_END, tzinfo=tz)

    # Parse and clip events to this day's waking hours
    busy = []
    for e in events:
        s = datetime.fromisoformat(e["start_time"])
        en = datetime.fromisoformat(e["end_time"])
        if s.tzinfo is None:
            s = s.replace(tzinfo=timezone.utc)
        if en.tzinfo is None:
            en = en.replace(tzinfo=timezone.utc)
        # Convert to user timezone
        s = s.astimezone(tz)
        en = en.astimezone(tz)
        # Only include events that overlap with this day's waking hours
        if en > day_start and s < day_end:
            busy.append((max(s, day_start), min(en, day_end)))

    busy.sort(key=lambda x: x[0])

    # Find gaps between busy periods
    gaps = []
    cursor = day_start
    for start, end in busy:
        if start > cursor:
            gap_hours = (start - cursor).total_seconds() / 3600
            if gap_hours >= min_duration_hours:
                gaps.append({
                    "start": cursor.isoformat(),
                    "end": start.isoformat(),
                    "duration_hours": round(gap_hours, 1),
                })
        cursor = max(cursor, end)

    # Check gap after last event
    if cursor < day_end:
        gap_hours = (day_end - cursor).total_seconds() / 3600
        if gap_hours >= min_duration_hours:
            gaps.append({
                "start": cursor.isoformat(),
                "end": day_end.isoformat(),
                "duration_hours": round(gap_hours, 1),
            })

    # Sort by preference: slots in the preferred window come first
    pref_order = PREFERENCE_ORDER.get(study_preference, PREFERENCE_ORDER["evening"])

    def preference_key(slot: dict) -> int:
        slot_hour = datetime.fromisoformat(slot["start"]).hour
        for i, (lo, hi) in enumerate(pref_order):
            if lo <= slot_hour < hi:
                return i
        return len(pref_order)

    gaps.sort(key=preference_key)
    return gaps
