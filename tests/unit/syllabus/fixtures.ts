/**
 * Shared syllabus test fixtures: the Python goldens (contract v1) and a tiny dependency-free PDF
 * writer (port of services/parser/tests/pdf_factory.py; synthetic content only).
 */
import fs from "node:fs";
import path from "node:path";

/** Python-owned contract fixtures (goldens + signing vectors). */
export const CONTRACT_DIR = path.join(__dirname, "..", "..", "..", "services", "parser", "tests", "fixtures", "contract");

/**
 * Read one fixture JSON file.
 * @param name file name inside the contract dir
 * @returns parsed JSON
 */
export function loadContractFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, name), "utf8"));
}

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * A valid PDF with one Helvetica text line per string, one page per inner array.
 * @param pages lines per page
 * @returns PDF bytes
 */
export function makePdf(pages: string[][]): Buffer {
  const n = pages.length;
  const kids = pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`,
    );
    const ops = lines.length
      ? ["BT", "/F1 11 Tf", "14 TL", "72 740 Td", ...lines.map((l, j) => (j === 0 ? `(${esc(l)}) Tj` : `T* (${esc(l)}) Tj`)), "ET"]
      : [];
    const stream = ops.join("\n");
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Fictional HIST 101 syllabus (same course as the parser's fake extraction). */
export const SYNTHETIC_SYLLABUS: string[][] = [
  [
    "HIST 101: The Ancient World - Fall 2026",
    "Prof. Ada Marlow, ada.marlow@example.edu, office hours Wed 2-4pm",
    "Lectures Tue/Thu 1:00-2:15pm, Hall 101. Classes begin Wednesday August 26.",
    "Grading: Participation 10%, Response papers 30%, Midterm exam 25%, Final exam 35%.",
  ],
  [
    "Schedule: Week 1 Introduction. Week 5 Egypt (Ch. 4).",
    "Midterm: Thu Oct 15, in class. Final Exam: Monday, December 14, 9:00am.",
    "Response paper 1 due Fri Sep 18, 5pm.",
  ],
];
