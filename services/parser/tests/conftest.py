"""Shared fixtures: settings, signing helper, ASGI client, fake Anthropic, synthetic PDFs."""

from __future__ import annotations

import base64
import copy
import json
import sys
import time
import uuid
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx2
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.auth import sign  # noqa: E402
from app.config import Settings  # noqa: E402
from app.fake import FAKE_EXTRACTION  # noqa: E402
from app.main import PARSE_PATH, create_app  # noqa: E402
from fakes import FakeAnthropic, client_for  # noqa: E402
from pdf_factory import SYNTHETIC_SYLLABUS, make_pdf  # noqa: E402

SECRET = "test-secret-0123456789abcdef0123456789"
PREVIOUS_SECRET = "prev-secret-0123456789abcdef0123456789"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "contract"
REPO_ROOT = Path(__file__).resolve().parents[3]
TODAY = "2026-10-10"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {"anthropic_api_key": "sk-test", "shared_secrets": (SECRET, PREVIOUS_SECRET)}
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


def extraction(**overrides: Any) -> dict[str, Any]:
    """The canned HIST 101 extraction (deep copy) with top-level overrides."""
    data = copy.deepcopy(FAKE_EXTRACTION)
    data.update(overrides)
    return data


def with_weights(*weights: float | None) -> dict[str, Any]:
    """Extraction whose grading rows carry `weights` (None = not stated, sent as -1)."""
    rows = [{"name": f"Component {i + 1}", "weight_pct": -1 if w is None else w, "notes": ""} for i, w in enumerate(weights)]
    return extraction(grading=rows)


@pytest.fixture(scope="session")
def synthetic_pdf() -> bytes:
    return make_pdf(SYNTHETIC_SYLLABUS)


def request_dict(pdf: bytes, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "pdf_base64": base64.b64encode(pdf).decode("ascii"),
        "filename": "syllabus.pdf",
        "course_hint": None,
        "timezone": "America/New_York",
        "today": TODAY,
        "term": None,
        "known_courses": [],
        "allow_escalation": True,
    }
    body.update(overrides)
    return body


def signed_headers(body: bytes, *, secret: str = SECRET, ts: int | None = None, path: str = PARSE_PATH) -> dict[str, str]:
    stamp = int(time.time()) if ts is None else ts
    return {
        "content-type": "application/json",
        "x-aria-timestamp": str(stamp),
        "x-aria-signature": "v1=" + sign(secret, stamp, "POST", path, body),
        "x-aria-request-id": str(uuid.uuid4()),
    }


async def signed_post(
    client: httpx2.AsyncClient, payload: dict[str, Any] | bytes, **sign_kwargs: Any
) -> httpx2.Response:
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return await client.post(PARSE_PATH, content=body, headers=signed_headers(body, **sign_kwargs))


class StepClock:
    """Deterministic monotonic clock: every call advances by `step` seconds."""

    def __init__(self, step: float = 0.25, start: float = 1000.0) -> None:
        self.now = start
        self.step = step

    def __call__(self) -> float:
        self.now += self.step
        return self.now


AppFactory = Callable[..., httpx2.AsyncClient]


@pytest.fixture
async def make_client() -> AsyncIterator[Callable[..., httpx2.AsyncClient]]:
    """Build an ASGI client for an app wired to `fake` (or no fake for fake_llm settings)."""
    clients: list[httpx2.AsyncClient] = []

    def factory(
        fake: FakeAnthropic | None = None,
        settings: Settings | None = None,
        clock: Callable[[], float] | None = None,
        max_retries: int = 0,
    ) -> httpx2.AsyncClient:
        s = settings or make_settings()
        anthropic_client = client_for(fake, max_retries=max_retries) if fake is not None else None
        app = create_app(s, anthropic_client, clock=clock or StepClock())
        c = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://parser.test")
        clients.append(c)
        return c

    yield factory
    for c in clients:
        await c.aclose()
