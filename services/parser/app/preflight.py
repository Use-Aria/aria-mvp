"""PDF preflight in a resource-limited child process (V2-08 §2.13).

The parent (`run_preflight`) spawns ``python -I <this file>`` with the PDF on stdin, a scrubbed
environment (no API key, no shared secret), and kills it after `timeout_s`. The child applies
rlimits (address space 512 MiB, CPU 10 s, no file writes) before importing pypdf, then reports
page count, encryption, text-layer size and %-token evidence as one JSON line on stdout, plus the
first `slice_to` pages as a new PDF when the document has more than `slice_above` pages.

This module must stay importable with the standard library only (the child runs in isolated
mode with no access to the `app` package); pypdf is imported inside the child function.
Nothing from the PDF is ever logged; the child's stderr is discarded.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass

CHILD_AS_BYTES = 512 * 1024 * 1024
CHILD_CPU_S = 10
TEXT_PAGES = 40
MIN_TEXT_CHARS = 100
_MAX_STDOUT = 64 * 1024 * 1024

_PERCENT_RE = re.compile(r"\d{1,3}(?:\.\d+)?\s?%")
_GRADING_RE = re.compile(r"grad(e|ing)|weight|evaluation|assessment|breakdown", re.I)


class PdfRejected(Exception):
    """The PDF can't be parsed. `code`: invalid_pdf, encrypted_pdf or too_many_pages."""

    def __init__(self, code: str, page_count: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.page_count = page_count


@dataclass(frozen=True)
class Preflight:
    """What the preflight learned. `pdf_for_model` is the original or the sliced PDF."""

    page_count: int
    sent_pages: int
    encrypted: bool
    text_chars: int
    has_text_layer: bool
    percent_tokens: int
    pdf_for_model: bytes
    truncated: bool


# --- child -------------------------------------------------------------------------------


def _apply_limits() -> None:
    try:
        import resource
    except ImportError:  # non-POSIX
        return
    for limit, value in (
        (getattr(resource, "RLIMIT_AS", None), CHILD_AS_BYTES),
        (getattr(resource, "RLIMIT_CPU", None), CHILD_CPU_S),
        (getattr(resource, "RLIMIT_FSIZE", None), 0),
        (getattr(resource, "RLIMIT_CORE", None), 0),
    ):
        if limit is None:
            continue
        try:
            resource.setrlimit(limit, (value, value))
        except (ValueError, OSError):
            # macOS rejects RLIMIT_AS; the wall-clock kill in the parent still applies.
            pass


def _analyze(data: bytes, slice_above: int, slice_to: int, hard_max: int) -> dict[str, object]:
    import io

    from pypdf import PdfReader, PdfWriter

    if not data.startswith(b"%PDF-"):
        return {"ok": False, "error": "invalid_pdf"}
    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted:
        return {"ok": False, "error": "encrypted_pdf"}
    page_count = len(reader.pages)
    if page_count == 0:
        return {"ok": False, "error": "invalid_pdf"}
    if page_count > hard_max:
        return {"ok": False, "error": "too_many_pages", "page_count": page_count}

    text_chars = 0
    percent_tokens = 0
    for page in reader.pages[: min(page_count, TEXT_PAGES)]:
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001 - a broken page shouldn't sink the document
            text = ""
        text_chars += len("".join(text.split()))
        if _GRADING_RE.search(text):
            percent_tokens += len(_PERCENT_RE.findall(text))

    sliced_b64: str | None = None
    sent_pages = page_count
    if page_count > slice_above:
        writer = PdfWriter()
        for page in reader.pages[:slice_to]:
            writer.add_page(page)
        out = io.BytesIO()
        writer.write(out)
        sliced_b64 = base64.b64encode(out.getvalue()).decode("ascii")
        sent_pages = slice_to

    return {
        "ok": True,
        "page_count": page_count,
        "sent_pages": sent_pages,
        "text_chars": text_chars,
        "percent_tokens": percent_tokens,
        "sliced_b64": sliced_b64,
    }


def _main(argv: Sequence[str] | None = None) -> int:
    """Child entry point: `python -I preflight.py <slice_above> <slice_to> <hard_max>`."""
    args = list(sys.argv[1:] if argv is None else argv)
    _apply_limits()
    try:
        slice_above, slice_to, hard_max = (int(a) for a in args[:3])
        data = sys.stdin.buffer.read()
        result = _analyze(data, slice_above, slice_to, hard_max)
    except MemoryError:
        result = {"ok": False, "error": "invalid_pdf"}
    except Exception:  # noqa: BLE001 - any parser failure means "invalid_pdf"; no details leak
        result = {"ok": False, "error": "invalid_pdf"}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
    return 0


# --- parent ------------------------------------------------------------------------------


def child_argv(slice_above: int, slice_to: int, hard_max: int) -> list[str]:
    """Command line for the child: isolated mode (-I: no env vars, no cwd/script dir on sys.path)."""
    return [sys.executable, "-I", os.path.abspath(__file__), str(slice_above), str(slice_to), str(hard_max)]


async def run_preflight(
    pdf: bytes,
    *,
    slice_above: int,
    slice_to: int,
    hard_max: int,
    timeout_s: float = 15.0,
    argv: Sequence[str] | None = None,
) -> Preflight:
    """Run the child on `pdf` and return what it found.

    Raises:
        PdfRejected: `invalid_pdf` (bad bytes, crash, timeout), `encrypted_pdf`, `too_many_pages`.
    """
    cmd = list(argv) if argv is not None else child_argv(slice_above, slice_to, hard_max)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C.UTF-8"},
        limit=_MAX_STDOUT,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(input=pdf), timeout=timeout_s)
    except (TimeoutError, BrokenPipeError, ConnectionResetError) as exc:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        raise PdfRejected("invalid_pdf") from exc

    if proc.returncode != 0 or not stdout:
        raise PdfRejected("invalid_pdf")
    try:
        result = json.loads(stdout)
    except ValueError as exc:
        raise PdfRejected("invalid_pdf") from exc
    if not isinstance(result, dict):
        raise PdfRejected("invalid_pdf")
    if not result.get("ok"):
        code = str(result.get("error", "invalid_pdf"))
        if code not in {"invalid_pdf", "encrypted_pdf", "too_many_pages"}:
            code = "invalid_pdf"
        page_count = result.get("page_count")
        raise PdfRejected(code, page_count if isinstance(page_count, int) else None)

    try:
        page_count = int(result["page_count"])
        sent_pages = int(result["sent_pages"])
        text_chars = int(result["text_chars"])
        percent_tokens = int(result["percent_tokens"])
        sliced = result.get("sliced_b64")
        pdf_for_model = base64.b64decode(sliced) if isinstance(sliced, str) else pdf
    except (KeyError, TypeError, ValueError) as exc:
        raise PdfRejected("invalid_pdf") from exc

    return Preflight(
        page_count=page_count,
        sent_pages=sent_pages,
        encrypted=False,
        text_chars=text_chars,
        has_text_layer=text_chars >= MIN_TEXT_CHARS,
        percent_tokens=percent_tokens,
        pdf_for_model=pdf_for_model,
        truncated=sent_pages < page_count,
    )


if __name__ == "__main__":
    raise SystemExit(_main())
