"""Pipeline behavior with the real SDK over a fake HTTP transport and real preflight."""

from __future__ import annotations

import base64
from typing import Any

import httpx2
import pytest
from conftest import StepClock, TODAY, extraction, make_settings, with_weights
from fakes import FakeAnthropic, client_for, message_json

from app.models import ParseSyllabusRequest
from app.pipeline import Deps, PipelineError, parse_syllabus

pytestmark = pytest.mark.anyio

SONNET = "claude-sonnet-5-5"
OPUS = "claude-opus-5-5"


def req(pdf: bytes, **overrides: Any) -> ParseSyllabusRequest:
    data: dict[str, Any] = {
        "pdf_base64": base64.b64encode(pdf).decode(),
        "filename": "syllabus.pdf",
        "timezone": "America/New_York",
        "today": TODAY,
    }
    data.update(overrides)
    return ParseSyllabusRequest.model_validate(data)


async def run(
    fake: FakeAnthropic, pdf: bytes, *, max_retries: int = 0, clock: Any = None, settings: Any = None, **req_over: Any
):
    deps = Deps(client=client_for(fake, max_retries), settings=settings or make_settings(), clock=clock or StepClock())
    return await parse_syllabus(req(pdf, **req_over), pdf, deps, "req-test-0001")


def assert_request_shape(body: dict[str, Any], model: str, effort: str) -> None:
    assert body["model"] == model
    assert body["max_tokens"] == 16000
    assert body["thinking"] == {"type": "adaptive"}
    assert body["output_config"]["effort"] == effort
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert body["output_config"]["format"]["schema"]["additionalProperties"] is False
    for banned in ("temperature", "top_p", "top_k", "tool_choice", "tools"):
        assert banned not in body
    content = body["messages"][0]["content"]
    assert content[0]["type"] == "document"
    assert content[0]["source"]["type"] == "base64"
    assert content[0]["source"]["media_type"] == "application/pdf"
    assert content[1]["type"] == "text"
    assert "untrusted data" in body["system"]


async def test_sonnet_ok_single_attempt(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([message_json(extraction(), model=SONNET)])
    res = await run(fake, synthetic_pdf)
    assert res.status == "ok"
    assert res.chosen_attempt == 0
    assert [a.model for a in res.attempts] == [SONNET]
    assert res.attempts[0].input_tokens == 1000 and res.attempts[0].outcome == "ok"
    assert res.syllabus is not None and res.syllabus.course.key == "HIST101"
    assert len(fake.requests) == 1
    assert_request_shape(fake.requests[0], SONNET, "medium")
    data = fake.requests[0]["messages"][0]["content"][0]["source"]["data"]
    assert base64.b64decode(data) == synthetic_pdf


async def test_weights_85_escalates_and_opus_wins(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([message_json(with_weights(50, 35), model=SONNET), message_json(extraction(), model=OPUS)])
    res = await run(fake, synthetic_pdf)
    assert res.status == "ok"
    assert res.chosen_attempt == 1
    assert [a.model for a in res.attempts] == [SONNET, OPUS]
    assert_request_shape(fake.requests[1], OPUS, "high")
    second_text = fake.requests[1]["messages"][0]["content"][1]["text"]
    assert "did not add up" in second_text and "85" in second_text


async def test_both_bad_tie_goes_to_opus(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([message_json(with_weights(50, 35), model=SONNET), message_json(with_weights(50, 40), model=OPUS)])
    res = await run(fake, synthetic_pdf)
    assert res.status == "needs_review"
    assert res.chosen_attempt == 1
    assert [i.code for i in res.issues if i.severity == "error"] == ["weights_sum"]
    assert res.issues[0].message == "grading weights sum to 90"


async def test_both_bad_fewer_errors_wins(synthetic_pdf: bytes) -> None:
    worse = with_weights(50, 40)
    worse["exams"] = [{**worse["exams"][0], "date_text": "2027-03-01", "date": "2027-03-01"}]
    fake = FakeAnthropic([message_json(with_weights(50, 35), model=SONNET), message_json(worse, model=OPUS)])
    res = await run(fake, synthetic_pdf)
    assert res.status == "needs_review"
    assert res.chosen_attempt == 0


async def test_refusal_escalates(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([message_json(None, model=SONNET, stop_reason="refusal"), message_json(extraction(), model=OPUS)])
    res = await run(fake, synthetic_pdf)
    assert res.status == "ok"
    assert [a.outcome for a in res.attempts] == ["refused", "ok"]
    assert res.attempts[0].stop_reason == "refusal"
    assert "declined" in fake.requests[1]["messages"][0]["content"][1]["text"]


async def test_both_refuse_is_unreadable(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic(
        [message_json(None, model=SONNET, stop_reason="refusal"), message_json(None, model=OPUS, stop_reason="refusal")]
    )
    res = await run(fake, synthetic_pdf)
    assert res.status == "unreadable"
    assert res.syllabus is None and res.chosen_attempt is None
    assert [i.code for i in res.issues] == ["refused"]


async def test_max_tokens_escalates(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic(
        [
            message_json(None, model=SONNET, stop_reason="max_tokens", raw_text='{"document_kind": "sylla'),
            message_json(extraction(), model=OPUS),
        ]
    )
    res = await run(fake, synthetic_pdf)
    assert res.status == "ok"
    assert [a.outcome for a in res.attempts] == ["truncated", "ok"]


async def test_schema_mismatch_escalates_and_keeps_usage(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic(
        [
            message_json(None, model=SONNET, raw_text='{"unexpected": true}', usage={"input_tokens": 7, "output_tokens": 3}),
            message_json(extraction(), model=OPUS),
        ]
    )
    res = await run(fake, synthetic_pdf)
    assert res.attempts[0].outcome == "invalid"
    assert (res.attempts[0].input_tokens, res.attempts[0].output_tokens) == (7, 3)
    assert res.chosen_attempt == 1


async def test_overloaded_everywhere_is_502(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([529] * 6)  # 3 tries (max_retries=2) per model
    with pytest.raises(PipelineError) as exc:
        await run(fake, synthetic_pdf, max_retries=2)
    assert (exc.value.status, exc.value.code, exc.value.retryable) == (502, "upstream_llm", True)
    assert fake.remaining == 0


async def test_timeout_without_output_is_503(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([httpx2.ReadTimeout("slow"), httpx2.ReadTimeout("slow")])
    with pytest.raises(PipelineError) as exc:
        await run(fake, synthetic_pdf)
    assert (exc.value.status, exc.value.code) == (503, "overloaded")


async def test_not_syllabus_makes_one_request(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([message_json(extraction(document_kind="assignment", grading=[]), model=SONNET)])
    res = await run(fake, synthetic_pdf)
    assert res.status == "not_syllabus"
    assert res.document_kind == "assignment"
    assert res.syllabus is None and res.issues == []
    assert len(fake.requests) == 1


async def test_deadline_exhausted_skips_escalation(synthetic_pdf: bytes) -> None:
    clock = StepClock(step=0.0)

    def slow_bad_answer() -> dict[str, Any]:
        clock.now += 200  # attempt 1 "took" 200 s of the 250 s budget
        return message_json(with_weights(50, 35), model=SONNET)

    fake = FakeAnthropic([slow_bad_answer])
    res = await run(fake, synthetic_pdf, clock=clock)
    assert res.status == "needs_review"
    assert len(res.attempts) == 1 and len(fake.requests) == 1
    assert res.attempts[0].latency_ms == 200_000


async def test_escalation_disabled_by_request_or_settings(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([message_json(with_weights(50, 35), model=SONNET)])
    res = await run(fake, synthetic_pdf, allow_escalation=False)
    assert res.status == "needs_review" and len(fake.requests) == 1

    fake = FakeAnthropic([message_json(with_weights(50, 35), model=SONNET)])
    res = await run(fake, synthetic_pdf, settings=make_settings(escalation_model=""))
    assert res.status == "needs_review" and len(fake.requests) == 1


async def test_server_fallbacks_opt_in_uses_beta(synthetic_pdf: bytes) -> None:
    fake = FakeAnthropic([message_json(extraction(), model="claude-opus-4-8")])
    res = await run(fake, synthetic_pdf, settings=make_settings(server_fallbacks=True))
    assert fake.requests[0]["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in fake.headers[0]["anthropic-beta"]
    assert res.attempts[0].model == "claude-opus-4-8"  # the model that actually served


async def test_fake_llm_mode_needs_no_client(synthetic_pdf: bytes) -> None:
    deps = Deps(client=None, settings=make_settings(fake_llm=True, anthropic_api_key=""), clock=StepClock())
    res = await parse_syllabus(req(synthetic_pdf), synthetic_pdf, deps, "req-fake")
    assert res.status == "ok"
    assert res.attempts[0].model == "fake-llm" and res.attempts[0].input_tokens == 0
