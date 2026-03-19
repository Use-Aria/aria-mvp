"""Parse iCal VEVENT records into normalized dicts with UTC due_date."""
import datetime as dt
from datetime import datetime, timezone, time

from icalendar import Calendar


def parse_vevents(raw_bytes: bytes) -> list[dict]:
    """Parse raw iCal bytes and return a list of normalized event dicts.

    Args:
        raw_bytes: Raw iCal feed bytes from Canvas.
    Returns:
        List of dicts with keys: canvas_uid, title, due_date (UTC ISO 8601),
        course, type. Events missing DTSTART or that are not VEVENT are skipped.
    """
    cal = Calendar.from_ical(raw_bytes)
    events = []

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

        uid = str(component.get("UID", ""))
        summary = str(component.get("SUMMARY", ""))

        dtstart_prop = component.get("DTSTART")
        if dtstart_prop is None:
            continue

        dtstart_value = dtstart_prop.dt

        # Handle all-day DATE vs timezone-aware DATETIME
        if isinstance(dtstart_value, dt.date) and not isinstance(dtstart_value, dt.datetime):
            # All-day event: normalize to end-of-day UTC (23:59:59Z)
            due_utc = datetime.combine(dtstart_value, time(23, 59, 59), tzinfo=timezone.utc)
        else:
            # Timezone-aware datetime — convert to UTC
            due_utc = dtstart_value.astimezone(timezone.utc)

        events.append({
            "canvas_uid": uid,
            "title": summary,
            "due_date": due_utc.isoformat(),
            "course": _extract_course(summary),
            "type": _infer_type(summary),
        })

    return events


def _extract_course(summary: str) -> str | None:
    """Extract course name from Canvas SUMMARY string.

    Canvas SUMMARY format is typically "Assignment Name - Course Name".
    Returns the part after " - " if present, else None.

    Args:
        summary: VEVENT SUMMARY field value.
    Returns:
        Course name string or None if delimiter not found.
    """
    if " - " in summary:
        return summary.split(" - ", 1)[1]
    return None


def _infer_type(summary: str) -> str:
    """Infer event type from SUMMARY text.

    Args:
        summary: VEVENT SUMMARY field value.
    Returns:
        "exam" if summary contains exam/midterm/final keywords, else "assignment".
    """
    lower = summary.lower()
    if any(keyword in lower for keyword in ("exam", "midterm", "final")):
        return "exam"
    return "assignment"
