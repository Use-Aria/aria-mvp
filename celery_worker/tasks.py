import requests
from celery_app import celery_app
from datetime import datetime, timezone


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
    """
    from canvas.fetch import fetch_ical
    from canvas.parse import parse_vevents
    from canvas.diff import compute_diff
    from canvas.db import load_current_deadlines, apply_diff, mark_synced

    raw = fetch_ical(ical_url)
    events = parse_vevents(raw)
    current = load_current_deadlines(user_id)
    diff = compute_diff(current, events)
    apply_diff(user_id, diff)
    mark_synced(user_id)
    return {
        "user_id": user_id,
        "added": len(diff["added"]),
        "changed": len(diff["changed"]),
        "removed": len(diff["removed"]),
    }


@celery_app.task(name="tasks.process_inbound_sms", bind=True)
def process_inbound_sms(self, message_sid: str, body: str, user_id: str) -> dict:
    """Process one inbound SMS. Dispatch to command handler or stub Claude reply (Phase 4).

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
        # Phase 4: route to Claude conversational handler
        # Stub: log and skip — no phone number or body in log
        print(f"[process_inbound_sms] non-command message — Phase 4 stub (sid={message_sid})")

    return {"message_sid": message_sid, "command_dispatched": command_dispatched}
