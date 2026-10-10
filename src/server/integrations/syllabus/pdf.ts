import "server-only";
// OWNER: 3.5

/** Pure PDF helpers (V2-08 §7.2 `pdf.ts`). */
import { createHash } from "node:crypto";

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * Whether the bytes start with the `%PDF-` magic.
 * @param buf file bytes (or the first chunk)
 * @returns true for a PDF header
 */
export function looksLikePdf(buf: Uint8Array): boolean {
  if (buf.length < MAGIC.length) return false;
  return MAGIC.every((b, i) => buf[i] === b);
}

/**
 * Lowercase hex SHA-256 of the bytes (the re-parse guard; the PDF itself is never stored).
 * @param buf file bytes
 * @returns 64 hex chars
 */
export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}
