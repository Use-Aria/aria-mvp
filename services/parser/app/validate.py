"""Deterministic validation and escalation rules (V2-08 §2.5). Pure."""

from __future__ import annotations

from collections.abc import Sequence

from app.dates import PAD_AFTER, PAD_BEFORE, is_stale
from app.models import AttemptOutcome, ParsedSyllabus, ParseIssue, ParseSyllabusRequest, SyllabusExtraction
from app.normalize import NormalizeMeta, course_key
from app.preflight import Preflight

SYLLABUS_KINDS = frozenset({"syllabus", "course_schedule"})
WEIGHT_MIN = 95.0
WEIGHT_MAX = 105.0
MIN_PERCENT_EVIDENCE = 2


def _fmt(n: float) -> str:
    return f"{n:g}"


def failure_issue(outcome: AttemptOutcome, stop_reason: str | None = None) -> ParseIssue:
    """The error issue for an attempt that produced no usable extraction."""
    if outcome == "refused":
        return ParseIssue(code="refused", severity="error", message="the model declined this document")
    if outcome == "truncated" or stop_reason == "max_tokens":
        return ParseIssue(code="truncated", severity="error", message="the extraction hit the output limit")
    if outcome == "invalid":
        return ParseIssue(code="schema", severity="error", message="the extraction did not match the schema")
    return ParseIssue(code="upstream_error", severity="error", message=f"the model call failed ({outcome})")


def _hint_matches(hint: str, parsed: ParsedSyllabus, req: ParseSyllabusRequest) -> bool:
    hk = course_key(hint)
    if hk is None:
        return True
    keys = {parsed.course.key, course_key(parsed.course.title)} | {course_key(c) for c in parsed.course.cross_listed}
    if hk in keys:
        return True
    low = hint.strip().lower()
    title = parsed.course.title.lower()
    if len(low) >= 3 and (low in title or (title and title in low)):
        return True
    # The hint names one of the student's known courses whose key is the parsed one.
    return any(c.key == parsed.course.key and low in c.label.lower() for c in req.known_courses)


def validate(
    x: SyllabusExtraction,
    norm: ParsedSyllabus,
    req: ParseSyllabusRequest,
    pre: Preflight,
    stop_reason: str | None,
    meta: NormalizeMeta | None = None,
) -> list[ParseIssue]:
    """Issues for one successful extraction. Error severity means "escalate" (see `should_escalate`)."""
    issues: list[ParseIssue] = []
    if x.document_kind not in SYLLABUS_KINDS:
        return issues  # caller returns not_syllabus; never escalates
    if stop_reason == "max_tokens":
        issues.append(failure_issue("truncated"))

    weights = [g.weight_pct for g in norm.grading if g.weight_pct is not None]
    if weights:
        total = sum(weights)
        if not WEIGHT_MIN <= total <= WEIGHT_MAX:
            issues.append(
                ParseIssue(
                    code="weights_sum",
                    severity="error",
                    message=f"grading weights sum to {_fmt(round(total, 2))}",
                    path="grading",
                )
            )
    elif pre.percent_tokens >= MIN_PERCENT_EVIDENCE or not pre.has_text_layer:
        issues.append(
            ParseIssue(
                code="weights_missing",
                severity="error",
                message="no grading weights extracted, but the document seems to state some",
                path="grading",
            )
        )
    else:
        issues.append(
            ParseIssue(code="no_weights_stated", severity="warn", message="the syllabus doesn't state grading weights", path="grading")
        )

    term = meta.term if meta else None
    if term and term.start and term.end:
        lo, hi = term.start - PAD_BEFORE, term.end + PAD_AFTER
        for i, exam in enumerate(norm.exams):
            if exam.date is not None and not lo <= exam.date <= hi:
                issues.append(
                    ParseIssue(
                        code="exam_out_of_term",
                        severity="error",
                        message=f"{exam.date.isoformat()} is outside {term.start.isoformat()}..{term.end.isoformat()}",
                        path=f"exams[{i}]",
                    )
                )

    if meta:
        for path in meta.weekday_mismatch_paths:
            issues.append(
                ParseIssue(code="weekday_mismatch", severity="warn", message="the written weekday doesn't match the date", path=path)
            )
        if is_stale(meta.resolved_dates, req.today):
            issues.append(
                ParseIssue(code="stale_term", severity="warn", message="most dates are in the past; this may be an old syllabus")
            )

    if req.course_hint and not _hint_matches(req.course_hint, norm, req):
        issues.append(
            ParseIssue(
                code="course_mismatch",
                severity="warn",
                message=f"the document is for {norm.course.key}, not the hinted course",
                path="course",
            )
        )

    if pre.truncated:
        issues.append(
            ParseIssue(
                code="truncated_pages",
                severity="warn",
                message=f"only the first {pre.sent_pages} of {pre.page_count} pages were read",
            )
        )
    if not norm.exams and not norm.assignments and not norm.grading:
        issues.append(ParseIssue(code="sparse", severity="warn", message="no exams, assignments or grading found"))
    return issues


def error_count(issues: Sequence[ParseIssue]) -> int:
    """Number of error-severity issues."""
    return sum(1 for i in issues if i.severity == "error")


def should_escalate(issues: Sequence[ParseIssue]) -> bool:
    """True when any issue is an error."""
    return error_count(issues) > 0
