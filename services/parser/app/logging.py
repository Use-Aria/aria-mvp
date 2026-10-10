"""Structured JSON logs with an allowlist of fields.

Never logs request bodies, PDF bytes or text, model output, filenames, course hints or
headers. `log_event` silently drops any field that is not on the allowlist, and string
values are capped, so a caller mistake cannot leak content.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

LOGGER_NAME = "aria.parser"

ALLOWED_FIELDS = frozenset(
    {
        "request_id",
        "bytes",
        "pages",
        "sent_pages",
        "scanned",
        "truncated",
        "model",
        "attempt",
        "outcome",
        "stop_reason",
        "input_tokens",
        "output_tokens",
        "cache_read",
        "cache_write",
        "latency_ms",
        "duration_ms",
        "status",
        "http_status",
        "code",
        "issue_codes",
        "chosen_attempt",
        "method",
        "path",
        "version",
        "error_type",
        "fake_llm",
        "escalation",
    }
)
_MAX_STR = 120

FieldValue = str | int | float | bool | None


class JsonFormatter(logging.Formatter):
    """One JSON object per line: ts, level, logger, event, plus allowlisted fields."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
        }
        fields = getattr(record, "aria_fields", None)
        if isinstance(fields, dict):
            payload["event"] = record.getMessage()
            payload.update(fields)
        else:
            # Third-party records (uvicorn startup etc.): keep the message, never args/exc text.
            payload["event"] = _clip(record.getMessage())
            if record.exc_info and record.exc_info[0] is not None:
                payload["error_type"] = record.exc_info[0].__name__
        return json.dumps(payload, separators=(",", ":"), ensure_ascii=True)


def _clip(value: str) -> str:
    return value if len(value) <= _MAX_STR else value[:_MAX_STR] + "…"


def _clean(fields: dict[str, FieldValue]) -> dict[str, FieldValue]:
    out: dict[str, FieldValue] = {}
    for key, value in fields.items():
        if key not in ALLOWED_FIELDS:
            continue
        if isinstance(value, str):
            value = _clip(value)
        elif not isinstance(value, (int, float, bool)) and value is not None:
            continue
        out[key] = value
    return out


def log_event(event: str, level: int = logging.INFO, **fields: FieldValue) -> None:
    """Log one structured event. Unknown fields are dropped; strings are capped at 120 chars."""
    logging.getLogger(LOGGER_NAME).log(level, event, extra={"aria_fields": _clean(fields)})


def logging_config(level: str = "info") -> dict[str, Any]:
    """`logging.config.dictConfig` dict for the app and uvicorn (JSON to stdout)."""
    lvl = level.upper()
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"json": {"()": "app.logging.JsonFormatter"}},
        "handlers": {
            "stdout": {
                "class": "logging.StreamHandler",
                "formatter": "json",
                "stream": "ext://sys.stdout",
            }
        },
        "loggers": {
            LOGGER_NAME: {"handlers": ["stdout"], "level": lvl, "propagate": True},
            "uvicorn": {"handlers": ["stdout"], "level": lvl, "propagate": False},
            "uvicorn.error": {"handlers": ["stdout"], "level": lvl, "propagate": False},
            # Access logs are replaced by our own `request` event (no client IPs or query strings).
            "uvicorn.access": {"handlers": [], "level": "CRITICAL", "propagate": False},
            # The SDK logs request options at debug; keep it quiet.
            "anthropic": {"handlers": ["stdout"], "level": "WARNING", "propagate": False},
            "httpx2": {"handlers": ["stdout"], "level": "WARNING", "propagate": False},
            "pypdf": {"handlers": [], "level": "CRITICAL", "propagate": False},
        },
    }


LOGGING: dict[str, Any] = logging_config()
