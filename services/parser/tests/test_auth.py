from __future__ import annotations

import json
import os

import pytest
from conftest import FIXTURES, PREVIOUS_SECRET, SECRET

from app.auth import AuthError, ReplayCache, canonical, sign, verify

PATH = "/v1/parse-syllabus"
NOW = 1_791_600_000
BODY = b'{"hello":"world"}'


def headers(body: bytes = BODY, *, secret: str = SECRET, ts: int = NOW, path: str = PATH) -> dict[str, str]:
    return {"x-aria-timestamp": str(ts), "x-aria-signature": "v1=" + sign(secret, ts, "POST", path, body)}


def check(h: dict[str, str], body: bytes = BODY, *, now: float = NOW, replay: ReplayCache | None = None) -> None:
    verify(h, "POST", PATH, body, (SECRET, PREVIOUS_SECRET), now, replay or ReplayCache(), 300)


def code_of(h: dict[str, str], body: bytes = BODY, **kw: object) -> str:
    with pytest.raises(AuthError) as exc:
        check(h, body, **kw)  # type: ignore[arg-type]
    return exc.value.code


def test_valid_signature_passes() -> None:
    check(headers())


def test_canonical_layout() -> None:
    c = canonical(NOW, "post", PATH, b"")
    assert c == (
        f"v1\n{NOW}\nPOST\n{PATH}\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".encode()
    )


def test_wrong_secret() -> None:
    assert code_of(headers(secret="x" * 40)) == "bad_signature"


def test_tampered_body() -> None:
    assert code_of(headers(), b'{"hello":"world!"}') == "bad_signature"


def test_tampered_path() -> None:
    assert code_of(headers(path="/v1/other")) == "bad_signature"


@pytest.mark.parametrize("delta", [301, -301, 10_000])
def test_stale_timestamp(delta: int) -> None:
    assert code_of(headers(ts=NOW + delta)) == "stale_timestamp"


@pytest.mark.parametrize("delta", [299, -299])
def test_inside_window(delta: int) -> None:
    check(headers(ts=NOW + delta))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda h: {**h, "x-aria-signature": h["x-aria-signature"].removeprefix("v1=")},
        lambda h: {**h, "x-aria-signature": "v2=" + h["x-aria-signature"][3:]},
        lambda h: {**h, "x-aria-signature": "v1=zz" + h["x-aria-signature"][5:]},
        lambda h: {**h, "x-aria-signature": h["x-aria-signature"][:-2]},
        lambda h: {**h, "x-aria-timestamp": "12.5"},
        lambda h: {**h, "x-aria-timestamp": ""},
        lambda h: {"x-aria-timestamp": h["x-aria-timestamp"]},
        lambda h: {},
    ],
)
def test_malformed_headers(mutate: object) -> None:
    assert code_of(mutate(headers())) == "bad_signature"  # type: ignore[operator]


def test_replay_rejected() -> None:
    cache = ReplayCache()
    h = headers()
    check(h, replay=cache)
    assert code_of(h, replay=cache) == "replay"


def test_resigned_retry_is_not_a_replay() -> None:
    cache = ReplayCache()
    check(headers(ts=NOW), replay=cache)
    check(headers(ts=NOW + 1), now=NOW + 1, replay=cache)


def test_previous_secret_accepted() -> None:
    check(headers(secret=PREVIOUS_SECRET))


def test_replay_cache_expires_and_caps() -> None:
    cache = ReplayCache(ttl_s=10, max_items=2)
    assert cache.check_and_add("a", 0)
    assert not cache.check_and_add("a", 5)
    assert cache.check_and_add("a", 11)  # expired
    assert cache.check_and_add("b", 12)
    assert cache.check_and_add("c", 12)  # evicts oldest to stay at max_items
    assert cache.check_and_add("a", 12)


def _vectors() -> list[dict[str, object]]:
    cases = [
        ("test-secret-0123456789abcdef0123456789", 1_791_600_000, "POST", PATH, ""),
        ("test-secret-0123456789abcdef0123456789", 1_791_600_000, "POST", PATH, '{"pdf_base64":"JVBERi0x","today":"2026-10-10"}'),
        ("aW1hZ2luZS1hLWJhc2U2NC1zZWNyZXQtb2YtNDgtYnl0ZXMhIQ==", 1_791_600_123, "POST", PATH, '{"a":"ünïcödé ✓"}'),
    ]
    out: list[dict[str, object]] = []
    for secret, ts, method, path, body in cases:
        raw = body.encode()
        out.append(
            {
                "secret": secret,
                "timestamp": ts,
                "method": method,
                "path": path,
                "body": body,
                "canonical": canonical(ts, method, path, raw).decode(),
                "signature": "v1=" + sign(secret, ts, method, path, raw),
            }
        )
    return out


def test_signing_vectors_round_trip() -> None:
    path = FIXTURES / "signing_vectors.json"
    doc = {
        "description": (
            "Cross-language HMAC vectors for parser contract v1. Python: services/parser/app/auth.py. "
            "TS: src/server/integrations/syllabus/signing.ts. The secret is used as UTF-8 bytes; "
            "body is the exact UTF-8 request body; signature header value is 'v1=<hex>'."
        ),
        "version": 1,
        "vectors": _vectors(),
    }
    if os.environ.get("UPDATE_GOLDEN") == "1":
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    stored = json.loads(path.read_text())
    assert stored == doc
    for v in stored["vectors"]:
        verify(
            {"x-aria-timestamp": str(v["timestamp"]), "x-aria-signature": v["signature"]},
            v["method"],
            v["path"],
            v["body"].encode(),
            (v["secret"],),
            v["timestamp"],
            ReplayCache(),
            300,
        )
