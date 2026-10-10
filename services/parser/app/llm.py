"""One extraction attempt against the Messages API, with a typed outcome and usage.

SDK notes (anthropic==1.8.0, verified 2026-10-10 for V2-08 §2.4 [verify] items):
- `messages.parse(output_format=Model, output_config={"effort": ...})` merges cleanly: the SDK
  builds `output_config = {**output_config, "format": <transformed schema>}`. No fallback to a
  hand-built `messages.create` schema is needed.
- `beta.messages.parse` accepts `fallbacks="default"` (beta `server-side-fallback-2026-07-01`).
  It is opt-in here (`PARSER_SERVER_FALLBACKS=1`): refusals already escalate to Opus 5.5 in
  `pipeline.py`, and a server-side fallback would bill under a model id the TS pricing table may
  not know. When enabled, the attempt reports the model that actually served the response.
- We call `client.beta.messages.with_raw_response.parse(...)` so usage and `stop_reason` are read
  from the raw body before the SDK validates the JSON; a schema failure therefore still reports
  its token usage. Only the beta namespace exposes `with_raw_response.parse` in 1.8.0; without
  `betas` it sends the same request as `client.messages.parse` (no beta header).
- No `temperature`/`top_p` (400 on these models). Thinking is adaptive; depth is set by effort.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

import pydantic
from anthropic import APIConnectionError, APIStatusError, APITimeoutError, AsyncAnthropic

from app.models import AttemptOutcome, LlmAttempt, SyllabusExtraction

SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _usage(body: dict[str, Any]) -> tuple[int, int, int, int]:
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
    assert isinstance(usage, dict)

    def n(key: str) -> int:
        value = usage.get(key)
        return int(value) if isinstance(value, (int, float)) else 0

    return n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens")


def _attempt(
    model: str,
    started: float,
    clock: Callable[[], float],
    outcome: AttemptOutcome,
    stop_reason: str | None = None,
    body: dict[str, Any] | None = None,
) -> LlmAttempt:
    inp, out, cr, cw = _usage(body or {})
    return LlmAttempt(
        model=model,
        input_tokens=inp,
        output_tokens=out,
        cache_read=cr,
        cache_write=cw,
        latency_ms=max(0, int(round((clock() - started) * 1000))),
        stop_reason=stop_reason,
        outcome=outcome,
    )


async def extract(
    client: AsyncAnthropic,
    *,
    model: str,
    effort: str,
    pdf_b64: str,
    system: str,
    user_text: str,
    max_tokens: int,
    timeout_s: float,
    server_fallbacks: bool = False,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[SyllabusExtraction | None, LlmAttempt]:
    """Run one structured-output extraction.

    Returns:
        (extraction or None, attempt). Outcomes: ok, invalid (schema), refused, truncated
        (stop_reason max_tokens), api_error (HTTP/connection), timeout. Never raises for API
        failures. Nothing from the request or response is logged here.
    """
    started = clock()
    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": [
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
                {"type": "text", "text": user_text},
            ],
        }
    ]
    common: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": effort},
        "output_format": SyllabusExtraction,
        "timeout": timeout_s,
    }
    try:
        if server_fallbacks:
            common |= {"betas": [SERVER_FALLBACK_BETA], "fallbacks": "default"}
        raw = await client.beta.messages.with_raw_response.parse(**common)
    except APITimeoutError:
        return None, _attempt(model, started, clock, "timeout")
    except (APIStatusError, APIConnectionError):
        return None, _attempt(model, started, clock, "api_error")

    try:
        body = raw.http_response.json()
    except ValueError:
        return None, _attempt(model, started, clock, "invalid")
    if not isinstance(body, dict):
        return None, _attempt(model, started, clock, "invalid")
    stop_reason = body.get("stop_reason") if isinstance(body.get("stop_reason"), str) else None
    served = body.get("model") if isinstance(body.get("model"), str) and body.get("model") else model

    if stop_reason == "refusal":
        return None, _attempt(served, started, clock, "refused", stop_reason, body)
    if stop_reason == "max_tokens":
        return None, _attempt(served, started, clock, "truncated", stop_reason, body)

    try:
        parsed = await raw.parse()
    except (pydantic.ValidationError, ValueError):
        return None, _attempt(served, started, clock, "invalid", stop_reason, body)
    extraction = next(
        (
            b.parsed_output
            for b in parsed.content
            if getattr(b, "type", None) == "text" and isinstance(getattr(b, "parsed_output", None), SyllabusExtraction)
        ),
        None,
    )
    if extraction is None:
        return None, _attempt(served, started, clock, "invalid", stop_reason, body)
    return extraction, _attempt(served, started, clock, "ok", stop_reason, body)
