"""FastAPI app: `GET /healthz`, `POST /v1/parse-syllabus` (contract v1, V2-08 §8.1).

Error bodies are always `{"error": {code, message, retryable}}` and never echo request input
(FastAPI's default 422 handler would echo the base64 PDF). The body is read raw, size-limited by
an ASGI middleware before it is read, HMAC-verified, and only then parsed.
"""

from __future__ import annotations

import base64
import binascii
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, MutableMapping
from contextlib import asynccontextmanager
from typing import Any

import pydantic
from anthropic import AsyncAnthropic
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import PARSER_VERSION
from app.auth import REQUEST_ID_HEADER, AuthError, ReplayCache, verify
from app.config import ConfigError, Settings, load_settings
from app.logging import log_event
from app.models import ErrorBody, ErrorDetail, ParseSyllabusRequest
from app.pipeline import Deps, PipelineError, parse_syllabus
from app.preflight import PdfRejected

PARSE_PATH = "/v1/parse-syllabus"
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
_PDF_ERRORS = {"invalid_pdf": 400, "encrypted_pdf": 400, "too_many_pages": 422}

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def error_response(status: int, code: str, message: str, retryable: bool = False) -> JSONResponse:
    """Contract error body."""
    body = ErrorBody(error=ErrorDetail(code=code, message=message, retryable=retryable))
    return JSONResponse(status_code=status, content=body.model_dump())


class _State:
    """Per-app runtime state, created lazily so `app = create_app()` imports without env vars."""

    def __init__(self, settings: Settings, client: AsyncAnthropic | None, owns_client: bool) -> None:
        self.settings = settings
        self.client = client
        self.owns_client = owns_client
        self.replay = ReplayCache(ttl_s=settings.replay_ttl_s)


def _build_state(settings: Settings | None, client: AsyncAnthropic | None) -> _State:
    s = settings or load_settings()
    owns = False
    if client is None and not s.fake_llm:
        client = AsyncAnthropic(api_key=s.anthropic_api_key, max_retries=2)
        owns = True
    return _State(s, client, owns)


class _BodyTooLarge(Exception):
    pass


class BodyLimitMiddleware:
    """Rejects bodies over the limit with 413: by `Content-Length` before reading, and by
    counting streamed bytes for chunked bodies."""

    def __init__(self, app: ASGIApp, limit: Callable[[], int]) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.limit()
        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared is not None:
            if not declared.isdigit():
                await error_response(400, "invalid_json", "bad content-length")(scope, receive, send)
                return
            if int(declared) > limit:
                await error_response(413, "too_large", "request body too large")(scope, receive, send)
                return

        received = 0
        started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _BodyTooLarge
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            if not started:
                await error_response(413, "too_large", "request body too large")(scope, receive, send)


def create_app(
    settings: Settings | None = None,
    client: AsyncAnthropic | None = None,
    clock: Callable[[], float] | None = None,
) -> FastAPI:
    """App factory. With no arguments, settings load from env at startup (fail fast) or on the
    first request; tests pass `settings`, a `client` wired to a fake transport, and optionally a
    deterministic monotonic `clock` (used for deadlines and attempt latency)."""
    state_box: dict[str, _State] = {}
    if settings is not None:
        state_box["s"] = _build_state(settings, client)

    def state() -> _State:
        if "s" not in state_box:
            state_box["s"] = _build_state(None, client)
        return state_box["s"]

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            st = state()
        except ConfigError as exc:  # fail fast; the message names the var, never its value
            log_event("config_error", logging.ERROR, code=str(exc))
            raise
        log_event("startup", version=PARSER_VERSION, fake_llm=st.settings.fake_llm)
        try:
            yield
        finally:
            if st.owns_client and st.client is not None:
                await st.client.close()

    app = FastAPI(
        title="aria-parser", version=PARSER_VERSION, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
    )
    app.add_middleware(BodyLimitMiddleware, limit=lambda: state().settings.max_body_bytes)

    @app.middleware("http")
    async def request_log(request: Request, call_next: Callable[[Request], Awaitable[Any]]) -> Any:
        rid_raw = request.headers.get(REQUEST_ID_HEADER, "")
        request.state.request_id = rid_raw if _REQUEST_ID_RE.match(rid_raw) else str(uuid.uuid4())
        t0 = time.monotonic()
        response = await call_next(request)
        if request.url.path != "/healthz":
            log_event(
                "request",
                request_id=request.state.request_id,
                method=request.method,
                path=request.url.path if request.url.path in (PARSE_PATH,) else "other",
                http_status=response.status_code,
                duration_ms=int((time.monotonic() - t0) * 1000),
            )
        return response

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, __: RequestValidationError) -> JSONResponse:
        return error_response(400, "invalid_json", "request does not match the contract")

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return error_response(exc.status_code, code, code.replace("_", " "))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log_event(
            "unhandled_error",
            logging.ERROR,
            request_id=getattr(request.state, "request_id", None),
            error_type=type(exc).__name__,
        )
        return error_response(500, "internal", "internal error", retryable=True)

    @app.get("/healthz")
    async def healthz() -> dict[str, object]:
        return {"ok": True, "version": PARSER_VERSION}

    @app.post(PARSE_PATH)
    async def parse(request: Request) -> JSONResponse:
        st = state()
        s = st.settings
        request_id: str = request.state.request_id
        body = await request.body()

        try:
            verify(request.headers, "POST", PARSE_PATH, body, s.shared_secrets, time.time(), st.replay, s.clock_skew_s)
        except AuthError as exc:
            log_event("auth_rejected", logging.WARNING, request_id=request_id, code=exc.code)
            return error_response(401, exc.code, "unauthorized")

        try:
            req = ParseSyllabusRequest.model_validate_json(body)
        except pydantic.ValidationError as exc:
            fields = sorted({".".join(str(p) for p in e["loc"][:2]) for e in exc.errors(include_input=False)})
            return error_response(400, "invalid_json", "invalid request: " + ", ".join(fields[:6]))

        try:
            pdf = base64.b64decode(req.pdf_base64, validate=True)
        except (binascii.Error, ValueError):
            return error_response(400, "invalid_base64", "pdf_base64 is not valid base64")
        if len(pdf) > s.max_pdf_bytes:
            return error_response(413, "too_large", f"PDF exceeds {s.max_pdf_bytes} bytes")
        if not pdf.startswith(b"%PDF-"):
            return error_response(400, "invalid_pdf", "not a PDF")

        deps = Deps(client=st.client, settings=s, clock=clock or time.monotonic)
        try:
            result = await parse_syllabus(req, pdf, deps, request_id)
        except PdfRejected as exc:
            log_event("pdf_rejected", request_id=request_id, code=exc.code, bytes=len(pdf), pages=exc.page_count)
            messages = {
                "invalid_pdf": "the PDF could not be read",
                "encrypted_pdf": "the PDF is password-protected",
                "too_many_pages": f"the PDF has more than {s.hard_max_pages} pages",
            }
            return error_response(_PDF_ERRORS.get(exc.code, 400), exc.code, messages.get(exc.code, "bad PDF"))
        except PipelineError as exc:
            log_event("parse_failed", logging.WARNING, request_id=request_id, code=exc.code, http_status=exc.status)
            return error_response(exc.status, exc.code, exc.message, retryable=exc.retryable)

        log_event(
            "parse_done",
            request_id=request_id,
            status=result.status,
            chosen_attempt=result.chosen_attempt,
            escalation=len(result.attempts) > 1,
            issue_codes=",".join(i.code for i in result.issues),
        )
        return JSONResponse(status_code=200, content=result.model_dump(mode="json"))

    return app


app = create_app()
