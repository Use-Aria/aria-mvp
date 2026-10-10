"""Fake Messages API at the HTTP transport (httpx2.MockTransport), so the real SDK code path runs.

respx / pytest-httpx don't see the SDK's httpx2 traffic, hence a transport-level fake.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

import httpx2
from anthropic import AsyncAnthropic, DefaultAsyncHttpxClient

Response = dict[str, Any] | int | Exception | Callable[[], Any]


def message_json(
    payload: dict[str, Any] | None,
    *,
    model: str,
    stop_reason: str = "end_turn",
    usage: dict[str, int] | None = None,
    raw_text: str | None = None,
) -> dict[str, Any]:
    """A Messages API 200 body. `payload` becomes the JSON text block; `raw_text` overrides it."""
    content: list[dict[str, Any]] = [{"type": "thinking", "thinking": "", "signature": "sig"}]
    text = raw_text if raw_text is not None else (json.dumps(payload) if payload is not None else None)
    if text is not None:
        content.append({"type": "text", "text": text})
    body: dict[str, Any] = {
        "id": "msg_fake",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": usage or {"input_tokens": 1000, "output_tokens": 500, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
    }
    if stop_reason == "refusal":
        body["content"] = []
        body["stop_details"] = {"type": "refusal", "category": "bio", "explanation": None}
    return body


class FakeAnthropic:
    """Serves queued responses in order and records every request body.

    Each queued item is a 200 JSON body (dict), an HTTP status (int → error body), an
    exception to raise from the transport (e.g. httpx2.ReadTimeout), or a zero-arg callable
    returning one of those (runs at request time, e.g. to advance a fake clock).
    """

    def __init__(self, responses: Sequence[Response]) -> None:
        self._queue = list(responses)
        self.requests: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []
        self.transport = httpx2.MockTransport(self._handle)

    def _handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(json.loads(request.content or b"{}"))
        self.headers.append(dict(request.headers))
        if not self._queue:
            raise AssertionError("FakeAnthropic: unexpected extra request")
        item = self._queue.pop(0)
        if callable(item):
            item = item()
        if isinstance(item, Exception):
            raise item
        if isinstance(item, int):
            err_type = {529: "overloaded_error", 429: "rate_limit_error", 400: "invalid_request_error"}.get(item, "api_error")
            return httpx2.Response(
                item,
                json={"type": "error", "error": {"type": err_type, "message": "fake"}},
                headers={"retry-after-ms": "1", "request-id": "req_fake"},
            )
        return httpx2.Response(200, json=item, headers={"request-id": "req_fake"})

    @property
    def remaining(self) -> int:
        return len(self._queue)


def client_for(fake: FakeAnthropic, max_retries: int = 0) -> AsyncAnthropic:
    """An AsyncAnthropic whose HTTP layer is the fake transport."""
    return AsyncAnthropic(
        api_key="sk-test",
        max_retries=max_retries,
        http_client=DefaultAsyncHttpxClient(transport=fake.transport),
    )
