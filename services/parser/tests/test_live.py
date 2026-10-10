"""One real Sonnet 5.5 call on the synthetic syllabus. Opt-in:

    ARIA_LIVE_LLM=1 ANTHROPIC_API_KEY=... pytest -m live -s

Costs about $0.02–0.05 per run (escalation disabled so at most one call).
"""

from __future__ import annotations

import base64
import os
from datetime import date

import pytest
from anthropic import AsyncAnthropic
from conftest import make_settings
from pdf_factory import SYNTHETIC_SYLLABUS, make_pdf

from app.models import ParseSyllabusRequest
from app.pipeline import Deps, parse_syllabus

pytestmark = [
    pytest.mark.live,
    pytest.mark.anyio,
    pytest.mark.skipif(
        os.environ.get("ARIA_LIVE_LLM") != "1" or not os.environ.get("ANTHROPIC_API_KEY"),
        reason="set ARIA_LIVE_LLM=1 and ANTHROPIC_API_KEY",
    ),
]

PRICE_PER_MTOK = {"claude-sonnet-5-5": (2.0, 10.0), "claude-opus-5-5": (4.0, 20.0)}


async def test_live_sonnet_synthetic_syllabus() -> None:
    pdf = make_pdf(SYNTHETIC_SYLLABUS)
    req = ParseSyllabusRequest.model_validate(
        {
            "pdf_base64": base64.b64encode(pdf).decode(),
            "filename": "hist101.pdf",
            "timezone": "America/New_York",
            "today": "2026-10-10",
            "allow_escalation": False,
        }
    )
    client = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"], max_retries=2)
    try:
        res = await parse_syllabus(req, pdf, Deps(client=client, settings=make_settings(anthropic_api_key="live")), "live-test")
    finally:
        await client.close()

    cost = 0.0
    for a in res.attempts:
        pin, pout = PRICE_PER_MTOK.get(a.model, (0.0, 0.0))
        cost += a.input_tokens * pin / 1e6 + a.output_tokens * pout / 1e6
        print(
            f"\nLIVE attempt model={a.model} outcome={a.outcome} in={a.input_tokens} out={a.output_tokens} "
            f"latency_ms={a.latency_ms} stop={a.stop_reason}"
        )
    print(f"LIVE status={res.status} issues={[i.code for i in res.issues]} cost=${cost:.4f}")

    assert res.status == "ok", [i.model_dump() for i in res.issues]
    assert res.syllabus is not None
    assert res.syllabus.course.key == "HIST101"
    dates = sorted(e.date for e in res.syllabus.exams if e.date)
    assert dates == [date(2026, 10, 15), date(2026, 12, 14)]
    assert res.syllabus.grading_total_pct == pytest.approx(100)
