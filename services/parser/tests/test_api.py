"""HTTP surface: auth, limits, no-echo errors, and the golden contract responses for task 3.5."""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any

import pytest
from conftest import FIXTURES, SECRET, extraction, make_settings, request_dict, signed_headers, signed_post, with_weights
from fakes import FakeAnthropic, message_json
from pdf_factory import make_blank_pdf, make_encrypted_pdf, make_pdf

from app.auth import sign
from app.main import PARSE_PATH, create_app

pytestmark = pytest.mark.anyio

SONNET = "claude-sonnet-5-5"
OPUS = "claude-opus-5-5"
SENTINEL = "ZQX-ECHO-SENTINEL-4417"


def error_of(resp: Any) -> dict[str, Any]:
    body = resp.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "retryable"}
    return body["error"]


def check_golden(name: str, body: dict[str, Any]) -> None:
    path = FIXTURES / name
    if os.environ.get("UPDATE_GOLDEN") == "1":
        path.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n")
    assert json.loads(path.read_text()) == body, f"{name} drifted; rerun with UPDATE_GOLDEN=1 if intended"


async def test_healthz_needs_no_auth(make_client: Any) -> None:
    resp = await make_client(FakeAnthropic([])).get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "version": "2026.10.1"}


async def test_unsigned_post_is_401(make_client: Any) -> None:
    resp = await make_client(FakeAnthropic([])).post(PARSE_PATH, json={})
    assert resp.status_code == 401
    assert error_of(resp) == {"code": "bad_signature", "message": "unauthorized", "retryable": False}


async def test_stale_and_replayed_requests_are_401(make_client: Any, synthetic_pdf: bytes) -> None:
    client = make_client(FakeAnthropic([message_json(extraction(), model=SONNET)]))
    resp = await signed_post(client, request_dict(synthetic_pdf), ts=int(time.time()) - 301)
    assert error_of(resp)["code"] == "stale_timestamp"

    body = json.dumps(request_dict(synthetic_pdf)).encode()
    headers = signed_headers(body)
    assert (await client.post(PARSE_PATH, content=body, headers=headers)).status_code == 200
    resp = await client.post(PARSE_PATH, content=body, headers=headers)
    assert resp.status_code == 401 and error_of(resp)["code"] == "replay"


async def _asgi_call(app: Any, headers: list[tuple[bytes, bytes]], chunks: list[bytes] | None) -> tuple[int, bytes]:
    sent: list[dict[str, Any]] = []
    reads = 0

    async def receive() -> dict[str, Any]:
        nonlocal reads
        if chunks is None:
            raise AssertionError("body must not be read")
        i = reads
        reads += 1
        return {"type": "http.request", "body": chunks[i], "more_body": i < len(chunks) - 1}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": PARSE_PATH,
        "raw_path": PARSE_PATH.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("parser.test", 80),
    }
    await app(scope, receive, send)
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body


async def test_oversized_content_length_is_413_before_reading() -> None:
    app = create_app(make_settings(), None)
    status, body = await _asgi_call(app, [(b"content-length", b"31457280"), (b"content-type", b"application/json")], None)
    assert status == 413
    assert json.loads(body)["error"]["code"] == "too_large"


async def test_streamed_body_over_limit_is_413() -> None:
    settings = make_settings(max_pdf_bytes=1024)
    app = create_app(settings, None)
    chunk = b"x" * 40_000
    status, body = await _asgi_call(app, [(b"content-type", b"application/json")], [chunk, chunk, chunk])
    assert status == 413
    assert json.loads(body)["error"]["code"] == "too_large"


async def test_bad_base64_is_400(make_client: Any, synthetic_pdf: bytes) -> None:
    resp = await signed_post(make_client(FakeAnthropic([])), request_dict(synthetic_pdf, pdf_base64="!!!not base64!!!"))
    assert resp.status_code == 400 and error_of(resp)["code"] == "invalid_base64"


async def test_contract_errors_never_echo_input(make_client: Any) -> None:
    client = make_client(FakeAnthropic([]))
    payload = request_dict(make_pdf([[SENTINEL]]), today="not-a-date", sneaky=SENTINEL, course_hint=SENTINEL * 10)
    payload["pdf_base64"] = base64.b64encode(SENTINEL.encode() * 20).decode()
    resp = await signed_post(client, payload)
    assert resp.status_code == 400
    err = error_of(resp)
    assert err["code"] == "invalid_json"
    raw_b64 = payload["pdf_base64"]
    assert SENTINEL not in resp.text and raw_b64[:40] not in resp.text

    resp = await signed_post(client, b'{"pdf_base64": "' + SENTINEL.encode() + b'", broken')
    assert resp.status_code == 400 and SENTINEL not in resp.text


async def test_not_a_pdf_and_decoded_too_large(make_client: Any) -> None:
    client = make_client(FakeAnthropic([]), settings=make_settings(max_pdf_bytes=2048))
    resp = await signed_post(client, request_dict(b"hello, not a pdf"))
    assert resp.status_code == 400 and error_of(resp)["code"] == "invalid_pdf"
    resp = await signed_post(client, request_dict(b"%PDF-1.4\n" + b"0" * 3000))
    assert resp.status_code == 413 and error_of(resp)["code"] == "too_large"


async def test_encrypted_and_too_many_pages(make_client: Any) -> None:
    client = make_client(FakeAnthropic([]))
    resp = await signed_post(client, request_dict(make_encrypted_pdf()))
    assert resp.status_code == 400 and error_of(resp)["code"] == "encrypted_pdf"
    resp = await signed_post(client, request_dict(make_blank_pdf(301)))
    assert resp.status_code == 422 and error_of(resp)["code"] == "too_many_pages"


async def test_upstream_failure_is_502_retryable(make_client: Any, synthetic_pdf: bytes) -> None:
    client = make_client(FakeAnthropic([529, 529]))
    resp = await signed_post(client, request_dict(synthetic_pdf))
    assert resp.status_code == 502
    assert error_of(resp) == {"code": "upstream_llm", "message": "the model API failed on every attempt", "retryable": True}


async def test_unknown_route_shape(make_client: Any) -> None:
    resp = await make_client(FakeAnthropic([])).get("/nope")
    assert resp.status_code == 404 and error_of(resp)["code"] == "not_found"


async def test_fake_llm_app_without_client(make_client: Any, synthetic_pdf: bytes) -> None:
    client = make_client(None, settings=make_settings(fake_llm=True, anthropic_api_key=""))
    resp = await signed_post(client, request_dict(synthetic_pdf))
    assert resp.status_code == 200 and resp.json()["attempts"][0]["model"] == "fake-llm"


# --- golden contract responses (consumed by the TS zod schema in task 3.5) ----------------


async def test_golden_ok(make_client: Any, synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic(
        [message_json(extraction(), model=SONNET, usage={"input_tokens": 7412, "output_tokens": 2310, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0})]
    )
    req = request_dict(
        synthetic_pdf,
        course_hint="hist 101",
        term={"name": "Fall 2026", "start": "2026-08-26", "end": "2026-12-18"},
        known_courses=[{"key": "HIST101", "label": "HIST 101 The Ancient World"}],
    )
    resp = await signed_post(make_client(fake), req)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok" and body["issues"] == []
    check_golden("response_ok.json", body)


async def test_golden_needs_review(make_client: Any, synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic(
        [
            message_json(with_weights(50, 35), model=SONNET, usage={"input_tokens": 7412, "output_tokens": 2104}),
            message_json(with_weights(50, 35, None), model=OPUS, usage={"input_tokens": 7530, "output_tokens": 3880}),
        ]
    )
    resp = await signed_post(make_client(fake), request_dict(synthetic_pdf, course_hint="orgo"))
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "needs_review" and body["chosen_attempt"] == 1
    assert {i["code"] for i in body["issues"]} == {"weights_sum", "course_mismatch"}
    check_golden("response_needs_review.json", body)


async def test_golden_not_syllabus(make_client: Any) -> None:
    pdf = make_pdf([["Problem Set 3", "Due Friday. Show your work."]])
    fake = FakeAnthropic(
        [message_json(extraction(document_kind="assignment"), model=SONNET, usage={"input_tokens": 2051, "output_tokens": 340})]
    )
    resp = await signed_post(make_client(fake), request_dict(pdf, filename=None))
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "not_syllabus" and body["syllabus"] is None
    check_golden("response_not_syllabus.json", body)


def test_error_golden_examples() -> None:
    """Static error bodies for the TS client tests (one per contract status)."""
    doc = {
        "description": "Parser contract v1 error bodies by HTTP status (V2-08 §8.1).",
        "errors": {
            "400": {"error": {"code": "invalid_pdf", "message": "the PDF could not be read", "retryable": False}},
            "401": {"error": {"code": "bad_signature", "message": "unauthorized", "retryable": False}},
            "413": {"error": {"code": "too_large", "message": "request body too large", "retryable": False}},
            "422": {"error": {"code": "too_many_pages", "message": "the PDF has more than 300 pages", "retryable": False}},
            "502": {"error": {"code": "upstream_llm", "message": "the model API failed on every attempt", "retryable": True}},
            "503": {"error": {"code": "overloaded", "message": "the model did not answer within the deadline", "retryable": True}},
        },
    }
    check_golden("response_errors.json", doc)


def test_signature_helper_matches_server() -> None:
    body = b"{}"
    ts = 1_791_600_000
    assert signed_headers(body, ts=ts)["x-aria-signature"] == "v1=" + sign(SECRET, ts, "POST", PARSE_PATH, body)
