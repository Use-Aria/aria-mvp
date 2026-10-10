from __future__ import annotations

from datetime import date, time

import pytest

from app.dates import (
    Term,
    extract_times,
    is_stale,
    localize,
    parse_hhmm,
    resolve_date,
    term_window,
    tz_from_hint,
)

FALL = Term(date(2026, 8, 26), date(2026, 12, 18))
TODAY = date(2026, 10, 10)


def test_month_day_in_fall_term() -> None:
    r = resolve_date("", "Oct 15", 0, FALL, TODAY)
    assert r.date == date(2026, 10, 15)
    assert r.confidence == "inferred_year"


def test_jan_in_fall_to_spring_window_is_next_year() -> None:
    # No term hint: window is today-30 .. today+150, which spans New Year.
    r = resolve_date("", "Jan 20", 0, Term(None, None), TODAY)
    assert r.date == date(2027, 1, 20)


@pytest.mark.parametrize(("text", "expected"), [("Fri 1/8", date(2027, 1, 8)), ("Thu 1/8", date(2026, 1, 8))])
def test_weekday_picks_matching_year(text: str, expected: date) -> None:
    # A calendar-year program: both Jan 8 2026 and Jan 8 2027 sit inside the padded window.
    term = Term(date(2026, 1, 12), date(2026, 12, 18))
    r = resolve_date("", text, 0, term, TODAY)
    assert r.date == expected
    assert not r.weekday_mismatch


def test_thu_10_15_matches_2026() -> None:
    r = resolve_date("", "Thu 10/15", 0, FALL, TODAY)
    assert r.date == date(2026, 10, 15)
    assert not r.weekday_mismatch


def test_weekday_mismatch_flagged() -> None:
    r = resolve_date("", "Wed Oct 15", 0, FALL, TODAY)
    assert r.date == date(2026, 10, 15)
    assert r.weekday_mismatch


def test_week_n_weekday() -> None:
    r = resolve_date("", "Week 5 Tue", 0, Term(date(2026, 8, 26), None), TODAY)
    assert r.date == date(2026, 9, 22)
    assert r.confidence == "from_week"
    assert r.week == 5


def test_week_without_weekday_is_unresolved_but_keeps_week() -> None:
    r = resolve_date("", "Week 8", 0, FALL, TODAY)
    assert r.date is None
    assert r.confidence == "unresolved"
    assert r.week == 8


def test_unresolvable_text() -> None:
    r = resolve_date("", "TBA (registrar)", 0, FALL, TODAY)
    assert r.date is None and r.confidence == "unresolved"


def test_explicit_year_is_exact() -> None:
    r = resolve_date("2025-01-01", "Monday, December 14, 2026", 0, FALL, TODAY)
    assert r.date == date(2026, 12, 14)
    assert r.confidence == "exact"


def test_model_iso_used_when_text_has_no_date() -> None:
    r = resolve_date("2026-11-20", "the Friday before Thanksgiving", 0, FALL, TODAY)
    assert r.date == date(2026, 11, 20)
    assert r.confidence == "inferred_year"


def test_model_iso_outside_window_rejected() -> None:
    r = resolve_date("2024-11-20", "", 0, FALL, TODAY)
    assert r.date is None


def test_text_beats_model() -> None:
    r = resolve_date("2026-10-16", "Thu Oct 15", 0, FALL, TODAY)
    assert r.date == date(2026, 10, 15)


def test_term_window_fallbacks() -> None:
    assert term_window(Term(None, None), TODAY) == (date(2026, 9, 10), date(2027, 3, 9))
    assert term_window(Term(date(2026, 8, 26), None), TODAY)[1] == date(2027, 1, 23)


def test_dst_fall_back() -> None:
    before = localize(date(2026, 10, 30), time(9, 0), None, "America/New_York")
    after = localize(date(2026, 11, 2), time(9, 0), time(10, 30), "America/New_York")
    assert before.starts_at_utc == "2026-10-30T13:00:00Z"
    assert after.starts_at_utc == "2026-11-02T14:00:00Z"
    assert after.ends_at_utc == "2026-11-02T15:30:00Z"
    assert after.start_local == "2026-11-02T09:00"
    assert not after.all_day


def test_spring_forward_gap_resolves_forward() -> None:
    lt = localize(date(2027, 3, 14), time(2, 30), None, "America/New_York")
    assert lt.starts_at_utc == "2027-03-14T07:30:00Z"  # == 03:30 EDT


def test_all_day_bounds() -> None:
    lt = localize(date(2026, 11, 1), None, None, "America/New_York")
    assert lt.all_day
    assert lt.start_local is None
    assert lt.starts_at_utc == "2026-11-01T04:00:00Z"
    assert lt.ends_at_utc == "2026-11-02T05:00:00Z"  # 25-hour day (DST ends)


def test_end_before_start_dropped() -> None:
    lt = localize(date(2026, 10, 15), time(13, 0), time(12, 0), "America/New_York")
    assert lt.end_local is None and lt.ends_at_utc is None


@pytest.mark.parametrize(
    ("hint", "expected"),
    [
        ("ET", "America/New_York"),
        ("all times Eastern", "America/New_York"),
        ("PT", "America/Los_Angeles"),
        ("America/Chicago", "America/Chicago"),
        ("", "Europe/London"),
        ("Mars/Olympus", "Europe/London"),
        ("whenever", "Europe/London"),
    ],
)
def test_tz_from_hint(hint: str, expected: str) -> None:
    assert tz_from_hint(hint, "Europe/London") == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("13:05", time(13, 5)), ("9:30", time(9, 30)), ("1:30pm", time(13, 30)), ("9 am", time(9, 0)),
     ("12pm", time(12, 0)), ("12am", time(0, 0)), ("noon", time(12, 0)), ("", None), ("25:00", None),
     ("9", None), ("soon", None)],
)  # fmt: skip
def test_parse_hhmm(raw: str, expected: time | None) -> None:
    assert parse_hhmm(raw) == expected


def test_stale_term_detection() -> None:
    old = [date(2025, 9, 1), date(2025, 10, 1), date(2026, 11, 1)]
    assert is_stale(old, TODAY)
    assert not is_stale([date(2026, 10, 1), date(2026, 11, 1)], TODAY)
    assert not is_stale([], TODAY)


@pytest.mark.parametrize(
    ("text", "start", "end"),
    [
        ("13:00-14:15", time(13, 0), time(14, 15)),
        ("1:00-2:15pm", time(13, 0), time(14, 15)),
        ("11-12:15pm", time(11, 0), time(12, 15)),
        ("9:00am-12:00pm", time(9, 0), time(12, 0)),
        ("9 a.m. to 10:30 a.m.", time(9, 0), time(10, 30)),
        ("Fri 9/18, 5pm", time(17, 0), None),
        ("due 11:59 PM", time(23, 59), None),
        ("19:30", time(19, 30), None),
        ("noon", time(12, 0), None),
        ("by midnight", time(23, 59), None),
        ("Oct 10-15", None, None),
        ("Thu 10/15", None, None),
        ("Week 8", None, None),
        ("", None, None),
    ],
)
def test_extract_times(text: str, start: time | None, end: time | None) -> None:
    assert extract_times(text) == (start, end)
