"""Pure normalization: LLM extraction → contract v1 `ParsedSyllabus`.

`course_key` mirrors TS `courseKey(input)` in `src/shared/course-key.ts` exactly; both must pass
`tests/fixtures/contract/course_key_vectors.json` (repo root). Python returns None where TS
returns null.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date

from app.dates import (
    ResolvedDate,
    Term,
    extract_times,
    format_hhmm,
    localize,
    parse_iso,
    resolve_date,
    tz_from_hint,
)
from app.models import (
    ParsedAssignment,
    ParsedCourse,
    ParsedExam,
    ParsedGrading,
    ParsedInstructor,
    ParsedMeeting,
    ParsedPolicies,
    ParsedScheduleRow,
    ParsedSyllabus,
    ParseSyllabusRequest,
    SyllabusExtraction,
)

# --- course_key (keep in lockstep with src/shared/course-key.ts) ---------------------------

_SUBJECT_STOPWORDS = frozenset(
    {
        "FALL", "SPRING", "SUMMER", "WINTER", "TERM", "YEAR", "WEEK", "DAY", "UNIT", "PART",
        "EXAM", "QUIZ", "TEST", "PSET", "SET", "HW", "LAB", "SEC", "SECT", "LEC", "CLASS",
        "ROOM", "RM", "CH", "CHAP", "PAGE", "PP", "FA", "SP", "SU", "WI", "AT", "BY", "OF",
        "IN", "ON", "TO", "AND", "THE", "FOR",
    }
)  # fmt: skip

# JS `\s` (ECMAScript WhiteSpace + LineTerminator). Python's `\s` differs slightly (e.g. U+FEFF),
# so the TS whitespace class is spelled out to keep both sides identical.
_JS_WS = "\t\n\v\f\r    -     　﻿"
_JS_WS_RUN = re.compile(f"[{_JS_WS}]+")
# re.ASCII: JS `\d` is ASCII-only; Python's would match other scripts' digits.
_CODE_AT_START = re.compile(
    rf"^[\[({_JS_WS}]*([A-Z&]{{2,5}})[{_JS_WS}]*[-_.]?[{_JS_WS}]*(\d{{2,4}}[A-Z]?)(?![A-Z0-9])", re.ASCII
)
_CODE_ANYWHERE = re.compile(
    rf"[{_JS_WS}\[(]([A-Z&]{{2,5}})[{_JS_WS}]*[-_.]?[{_JS_WS}]*(\d{{2,4}}[A-Z]?)(?![A-Z0-9])", re.ASCII
)
_NORMALIZED_TITLE = re.compile(r"^t:[a-z0-9]+(?:-[a-z0-9]+)*$")
_ASIDES = re.compile(r"\([^)]*\)|\[[^\]]*\]")
_COMBINING = re.compile("[̀-ͯ]")
_NON_SLUG = re.compile(r"[^a-z0-9]+")
_MAX_SLUG = 60


def _valid_subject(subject: str) -> bool:
    return re.search(r"[A-Z]", subject) is not None and subject not in _SUBJECT_STOPWORDS


def _find_code(upper: str) -> str | None:
    m = _CODE_AT_START.match(upper)
    if m and _valid_subject(m.group(1)):
        return m.group(1) + m.group(2)
    for m in _CODE_ANYWHERE.finditer(upper):
        if _valid_subject(m.group(1)):
            return m.group(1) + m.group(2)
    return None


def _slugify(text: str) -> str:
    folded = _COMBINING.sub("", unicodedata.normalize("NFKD", text)).lower().replace("&", " and ")
    slug = _NON_SLUG.sub("-", folded).strip("-")
    if len(slug) > _MAX_SLUG:
        slug = slug[:_MAX_SLUG].rstrip("-")
    return slug


def course_key(value: str | None) -> str | None:
    """Normalize free course text to a stable key (mirror of TS `courseKey`).

    "CPSC 223 01 (FA26)" → "CPSC223"; "Data Structures" → "t:data-structures";
    "" / whitespace / None → None (empty never matches anything).
    """
    if not isinstance(value, str):
        return None
    text = _JS_WS_RUN.sub(" ", unicodedata.normalize("NFKC", value)).strip(_JS_WS_STRIP)
    if text == "":
        return None
    if _NORMALIZED_TITLE.match(text):
        return text
    code = _find_code(text.upper())
    if code:
        return code
    without_asides = _ASIDES.sub(" ", text)
    slug = _slugify(without_asides) or _slugify(text)
    return f"t:{slug}" if slug else None


# str.strip() needs the literal characters (no ranges).
_JS_WS_STRIP = "\t\n\v\f\r   " + "".join(chr(c) for c in range(0x2000, 0x200B)) + (
    "    　﻿"
)

# --- normalization -----------------------------------------------------------------------

MAX_STR = 300
MAX_EXAMS = 30
MAX_ASSIGNMENTS = 200
MAX_SCHEDULE = 40
MAX_TOPICS = 25
MAX_INSTRUCTORS = 20
MAX_MEETINGS = 20
MAX_GRADING = 30
MAX_NOTES = 10
MAX_CROSS_LISTED = 8


def _s(value: str, limit: int = MAX_STR) -> str:
    text = " ".join((value or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _list(values: Iterable[str], cap: int) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        t = _s(v)
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
        if len(out) >= cap:
            break
    return out


def _split(text: str, cap: int) -> list[str]:
    """"a; b\nc" → ["a", "b", "c"] (deduped, trimmed, capped). Commas are kept inside items."""
    return _list(re.split(r"[;\n]+", text or ""), cap)


def _weight(value: float | None) -> float | None:
    if value is None or value != value or value < 0 or value > 100:  # NaN / out of range
        return None
    return round(float(value), 2)


@dataclass
class NormalizeMeta:
    """Side information `validate` needs (kept out of the response)."""

    term: Term
    weekday_mismatch_paths: list[str] = field(default_factory=list)
    resolved_dates: list[date] = field(default_factory=list)


def _title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def normalize_detailed(x: SyllabusExtraction, req: ParseSyllabusRequest) -> tuple[ParsedSyllabus, NormalizeMeta]:
    """Normalize an extraction and return the side information used by validation."""
    x_start, x_end = parse_iso(x.term_start), parse_iso(x.term_end)
    hint_start = req.term.start if req.term else None
    hint_end = req.term.end if req.term else None
    term = Term(start=hint_start or x_start, end=hint_end or x_end)
    meta = NormalizeMeta(term=term)
    tz = tz_from_hint(x.timezone_hint, req.timezone)

    code = _s(x.course_code, 80)
    title = _s(x.course_title, 160)
    key = course_key(code) or course_key(title) or course_key(req.course_hint) or "t:untitled"
    course = ParsedCourse(
        code=code,
        title=title,
        key=key,
        cross_listed=_split(x.cross_listed_codes, MAX_CROSS_LISTED),
        term=_s(x.term, 80),
        term_start=x_start,
        term_end=x_end,
    )

    def resolve(path: str, model_iso: str, text: str, week: int = 0) -> ResolvedDate:
        r = resolve_date(model_iso, text, week, term, req.today)
        if r.weekday_mismatch:
            meta.weekday_mismatch_paths.append(path)
        if r.date is not None:
            meta.resolved_dates.append(r.date)
        return r

    exams: list[ParsedExam] = []
    seen_exams: set[tuple[str, date | None]] = set()
    for i, e in enumerate(x.exams):
        title_e = _s(e.title, 160)
        r = resolve(f"exams[{i}]", e.date, e.date_text)
        dedupe = (_title_key(title_e), r.date)
        if not title_e or dedupe in seen_exams:
            continue
        seen_exams.add(dedupe)
        start, end = extract_times(e.time_text)
        if start is None:
            start, end = extract_times(e.date_text)
        loc = localize(r.date, start, end, tz) if r.date else None
        exams.append(
            ParsedExam(
                title=title_e,
                kind=e.kind,
                date_text=_s(e.date_text, 120),
                date=r.date,
                date_confidence=r.confidence,
                all_day=loc.all_day if loc else False,
                start_local=loc.start_local if loc else None,
                end_local=loc.end_local if loc else None,
                starts_at_utc=loc.starts_at_utc if loc else None,
                ends_at_utc=loc.ends_at_utc if loc else None,
                location=_s(e.location, 160),
                weight_pct=_weight(e.weight_pct),
                topics=_split(e.topics, MAX_TOPICS),
                cumulative=e.cumulative,
            )
        )
        if len(exams) >= MAX_EXAMS:
            break

    assignments: list[ParsedAssignment] = []
    for i, a in enumerate(x.assignments[: MAX_ASSIGNMENTS * 2]):
        title_a = _s(a.title, 160)
        if not title_a:
            continue
        r = resolve(f"assignments[{i}]", a.due_date, a.due_text)
        loc = localize(r.date, extract_times(a.due_text)[0], None, tz) if r.date else None
        assignments.append(
            ParsedAssignment(
                title=title_a,
                category=_s(a.category, 120),
                due_text=_s(a.due_text, 120),
                due_date=r.date,
                date_confidence=r.confidence,
                all_day=loc.all_day if loc else False,
                due_local=loc.start_local if loc else None,
                due_at_utc=loc.starts_at_utc if loc else None,
                weight_pct=_weight(a.weight_pct),
            )
        )
        if len(assignments) >= MAX_ASSIGNMENTS:
            break

    schedule: list[ParsedScheduleRow] = []
    for row in x.schedule[:MAX_SCHEDULE]:
        r = resolve_date(row.date, "", 0, term, req.today)
        schedule.append(
            ParsedScheduleRow(
                week=row.week if row.week > 0 else None,
                date=r.date,
                topics=_split(row.topics, MAX_TOPICS),
                readings=_split(row.readings, MAX_TOPICS),
                due=_split(row.due, MAX_TOPICS),
            )
        )

    grading = [
        ParsedGrading(name=_s(g.name, 120), weight_pct=_weight(g.weight_pct), notes=_s(g.notes, 200))
        for g in x.grading[:MAX_GRADING]
        if _s(g.name)
    ]
    weights = [g.weight_pct for g in grading if g.weight_pct is not None]
    grading_total = round(sum(weights), 2) if weights else None

    parsed = ParsedSyllabus(
        course=course,
        timezone=tz,
        instructors=[
            ParsedInstructor(
                name=_s(p.name, 120), role=p.role, email=_s(p.email, 120), office_hours=_s(p.office_hours, 200)
            )
            for p in x.instructors[:MAX_INSTRUCTORS]
            if _s(p.name)
        ],
        meetings=[
            ParsedMeeting(
                kind=_s(m.kind, 40) or "lecture",
                days=list(dict.fromkeys(m.days)),
                start_local=format_hhmm(extract_times(m.time_text)[0]),
                end_local=format_hhmm(extract_times(m.time_text)[1]),
                location=_s(m.location, 160),
            )
            for m in x.meetings[:MAX_MEETINGS]
        ],
        grading=grading,
        grading_total_pct=grading_total,
        exams=exams,
        assignments=assignments,
        schedule=schedule,
        policies=ParsedPolicies(
            late_work=_s(x.policies.late_work),
            attendance=_s(x.policies.attendance),
            collaboration=_s(x.policies.collaboration),
            exam_makeup=_s(x.policies.exam_makeup),
        ),
        notes=_split(x.extraction_notes, MAX_NOTES),
    )
    return parsed, meta


def normalize(x: SyllabusExtraction, req: ParseSyllabusRequest) -> ParsedSyllabus:
    """Extraction → normalized output (course key, resolved dates, UTC, trims, caps)."""
    return normalize_detailed(x, req)[0]
