"""Claude Haiku email classifier and rapidfuzz deadline matcher.

Classifies professor emails as deadline changes using Claude Haiku.
Cross-references email subjects against Canvas deadlines using rapidfuzz
token_set_ratio fuzzy matching.

Per CLAUDE.md: Use claude-haiku-4-5-20251001 for deadline change classification.
"""
import json
import logging
import os

from anthropic import Anthropic
from rapidfuzz import fuzz

logger = logging.getLogger(__name__)

HAIKU_SYSTEM = """You classify professor emails for a college student assistant.
Output ONLY valid JSON: {"is_deadline_change": bool, "confidence": float}
Set confidence 0.0-1.0. High confidence (0.8+) if the email explicitly mentions:
- A new due date, deadline extension, or postponement
- Assignment or exam cancellation
- Schedule change for an exam or major assignment
Low confidence for: general announcements, office hours changes, logistics."""


def classify_email(subject: str, snippet: str) -> dict:
    """Classify an email using Claude Haiku.

    Sends only the subject and email preview (snippet) to Claude — never full body.
    Returns a structured classification with confidence score.

    Args:
        subject: Email subject line.
        snippet: Short email preview/snippet (not full body).

    Returns:
        Dict with keys 'is_deadline_change' (bool) and 'confidence' (float 0.0-1.0).
        Falls back to {is_deadline_change: False, confidence: 0.0} on any error.
    """
    try:
        client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        user_content = f"Subject: {subject}\n\nEmail preview: {snippet}"
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=64,
            system=HAIKU_SYSTEM,
            messages=[{"role": "user", "content": user_content}],
        )
        return json.loads(response.content[0].text)
    except Exception as e:
        logger.error("Email classification failed: %s", e)
        return {"is_deadline_change": False, "confidence": 0.0}


def find_matching_deadline(email_subject: str, deadlines: list[dict]) -> dict | None:
    """Find best-matching Canvas deadline via rapidfuzz token_set_ratio.

    Compares email subject against each deadline's title and title+course combo.
    Returns best match if score >= 70, else None.

    Threshold 70 is chosen to allow partial matches (e.g. "Bio Lab Report Extended"
    should match "Bio Lab Report") while rejecting completely unrelated subjects.

    Args:
        email_subject: The email subject line to match against.
        deadlines: List of deadline dicts with 'title' and optionally 'course'/'course_id'.

    Returns:
        Best matching deadline dict if score >= 70, else None.
        Returns None immediately for empty deadlines list.
    """
    if not deadlines:
        return None

    best_score = 0
    best_match = None
    subject_lower = email_subject.lower()

    for d in deadlines:
        # Match against title
        title_score = fuzz.token_set_ratio(subject_lower, d.get("title", "").lower())
        # Also try title + course combo
        course = d.get("course") or d.get("course_id") or ""
        combo = f"{d.get('title', '')} {course}".lower()
        combo_score = fuzz.token_set_ratio(subject_lower, combo)
        score = max(title_score, combo_score)

        if score > best_score:
            best_score = score
            best_match = d

    return best_match if best_score >= 70 else None
