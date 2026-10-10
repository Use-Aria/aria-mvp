"""Preflight → attempt 1 (Sonnet) → validate → maybe attempt 2 (Opus) → choose → response,
all under one deadline (V2-08 §2.5). Python never touches the DB; usage goes back to TS."""

from __future__ import annotations

import base64
import hashlib
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from anthropic import AsyncAnthropic

from app import PARSER_VERSION
from app.config import Settings
from app.fake import fake_extract
from app.llm import extract
from app.logging import log_event
from app.models import (
    LlmAttempt,
    ParsedSyllabus,
    ParseIssue,
    ParseSyllabusRequest,
    ParseSyllabusResponse,
    SyllabusExtraction,
)
from app.normalize import normalize_detailed
from app.preflight import Preflight, run_preflight
from app.prompt import PROMPT_VERSION, SYSTEM_PROMPT, build_user_text
from app.validate import SYLLABUS_KINDS, error_count, failure_issue, should_escalate, validate

MIN_ESCALATION_BUDGET_S = 20.0
_TRANSIENT = frozenset({"api_error", "timeout"})


class PipelineError(Exception):
    """A non-200 outcome: 502 `upstream_llm` or 503 `overloaded` (both retryable)."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message
        self.retryable = True


@dataclass
class Deps:
    """Injectable dependencies. `client` may be None only when `settings.fake_llm`."""

    client: AsyncAnthropic | None
    settings: Settings
    clock: Callable[[], float] = time.monotonic


@dataclass
class _Evaluated:
    extraction: SyllabusExtraction | None
    attempt: LlmAttempt
    syllabus: ParsedSyllabus | None = None
    issues: list[ParseIssue] = field(default_factory=list)

    @property
    def not_syllabus(self) -> bool:
        return self.extraction is not None and self.extraction.document_kind not in SYLLABUS_KINDS


def _evaluate(
    extraction: SyllabusExtraction | None, attempt: LlmAttempt, req: ParseSyllabusRequest, pre: Preflight
) -> _Evaluated:
    if extraction is None:
        return _Evaluated(None, attempt, None, [failure_issue(attempt.outcome, attempt.stop_reason)])
    if extraction.document_kind not in SYLLABUS_KINDS:
        return _Evaluated(extraction, attempt)
    syllabus, meta = normalize_detailed(extraction, req)
    issues = validate(extraction, syllabus, req, pre, attempt.stop_reason, meta)
    return _Evaluated(extraction, attempt, syllabus, issues)


def _response(
    *,
    status: str,
    chosen: _Evaluated | None,
    chosen_index: int | None,
    attempts: list[LlmAttempt],
    issues: list[ParseIssue],
    pre: Preflight,
    sha: str,
) -> ParseSyllabusResponse:
    kind = chosen.extraction.document_kind if chosen and chosen.extraction else "other"
    return ParseSyllabusResponse(
        status=status,  # type: ignore[arg-type]
        document_kind=kind,
        syllabus=chosen.syllabus if chosen and status in ("ok", "needs_review") else None,
        issues=issues,
        attempts=attempts,
        chosen_attempt=chosen_index,
        page_count=pre.page_count,
        sent_pages=pre.sent_pages,
        truncated_pages=pre.truncated,
        scanned=not pre.has_text_layer,
        pdf_sha256=sha,
        parser_version=PARSER_VERSION,
        prompt_version=PROMPT_VERSION,
    )


async def _attempt(
    deps: Deps,
    *,
    index: int,
    model: str,
    effort: str,
    timeout_s: float,
    pdf_b64: str,
    user_text: str,
    request_id: str,
) -> tuple[SyllabusExtraction | None, LlmAttempt]:
    s = deps.settings
    if s.fake_llm:
        extraction, attempt = fake_extract()
    else:
        assert deps.client is not None
        extraction, attempt = await extract(
            deps.client,
            model=model,
            effort=effort,
            pdf_b64=pdf_b64,
            system=SYSTEM_PROMPT,
            user_text=user_text,
            max_tokens=s.max_tokens,
            timeout_s=timeout_s,
            server_fallbacks=s.server_fallbacks,
            clock=deps.clock,
        )
    log_event(
        "llm_attempt",
        request_id=request_id,
        attempt=index,
        model=attempt.model,
        outcome=attempt.outcome,
        stop_reason=attempt.stop_reason,
        input_tokens=attempt.input_tokens,
        output_tokens=attempt.output_tokens,
        cache_read=attempt.cache_read,
        cache_write=attempt.cache_write,
        latency_ms=attempt.latency_ms,
    )
    return extraction, attempt


async def parse_syllabus(
    req: ParseSyllabusRequest, pdf: bytes, deps: Deps, request_id: str
) -> ParseSyllabusResponse:
    """Parse one PDF.

    Raises:
        PdfRejected: from the preflight (invalid_pdf, encrypted_pdf, too_many_pages).
        PipelineError: 502 upstream_llm (every attempt failed on API errors) or 503 overloaded
            (an attempt timed out and nothing usable came back).
    """
    s = deps.settings
    began = deps.clock()
    sha = hashlib.sha256(pdf).hexdigest()
    pre = await run_preflight(
        pdf,
        slice_above=s.slice_above_pages,
        slice_to=s.slice_to_pages,
        hard_max=s.hard_max_pages,
        timeout_s=s.preflight_timeout_s,
    )
    log_event(
        "preflight",
        request_id=request_id,
        bytes=len(pdf),
        pages=pre.page_count,
        sent_pages=pre.sent_pages,
        scanned=not pre.has_text_layer,
        truncated=pre.truncated,
    )
    pdf_b64 = base64.b64encode(pre.pdf_for_model).decode("ascii")

    def remaining() -> float:
        return s.deadline_s - (deps.clock() - began)

    evaluated: list[_Evaluated] = []
    x1, a1 = await _attempt(
        deps,
        index=0,
        model=s.primary_model,
        effort=s.primary_effort,
        timeout_s=max(1.0, min(s.primary_timeout_s, remaining())),
        pdf_b64=pdf_b64,
        user_text=build_user_text(req, pre),
        request_id=request_id,
    )
    first = _evaluate(x1, a1, req, pre)
    evaluated.append(first)

    elapsed = deps.clock() - began
    can_escalate = (
        req.allow_escalation
        and bool(s.escalation_model)
        and not s.fake_llm
        and not first.not_syllabus
        and should_escalate(first.issues)
        and elapsed <= s.escalate_before_s
        and remaining() >= MIN_ESCALATION_BUDGET_S
    )
    if can_escalate:
        x2, a2 = await _attempt(
            deps,
            index=1,
            model=s.escalation_model,
            effort=s.escalation_effort,
            timeout_s=max(1.0, min(s.escalation_timeout_s, remaining())),
            pdf_b64=pdf_b64,
            user_text=build_user_text(req, pre, first.issues),
            request_id=request_id,
        )
        evaluated.append(_evaluate(x2, a2, req, pre))

    attempts = [e.attempt for e in evaluated]

    # Not a syllabus (by the latest attempt that produced output): no data, never escalated.
    for idx in range(len(evaluated) - 1, -1, -1):
        if evaluated[idx].extraction is not None:
            if evaluated[idx].not_syllabus:
                return _response(
                    status="not_syllabus", chosen=evaluated[idx], chosen_index=idx,
                    attempts=attempts, issues=[], pre=pre, sha=sha,
                )  # fmt: skip
            break

    usable = [(i, e) for i, e in enumerate(evaluated) if e.syllabus is not None]
    if not usable:
        outcomes = {e.attempt.outcome for e in evaluated}
        if outcomes <= _TRANSIENT:
            if "timeout" in outcomes:
                raise PipelineError(503, "overloaded", "the model did not answer within the deadline")
            raise PipelineError(502, "upstream_llm", "the model API failed on every attempt")
        issues = [i for e in evaluated for i in e.issues]
        return _response(
            status="unreadable", chosen=None, chosen_index=None,
            attempts=attempts, issues=_dedupe(issues), pre=pre, sha=sha,
        )  # fmt: skip

    # Fewest errors wins; ties go to the later (escalation) attempt.
    chosen_index, chosen = min(usable, key=lambda item: (error_count(item[1].issues), -item[0]))
    status = "ok" if error_count(chosen.issues) == 0 else "needs_review"
    return _response(
        status=status, chosen=chosen, chosen_index=chosen_index,
        attempts=attempts, issues=chosen.issues, pre=pre, sha=sha,
    )  # fmt: skip


def _dedupe(issues: list[ParseIssue]) -> list[ParseIssue]:
    seen: set[tuple[str, str]] = set()
    out: list[ParseIssue] = []
    for i in issues:
        if (i.code, i.path) not in seen:
            seen.add((i.code, i.path))
            out.append(i)
    return out
