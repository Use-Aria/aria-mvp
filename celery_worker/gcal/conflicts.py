"""Conflict detection between Canvas deadlines and GCal events.

Finds Canvas deadlines whose due_date (calendar day) overlaps any busy GCal event
on the same calendar day. Deduplicates via the conflict_alerts table
(UNIQUE on user_id, deadline_id, gcal_event_id + deadline_due_at check for re-fire).

Fired conflicts are routed through the SMS batch queue (SMS-10/SMS-11 compliant).
"""
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def detect_conflicts_user(user_id: str) -> list[dict]:
    """Find Canvas deadlines whose due_date (calendar day) overlaps any busy GCal event.

    Deduplicates via the conflict_alerts table. Re-fires if the deadline's due_date
    has changed since the last alert (deadline was moved).

    Args:
        user_id: UUID of the user to check conflicts for.

    Returns:
        List of newly fired conflict dicts with keys: deadline (title), event (title).
    """
    from ai.db import _get_supabase
    from sms.batch import enqueue_alert

    client = _get_supabase()

    # Get active Canvas deadlines (not deleted, not completed)
    deadlines = (
        client.table("deadlines")
        .select("id, title, due_date, course")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .neq("status", "completed")
        .execute()
    ).data

    # Get GCal events for this user
    events = (
        client.table("calendar_events")
        .select("id, google_event_id, title, start_time, end_time")
        .eq("user_id", user_id)
        .execute()
    ).data

    if not deadlines or not events:
        return []

    # Get existing conflict alerts for deduplication
    # Key: (deadline_id, gcal_event_id, deadline_due_at) — re-fires if due_date changed
    existing = (
        client.table("conflict_alerts")
        .select("deadline_id, gcal_event_id, deadline_due_at")
        .eq("user_id", user_id)
        .execute()
    ).data
    existing_set = {
        (e["deadline_id"], e["gcal_event_id"], e.get("deadline_due_at"))
        for e in existing
    }

    new_conflicts = []
    for d in deadlines:
        d_date_str = d["due_date"][:10]  # YYYY-MM-DD

        for e in events:
            e_date_str = e["start_time"][:10]

            if d_date_str == e_date_str:
                # Check deduplication: same (deadline_id, gcal_event_id, due_date) = skip
                dedup_key = (d["id"], e["google_event_id"], d["due_date"])
                if dedup_key in existing_set:
                    continue

                # Calculate event duration for SMS
                try:
                    e_start = datetime.fromisoformat(e["start_time"])
                    e_end = datetime.fromisoformat(e["end_time"])
                    duration_hrs = round((e_end - e_start).total_seconds() / 3600, 1)
                    duration_str = f"{duration_hrs}-hour" if duration_hrs != 1 else "1-hour"
                except Exception:
                    duration_str = ""

                # Build conflict SMS — follows CONTEXT.md actionable format
                try:
                    day_name = datetime.fromisoformat(d["due_date"]).strftime("%A")
                except Exception:
                    day_name = "that day"

                course = d.get("course") or ""
                course_suffix = f" ({course})" if course else ""
                body = (
                    f"Heads up: {d['title']}{course_suffix}"
                    f" is due {day_name}, and you have "
                    f"{e['title']} ({duration_str}) that day. "
                    f"Want me to add a study block the day before?"
                )

                # Record in conflict_alerts (dedup via UNIQUE constraint)
                try:
                    client.table("conflict_alerts").insert({
                        "user_id": user_id,
                        "deadline_id": d["id"],
                        "gcal_event_id": e["google_event_id"],
                        "deadline_due_at": d["due_date"],
                        "gcal_event_date": e_date_str,
                    }).execute()
                except Exception as exc:
                    # UNIQUE constraint violation means it was already inserted concurrently — skip
                    logger.warning("conflict_alerts insert failed for user %s: %s", user_id, exc)
                    continue

                # Route through batch queue (SMS-10)
                is_first = enqueue_alert(user_id, body, priority_score=75)
                if is_first:
                    # Import lazily to avoid circular imports (tasks.py imports gcal.conflicts)
                    from tasks import flush_sms_batch
                    flush_sms_batch.apply_async(args=[user_id], countdown=600)

                logger.info(
                    "Conflict fired for user %s: deadline=%s, event=%s",
                    user_id, d["title"], e["title"],
                )
                new_conflicts.append({"deadline": d["title"], "event": e["title"]})

    return new_conflicts
