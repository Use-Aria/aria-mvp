"""Pure date logic (V2-08 §2.7): term windows, year inference, "Week N" resolution, DST-safe
localization. The resolver trusts its own reading of the raw text over the model's ISO guess.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

Confidence = Literal["exact", "inferred_year", "from_week", "unresolved"]

PAD_BEFORE = timedelta(days=7)
PAD_AFTER = timedelta(days=21)
FALLBACK_BEFORE = timedelta(days=30)
FALLBACK_AFTER = timedelta(days=150)
TERM_SPAN = timedelta(days=150)


@dataclass(frozen=True)
class Term:
    """Known term bounds (either may be missing)."""

    start: date | None
    end: date | None


@dataclass(frozen=True)
class ResolvedDate:
    """Outcome of `resolve_date`. `weekday_mismatch` = the text names a weekday that the
    chosen date doesn't fall on."""

    date: date | None
    confidence: Confidence
    week: int | None = None
    weekday_mismatch: bool = False


@dataclass(frozen=True)
class LocalizedTimes:
    """Local wall-clock strings and UTC instants for one dated item."""

    all_day: bool
    start_local: str | None
    end_local: str | None
    starts_at_utc: str | None
    ends_at_utc: str | None


def term_window(term: Term, today: date) -> tuple[date, date]:
    """Term bounds with fallbacks: a missing end is start + 150 d, a missing start is end − 150 d,
    and with neither the window is today − 30 d … today + 150 d."""
    if term.start and term.end and term.start <= term.end:
        return term.start, term.end
    if term.start:
        return term.start, term.start + TERM_SPAN
    if term.end:
        return term.end - TERM_SPAN, term.end
    return today - FALLBACK_BEFORE, today + FALLBACK_AFTER


def padded_window(term: Term, today: date) -> tuple[date, date]:
    """`term_window` widened to [start − 7 d, end + 21 d] (exam weeks, early quizzes)."""
    start, end = term_window(term, today)
    return start - PAD_BEFORE, end + PAD_AFTER


def parse_iso(value: str) -> date | None:
    """`YYYY-MM-DD` → date, anything else → None."""
    value = (value or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


# --- text parsing -----------------------------------------------------------

_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4,
    "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}  # fmt: skip
_WEEKDAYS = {
    "mon": 0, "monday": 0, "tue": 1, "tues": 1, "tuesday": 1, "wed": 2, "weds": 2,
    "wednesday": 2, "thu": 3, "thur": 3, "thurs": 3, "thursday": 3, "fri": 4, "friday": 4,
    "sat": 5, "saturday": 5, "sun": 6, "sunday": 6,
}  # fmt: skip
_MONTH_ALT = "|".join(sorted(_MONTHS, key=len, reverse=True))
_WEEKDAY_RE = re.compile(r"\b(" + "|".join(sorted(_WEEKDAYS, key=len, reverse=True)) + r")\b\.?", re.I)
_ISO_RE = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_MONTH_DAY_RE = re.compile(
    r"\b(" + _MONTH_ALT + r")\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?", re.I
)
_DAY_MONTH_RE = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(" + _MONTH_ALT + r")\b\.?(?:,?\s+(\d{4})\b)?", re.I
)
_NUMERIC_RE = re.compile(r"(?<![\d/])(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?(?![\d/])")
_WEEK_RE = re.compile(r"\bweek\s*#?\s*(\d{1,2})\b", re.I)


@dataclass(frozen=True)
class _TextDate:
    month: int
    day: int
    year: int | None


def _first_text_date(text: str) -> _TextDate | None:
    """Earliest explicit date in `text` (ISO, "Oct 15[, 2026]", "15 Oct", "10/15[/26]")."""
    found: list[tuple[int, _TextDate]] = []
    if m := _ISO_RE.search(text):
        found.append((m.start(), _TextDate(int(m.group(2)), int(m.group(3)), int(m.group(1)))))
    if m := _MONTH_DAY_RE.search(text):
        year = int(m.group(3)) if m.group(3) else None
        found.append((m.start(), _TextDate(_MONTHS[m.group(1).lower()], int(m.group(2)), year)))
    if m := _DAY_MONTH_RE.search(text):
        year = int(m.group(3)) if m.group(3) else None
        found.append((m.start(), _TextDate(_MONTHS[m.group(2).lower()], int(m.group(1)), year)))
    if m := _NUMERIC_RE.search(text):
        year: int | None = None
        if m.group(3):
            year = int(m.group(3))
            year = year + 2000 if year < 100 else year
        found.append((m.start(), _TextDate(int(m.group(1)), int(m.group(2)), year)))
    if not found:
        return None
    found.sort(key=lambda item: item[0])
    return found[0][1]


def weekdays_in(text: str) -> set[int]:
    """Weekday numbers (Mon=0) named in `text`."""
    return {_WEEKDAYS[m.group(1).lower()] for m in _WEEKDAY_RE.finditer(text or "")}


def week_number(text: str) -> int | None:
    """N from "Week N" in `text`."""
    m = _WEEK_RE.search(text or "")
    return int(m.group(1)) if m else None


def monday_of(d: date) -> date:
    """Monday of the ISO week containing `d`."""
    return d - timedelta(days=d.weekday())


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _in(d: date, window: tuple[date, date]) -> bool:
    return window[0] <= d <= window[1]


def resolve_date(model_iso: str, date_text: str, week: int, term: Term, today: date) -> ResolvedDate:
    """Resolve one item's date (V2-08 §2.7), in priority order:

    1. a full date written in the text (ISO, or month/day with a year) → `exact`;
    2. month/day without a year → the year that lands in the padded term window, preferring
       the year whose weekday matches a weekday named in the text → `inferred_year`;
    3. "Week N <weekday>" (or `week` + weekday) with a known term start → `from_week`;
    4. the model's ISO guess, if it is inside the padded window and agrees with any named
       weekday → `exact` when the text carries a year, else `inferred_year`;
    5. otherwise `unresolved` (the raw text is kept; `week` is kept when known).
    """
    text = date_text or ""
    window = padded_window(term, today)
    wdays = weekdays_in(text)
    wanted = next(iter(wdays)) if len(wdays) == 1 else None
    wk = week_number(text) or (week if week and week > 0 else None)

    def mismatch(d: date) -> bool:
        return wanted is not None and d.weekday() != wanted

    parsed = _first_text_date(text)
    if parsed and parsed.year is not None:
        d = _safe_date(parsed.year, parsed.month, parsed.day)
        if d is not None:
            return ResolvedDate(d, "exact", wk, mismatch(d))
    if parsed and parsed.year is None:
        base_start, base_end = term_window(term, today)
        years = sorted({base_start.year - 1, base_start.year, base_end.year, base_end.year + 1})
        candidates = [d for y in years if (d := _safe_date(y, parsed.month, parsed.day))]
        center = base_start + (base_end - base_start) / 2

        def score(d: date) -> tuple[int, int, int]:
            return (int(_in(d, window)), int(wanted is not None and not mismatch(d)), -abs((d - center).days))

        if candidates:
            best = max(candidates, key=score)
            if _in(best, window) or (wanted is not None and not mismatch(best)):
                return ResolvedDate(best, "inferred_year", wk, mismatch(best))

    if wk is not None and wanted is not None and term.start is not None:
        d = monday_of(term.start) + timedelta(weeks=wk - 1, days=wanted)
        return ResolvedDate(d, "from_week", wk, False)

    model = parse_iso(model_iso)
    if model is not None and _in(model, window) and not mismatch(model):
        has_year = re.search(r"\b(19|20)\d{2}\b", text) is not None
        return ResolvedDate(model, "exact" if has_year else "inferred_year", wk, False)

    return ResolvedDate(None, "unresolved", wk, False)


# --- times and zones ----------------------------------------------------------

_HHMM_RE = re.compile(r"^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*(m\.?)?\s*$", re.I)


def parse_hhmm(s: str) -> time | None:
    """"13:05", "9:30", "1:30pm", "9 am", "12pm" → time; "" or garbage → None."""
    if not s:
        return None
    m = _HHMM_RE.match(s)
    if not m:
        if s.strip().lower() == "noon":
            return time(12, 0)
        return None
    hour = int(m.group(1))
    minute = int(m.group(2) or 0)
    meridiem = (m.group(3) or "").lower()
    if not meridiem and m.group(2) is None:
        return None  # a bare number isn't a time
    if meridiem:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if meridiem == "p" else 0)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return time(hour, minute)


_MER = r"(?:([ap])\.?\s*m\.?)"
_CLOCK = r"(\d{1,2})(?::([0-5]\d))?\s*" + _MER + r"?"
_RANGE_RE = re.compile(r"(?<![\d/:])" + _CLOCK + r"\s*(?:-|–|—|to)\s*" + _CLOCK + r"(?![\d/])", re.I)
_SINGLE_RE = re.compile(r"(?<![\d/:])(\d{1,2})(?::([0-5]\d))?\s*" + _MER + r"(?![a-z])|(?<![\d/:])([01]?\d|2[0-3]):([0-5]\d)(?![\d/])", re.I)


def _clock(hour: int, minute: int, meridiem: str | None) -> time | None:
    if meridiem:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if meridiem.lower() == "p" else 0)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return time(hour, minute)


def extract_times(text: str) -> tuple[time | None, time | None]:
    """Start/end wall-clock times from free text.

    "13:00-14:15" → (13:00, 14:15); "1:00-2:15pm" → (13:00, 14:15) (a trailing am/pm applies to
    both ends unless that would put the start after the end); "Fri 9/18, 5pm" → (17:00, None);
    "noon" → 12:00; "midnight" → 23:59 (same-day deadline). Date-like "10-15" or "9/18" never
    count as times: a time needs a colon or am/pm.
    """
    t = text or ""
    m = _RANGE_RE.search(t)
    if m and (m.group(2) or m.group(3) or m.group(5) or m.group(6)):
        h1, m1, mer1, h2, m2, mer2 = m.groups()
        if mer2 and not mer1:
            end = _clock(int(h2), int(m2 or 0), mer2)
            start = _clock(int(h1), int(m1 or 0), mer2)
            if start is not None and end is not None and start > end:
                start = _clock(int(h1), int(m1 or 0), "a" if mer2.lower() == "p" else "p")
        else:
            start = _clock(int(h1), int(m1 or 0), mer1)
            end = _clock(int(h2), int(m2 or 0), mer2)
        if start is not None:
            return start, end if end is not None and end > start else None
    m = _SINGLE_RE.search(t)
    if m:
        if m.group(3):
            return _clock(int(m.group(1)), int(m.group(2) or 0), m.group(3)), None
        return _clock(int(m.group(4)), int(m.group(5)), None), None
    low = t.lower()
    if re.search(r"\bnoon\b", low):
        return time(12, 0), None
    if re.search(r"\bmidnight\b", low):
        return time(23, 59), None
    return None, None


def format_hhmm(t: time | None) -> str | None:
    """time → "HH:MM" (None stays None)."""
    return None if t is None else f"{t.hour:02d}:{t.minute:02d}"


def _utc_iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def localize(d: date, start: time | None, end: time | None, tz: str) -> LocalizedTimes:
    """Wall-clock times at the school → local strings + UTC (DST-safe via zoneinfo).

    No start time → all-day: UTC bounds are local midnight to the next local midnight.
    A nonexistent local time (spring-forward gap) resolves forward, e.g. 02:30 → 03:30 EDT.
    An end at or before the start is dropped.
    """
    zone = ZoneInfo(tz)
    if start is None:
        midnight = datetime.combine(d, time(0, 0), zone)
        next_midnight = datetime.combine(d + timedelta(days=1), time(0, 0), zone)
        return LocalizedTimes(True, None, None, _utc_iso(midnight), _utc_iso(next_midnight))
    start_dt = datetime.combine(d, start, zone)
    end_dt = datetime.combine(d, end, zone) if end is not None and end > start else None
    return LocalizedTimes(
        False,
        f"{d.isoformat()}T{format_hhmm(start)}",
        f"{d.isoformat()}T{format_hhmm(end)}" if end_dt is not None else None,
        _utc_iso(start_dt),
        _utc_iso(end_dt) if end_dt is not None else None,
    )


_TZ_ABBREV = {
    "ET": "America/New_York", "EST": "America/New_York", "EDT": "America/New_York",
    "EASTERN": "America/New_York", "CT": "America/Chicago", "CST": "America/Chicago",
    "CDT": "America/Chicago", "CENTRAL": "America/Chicago", "MT": "America/Denver",
    "MST": "America/Denver", "MDT": "America/Denver", "MOUNTAIN": "America/Denver",
    "PT": "America/Los_Angeles", "PST": "America/Los_Angeles", "PDT": "America/Los_Angeles",
    "PACIFIC": "America/Los_Angeles",
}  # fmt: skip


def tz_from_hint(hint: str, default: str) -> str:
    """Map an explicit syllabus zone ("ET", "all times Pacific", "America/Chicago") to IANA;
    anything unrecognized keeps `default` (the user's zone)."""
    raw = (hint or "").strip()
    if not raw:
        return default
    if "/" in raw:
        try:
            ZoneInfo(raw)
            return raw
        except (ZoneInfoNotFoundError, ValueError):
            return default
    for token in re.findall(r"[A-Za-z]+", raw):
        mapped = _TZ_ABBREV.get(token.upper())
        if mapped:
            return mapped
    return default


def is_stale(dates: Sequence[date], today: date, days: int = 30) -> bool:
    """True when a strict majority of `dates` are more than `days` before `today`."""
    if not dates:
        return False
    old = sum(1 for d in dates if d < today - timedelta(days=days))
    return old * 2 > len(dates)
