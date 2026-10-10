"""Guards for the LLM-facing schema's grammar budget (see the note in app/models.py)."""

from __future__ import annotations

import json
from typing import Any

from anthropic.lib._parse._transform import transform_schema

from app.models import SyllabusExtraction

# Measured live on 2026-10-10: this schema compiles on claude-sonnet-5-5 and claude-opus-5-5, and
# the API rejected it with "compiled grammar is too large" after ~6-9 more plain string fields.
MAX_PROPERTIES = 51


def _schema() -> dict[str, Any]:
    return transform_schema(SyllabusExtraction.model_json_schema())


def _walk(node: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if isinstance(node, dict):
        out.append(node)
        for value in node.values():
            out.extend(_walk(value))
    elif isinstance(node, list):
        for value in node:
            out.extend(_walk(value))
    return out


def test_no_unions_or_optional_fields() -> None:
    nodes = _walk(_schema())
    assert not [n for n in nodes if "anyOf" in n or "oneOf" in n], "nullable unions blow the grammar budget"
    for n in nodes:
        if n.get("type") == "object" and "properties" in n:
            assert set(n["required"]) == set(n["properties"])
            assert n["additionalProperties"] is False


def test_string_arrays_only_for_enums() -> None:
    for n in _walk(_schema()):
        if n.get("type") == "array" and n.get("items", {}).get("type") == "string":
            assert "enum" in n["items"], "free-text lists must be '; '-separated strings"


def test_property_budget() -> None:
    count = sum(len(n["properties"]) for n in _walk(_schema()) if isinstance(n.get("properties"), dict))
    assert count <= MAX_PROPERTIES, (
        f"{count} properties: re-verify the grammar compiles live (ARIA_LIVE_LLM=1 pytest -m live) "
        "before raising MAX_PROPERTIES"
    )
    assert len(json.dumps(_schema())) < 12_000
