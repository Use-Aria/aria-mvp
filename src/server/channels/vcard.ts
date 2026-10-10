import "server-only";
// OWNER: 1.2

/**
 * Aria's contact card (vCard 3.0, RFC 2426; pure). Sent right after the welcome so iOS shows Aria
 * as a saved contact: link previews expand and "Unknown Senders" filtering doesn't hide her
 * (spec §3.2, Sendblue contact-card guide). Served by `GET /aria.vcf`.
 */

const CRLF = "\r\n";
/** RFC 2426 §2.6: lines SHOULD be folded at 75 octets. */
const FOLD_OCTETS = 75;

/**
 * Escapes a vCard text value: backslash, comma, semicolon, newline.
 * @param value raw text
 * @returns escaped text
 */
export function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Builds the vCard text.
 * @param input display name, Aria's line in E.164 (null in dev → no TEL), website URL, note
 * @returns vCard 3.0 with CRLF line endings and folded long lines
 */
export function buildVCard(input: { name: string; phoneE164: string | null; url: string; note: string }): string {
  const name = escapeVCardText(input.name.trim() || "Aria");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:;${name};;;`,
    `FN:${name}`,
    `ORG:${name}`,
  ];
  if (input.phoneE164 && /^\+\d{8,15}$/.test(input.phoneE164)) {
    lines.push(`TEL;TYPE=CELL,VOICE,pref:${input.phoneE164}`);
  }
  if (input.url) lines.push(`URL:${input.url.replace(/[\r\n]/g, "")}`);
  if (input.note) lines.push(`NOTE:${escapeVCardText(input.note)}`);
  lines.push("END:VCARD");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Folds a content line at 75 UTF-8 octets (continuation lines start with one space). */
function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    const limit = parts.length === 0 ? FOLD_OCTETS : FOLD_OCTETS - 1;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}
