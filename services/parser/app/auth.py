"""HMAC request signing (V2-08 §2.13).

Canonical string: ``v1\\n{unix_ts}\\n{METHOD}\\n{path}\\n{hex(sha256(body))}``.
Signature header: ``x-aria-signature: v1=<hex(HMAC_SHA256(secret, canonical))>``.
The secret is used as its UTF-8 bytes (no base64 decoding), on both sides.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import threading
from collections import OrderedDict
from collections.abc import Mapping, Sequence

TIMESTAMP_HEADER = "x-aria-timestamp"
SIGNATURE_HEADER = "x-aria-signature"
REQUEST_ID_HEADER = "x-aria-request-id"

_SIG_RE = re.compile(r"^v1=([0-9a-f]{64})$")
_TS_RE = re.compile(r"^[0-9]{1,12}$")


class AuthError(Exception):
    """Authentication failed. `code` is one of bad_signature, stale_timestamp, replay."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def canonical(ts: int, method: str, path: str, body: bytes) -> bytes:
    """Bytes that get signed for one request."""
    digest = hashlib.sha256(body).hexdigest()
    return f"v1\n{ts}\n{method.upper()}\n{path}\n{digest}".encode()


def sign(secret: str, ts: int, method: str, path: str, body: bytes) -> str:
    """Lowercase hex HMAC-SHA256 of `canonical(...)` (without the ``v1=`` prefix)."""
    return hmac.new(secret.encode(), canonical(ts, method, path, body), hashlib.sha256).hexdigest()


class ReplayCache:
    """Per-instance LRU of accepted signatures, each remembered for `ttl_s` seconds.

    Keyed by the signature (which covers timestamp, path and body), not by the request id,
    because the request id is not signed and could be changed by whoever replays a request.
    A legitimate retry re-signs with a fresh timestamp, so it never collides.
    """

    def __init__(self, ttl_s: int = 600, max_items: int = 10_000) -> None:
        self._ttl = ttl_s
        self._max = max_items
        self._items: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    def check_and_add(self, key: str, now: float) -> bool:
        """Record `key`. Returns False when it was already seen inside the TTL."""
        with self._lock:
            while self._items:
                oldest_key, seen_at = next(iter(self._items.items()))
                if now - seen_at <= self._ttl and len(self._items) < self._max:
                    break
                del self._items[oldest_key]
            if key in self._items:
                return False
            self._items[key] = now
            return True


def verify(
    headers: Mapping[str, str],
    method: str,
    path: str,
    body: bytes,
    secrets: Sequence[str],
    now: float,
    replay: ReplayCache,
    skew_s: int,
) -> None:
    """Check timestamp window, signature (current or previous secret) and replay.

    Raises:
        AuthError: `bad_signature`, `stale_timestamp` or `replay`.
    """
    ts_raw = (headers.get(TIMESTAMP_HEADER) or "").strip()
    sig_raw = (headers.get(SIGNATURE_HEADER) or "").strip().lower()
    if not _TS_RE.match(ts_raw):
        raise AuthError("bad_signature")
    match = _SIG_RE.match(sig_raw)
    if match is None:
        raise AuthError("bad_signature")
    ts = int(ts_raw)
    if abs(now - ts) > skew_s:
        raise AuthError("stale_timestamp")

    given = match.group(1).encode()
    ok = False
    for secret in secrets:
        expected = sign(secret, ts, method, path, body).encode()
        # Evaluate every secret (no early exit) so timing doesn't reveal which one matched.
        ok = hmac.compare_digest(expected, given) or ok
    if not ok:
        raise AuthError("bad_signature")
    if not replay.check_and_add(match.group(1), now):
        raise AuthError("replay")
