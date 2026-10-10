from __future__ import annotations

import pytest

from app.config import ConfigError, load_settings

SECRET = "s" * 40


def test_minimal_env() -> None:
    s = load_settings({"PARSER_SHARED_SECRET": SECRET, "ANTHROPIC_API_KEY": "sk-x"})
    assert s.primary_model == "claude-sonnet-5-5"
    assert s.escalation_model == "claude-opus-5-5"
    assert (s.primary_effort, s.escalation_effort) == ("medium", "high")
    assert s.shared_secrets == (SECRET,)
    assert s.max_body_bytes > s.max_pdf_bytes * 4 // 3
    assert not s.server_fallbacks and not s.fake_llm


def test_previous_secret_and_disabled_escalation() -> None:
    s = load_settings(
        {
            "PARSER_SHARED_SECRET": SECRET,
            "PARSER_SHARED_SECRET_PREVIOUS": "p" * 40,
            "ANTHROPIC_API_KEY": "sk-x",
            "PARSER_ESCALATION_MODEL": "",
        }
    )
    assert s.shared_secrets == (SECRET, "p" * 40)
    assert s.escalation_model == ""


@pytest.mark.parametrize(
    "env",
    [
        {},
        {"PARSER_SHARED_SECRET": "short", "ANTHROPIC_API_KEY": "sk-x"},
        {"PARSER_SHARED_SECRET": SECRET},
        {"PARSER_SHARED_SECRET": SECRET, "ANTHROPIC_API_KEY": "sk-x", "PARSER_PRIMARY_EFFORT": "turbo"},
        {"PARSER_SHARED_SECRET": SECRET, "ANTHROPIC_API_KEY": "sk-x", "PARSER_MAX_PDF_BYTES": "lots"},
        {"PARSER_SHARED_SECRET": SECRET, "ANTHROPIC_API_KEY": "sk-x", "PARSER_SLICE_TO_PAGES": "50"},
        {"PARSER_SHARED_SECRET": SECRET, "PARSER_FAKE_LLM": "1", "K_SERVICE": "aria-parser"},
        {"PARSER_SHARED_SECRET": SECRET, "PARSER_FAKE_LLM": "1", "VERCEL": "1"},
    ],
)
def test_invalid_env_fails_fast(env: dict[str, str]) -> None:
    with pytest.raises(ConfigError) as exc:
        load_settings(env)
    assert SECRET not in str(exc.value)


def test_fake_llm_needs_no_key_in_dev() -> None:
    s = load_settings({"PARSER_SHARED_SECRET": SECRET, "PARSER_FAKE_LLM": "1"})
    assert s.fake_llm and s.anthropic_api_key == ""
