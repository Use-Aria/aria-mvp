"""Delivery router — maps priority scores to delivery tiers.

Thresholds locked per CONTEXT.md:
    score >= 80: 'immediate' — SMS fires within 60 seconds of ingestion
    score 50-79: 'digest'    — queued for next morning briefing
    score < 50:  'silent'    — logged in canonical_events, visible in app only (Phase 8)

Immediate alerts (score >= 80) bypass TCPA quiet hours and daily proactive cap,
but always check opt-out status via send_sms_alert().
"""


def route_event(priority_score: int) -> str:
    """Map priority score to delivery_status string.

    Args:
        priority_score: Integer 0-100 (from score_event()).

    Returns:
        'immediate' if score >= 80
        'digest'    if score >= 50
        'silent'    otherwise
    """
    if priority_score >= 80:
        return "immediate"
    elif priority_score >= 50:
        return "digest"
    else:
        return "silent"
