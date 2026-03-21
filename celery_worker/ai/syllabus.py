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
