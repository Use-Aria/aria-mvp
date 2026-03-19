"""Priority scoring engine for canonical events.

Implements the locked priority formula from CONTEXT.md:
    Priority = (grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)

Source authority values are locked per CONTEXT.md:
    canvas = 1.0, gmail = 0.9 (professor email), todoist = 0.8, discord = 0.6

No external dependencies — stdlib math only.
"""
import math

SOURCE_AUTHORITY: dict[str, float] = {
    "canvas": 1.0,
    "gmail": 0.9,
    "todoist": 0.8,
    "discord": 0.6,
}


def compute_urgency(days_remaining: float) -> float:
    """Exponential urgency decay. Overdue events clamp to 1.0.

    Formula: min(1.0, e^(-0.15 × days_remaining))

    Spot checks from CONTEXT.md:
        14 days → ~0.12, 7 days → ~0.35, 3 days → ~0.64,
        1 day → ~0.86, 0 days → 1.0, overdue → 1.0

    Args:
        days_remaining: Days until the event is due. Negative means overdue.

    Returns:
        Urgency value in [0.0, 1.0]. Overdue (days_remaining <= 0) returns 1.0.
    """
    if days_remaining <= 0:
        return 1.0
    return min(1.0, math.exp(-0.15 * days_remaining))


def score_event(
    grade_weight: float | None,
    days_remaining: float,
    source: str,
) -> int:
    """Compute priority score on 0-100 scale.

    Formula (locked per CONTEXT.md):
        Priority = (grade_weight × 0.35) + (urgency × 0.45) + (source_authority × 0.20)
    Multiplied by 100 and rounded to an integer.

    grade_weight is expected normalized 0.0–1.0 (e.g. 0.25 for 25%).
    NULL grade_weight is treated as 0.0 (syllabus parsing not yet done for most events).
    Unknown source falls back to default authority 0.5.

    Args:
        grade_weight: Normalized grade weight 0.0–1.0, or None.
        days_remaining: Days until due. Negative = overdue.
        source: Event source string ('canvas', 'gmail', 'todoist', 'discord').

    Returns:
        Integer priority score in range 0–100.
    """
    gw = grade_weight if grade_weight is not None else 0.0
    urgency = compute_urgency(days_remaining)
    authority = SOURCE_AUTHORITY.get(source, 0.5)
    raw = (gw * 0.35) + (urgency * 0.45) + (authority * 0.20)
    return round(raw * 100)
