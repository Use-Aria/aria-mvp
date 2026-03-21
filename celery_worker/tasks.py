import requests
from celery_app import celery_app
from datetime import datetime, timezone

from anthropic import RateLimitError

# Forward declarations for tasks defined in Plan 03/04 (used in encrypt_and_store_tokens).
# These will be no-ops (caught by try/except) until those plans are executed.
try:
    from tasks import gcal_sync_user  # type: ignore[attr-defined]
except ImportError:
    gcal_sync_user = None  # type: ignore[assignment]

try:
    from tasks import gmail_establish_watch_task  # type: ignore[attr-defined]
except ImportError:
    gmail_establish_watch_task = None  # type: ignore[assignment]


@celery_app.task(name="tasks.flush_sms_batch")
def flush_sms_batch(user_id: str) -> dict:
    """Flush the SMS batch queue for a user after the 10-minute hold window.

    Called via countdown from send_priority_alert when the first alert is enqueued.
    Pops all queued alerts, sorts by priority descending, caps at 3 (SMS-11),
    and sends one combined SMS via send_sms_alert().

    Args:
        user_id: UUID of the user whose batch to flush.

    Returns:
        Dict with user_id, sent (bool), and body_len (int).
    """
    from sms.batch import flush_batch

    body = flush_batch(user_id)
    return {"user_id": user_id, "sent": body is not None, "body_len": len(body) if body else 0}


@celery_app.task(
    name="tasks.send_priority_alert",
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=2,
    max_retries=3,
)
def send_priority_alert(self, user_id: str, event_id: str) -> dict:
    """Enqueue a high-priority canonical event into the SMS batch queue.

    Fetches the event from canonical_events, builds alert message body,
    and enqueues via enqueue_alert(). If this is the first alert in the
    10-minute window (is_first=True), schedules flush_sms_batch after 600s.

    The canonical event is marked as 'sent' immediately (not at flush time)
    to prevent re-dispatch from the priority router.
    """
    from ai.db import _get_supabase
    from sms.send import _get_user_sms_state
    from sms.batch import enqueue_alert

    client = _get_supabase()
    event = (
        client.table("canonical_events")
        .select("title, due_at, course_id, type, priority_score")
        .eq("id", event_id)
        .single()
        .execute()
    ).data

    user = _get_user_sms_state(user_id)
    to_phone = user.get("phone", "")
    if not to_phone:
        return {"user_id": user_id, "status": "error", "reason": "no_phone"}

    # Build alert body
    course = event.get("course_id") or "Unknown course"
    title = event["title"]
    due = event["due_at"]
    body = f"URGENT: {title} ({course}) is due soon — {due}. Priority score: {event['priority_score']}/100."

    # Route through batch queue (SMS-10): collect all alerts in 10-min window
    is_first = enqueue_alert(user_id, body, event.get("priority_score", 80))
    if is_first:
        # Schedule batch flush after BATCH_TTL (600s) — only on first enqueue
        flush_sms_batch.apply_async(args=[user_id], countdown=600)

    # Mark event as 'sent' immediately to prevent re-dispatch by priority router.
    # The actual SMS delivery happens at flush_sms_batch time.
    from ai.db import write_outbound_message
    write_outbound_message(user_id, body, "priority_alert")
    client.table("canonical_events").update(
        {"delivery_status": "sent"}
    ).eq("id", event_id).execute()

    return {"user_id": user_id, "event_id": event_id, "status": "queued"}


@celery_app.task(
    name="tasks.parse_syllabus_task",
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=2,
    max_retries=3,
)
def parse_syllabus_task(self, user_id: str, pdf_b64: str, course_name: str) -> dict:
    """Parse syllabus PDF bytes via Claude Opus. Upsert result into syllabi table.

    Skips re-parsing if parsed_json already exists for (user_id, course_name).

    Args:
        user_id: UUID of the user who uploaded the syllabus.
        pdf_b64: Base64-encoded PDF bytes.
        course_name: Course name from the upload form.

    Returns:
        Dict with user_id, course_name, and parsed (bool).
    """
    import base64
    from ai.syllabus import check_existing_syllabus, parse_syllabus_pdf, upsert_syllabus

    # Never re-parse: check if parsed_json already exists for this (user_id, course_name)
    existing = check_existing_syllabus(user_id, course_name)
    if existing is not None:
        from sms.send import _get_user_sms_state, send_sms_safe
        user = _get_user_sms_state(user_id)
        if user and user.get("phone"):
            send_sms_safe(
                user_id,
                user["phone"],
                f"I already have your {course_name} syllabus on file. No need to re-upload!",
                is_proactive=True,
            )
        return {"user_id": user_id, "course_name": course_name, "parsed": True, "skipped": True}

    pdf_bytes = base64.b64decode(pdf_b64)
    parsed = parse_syllabus_pdf(pdf_bytes, course_hint=course_name)

    if parsed:
        # Use course_name from parsed result if available, else fall back to user-provided
        effective_course = parsed.get("course_name") or course_name
        upsert_syllabus(user_id, effective_course, parsed)
        # Send confirmation SMS
        from sms.send import _get_user_sms_state, send_sms_safe
        user = _get_user_sms_state(user_id)
        if user and user.get("phone"):
            send_sms_safe(
                user_id,
                user["phone"],
                f"Got it! I've parsed your {effective_course} syllabus. "
                f"Make sure this course name matches your Canvas course for gap alerts to work.",
                is_proactive=True,
            )
    else:
        # Parsing failed -- notify user
        from sms.send import _get_user_sms_state, send_sms_safe
        user = _get_user_sms_state(user_id)
        if user and user.get("phone"):
            send_sms_safe(
                user_id,
                user["phone"],
                "I had trouble reading that syllabus. Try uploading a text-based PDF if you have one.",
                is_proactive=True,
            )

    return {"user_id": user_id, "course_name": course_name, "parsed": bool(parsed)}


@celery_app.task(name="tasks.gap_analysis_all_users")
def gap_analysis_all_users() -> dict:
    """Daily fan-out: find all T-5 exams across all users, dispatch gap analysis.

    Queries canonical_events for exams due in exactly 5 days (UTC calendar day).
    Dispatches run_gap_analysis_task per matching (user, exam) pair.

    Returns:
        Dict with status and dispatched count.
    """
    from ai.db import _get_supabase
    from datetime import datetime, timezone, timedelta

    client = _get_supabase()
    now = datetime.now(timezone.utc)
    # T-5: exams due in exactly 5 days (date range: 5 days from now, same calendar day)
    target_start = (now + timedelta(days=5)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    target_end = (now + timedelta(days=5)).replace(hour=23, minute=59, second=59, microsecond=0).isoformat()

    exams = (
        client.table("canonical_events")
        .select("id, user_id, title, course_id, due_at")
        .eq("type", "exam")
        .gte("due_at", target_start)
        .lte("due_at", target_end)
        .execute()
    ).data

    dispatched = 0
    for exam in exams:
        run_gap_analysis_task.delay(exam["user_id"], exam["id"], exam.get("course_id", ""), exam["title"])
        dispatched += 1
    return {"status": "ok", "dispatched": dispatched}


@celery_app.task(
    name="tasks.run_gap_analysis_task",
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=2,
    max_retries=3,
)
def run_gap_analysis_task(self, user_id: str, exam_event_id: str, course_id: str, exam_title: str) -> dict:
    """Generate and send gap analysis SMS for one user's T-5 exam.

    Fetches topics from syllabus via get_gap_topics (ILIKE course match).
    Skips silently when no syllabus or topics found (graceful degradation).
    Routes alert through batch queue (SMS-10/SMS-11) with priority_score=75.

    Args:
        user_id: UUID of the user.
        exam_event_id: canonical_events row ID for the exam.
        course_id: Course ID from canonical_events (used for syllabus lookup).
        exam_title: Exam title for SMS body.

    Returns:
        Dict with user_id, exam_event_id, and status ('skipped' or 'queued').
    """
    from ai.syllabus import get_gap_topics, build_gap_alert_body
    from sms.batch import enqueue_alert

    topics = get_gap_topics(user_id, course_id)
    if not topics:
        return {"user_id": user_id, "exam_event_id": exam_event_id, "status": "skipped", "reason": "no_syllabus_or_topics"}

    body = build_gap_alert_body(course_id, 5, exam_title, topics)

    # Route through batch queue (SMS-10/SMS-11 compliant) with priority_score=75 (digest range)
    is_first = enqueue_alert(user_id, body, priority_score=75)
    if is_first:
        flush_sms_batch.apply_async(args=[user_id], countdown=600)

    return {"user_id": user_id, "exam_event_id": exam_event_id, "status": "queued"}


@celery_app.task(name="tasks.ping")
def ping():
    """Smoke-test task: logs timestamp to console. DB write added in Phase 2 when real users exist."""
    ts = datetime.now(timezone.utc).isoformat()
    print(f"[ping] executed at {ts}")
    return {"status": "ok", "timestamp": ts}


@celery_app.task(name="tasks.canvas_sync_all")
def canvas_sync_all():
    """Query all Canvas integrations and dispatch one sync task per user.

    Called by Celery Beat every 60 minutes. Fans out to canvas_sync_user
    for per-user isolation — one user's failure does not block another.
    """
    from canvas.db import get_all_canvas_integrations

    integrations = get_all_canvas_integrations()
    for row in integrations:
        canvas_sync_user.delay(row["user_id"], row["ical_url"])
    return {"status": "ok", "dispatched": len(integrations)}


@celery_app.task(
    name="tasks.canvas_sync_user",
    bind=True,
    autoretry_for=(requests.HTTPError,),
    retry_backoff=2,
    retry_backoff_max=300,
    retry_jitter=True,
    max_retries=5,
)
def canvas_sync_user(self, user_id: str, ical_url: str) -> dict:
    """Fetch, parse, diff, and persist one user's Canvas deadlines.

    Uses exponential backoff on HTTP errors (including 429 rate limit).
    synced_at is only written after apply_diff succeeds.
    Triggers welcome_briefing on the first sync (synced_at was NULL).
    """
    from canvas.fetch import fetch_ical
    from canvas.parse import parse_vevents
    from canvas.diff import compute_diff
    from canvas.db import load_current_deadlines, apply_diff, mark_synced
    from canvas.db import _get_supabase as _get_canvas_supabase

    raw = fetch_ical(ical_url)
    events = parse_vevents(raw)
    current = load_current_deadlines(user_id)
    diff = compute_diff(current, events)
    apply_diff(user_id, diff)

    # Write new and changed events to canonical_events for priority scoring
    from priority.ingest import ingest_canonical_event
    for event in diff["added"] + diff["changed"]:
        ingest_canonical_event(
            user_id=user_id,
            source="canvas",
            event_type=event.get("type", "assignment"),
            title=event["title"],
            due_at=event["due_date"],
            course_id=event.get("course"),
            grade_weight=event.get("grade_weight"),
        )

    # Trigger conflict detection after Canvas sync (deadline dates may have changed)
    detect_conflicts_user.delay(user_id)

    # Check if this is the first sync (synced_at is NULL) before updating
    db = _get_canvas_supabase()
    integration = (
        db.table("integrations")
        .select("synced_at")
        .eq("user_id", user_id)
        .eq("platform", "canvas")
        .single()
        .execute()
    )
    is_first_sync = integration.data.get("synced_at") is None

    mark_synced(user_id)

    if is_first_sync:
        welcome_briefing.delay(user_id)

    return {
        "user_id": user_id,
        "added": len(diff["added"]),
        "changed": len(diff["changed"]),
        "removed": len(diff["removed"]),
    }


@celery_app.task(name="tasks.backfill_canonical_events")
def backfill_canonical_events():
    """One-shot: fan out backfill per user. Run once on Phase 5 deploy.

    Dispatches backfill_canonical_events_user for each user who has
    Canvas deadlines. Idempotent — safe to re-run.
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    result = client.table("deadlines").select("user_id").execute()
    user_ids = list(set(row["user_id"] for row in result.data))
    for uid in user_ids:
        backfill_canonical_events_user.delay(uid)
    return {"status": "ok", "dispatched": len(user_ids)}


@celery_app.task(name="tasks.backfill_canonical_events_user")
def backfill_canonical_events_user(user_id: str) -> dict:
    """Backfill one user's Canvas deadlines into canonical_events.

    Uses skip_routing=True to prevent spamming users with immediate alerts
    for already-known events.
    """
    from ai.db import _get_supabase
    from priority.ingest import ingest_canonical_event

    client = _get_supabase()
    result = (
        client.table("deadlines")
        .select("title, due_date, course, type, grade_weight")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .execute()
    )
    count = 0
    for d in result.data:
        ingest_canonical_event(
            user_id=user_id,
            source="canvas",
            event_type=d.get("type", "assignment"),
            title=d["title"],
            due_at=d["due_date"],
            course_id=d.get("course"),
            grade_weight=d.get("grade_weight"),
            skip_routing=True,
        )
        count += 1
    return {"user_id": user_id, "backfilled": count}


@celery_app.task(name="tasks.process_inbound_sms", bind=True)
def process_inbound_sms(self, message_sid: str, body: str, user_id: str) -> dict:
    """Process one inbound SMS. Dispatch to command handler or Claude conversational reply.

    Args:
        message_sid: Twilio MessageSid for tracing.
        body: Message body text (raw).
        user_id: UUID of the sender user (looked up by webhook, never a phone number).

    Returns:
        dict with message_sid, command_dispatched, and user_id.
    """
    from sms.commands import dispatch_command
    from sms.send import _get_user_sms_state

    # Look up user's phone for reply (phone is included in _get_user_sms_state select)
    user = _get_user_sms_state(user_id)
    to_phone = user.get("phone", "")

    if not to_phone:
        print(f"[process_inbound_sms] no phone for user — skipping (sid={message_sid})")
        return {"message_sid": message_sid, "command_dispatched": False, "error": "no_phone"}

    command_dispatched = dispatch_command(body, user_id, to_phone)

    if not command_dispatched:
        from ai.replies import handle_reply
        from ai.db import write_outbound_message
        from sms.send import send_sms_safe

        reply_text = handle_reply(user_id, body)
        sent = send_sms_safe(user_id, to_phone, reply_text, is_proactive=False)
        if sent:
            write_outbound_message(user_id, reply_text, "reply")

    return {"message_sid": message_sid, "command_dispatched": command_dispatched}


@celery_app.task(name="tasks.generate_daily_briefings_all")
def generate_daily_briefings_all():
    """Fan-out: dispatch one briefing task per user with Canvas integration.

    Called by Beat every 15 min between 6am-12pm UTC.
    Each per-user task checks if the user's local time is in the 8am window.
    """
    from canvas.db import get_all_canvas_integrations

    integrations = get_all_canvas_integrations()
    for row in integrations:
        generate_daily_briefing_user.delay(row["user_id"])
    return {"status": "ok", "dispatched": len(integrations)}


@celery_app.task(
    name="tasks.generate_daily_briefing_user",
    bind=True,
    autoretry_for=(RateLimitError,),
    retry_backoff=True,
    max_retries=3,
)
def generate_daily_briefing_user(self, user_id: str) -> dict:
    """Generate and send daily briefing for one user.

    Guards:
    1. is_in_briefing_window — skip if user's local time is not 8am hour
    2. briefing_sent_today — skip if briefing or welcome_briefing already sent today
    Then generates briefing, sends via send_sms_safe, and writes to messages table.
    """
    from ai.briefing import generate_briefing, is_in_briefing_window
    from ai.db import get_events_for_briefing, briefing_sent_today, write_outbound_message
    from sms.send import _get_user_sms_state, send_sms_safe
    from zoneinfo import ZoneInfo
    from datetime import datetime

    user = _get_user_sms_state(user_id)
    prefs = user.get("preferences_json") or {}

    # Guard 1: Check briefing window (8am local — aligns with quiet hours end)
    if not is_in_briefing_window(prefs):
        return {"user_id": user_id, "status": "skipped", "reason": "not_in_window"}

    # Guard 2: Check for duplicate
    tz_name = prefs.get("timezone", "America/New_York")
    user_tz = ZoneInfo(tz_name)
    local_date = datetime.now(user_tz).date().isoformat()
    if briefing_sent_today(user_id, local_date):
        return {"user_id": user_id, "status": "skipped", "reason": "already_sent"}

    # Determine if Monday
    is_monday = datetime.now(user_tz).weekday() == 0
    days_ahead = 7 if is_monday else 2

    # Monday: enrich briefing with GCal conflict warnings and study windows (AI-08)
    gcal_context = None
    if is_monday:
        from ai.briefing import get_briefing_gcal_context
        gcal_context = get_briefing_gcal_context(user_id)

    # Fetch deadlines and generate
    deadlines = get_events_for_briefing(user_id, days_ahead=days_ahead)

    # Phase 7: Enrich briefing with syllabus context (exam topics, coverage)
    syllabus_context = None
    from ai.syllabus import get_syllabus_context
    syllabus_context = get_syllabus_context(user_id, deadlines, is_monday=is_monday)

    briefing_text = generate_briefing(
        user_id=user_id,
        deadlines=deadlines,
        is_monday=is_monday,
        user_tz=user_tz,
        gcal_context=gcal_context,
        syllabus_context=syllabus_context,
    )

    # Send via TCPA-compliant path
    to_phone = user.get("phone", "")
    if not to_phone:
        return {"user_id": user_id, "status": "error", "reason": "no_phone"}

    sent = send_sms_safe(user_id, to_phone, briefing_text, is_proactive=True)
    if sent:
        write_outbound_message(user_id, briefing_text, "briefing")

    return {"user_id": user_id, "status": "sent" if sent else "suppressed"}


@celery_app.task(
    name="tasks.welcome_briefing",
    bind=True,
    autoretry_for=(RateLimitError,),
    retry_backoff=True,
    max_retries=3,
)
def welcome_briefing(self, user_id: str) -> dict:
    """Generate and send welcome briefing for a new user.

    Triggered from canvas_sync_user when synced_at was NULL (first sync).
    Sends via send_sms_safe(is_proactive=True) and writes to messages table
    with trigger_type='welcome_briefing'.
    """
    from ai.briefing import generate_briefing
    from ai.db import get_events_for_briefing, write_outbound_message
    from sms.send import _get_user_sms_state, send_sms_safe
    from zoneinfo import ZoneInfo

    user = _get_user_sms_state(user_id)
    to_phone = user.get("phone", "")
    if not to_phone:
        return {"user_id": user_id, "status": "error", "reason": "no_phone"}

    prefs = user.get("preferences_json") or {}
    tz_name = prefs.get("timezone", "America/New_York")
    user_tz = ZoneInfo(tz_name)

    deadlines = get_events_for_briefing(user_id, days_ahead=7)
    briefing_text = generate_briefing(
        user_id=user_id,
        deadlines=deadlines,
        is_welcome=True,
        user_tz=user_tz,
    )

    sent = send_sms_safe(user_id, to_phone, briefing_text, is_proactive=True)
    if sent:
        write_outbound_message(user_id, briefing_text, "welcome_briefing")

    return {"user_id": user_id, "status": "sent" if sent else "suppressed"}


@celery_app.task(name="tasks.gcal_sync_all")
def gcal_sync_all():
    """Fan-out: dispatch gcal_sync_user for every user with Google connected.

    Called by Celery Beat (or manually). Reads all Google integrations and
    dispatches one gcal_sync_user task per user.

    Returns:
        Dict with dispatched count.
    """
    from ai.db import _get_supabase

    client = _get_supabase()
    rows = client.table("integrations").select("user_id").eq("platform", "google").execute().data
    for row in rows:
        gcal_sync_user.delay(row["user_id"])
    return {"dispatched": len(rows)}


@celery_app.task(
    name="tasks.gcal_sync_user",
    bind=True,
    autoretry_for=(Exception,),
    retry_backoff=True,
    max_retries=3,
)
def gcal_sync_user(self, user_id: str) -> dict:
    """Fetch GCal events, store in calendar_events + canonical_events.

    Called on push notification (via webhook) or periodic sync (via gcal_sync_all).
    After storing events, triggers conflict detection for the user.

    Args:
        user_id: UUID of the user whose GCal to sync.

    Returns:
        Dict with user_id and events_synced count.
    """
    from gcal.fetch import fetch_gcal_events
    from gcal.db import store_calendar_events
    from priority.ingest import ingest_canonical_event

    events = fetch_gcal_events(user_id)
    stored = store_calendar_events(user_id, events)

    # Ingest into canonical_events for priority scoring and briefing enrichment
    for e in events:
        ingest_canonical_event(
            user_id=user_id,
            source="gcal",
            event_type=e["type"],
            title=e["title"],
            due_at=e["start_time"],
            course_id=None,
            grade_weight=None,
            skip_routing=False,
        )

    # Trigger conflict detection after sync (stub in Plan 03, implemented in Plan 05)
    detect_conflicts_user.delay(user_id)

    return {"user_id": user_id, "events_synced": stored}


@celery_app.task(name="tasks.detect_conflicts_user")
def detect_conflicts_user(user_id: str) -> dict:
    """Detect Canvas deadline vs GCal event conflicts for a user.

    Finds deadlines and GCal events on the same calendar day, fires deduped
    conflict alerts via the SMS batch queue. Implemented in Plan 05.

    Args:
        user_id: UUID of the user.

    Returns:
        Dict with user_id and new_conflicts count.
    """
    from gcal.conflicts import detect_conflicts_user as _detect
    conflicts = _detect(user_id)
    return {"user_id": user_id, "new_conflicts": len(conflicts)}


@celery_app.task(name="tasks.renew_watch_channels")
def renew_watch_channels() -> dict:
    """Check all Google integrations for expiring watch channels and renew them.

    Run every 6 hours via Celery Beat. Renews any channel expiring within
    the next 48 hours (2x the Beat interval for safety margin).

    Returns:
        Dict with checked count and renewed count.
    """
    from ai.db import _get_supabase
    from datetime import datetime, timezone, timedelta

    client = _get_supabase()
    cutoff = (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat()
    rows = (
        client.table("integrations")
        .select("user_id, channel_id, watch_expires_at")
        .eq("platform", "google")
        .not_.is_("channel_id", "null")
        .lte("watch_expires_at", cutoff)
        .execute()
    ).data

    renewed = 0
    for row in rows:
        try:
            from gcal.watch import renew_watch
            renew_watch(row["user_id"])
            renewed += 1
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(
                "Watch renewal failed for user %s: %s", row["user_id"], e
            )

    # Also renew Gmail watches for users with history_id set (indicates Gmail is active)
    gmail_rows = (
        client.table("integrations")
        .select("user_id, history_id, watch_expires_at")
        .eq("platform", "google")
        .not_.is_("history_id", "null")
        .lte("watch_expires_at", cutoff)
        .execute()
    ).data

    for row in gmail_rows:
        try:
            from gmail.watch import renew_gmail_watch
            renew_gmail_watch(row["user_id"])
            renewed += 1
        except Exception as e:
            import logging
            logging.getLogger(__name__).error(
                "Gmail watch renewal failed for %s: %s", row["user_id"], e
            )

    return {"checked": len(rows), "renewed": renewed}


@celery_app.task(name="tasks.gmail_process_notification")
def gmail_process_notification(user_id: str, new_history_id: str) -> dict:
    """Process a Gmail push notification: fetch new messages, classify, alert.

    Called when /api/gmail/webhook receives a Pub/Sub push notification.
    Fetches messages since last historyId, classifies with Claude Haiku,
    cross-references Canvas deadlines, and fires contradiction alerts.

    Args:
        user_id: UUID of the user whose Gmail notification to process.
        new_history_id: The new historyId from the Pub/Sub message.

    Returns:
        Dict with user_id, processed count, and alerts_fired count.
    """
    from gmail.fetch import fetch_new_messages, get_stored_history_id, update_history_id
    from gmail.classify import classify_email, find_matching_deadline
    from ai.db import _get_supabase
    from sms.batch import enqueue_alert

    stored_history_id = get_stored_history_id(user_id)
    if not stored_history_id:
        # No cursor yet — store new historyId and wait for next notification
        update_history_id(user_id, new_history_id)
        return {"user_id": user_id, "status": "initialized_history_id"}

    messages = fetch_new_messages(user_id, stored_history_id)
    # Advance cursor to new historyId after fetching
    update_history_id(user_id, new_history_id)

    if not messages:
        return {"user_id": user_id, "processed": 0}

    # Get user's Canvas deadlines for cross-reference (GMAI-05)
    client = _get_supabase()
    deadlines = (
        client.table("deadlines")
        .select("id, title, due_date, course")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .execute()
    ).data

    processed = 0
    alerts_fired = 0
    for msg in messages:
        classification = classify_email(msg["subject"], msg["snippet"])

        # Store in gmail_flags table (metadata only — NEVER full body)
        client.table("gmail_flags").insert({
            "user_id": user_id,
            "subject": msg["subject"],
            "sender": msg["sender"],
            "summary": msg["snippet"][:200],  # truncate snippet
            "confidence": classification.get("confidence", 0.0),
        }).execute()

        # Check alert threshold: confidence >= 0.8 AND is_deadline_change (GMAI-04)
        if classification.get("is_deadline_change") and classification.get("confidence", 0) >= 0.8:
            # Cross-reference against Canvas deadlines (GMAI-05)
            matched = find_matching_deadline(msg["subject"], deadlines)

            if matched:
                # ALRT-02: Contradiction alert — email signals change vs Canvas state
                body = (
                    f"Your professor emailed that {matched['title']} "
                    f"may have changed, but Canvas still shows due "
                    f"{matched['due_date'][:10]}. "
                    f"Email subject: \"{msg['subject'][:60]}\". Heads up!"
                )

                # Ingest as gmail source event for priority scoring
                from priority.ingest import ingest_canonical_event
                ingest_canonical_event(
                    user_id=user_id,
                    source="gmail",
                    event_type="deadline_change",
                    title=f"Email: {msg['subject'][:80]}",
                    due_at=matched["due_date"],
                    course_id=matched.get("course"),
                    grade_weight=None,
                    skip_routing=False,
                )
            else:
                # No Canvas match — still alert about potential deadline change
                body = (
                    f"A .edu email may signal a deadline change: "
                    f"\"{msg['subject'][:60]}\". "
                    f"Check your course announcements."
                )

            # Route through SMS batching queue (SMS-10/SMS-11)
            is_first = enqueue_alert(user_id, body, priority_score=85)
            if is_first:
                flush_sms_batch.apply_async(args=[user_id], countdown=600)
            alerts_fired += 1

        processed += 1

    return {"user_id": user_id, "processed": processed, "alerts_fired": alerts_fired}


@celery_app.task(name="tasks.gmail_establish_watch")
def gmail_establish_watch_task(user_id: str) -> dict:
    """Establish Gmail watch channel for a user. Called on OAuth callback.

    Args:
        user_id: UUID of the user to establish Gmail watch for.

    Returns:
        Dict with user_id and watch success flag.
    """
    from gmail.watch import establish_gmail_watch
    result = establish_gmail_watch(user_id)
    return {"user_id": user_id, "watch": bool(result)}


@celery_app.task(name="tasks.encrypt_and_store_tokens", priority=9)
def encrypt_and_store_tokens(user_id: str, access_token: str, refresh_token: str) -> dict:
    """Encrypt Google OAuth tokens and store in Supabase. Then trigger downstream setup.

    Called immediately from the OAuth callback route. Tokens arrive as plaintext
    args (from Next.js process memory / Redis transient queue) and are encrypted
    via Fernet before ANY Supabase write. Tokens are NEVER at rest unencrypted.

    After storing tokens:
    1. Sends confirmation SMS to user.
    2. On first Google connect (no study_preference set), asks study preference question.
    3. Dispatches gcal_sync_user and gmail_establish_watch_task (Plans 03/04 stubs).

    Args:
        user_id: UUID of the user.
        access_token: Plaintext Google OAuth access token.
        refresh_token: Plaintext Google OAuth refresh token.

    Returns:
        Dict with user_id, stored=True, and study_pref_asked flag.
    """
    from google_auth.tokens import store_google_tokens
    from sms.send import send_sms_safe, _get_user_sms_state
    from ai.db import _get_supabase

    # Step 1: Encrypt and store tokens (NEVER plaintext in DB)
    store_google_tokens(user_id, access_token, refresh_token)

    # Step 2: Send Google-connected confirmation SMS
    user_state = _get_user_sms_state(user_id)
    to_phone = user_state.get("phone", "") if user_state else ""

    if to_phone:
        send_sms_safe(
            user_id,
            to_phone,
            "Google connected! I'll now include your calendar and watch for deadline emails.",
            is_proactive=True,
        )

    # Step 3: Check if this is first Google connect (no study_preference set yet)
    client = _get_supabase()
    user_row = (
        client.table("users")
        .select("preferences_json")
        .eq("id", user_id)
        .execute()
        .data
    )
    prefs = (user_row[0].get("preferences_json") or {}) if user_row else {}
    study_pref_asked = False

    if not prefs.get("study_preference") and to_phone:
        send_sms_safe(
            user_id,
            to_phone,
            "Quick question: when do you prefer to study -- mornings, afternoons, or evenings? "
            "Just reply with one!",
            is_proactive=True,
        )
        study_pref_asked = True

    # Step 4: Dispatch downstream tasks (GCal backfill + Gmail watch)
    # These tasks are defined in Plans 03/04; they will be no-ops if not yet registered.
    try:
        gcal_sync_user.delay(user_id)  # type: ignore[union-attr]
    except Exception:
        pass  # Task not registered yet (Plan 03)
    try:
        gmail_establish_watch_task.delay(user_id)  # type: ignore[union-attr]
    except Exception:
        pass  # Task not registered yet (Plan 04)

    return {"user_id": user_id, "stored": True, "study_pref_asked": study_pref_asked}
