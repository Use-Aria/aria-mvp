"""No PDF text, model output, filename or hint may reach the logs (V2-08 §2.13)."""

from __future__ import annotations

import logging
import logging.config
from typing import Any

import pytest
from conftest import extraction, request_dict, signed_post
from fakes import FakeAnthropic, message_json
from pdf_factory import SYNTHETIC_SYLLABUS, make_pdf

from app.logging import JsonFormatter, log_event, logging_config

pytestmark = pytest.mark.anyio

SENTINEL = "ZQX-LOG-SENTINEL-9031"


async def test_sentinels_never_logged(make_client: Any, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]) -> None:
    logging.config.dictConfig(logging_config("debug"))
    caplog.set_level(logging.DEBUG)

    pdf = make_pdf([[*SYNTHETIC_SYLLABUS[0], f"Secret note {SENTINEL}"], SYNTHETIC_SYLLABUS[1]])
    x = extraction(course_title=f"Ancient {SENTINEL}")
    x["exams"][0]["topics"] = SENTINEL
    fake = FakeAnthropic(
        [
            message_json(x | {"grading": [{"name": SENTINEL, "weight_pct": 10, "notes": SENTINEL}]}, model="claude-sonnet-5-5"),
            message_json(x, model="claude-opus-5-5"),
        ]
    )
    client = make_client(fake)
    ok = await signed_post(client, request_dict(pdf, filename=f"{SENTINEL}.pdf", course_hint=SENTINEL[:20]))
    assert ok.status_code == 200
    assert SENTINEL in ok.text  # it *is* in the response, so the absence below is meaningful
    bad = await signed_post(client, request_dict(pdf, today=SENTINEL))
    assert bad.status_code == 400

    formatter = JsonFormatter()
    rendered = [formatter.format(r) for r in caplog.records]
    assert any('"event":"parse_done"' in line for line in rendered)
    assert any('"event":"llm_attempt"' in line for line in rendered)
    for record, line in zip(caplog.records, rendered, strict=True):
        assert SENTINEL not in line
        assert SENTINEL not in str(record.__dict__)
    out = capsys.readouterr()
    assert SENTINEL not in out.out and SENTINEL not in out.err


def test_log_event_drops_unknown_fields_and_caps_strings(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="aria.parser")
    log_event("x", request_id="r" * 500, body="secret body", filename="a.pdf", bytes=10)
    rec = caplog.records[-1]
    fields = rec.aria_fields  # type: ignore[attr-defined]
    assert set(fields) == {"request_id", "bytes"}
    assert len(fields["request_id"]) <= 121
