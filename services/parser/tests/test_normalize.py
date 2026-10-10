from __future__ import annotations

import base64
import json
from datetime import date

import pytest
from conftest import REPO_ROOT, TODAY, extraction

from app.models import ParseSyllabusRequest, SyllabusExtraction
from app.normalize import MAX_EXAMS, MAX_STR, MAX_TOPICS, course_key, normalize, normalize_detailed

VECTORS_PATH = REPO_ROOT / "tests" / "fixtures" / "contract" / "course_key_vectors.json"


def _vectors() -> list[dict[str, object]]:
    return json.loads(VECTORS_PATH.read_text())["vectors"]


@pytest.mark.parametrize("vector", _vectors(), ids=lambda v: repr(v["input"]))
def test_course_key_shared_vectors(vector: dict[str, object]) -> None:
    assert course_key(vector["input"]) == vector["expected"]  # type: ignore[arg-type]


def test_course_key_v1_regression_empty_is_none() -> None:
    assert course_key("") is None
    assert course_key(None) is None
    assert course_key("﻿ 　") is None


def req(**overrides: object) -> ParseSyllabusRequest:
    data: dict[str, object] = {
        "pdf_base64": base64.b64encode(b"%PDF-1.4 x").decode(),
        "timezone": "America/New_York",
        "today": TODAY,
    }
    data.update(overrides)
    return ParseSyllabusRequest.model_validate(data)


def test_happy_normalization() -> None:
    p = normalize(SyllabusExtraction.model_validate(extraction()), req())
    assert p.course.key == "HIST101"
    assert p.course.term_start == date(2026, 8, 26)
    assert p.grading_total_pct == 100
    mid, final = p.exams
    assert mid.date == date(2026, 10, 15) and mid.start_local == "2026-10-15T13:00"
    assert mid.starts_at_utc == "2026-10-15T17:00:00Z"
    assert final.date == date(2026, 12, 14) and final.starts_at_utc == "2026-12-14T14:00:00Z"
    assert final.date_confidence == "inferred_year"  # text has no year
    assert p.assignments[0].due_at_utc == "2026-09-18T21:00:00Z"
    assert p.meetings[0].start_local == "13:00"
    assert p.schedule[0].week == 1 and p.schedule[0].date is None


def test_caps_and_trimming() -> None:
    long = "x" * 1000
    exams = [
        {**extraction()["exams"][0], "title": f"Quiz {i}", "topics": "; ".join(f"t{j}" for j in range(40)), "location": long}
        for i in range(50)
    ]
    x = SyllabusExtraction.model_validate(extraction(exams=exams, course_title="  Data   Structures  "))
    p = normalize(x, req())
    assert len(p.exams) == MAX_EXAMS
    assert all(len(e.topics) == MAX_TOPICS for e in p.exams)
    assert all(len(e.location) <= MAX_STR for e in p.exams)
    assert p.course.title == "Data Structures"


def test_exam_dedupe_same_title_and_date() -> None:
    mid = extraction()["exams"][0]
    x = SyllabusExtraction.model_validate(extraction(exams=[mid, {**mid, "title": "midterm "}, {**mid, "date_text": "Oct 22"}]))
    p = normalize(x, req())
    assert [e.date for e in p.exams] == [date(2026, 10, 15), date(2026, 10, 22)]


def test_weights_out_of_range_become_null() -> None:
    x = SyllabusExtraction.model_validate(
        extraction(
            grading=[
                {"name": "A", "weight_pct": 150, "notes": ""},
                {"name": "B", "weight_pct": 40, "notes": ""},
                {"name": "C", "weight_pct": -1, "notes": ""},
            ]
        )
    )
    p = normalize(x, req())
    assert [g.weight_pct for g in p.grading] == [None, 40, None]
    assert p.grading_total_pct == 40


def test_term_hint_beats_extracted_term() -> None:
    x = SyllabusExtraction.model_validate(extraction(term_start="", term_end=""))
    _, meta = normalize_detailed(x, req(term={"name": "Fall 2026", "start": "2026-08-20", "end": "2026-12-20"}))
    assert meta.term.start == date(2026, 8, 20) and meta.term.end == date(2026, 12, 20)


def test_timezone_hint_overrides_user_zone() -> None:
    x = SyllabusExtraction.model_validate(extraction(timezone_hint="all times PT"))
    p = normalize(x, req())
    assert p.timezone == "America/Los_Angeles"
    assert p.exams[0].starts_at_utc == "2026-10-15T20:00:00Z"


def test_course_key_falls_back_to_title_then_hint() -> None:
    p = normalize(SyllabusExtraction.model_validate(extraction(course_code="")), req())
    assert p.course.key == "t:the-ancient-world"
    p = normalize(SyllabusExtraction.model_validate(extraction(course_code="", course_title="")), req(course_hint="orgo"))
    assert p.course.key == "t:orgo"


def test_all_day_exam_without_time() -> None:
    exam = {**extraction()["exams"][0], "time_text": "", "date_text": "Thu Oct 15"}
    p = normalize(SyllabusExtraction.model_validate(extraction(exams=[exam])), req())
    e = p.exams[0]
    assert e.all_day and e.start_local is None
    assert e.starts_at_utc == "2026-10-15T04:00:00Z" and e.ends_at_utc == "2026-10-16T04:00:00Z"


def test_list_fields_are_split_and_times_read_from_text() -> None:
    x = extraction(cross_listed_codes="CLSS 101; HIST 101", extraction_notes="weights ok\nfinal TBA")
    x["exams"][0] |= {"time_text": "", "date_text": "Thu Oct 15 (1:00-2:15pm)", "topics": "Egypt;  Rome ; egypt;"}
    x["assignments"][0]["due_text"] = "Fri 9/18, 11:59 PM"
    x["meetings"][0]["time_text"] = "1:00-2:15pm"
    p = normalize(SyllabusExtraction.model_validate(x), req())
    assert p.course.cross_listed == ["CLSS 101", "HIST 101"]
    assert p.notes == ["weights ok", "final TBA"]
    assert p.exams[0].topics == ["Egypt", "Rome"]
    assert (p.exams[0].start_local, p.exams[0].end_local) == ("2026-10-15T13:00", "2026-10-15T14:15")
    assert p.assignments[0].due_local == "2026-09-18T23:59"
    assert (p.meetings[0].start_local, p.meetings[0].end_local) == ("13:00", "14:15")
