"""Syllabus PDF parsing via Claude Opus and idempotent Supabase upsert.

Parses course syllabi uploaded as PDFs using Claude Opus document block API.
Stores structured JSON in the syllabi table with UNIQUE(user_id, course_name)
constraint for idempotent upsert.

Called by: celery_worker/tasks.py (parse_syllabus_task)
Never call directly from API routes — always dispatch via Celery task.
"""
import base64
import json
import logging
import os
from datetime import datetime, timezone

from anthropic import Anthropic

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

SYLLABUS_EXTRACTION_PROMPT = """Extract the course syllabus information from this PDF and return a single JSON object.

Return ONLY valid JSON — no markdown, no code fences, no explanation.

Required JSON schema:
{
  "course_name": "<string: full course name, e.g. 'CPSC 223 Data Structures'>",
  "exams": [
    {
      "title": "<string: exam name, e.g. 'Midterm 1'>",
      "date_str": "<string: raw date text from syllabus, e.g. 'October 15' — NOT converted to ISO>",
      "topics": ["<string>", "..."],
      "weight_pct": <number|null: grade percentage, null if not stated>
    }
  ],
  "assignments": [
    {
      "type": "<string: assignment category, e.g. 'Problem Sets', 'Lab Reports'>",
      "weight_pct": <number|null: grade percentage, null if not stated>
    }
  ],
  "total_tracked_weight_pct": <number|null: sum of all tracked weights, null if unknown>
}

Rules:
- date_str must be raw text as written in the syllabus (e.g. "October 15", "Week 8"), never ISO 8601
- weight_pct is null if the syllabus does not explicitly state a percentage
- Use empty arrays [] if no exams or assignments are listed (partial syllabi allowed)
- topics is an empty array [] if no topics are listed for an exam
- Extract all exams and quizzes; do not omit any

Return ONLY the JSON object, nothing else."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def check_existing_syllabus(user_id: str, course_name: str) -> dict | None:
    """Check if parsed_json already exists for (user_id, course_name).

    Used by parse_syllabus_task to implement the "never re-parse" requirement:
    if a parsed result already exists, skip Claude entirely and reuse it.

    Args:
        user_id: UUID of the user.
        course_name: Course name to check.

    Returns:
        parsed_json dict if a row exists with non-null parsed_json, else None.
    """
    from ai.db import _get_supabase
    client = _get_supabase()
    result = (
        client.table("syllabi")
        .select("parsed_json")
        .eq("user_id", user_id)
        .eq("course_name", course_name)
        .not_.is_("parsed_json", "null")
        .limit(1)
        .execute()
    )
    if result.data and result.data[0].get("parsed_json") is not None:
        return result.data[0]["parsed_json"]
    return None


def parse_syllabus_pdf(pdf_bytes: bytes, course_hint: str | None = None) -> dict | None:
    """Parse a syllabus PDF via Claude Opus document block API.

    Sends the raw PDF bytes to Claude Opus as a base64-encoded document block.
    Strips any markdown code fences from the response before JSON parsing.
    Returns None on any failure (malformed JSON, API error, network error).

    Args:
        pdf_bytes: Raw PDF file bytes.
        course_hint: Optional course name hint to pass as context. Currently unused
            but reserved for future prompt enrichment.

    Returns:
        Parsed dict with keys: course_name, exams, assignments,
        total_tracked_weight_pct. Returns None on failure.
    """
    try:
        pdf_data = base64.standard_b64encode(pdf_bytes).decode("utf-8")

        client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": "application/pdf",
                                "data": pdf_data,
                            },
                        },
                        {
                            "type": "text",
                            "text": SYLLABUS_EXTRACTION_PROMPT,
                        },
                    ],
                }
            ],
        )

        text = response.content[0].text

        # Strip markdown code fences if Claude wraps output (```json ... ```)
        if text.strip().startswith("```"):
            lines = text.strip().splitlines()
            # Drop first line (```json or ```) and last line (```)
            inner_lines = lines[1:]
            if inner_lines and inner_lines[-1].strip() == "```":
                inner_lines = inner_lines[:-1]
            text = "\n".join(inner_lines)

        return json.loads(text)

    except Exception as e:
        logger.error("parse_syllabus_pdf failed: %s", e)
        return None


def upsert_syllabus(user_id: str, course_name: str, parsed_json: dict) -> None:
    """Upsert parsed syllabus JSON into syllabi table.

    Uses ON CONFLICT(user_id, course_name) to replace an existing row.
    The UNIQUE constraint added in migration 007 makes this idempotent:
    re-uploading the same course replaces the previous parsed result.

    Args:
        user_id: UUID of the user who uploaded the syllabus.
        course_name: Course name (from parsed result or user-provided fallback).
        parsed_json: Structured dict returned by parse_syllabus_pdf().
    """
    from ai.db import _get_supabase
    client = _get_supabase()
    client.table("syllabi").upsert(
        {
            "user_id": user_id,
            "course_name": course_name,
            "parsed_json": parsed_json,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="user_id,course_name",
    ).execute()


# ---------------------------------------------------------------------------
# Phase 7 — Gap analysis and briefing enrichment
# ---------------------------------------------------------------------------


def get_gap_topics(user_id: str, course_id: str) -> list[dict]:
    """Return top-3 exam topics for a user's course to use in gap analysis.

    Queries syllabi table using case-insensitive ILIKE match on course_name.
    Returns topics from the first exam found, sorted by weight_pct descending,
    capped at top 3. Returns [] when no syllabus or no topics exist.

    Args:
        user_id: UUID of the user.
        course_id: Course ID from canonical_events (matched against syllabi.course_name).

    Returns:
        List of dicts with keys: topic (str), weight_pct (int|None). Max 3 items.
    """
    from ai.db import _get_supabase
    client = _get_supabase()

    result = (
        client.table("syllabi")
        .select("parsed_json")
        .eq("user_id", user_id)
        .ilike("course_name", f"%{course_id}%")
        .limit(1)
        .execute()
    )

    if not result.data:
        return []

    parsed_json = result.data[0].get("parsed_json")
    if not parsed_json:
        return []

    exams = parsed_json.get("exams") or []
    if not exams:
        return []

    # Use the first exam's topics as gap candidates
    exam = exams[0]
    topics = exam.get("topics") or []
    weight_pct = exam.get("weight_pct")

    topic_dicts = [{"topic": t, "weight_pct": weight_pct} for t in topics]

    # Sort by weight_pct descending (None treated as 0), cap at top 3
    topic_dicts.sort(key=lambda x: x.get("weight_pct") or 0, reverse=True)
    return topic_dicts[:3]


def build_gap_alert_body(course: str, days_until: int, exam_title: str, topics: list[dict]) -> str:
    """Build an SMS body for a gap analysis alert.

    Formats a concise SMS under 800 characters listing top-3 uncovered topics
    for an upcoming exam. Appends grade weight context when available.

    Args:
        course: Course name (e.g. "BIOL 201").
        days_until: Days until the exam (typically 5).
        exam_title: Name of the exam (e.g. "Midterm").
        topics: List of topic dicts with keys: topic, weight_pct.

    Returns:
        SMS body string, guaranteed <= 800 characters.
    """
    topic_names = [t["topic"] for t in topics[:3]]
    topic_list = ", ".join(topic_names)

    weight_str = ""
    if topics and topics[0].get("weight_pct") is not None:
        weight_str = f" (worth ~{topics[0]['weight_pct']}%)"

    body = (
        f"Gap alert for {course} {exam_title} in {days_until} days: "
        f"{topic_list}{weight_str}. Review these first."
    )

    if len(body) > 800:
        body = body[:797] + "..."

    return body


def get_syllabus_context(
    user_id: str,
    deadlines: list[dict],
    is_monday: bool = False,
) -> dict | None:
    """Build syllabus enrichment context for the daily briefing.

    Queries all syllabi for the user and builds:
    - exam_topic_hints: top-3 topics for exams due within 7 days
    - coverage_summaries: all topics for exams due within 14 days (Monday only)

    Returns None when user has no syllabi. Handles missing syllabus gracefully
    (exam_topic_hints entry is skipped when no matching syllabus found).

    Args:
        user_id: UUID of the user.
        deadlines: Active deadlines from get_events_for_briefing().
        is_monday: If True, include coverage_summaries for exams within 14 days.

    Returns:
        Dict with keys: exam_topic_hints (list[str]), coverage_summaries (list[str]).
        Returns None if no syllabi exist.
    """
    from ai.db import _get_supabase
    from datetime import datetime, timedelta, timezone

    client = _get_supabase()

    result = (
        client.table("syllabi")
        .select("course_name, parsed_json")
        .eq("user_id", user_id)
        .not_.is_("parsed_json", "null")
        .execute()
    )

    if not result.data:
        return None

    # Build lookup: course_name (lowered) -> parsed_json
    syllabi_by_course: dict[str, dict] = {}
    for row in result.data:
        syllabi_by_course[row["course_name"].lower()] = row["parsed_json"]

    def _find_syllabus(course_id: str) -> dict | None:
        """Case-insensitive partial match against syllabi course names."""
        course_lower = (course_id or "").lower()
        for name, parsed in syllabi_by_course.items():
            if course_lower in name or name in course_lower:
                return parsed
        return None

    now = datetime.now(timezone.utc)
    exam_topic_hints: list[str] = []
    coverage_summaries: list[str] = []

    for d in deadlines:
        if d.get("type") != "exam":
            continue

        due_str = str(d.get("due_date") or d.get("due_at", ""))
        if not due_str:
            continue

        due_dt = datetime.fromisoformat(due_str)
        if due_dt.tzinfo is None:
            due_dt = due_dt.replace(tzinfo=timezone.utc)

        days_until = (due_dt.date() - now.date()).days
        course_id = d.get("course") or d.get("course_id") or ""
        parsed = _find_syllabus(course_id)
        if not parsed:
            continue

        exams = parsed.get("exams") or []
        if not exams:
            continue

        exam = exams[0]
        all_topics = exam.get("topics") or []
        if not all_topics:
            continue

        # Daily hint: exams within 7 days
        if days_until <= 7:
            hint = f"{course_id}: {', '.join(all_topics[:3])}"
            exam_topic_hints.append(hint)

        # Monday coverage summary: exams within 14 days
        if is_monday and days_until <= 14:
            exam_title = exam.get("title", "Exam")
            summary = f"{course_id} {exam_title}: covers {', '.join(all_topics)}"
            coverage_summaries.append(summary)

    return {
        "exam_topic_hints": exam_topic_hints,
        "coverage_summaries": coverage_summaries if is_monday else [],
    }
