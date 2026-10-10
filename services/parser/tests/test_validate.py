from __future__ import annotations

import base64
from typing import Any

from conftest import TODAY, extraction

from app.models import ParseSyllabusRequest, SyllabusExtraction
from app.normalize import normalize_detailed
from app.preflight import Preflight
from app.validate import error_count, should_escalate, validate


def pre(**overrides: Any) -> Preflight:
    base: dict[str, Any] = {
        "page_count": 2,
        "sent_pages": 2,
        "encrypted": False,
        "text_chars": 2000,
        "has_text_layer": True,
        "percent_tokens": 0,
        "pdf_for_model": b"%PDF-",
        "truncated": False,
    }
    base.update(overrides)
    return Preflight(**base)


def run(x: dict[str, Any], p: Preflight | None = None, stop_reason: str | None = "end_turn", **req_over: Any) -> list[str]:
    data: dict[str, Any] = {"pdf_base64": base64.b64encode(b"%PDF-1").decode(), "timezone": "America/New_York", "today": TODAY}
    data.update(req_over)
    req = ParseSyllabusRequest.model_validate(data)
    ex = SyllabusExtraction.model_validate(x)
    norm, meta = normalize_detailed(ex, req)
    issues = validate(ex, norm, req, p or pre(), stop_reason, meta)
    return [f"{i.severity}:{i.code}" for i in issues]


def grading(*weights: float | None) -> list[dict[str, Any]]:
    return [{"name": f"C{i}", "weight_pct": -1 if w is None else w, "notes": ""} for i, w in enumerate(weights)]


def test_weights_100_and_100_5_pass() -> None:
    assert run(extraction(grading=grading(50, 50))) == []
    assert run(extraction(grading=grading(50, 50.5))) == []


def test_weights_85_escalate() -> None:
    codes = run(extraction(grading=grading(50, 35)))
    assert codes == ["error:weights_sum"]


def test_no_weights_with_percent_evidence_escalates() -> None:
    assert run(extraction(grading=grading(None, None)), pre(percent_tokens=3)) == ["error:weights_missing"]


def test_no_weights_scanned_escalates() -> None:
    assert run(extraction(grading=[]), pre(text_chars=0, has_text_layer=False)) == ["error:weights_missing"]


def test_no_weights_without_evidence_warns_only() -> None:
    assert run(extraction(grading=[])) == ["warn:no_weights_stated"]


def test_exam_out_of_term_is_error() -> None:
    exams = [{**extraction()["exams"][0], "date_text": "2027-03-01", "date": "2027-03-01"}]
    assert "error:exam_out_of_term" in run(extraction(exams=exams))


def test_course_mismatch_warns() -> None:
    assert run(extraction(), course_hint="orgo") == ["warn:course_mismatch"]
    assert run(extraction(), course_hint="hist 101") == []
    assert run(extraction(), course_hint="ancient world") == []


def test_not_syllabus_never_escalates() -> None:
    issues_codes = run(extraction(document_kind="assignment", grading=grading(10)))
    assert issues_codes == []


def test_max_tokens_is_error() -> None:
    assert "error:truncated" in run(extraction(), stop_reason="max_tokens")


def test_weekday_mismatch_and_truncated_pages_warn() -> None:
    exams = [{**extraction()["exams"][0], "date_text": "Wed Oct 15"}]
    codes = run(extraction(exams=exams), pre(page_count=45, sent_pages=20, truncated=True))
    assert codes == ["warn:weekday_mismatch", "warn:truncated_pages"]


def test_stale_term_warns() -> None:
    x = extraction(term_start="2025-08-27", term_end="2025-12-19")
    x["exams"] = [{**e, "date_text": e["date_text"], "date": e["date"].replace("2026", "2025")} for e in x["exams"]]
    x["exams"][0]["date_text"] = "Wed Oct 15"  # 2025-10-15 is a Wednesday
    x["exams"][1]["date_text"] = "Dec 15"
    x["assignments"] = []
    assert "warn:stale_term" in run(x)


def test_counts() -> None:
    from app.models import ParseIssue

    issues = [ParseIssue(code="a", severity="warn", message=""), ParseIssue(code="b", severity="error", message="")]
    assert error_count(issues) == 1
    assert should_escalate(issues)
    assert not should_escalate(issues[:1])
