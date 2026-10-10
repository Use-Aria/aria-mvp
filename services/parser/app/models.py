"""Pydantic v2 models for parser contract v1 (V2-08 §8.1).

Three groups:
- `ParseSyllabusRequest`: the HTTP request body (strict: unknown keys are rejected).
- `SyllabusExtraction`: the LLM-facing schema used with structured outputs. Every field is
  required ("unknown" = "", [], 0 or -1) and there are no unions.

  Grammar budget (measured live 2026-10-10 against claude-sonnet-5-5 / claude-opus-5-5): the API
  rejects large schemas with 400 "The compiled grammar is too large". The V2-08 §8.1 draft
  (nullable weights + string arrays + separate start/end times) was over the limit. Nullable
  unions and arrays of strings are the expensive constructs; enums are cheap. So weights are
  plain numbers (-1 = not stated), free-text lists are "; "-separated strings, and times are
  one `time_text` (or read from `due_text`). This version compiled with room for ~6 more string
  fields; `tests/test_models.py` pins the budget so additions are deliberate.
- `ParsedSyllabus` / `ParseSyllabusResponse`: the normalized response the TS zod schema
  (`src/server/integrations/syllabus/contract.ts`) validates.
"""

from __future__ import annotations

import datetime as dt
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class TermHint(_Strict):
    """Term window hint from TS (V2-05: min/max Canvas dates for the course)."""

    name: str | None = Field(default=None, max_length=80)
    start: dt.date | None = None
    end: dt.date | None = None


class KnownCourse(_Strict):
    """A course the user already has (Canvas), to help the model label the syllabus."""

    key: str = Field(max_length=64)
    label: str = Field(max_length=160)


class ParseSyllabusRequest(_Strict):
    """Body of `POST /v1/parse-syllabus`."""

    pdf_base64: str = Field(min_length=8)
    filename: str | None = Field(default=None, max_length=255)
    course_hint: str | None = Field(default=None, max_length=80)
    timezone: str = Field(min_length=1, max_length=64)
    today: dt.date
    term: TermHint | None = None
    known_courses: list[KnownCourse] = Field(default_factory=list, max_length=12)
    allow_escalation: bool = True

    @field_validator("timezone")
    @classmethod
    def _iana(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("timezone must be an IANA zone name") from exc
        return value


# ---------------------------------------------------------------------------
# LLM-facing extraction (structured outputs)
# ---------------------------------------------------------------------------

DocumentKind = Literal["syllabus", "course_schedule", "assignment", "exam", "reading", "other"]
Weekday = Literal["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
InstructorRole = Literal["instructor", "ta", "other"]
ExamKind = Literal["midterm", "final", "quiz", "exam", "presentation", "project", "other"]


class _X(BaseModel):
    model_config = ConfigDict(extra="forbid")


LIST_HINT = 'Items separated by "; ", or "".'
WEIGHT_HINT = "Percent of the final grade (25 means 25%), or -1 if not stated."


class XInstructor(_X):
    name: str
    role: InstructorRole
    email: str = Field(description='Email exactly as printed, or "".')
    office_hours: str = Field(description='Office hours as printed, or "".')


class XMeeting(_X):
    kind: str = Field(description="lecture, section, lab, discussion, seminar, ...")
    days: list[Weekday]
    time_text: str = Field(description='24-hour "HH:MM-HH:MM" (or "HH:MM"), or "".')
    location: str


class XGrading(_X):
    name: str
    weight_pct: float = Field(description=WEIGHT_HINT)
    notes: str = Field(description='e.g. "lowest dropped", or "".')


class XExam(_X):
    title: str
    kind: ExamKind
    date_text: str = Field(description="The date exactly as written in the document (raw text).")
    date: str = Field(description='Best guess "YYYY-MM-DD", or "" when the year or day is unknown.')
    time_text: str = Field(description='24-hour "HH:MM-HH:MM" (or "HH:MM"), or "".')
    location: str
    weight_pct: float = Field(description=WEIGHT_HINT)
    topics: str = Field(description=LIST_HINT)
    cumulative: bool


class XAssignment(_X):
    title: str
    category: str = Field(description='Grading category this belongs to, or "".')
    due_text: str = Field(description='Due date and time exactly as written (raw text), e.g. "Fri 9/18, 5pm".')
    due_date: str = Field(description='Best guess "YYYY-MM-DD", or "".')
    weight_pct: float = Field(description=WEIGHT_HINT)


class XScheduleRow(_X):
    week: int = Field(description="Week number in the term, or 0 if unknown.")
    date: str = Field(description='"YYYY-MM-DD" of the class/week, or "".')
    topics: str = Field(description=LIST_HINT)
    readings: str = Field(description=LIST_HINT)
    due: str = Field(description=LIST_HINT)


class XPolicies(_X):
    late_work: str
    attendance: str
    collaboration: str
    exam_makeup: str


class SyllabusExtraction(_X):
    """What the model returns. Validated by the SDK (`messages.parse`) and then by `validate.py`."""

    document_kind: DocumentKind
    course_code: str = Field(description='e.g. "CPSC 223", or "".')
    course_title: str
    cross_listed_codes: str = Field(description=LIST_HINT)
    term: str = Field(description='e.g. "Fall 2026", or "".')
    term_start: str = Field(description='First day of classes "YYYY-MM-DD", or "".')
    term_end: str = Field(description='Last day of the term or exam period "YYYY-MM-DD", or "".')
    timezone_hint: str = Field(description='Explicit zone stated in the document (e.g. "ET"), or "".')
    instructors: list[XInstructor]
    meetings: list[XMeeting]
    grading: list[XGrading]
    grading_notes: str
    exams: list[XExam]
    assignments: list[XAssignment]
    schedule: list[XScheduleRow]
    policies: XPolicies
    extraction_notes: str = Field(description=LIST_HINT)


# ---------------------------------------------------------------------------
# Normalized output (response)
# ---------------------------------------------------------------------------

DateConfidence = Literal["exact", "inferred_year", "from_week", "unresolved"]


class ParsedCourse(BaseModel):
    code: str
    title: str
    key: str
    cross_listed: list[str]
    term: str
    term_start: dt.date | None
    term_end: dt.date | None


class ParsedInstructor(BaseModel):
    name: str
    role: InstructorRole
    email: str
    office_hours: str


class ParsedMeeting(BaseModel):
    kind: str
    days: list[Weekday]
    start_local: str | None
    end_local: str | None
    location: str


class ParsedGrading(BaseModel):
    name: str
    weight_pct: float | None
    notes: str


class ParsedExam(BaseModel):
    title: str
    kind: str
    date_text: str
    date: dt.date | None
    date_confidence: DateConfidence
    all_day: bool
    start_local: str | None
    end_local: str | None
    starts_at_utc: str | None
    ends_at_utc: str | None
    location: str
    weight_pct: float | None
    topics: list[str]
    cumulative: bool


class ParsedAssignment(BaseModel):
    title: str
    category: str
    due_text: str
    due_date: dt.date | None
    date_confidence: DateConfidence
    all_day: bool
    due_local: str | None
    due_at_utc: str | None
    weight_pct: float | None


class ParsedScheduleRow(BaseModel):
    week: int | None
    date: dt.date | None
    topics: list[str]
    readings: list[str]
    due: list[str]


class ParsedPolicies(BaseModel):
    late_work: str
    attendance: str
    collaboration: str
    exam_makeup: str


class ParsedSyllabus(BaseModel):
    course: ParsedCourse
    timezone: str
    instructors: list[ParsedInstructor]
    meetings: list[ParsedMeeting]
    grading: list[ParsedGrading]
    grading_total_pct: float | None
    exams: list[ParsedExam]
    assignments: list[ParsedAssignment]
    schedule: list[ParsedScheduleRow]
    policies: ParsedPolicies
    notes: list[str]


Severity = Literal["error", "warn"]


class ParseIssue(BaseModel):
    code: str
    severity: Severity
    message: str
    path: str = ""


AttemptOutcome = Literal["ok", "invalid", "refused", "truncated", "api_error", "timeout"]


class LlmAttempt(BaseModel):
    """Usage for one model call; TS turns each into an `llm_calls` row (route `syllabus`)."""

    model: str
    input_tokens: int
    output_tokens: int
    cache_read: int
    cache_write: int
    latency_ms: int
    stop_reason: str | None
    outcome: AttemptOutcome


ParseStatus = Literal["ok", "needs_review", "not_syllabus", "unreadable"]


class ParseSyllabusResponse(BaseModel):
    contract: Literal["v1"] = "v1"
    status: ParseStatus
    document_kind: DocumentKind
    syllabus: ParsedSyllabus | None
    issues: list[ParseIssue]
    attempts: list[LlmAttempt]
    chosen_attempt: int | None
    page_count: int
    sent_pages: int
    truncated_pages: bool
    scanned: bool
    pdf_sha256: str
    parser_version: str
    prompt_version: str


class ErrorDetail(BaseModel):
    code: str
    message: str
    retryable: bool


class ErrorBody(BaseModel):
    error: ErrorDetail
