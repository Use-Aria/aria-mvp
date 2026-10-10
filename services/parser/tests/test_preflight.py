"""Preflight runs a real child process for every test."""

from __future__ import annotations

import io
import sys
import time

import pytest
from pdf_factory import SYNTHETIC_SYLLABUS, make_blank_pdf, make_encrypted_pdf, make_pdf
from pypdf import PdfReader

from app.preflight import PdfRejected, run_preflight

pytestmark = pytest.mark.anyio

LIMITS = {"slice_above": 40, "slice_to": 20, "hard_max": 300}


async def test_factory_pdf_has_text_and_percent_evidence() -> None:
    pre = await run_preflight(make_pdf(SYNTHETIC_SYLLABUS), **LIMITS)
    assert pre.page_count == 2
    assert pre.sent_pages == 2
    assert pre.has_text_layer
    assert pre.text_chars > 500
    assert pre.percent_tokens >= 4
    assert not pre.truncated
    assert pre.pdf_for_model == make_pdf(SYNTHETIC_SYLLABUS)


async def test_blank_pdf_has_no_text_layer() -> None:
    pre = await run_preflight(make_blank_pdf(3), **LIMITS)
    assert pre.page_count == 3
    assert pre.text_chars == 0
    assert not pre.has_text_layer
    assert pre.percent_tokens == 0


async def test_encrypted_pdf_rejected() -> None:
    with pytest.raises(PdfRejected) as exc:
        await run_preflight(make_encrypted_pdf(), **LIMITS)
    assert exc.value.code == "encrypted_pdf"


@pytest.mark.parametrize("data", [b"not a pdf at all", b"%PDF-1.4\n" + b"\x00garbage" * 50, b""])
async def test_garbage_rejected(data: bytes) -> None:
    with pytest.raises(PdfRejected) as exc:
        await run_preflight(data, **LIMITS)
    assert exc.value.code == "invalid_pdf"


async def test_long_pdf_is_sliced_to_20_pages() -> None:
    pdf = make_pdf([[f"Page {i + 1} text about the course"] for i in range(45)])
    pre = await run_preflight(pdf, **LIMITS)
    assert pre.page_count == 45
    assert pre.sent_pages == 20
    assert pre.truncated
    assert pre.pdf_for_model != pdf
    assert len(PdfReader(io.BytesIO(pre.pdf_for_model)).pages) == 20


async def test_too_many_pages() -> None:
    with pytest.raises(PdfRejected) as exc:
        await run_preflight(make_blank_pdf(301), **LIMITS)
    assert exc.value.code == "too_many_pages"
    assert exc.value.page_count == 301


async def test_hung_child_is_killed() -> None:
    started = time.monotonic()
    with pytest.raises(PdfRejected) as exc:
        await run_preflight(
            make_pdf([["x"]]),
            **LIMITS,
            timeout_s=1.0,
            argv=[sys.executable, "-c", "import time; time.sleep(60)"],
        )
    assert exc.value.code == "invalid_pdf"
    assert time.monotonic() - started < 5


async def test_crashing_child_is_invalid_pdf() -> None:
    with pytest.raises(PdfRejected) as exc:
        await run_preflight(make_pdf([["x"]]), **LIMITS, argv=[sys.executable, "-c", "raise SystemExit(3)"])
    assert exc.value.code == "invalid_pdf"


async def test_child_env_has_no_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("PARSER_SHARED_SECRET", "x" * 40)
    probe = (
        "import os,sys,json; sys.stdin.buffer.read(); "
        "leak = any(k in os.environ for k in ('ANTHROPIC_API_KEY','PARSER_SHARED_SECRET')); "
        "print(json.dumps({'ok': False, 'error': 'invalid_pdf' if leak else 'encrypted_pdf'}))"
    )
    with pytest.raises(PdfRejected) as exc:
        await run_preflight(make_pdf([["x"]]), **LIMITS, argv=[sys.executable, "-c", probe])
    assert exc.value.code == "encrypted_pdf"  # i.e. no secret visible to the child
