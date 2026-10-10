"""Canned extraction for `PARSER_FAKE_LLM=1` (dev only; refused on Cloud Run / Vercel by config).

Fictional "HIST 101 The Ancient World", Fall 2026 — the same course as the test factory's
SYNTHETIC_SYLLABUS — so local smoke runs (task 3.5 / 5.3) get realistic output for $0.
"""

from __future__ import annotations

from app.models import LlmAttempt, SyllabusExtraction

FAKE_MODEL = "fake-llm"

FAKE_EXTRACTION: dict[str, object] = {
    "document_kind": "syllabus",
    "course_code": "HIST 101",
    "course_title": "The Ancient World",
    "cross_listed_codes": "",
    "term": "Fall 2026",
    "term_start": "2026-08-26",
    "term_end": "2026-12-18",
    "timezone_hint": "",
    "instructors": [
        {"name": "Prof. Ada Marlow", "role": "instructor", "email": "ada.marlow@example.edu", "office_hours": "Wed 2-4pm"}
    ],
    "meetings": [{"kind": "lecture", "days": ["TU", "TH"], "time_text": "13:00-14:15", "location": "Hall 101"}],
    "grading": [
        {"name": "Participation", "weight_pct": 10, "notes": ""},
        {"name": "Response papers", "weight_pct": 30, "notes": "lowest dropped"},
        {"name": "Midterm exam", "weight_pct": 25, "notes": ""},
        {"name": "Final exam", "weight_pct": 35, "notes": ""},
    ],
    "grading_notes": "",
    "exams": [
        {
            "title": "Midterm",
            "kind": "midterm",
            "date_text": "Thu Oct 15, in class",
            "date": "2026-10-15",
            "time_text": "13:00-14:15",
            "location": "Hall 101",
            "weight_pct": 25,
            "topics": "Mesopotamia; Egypt; Archaic Greece",
            "cumulative": False,
        },
        {
            "title": "Final Exam",
            "kind": "final",
            "date_text": "Monday, December 14, 9:00am",
            "date": "2026-12-14",
            "time_text": "09:00-12:00",
            "location": "",
            "weight_pct": 35,
            "topics": "Classical Greece; Rome",
            "cumulative": True,
        },
    ],
    "assignments": [
        {
            "title": "Response paper 1",
            "category": "Response papers",
            "due_text": "Fri Sep 18, 5pm",
            "due_date": "2026-09-18",
            "weight_pct": -1,
        }
    ],
    "schedule": [
        {"week": 1, "date": "", "topics": "Introduction", "readings": "", "due": ""},
        {"week": 5, "date": "", "topics": "Egypt", "readings": "Ch. 4", "due": ""},
    ],
    "policies": {
        "late_work": "Papers lose a third of a grade per day late.",
        "attendance": "",
        "collaboration": "Discuss freely; write alone.",
        "exam_makeup": "Only with a dean's excuse.",
    },
    "extraction_notes": "",
}


def fake_extract(model: str = FAKE_MODEL) -> tuple[SyllabusExtraction, LlmAttempt]:
    """The canned extraction plus a zero-usage attempt."""
    attempt = LlmAttempt(
        model=model,
        input_tokens=0,
        output_tokens=0,
        cache_read=0,
        cache_write=0,
        latency_ms=0,
        stop_reason="end_turn",
        outcome="ok",
    )
    return SyllabusExtraction.model_validate(FAKE_EXTRACTION), attempt
