"""Minimal, dependency-free PDF writer for tests (synthetic content only; no real syllabi)."""

from __future__ import annotations

from collections.abc import Sequence


def _esc(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _content_stream(lines: Sequence[str]) -> bytes:
    if not lines:
        return b""
    ops = ["BT", "/F1 11 Tf", "14 TL", "72 740 Td"]
    for i, line in enumerate(lines):
        safe = line.encode("latin-1", "replace").decode("latin-1")
        ops.append(f"({_esc(safe)}) Tj" if i == 0 else f"T* ({_esc(safe)}) Tj")
    ops.append("ET")
    return "\n".join(ops).encode("latin-1")


def _assemble(objects: list[bytes], trailer_extra: bytes = b"") -> bytes:
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for num, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R ".encode() + trailer_extra + b">>\n"
    out += f"startxref\n{xref_at}\n%%EOF\n".encode()
    return bytes(out)


def _objects(pages: Sequence[Sequence[str]]) -> list[bytes]:
    n = len(pages)
    # 1 catalog, 2 pages, 3 font, then (page, content) pairs.
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(n))
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for i, lines in enumerate(pages):
        content_num = 5 + 2 * i
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_num} 0 R >>".encode()
        )
        stream = _content_stream(lines)
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    return objects


def make_pdf(pages: Sequence[Sequence[str]]) -> bytes:
    """A valid PDF with one Helvetica text line per string, one page per inner sequence."""
    return _assemble(_objects(pages))


def make_blank_pdf(n_pages: int) -> bytes:
    """A valid PDF with `n_pages` empty pages (no text layer)."""
    return _assemble(_objects([[] for _ in range(n_pages)]))


def make_encrypted_pdf() -> bytes:
    """A PDF whose trailer carries an /Encrypt dictionary (pypdf reports is_encrypted)."""
    objects = _objects([["Locked"]])
    objects.append(
        b"<< /Filter /Standard /V 1 /R 2 /O <" + b"00" * 32 + b"> /U <" + b"00" * 32 + b"> /P -4 >>"
    )
    enc_num = len(objects)
    return _assemble(objects, f"/Encrypt {enc_num} 0 R /ID [<{'ab' * 16}> <{'ab' * 16}>] ".encode())


# Fictional course; every date is consistent with its weekday (Fall 2026).
SYNTHETIC_SYLLABUS: list[list[str]] = [
    [
        "HIST 101: The Ancient World",
        "Example College - Fall 2026",
        "Instructor: Prof. Ada Marlow (ada.marlow@example.edu)",
        "Office hours: Wednesdays 2-4pm, Hall 210",
        "Lectures: Tuesday and Thursday 1:00-2:15pm, Hall 101",
        "Classes begin Wednesday, August 26, 2026. Last day of classes: Friday, December 11, 2026.",
        "Final examinations end Friday, December 18, 2026.",
        "",
        "Grading",
        "Participation 10%",
        "Response papers (4, lowest dropped) 30%",
        "Midterm exam 25%",
        "Final exam 35%",
    ],
    [
        "Exams",
        "Midterm: Thursday, October 15, in class (1:00-2:15pm), Hall 101.",
        "Covers Mesopotamia, Egypt and Archaic Greece.",
        "Final exam: Monday, December 14, 9:00am-12:00pm. Cumulative, with emphasis on Classical Greece and Rome.",
        "",
        "Response papers are due Fridays at 5pm: Sep 18, Oct 9, Nov 6, Dec 4.",
        "",
        "Schedule",
        "Week 1: Introduction",
        "Week 2: Mesopotamia (read Ch. 1-2)",
        "Week 3: Egypt (read Ch. 3-4)",
        "Week 4: Archaic Greece",
        "",
        "Late papers lose a third of a letter grade per day.",
        "Make-up exams only with a dean's excuse.",
    ],
]
