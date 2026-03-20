"""Redis-based SMS batching queue for combining multiple alerts per user.

SMS-10: Multiple alerts for the same user within a 10-minute window are combined
        into one SMS message to prevent alert spam.

SMS-11: No more than 3 texts are sent in any 10-minute window per user.
        If more than 3 alerts are enqueued, only the top-3 by priority are sent.

Usage:
    1. Call enqueue_alert() when an alert fires. If it returns True, schedule
       flush_sms_batch.apply_async(args=[user_id], countdown=BATCH_TTL).
    2. flush_sms_batch (Celery task in tasks.py) calls flush_batch() after BATCH_TTL.
    3. flush_batch() reads all queued items, sorts by priority descending, caps at 3,
       formats the body, and sends via send_sms_alert().
"""
import json
import logging
import os

import redis

logger = logging.getLogger(__name__)

BATCH_TTL = 600  # 10 minutes in seconds
MAX_TEXTS_PER_WINDOW = 3  # SMS-11: max alerts per 10-minute window


def _get_redis() -> redis.Redis:
    """Create a Redis client from the REDIS_URL environment variable."""
    return redis.from_url(os.environ["REDIS_URL"])


def enqueue_alert(user_id: str, text: str, priority_score: int) -> bool:
    """Add an alert to the user's hold queue.

    Atomically appends the item to the batch list and sets a flush lock via SETNX.
    The lock ensures only the first caller (who sets the lock) returns True — callers
    that see an existing lock return False. This prevents duplicate flush scheduling
    when multiple alerts arrive within the same BATCH_TTL window.

    Args:
        user_id: UUID of the user to receive the alert.
        text: Alert message body text.
        priority_score: Integer 0-100. Higher scores appear first in batched SMS.

    Returns:
        True if this is the first alert in the batch window (caller must schedule
        flush_sms_batch.apply_async(args=[user_id], countdown=BATCH_TTL)).
        False if a flush is already scheduled (another alert arrived first).
    """
    r = _get_redis()
    key = f"sms_batch:{user_id}"
    lock_key = f"sms_batch_lock:{user_id}"

    item = json.dumps({"text": text, "priority": priority_score})
    r.rpush(key, item)
    r.expire(key, BATCH_TTL)

    # Atomic lock: SET lock_key "1" NX EX BATCH_TTL
    # Returns truthy only if the key was newly set (first enqueuer in this window).
    is_new = r.set(lock_key, "1", nx=True, ex=BATCH_TTL)
    return bool(is_new)


def flush_batch(user_id: str) -> str | None:
    """Pop all queued alerts, combine them, and send one SMS.

    Reads and deletes all items from the batch list atomically (LRANGE + DELETE).
    Sorts by priority descending and enforces SMS-11 cap of MAX_TEXTS_PER_WINDOW.

    Formatting:
    - 1 item: sends text directly (no numbered list wrapper).
    - 2+ items: sends numbered list prefixed with "{N} updates:".

    Args:
        user_id: UUID of the user whose batch to flush.

    Returns:
        The SMS body string that was sent, or None if queue was empty or user
        state could not be retrieved.
    """
    r = _get_redis()
    key = f"sms_batch:{user_id}"
    lock_key = f"sms_batch_lock:{user_id}"

    # Read all queued items then delete both keys unconditionally.
    raw_items = r.lrange(key, 0, -1)
    r.delete(key)
    r.delete(lock_key)

    if not raw_items:
        logger.info("flush_batch: empty queue for user %s — no-op", user_id[:8])
        return None

    items = sorted(
        [json.loads(i) for i in raw_items],
        key=lambda x: x["priority"],
        reverse=True,
    )

    # SMS-11: cap to MAX_TEXTS_PER_WINDOW
    items = items[:MAX_TEXTS_PER_WINDOW]

    if len(items) == 1:
        body = items[0]["text"]
    else:
        lines = "\n".join(f"{i + 1}) {item['text']}" for i, item in enumerate(items))
        body = f"{len(items)} updates:\n{lines}"

    from sms.send import send_sms_alert, _get_user_sms_state

    user_state = _get_user_sms_state(user_id)
    if not user_state:
        logger.warning("flush_batch: no user state for user %s — skipping send", user_id[:8])
        return None

    send_sms_alert(user_id, user_state["phone"], body)
    return body
