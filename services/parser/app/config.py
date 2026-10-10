"""Frozen settings read from the environment and validated at startup (fail fast)."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_PRIMARY_MODEL = "claude-sonnet-5-5"
DEFAULT_ESCALATION_MODEL = "claude-opus-5-5"
_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
_LOG_LEVELS = frozenset({"debug", "info", "warning", "error"})
MIN_SECRET_CHARS = 32


class ConfigError(RuntimeError):
    """Raised when the environment is invalid. The message never contains secret values."""


@dataclass(frozen=True)
class Settings:
    """Parser settings (V2-08 §6). `shared_secrets` is (current, previous?)."""

    anthropic_api_key: str
    shared_secrets: tuple[str, ...]
    primary_model: str = DEFAULT_PRIMARY_MODEL
    escalation_model: str = DEFAULT_ESCALATION_MODEL
    primary_effort: str = "medium"
    escalation_effort: str = "high"
    server_fallbacks: bool = False
    max_pdf_bytes: int = 15 * 1024 * 1024
    slice_above_pages: int = 40
    slice_to_pages: int = 20
    hard_max_pages: int = 300
    deadline_s: float = 250.0
    clock_skew_s: int = 300
    port: int = 8080
    log_level: str = "info"
    fake_llm: bool = False
    max_tokens: int = 16000
    primary_timeout_s: float = 150.0
    escalation_timeout_s: float = 120.0
    escalate_before_s: float = 150.0
    preflight_timeout_s: float = 15.0
    replay_ttl_s: int = 600

    @property
    def max_body_bytes(self) -> int:
        """Largest accepted HTTP body: base64 of the max PDF plus 64 KiB of JSON context."""
        return self.max_pdf_bytes * 4 // 3 + 4 + 64 * 1024


def _int(env: Mapping[str, str], name: str, default: int, lo: int, hi: int) -> int:
    raw = env.get(name, "").strip()
    if raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if not lo <= value <= hi:
        raise ConfigError(f"{name} must be in [{lo}, {hi}]")
    return value


def _flag(env: Mapping[str, str], name: str) -> bool:
    return env.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _effort(env: Mapping[str, str], name: str, default: str) -> str:
    value = env.get(name, "").strip().lower() or default
    if value not in _EFFORTS:
        raise ConfigError(f"{name} must be one of {sorted(_EFFORTS)}")
    return value


def load_settings(env: Mapping[str, str] = os.environ) -> Settings:
    """Build `Settings` from env vars.

    Raises:
        ConfigError: a required var is missing or a value is out of range.
    """
    fake_llm = _flag(env, "PARSER_FAKE_LLM")
    if fake_llm and (env.get("K_SERVICE") or env.get("VERCEL")):
        raise ConfigError("PARSER_FAKE_LLM is dev-only and is refused on Cloud Run / Vercel")

    secret = env.get("PARSER_SHARED_SECRET", "").strip()
    if len(secret) < MIN_SECRET_CHARS:
        raise ConfigError(f"PARSER_SHARED_SECRET is required (>= {MIN_SECRET_CHARS} chars)")
    previous = env.get("PARSER_SHARED_SECRET_PREVIOUS", "").strip()
    if previous and len(previous) < MIN_SECRET_CHARS:
        raise ConfigError(f"PARSER_SHARED_SECRET_PREVIOUS must be >= {MIN_SECRET_CHARS} chars")
    secrets = (secret, previous) if previous and previous != secret else (secret,)

    api_key = env.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key and not fake_llm:
        raise ConfigError("ANTHROPIC_API_KEY is required (or PARSER_FAKE_LLM=1 in dev)")

    slice_above = _int(env, "PARSER_SLICE_ABOVE_PAGES", 40, 1, 600)
    slice_to = _int(env, "PARSER_SLICE_TO_PAGES", 20, 1, 600)
    hard_max = _int(env, "PARSER_HARD_MAX_PAGES", 300, 1, 5000)
    if slice_to > slice_above:
        raise ConfigError("PARSER_SLICE_TO_PAGES must be <= PARSER_SLICE_ABOVE_PAGES")
    if slice_above > hard_max:
        raise ConfigError("PARSER_SLICE_ABOVE_PAGES must be <= PARSER_HARD_MAX_PAGES")

    log_level = env.get("LOG_LEVEL", "info").strip().lower() or "info"
    if log_level not in _LOG_LEVELS:
        raise ConfigError(f"LOG_LEVEL must be one of {sorted(_LOG_LEVELS)}")

    return Settings(
        anthropic_api_key=api_key,
        shared_secrets=secrets,
        primary_model=env.get("PARSER_PRIMARY_MODEL", "").strip() or DEFAULT_PRIMARY_MODEL,
        # Present-but-empty disables escalation; absent means the default.
        escalation_model=env.get("PARSER_ESCALATION_MODEL", DEFAULT_ESCALATION_MODEL).strip(),
        primary_effort=_effort(env, "PARSER_PRIMARY_EFFORT", "medium"),
        escalation_effort=_effort(env, "PARSER_ESCALATION_EFFORT", "high"),
        server_fallbacks=_flag(env, "PARSER_SERVER_FALLBACKS"),
        max_pdf_bytes=_int(env, "PARSER_MAX_PDF_BYTES", 15 * 1024 * 1024, 1024, 32 * 1024 * 1024),
        slice_above_pages=slice_above,
        slice_to_pages=slice_to,
        hard_max_pages=hard_max,
        deadline_s=float(_int(env, "PARSER_DEADLINE_S", 250, 30, 3600)),
        clock_skew_s=_int(env, "PARSER_CLOCK_SKEW_S", 300, 10, 3600),
        port=_int(env, "PORT", 8080, 1, 65535),
        log_level=log_level,
        fake_llm=fake_llm,
    )
