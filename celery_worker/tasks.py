import requests
from celery_app import celery_app
from datetime import datetime, timezone

from anthropic import RateLimitError


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
    from ai.db import get_deadlines_for_briefing, briefing_sent_today, write_outbound_message
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

    # Fetch deadlines and generate
    deadlines = get_deadlines_for_briefing(user_id, days_ahead=days_ahead)
    briefing_text = generate_briefing(
        user_id=user_id,
        deadlines=deadlines,
        is_monday=is_monday,
        user_tz=user_tz,
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
    from ai.db import get_deadlines_for_briefing, write_outbound_message
    from sms.send import _get_user_sms_state, send_sms_safe
    from zoneinfo import ZoneInfo

    user = _get_user_sms_state(user_id)
    to_phone = user.get("phone", "")
    if not to_phone:
        return {"user_id": user_id, "status": "error", "reason": "no_phone"}

    prefs = user.get("preferences_json") or {}
    tz_name = prefs.get("timezone", "America/New_York")
    user_tz = ZoneInfo(tz_name)

    deadlines = get_deadlines_for_briefing(user_id, days_ahead=7)
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
