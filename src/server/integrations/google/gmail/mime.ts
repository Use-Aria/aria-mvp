import "server-only";
// OWNER: 2.5

/**
 * RFC 5322 message builder for outgoing replies/new emails (V2-07 §7.3 `gmail/mime.ts`). Pure.
 *
 * - Header injection is impossible: any CR/LF in a header input throws.
 * - Non-ASCII header text uses RFC 2047 `=?UTF-8?B?…?=` words (≤75 chars each, never splitting a
 *   character), folded onto continuation lines.
 * - The body is UTF-8 `text/plain`, base64 with 76-column lines (CRLF canonical form).
 * - Replies carry `In-Reply-To` + `References` (Gmail also needs `threadId` on the send call and
 *   a matching `Re:` subject; see `replySubject`).
 * - `buildRawMessage` returns base64url without padding, ready for `users.messages.send` `raw`.
 */
import { randomUUID } from "node:crypto";
import type { Address } from "@/server/integrations/google/gmail/types";
import { parseAddressList } from "@/server/integrations/google/gmail/headers";

/** Everything needed to render one outgoing email. */
export interface OutgoingEmail {
  /** Sender: bare address or `Name <address>`. */
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  /** Message-ID of the message being replied to (`<…>`). */
  inReplyTo?: string;
  /** Full References chain (see `replyReferences`). */
  references?: string;
  /** Our own Message-ID (`<…@…>`), e.g. from `newMessageId`. */
  messageId: string;
  /** `Date` header; defaults to now. */
  date?: Date;
}

const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const MSG_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

/**
 * Pragmatic address check (dot-atom local part, LDH domain with an alphabetic TLD, ≤254 chars).
 * @param v candidate address (no display name)
 * @returns true if it is safe to put in a header
 */
export function isValidEmail(v: string): boolean {
  if (typeof v !== "string" || v.length > 254) return false;
  const at = v.lastIndexOf("@");
  if (at <= 0 || at === v.length - 1) return false;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  return local.length <= 64 && LOCAL_ATOM.test(local) && DOMAIN.test(domain);
}

function assertNoNewline(field: string, v: string): void {
  if (/[\r\n\0]/.test(v)) throw new Error(`mime: ${field} contains a line break`);
}

function isPrintableAscii(v: string): boolean {
  return /^[\x20-\x7e]*$/.test(v);
}

/** Split a string into chunks of whole code points whose UTF-8 size is ≤ maxBytes. */
function utf8Chunks(v: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  let size = 0;
  for (const ch of v) {
    const n = Buffer.byteLength(ch, "utf8");
    if (size + n > maxBytes && cur) {
      out.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += n;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * RFC 2047-encode a header text when it contains non-ASCII (or control) characters.
 * Each encoded word is ≤75 chars and holds whole characters; words are joined with CRLF + space
 * (folding whitespace between encoded words is ignored by decoders).
 * @param v header text (no CR/LF)
 * @returns `v` unchanged when printable ASCII, otherwise `=?UTF-8?B?…?=` words
 */
export function encodeHeaderWord(v: string): string {
  assertNoNewline("header", v);
  if (isPrintableAscii(v)) return v;
  // 39 bytes → 52 base64 chars → 64-char words, so even "Subject: " + word stays ≤ 76 (RFC 2047 §2).
  return utf8Chunks(v, 39)
    .map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

/**
 * Reply subject: exactly one leading "Re: " (strips any existing Re:/RE:/Re[2]:/Aw:/Sv: chain),
 * so it is idempotent and never yields "Re: Re:".
 * @param original subject of the message being replied to
 * @returns "Re: <subject>"
 */
export function replySubject(original: string): string {
  const rest = original
    .replace(/[\r\n]+/g, " ")
    .replace(/^(\s*(re|aw|sv|antw)(\s*\[\d+\])?\s*:\s*)+/i, "")
    .trim();
  return rest ? `Re: ${rest}` : "Re:";
}

/**
 * References header for a reply: the parent's References plus the parent's Message-ID, de-duped,
 * keeping the first id and the most recent ones when the chain would exceed ~900 chars.
 * @param parentReferences the parent's References header (or null)
 * @param parentMessageId the parent's Message-ID (`<…>`)
 * @returns space-separated Message-IDs
 */
export function replyReferences(parentReferences: string | null, parentMessageId: string): string {
  const ids = [...(parentReferences ?? "").matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
  const parent = parentMessageId.trim();
  if (MSG_ID.test(parent) || /^<[^<>\s]+>$/.test(parent)) ids.push(parent);
  const uniq = ids.filter((id, i) => ids.indexOf(id) === i);
  while (uniq.length > 2 && uniq.join(" ").length > 900) uniq.splice(1, 1);
  return uniq.join(" ");
}

/**
 * A fresh RFC 5322 Message-ID.
 * @param domain right-hand side (the sender's domain)
 * @returns `<uuid@domain>`
 */
export function newMessageId(domain: string): string {
  const d = domain.trim().toLowerCase();
  if (!DOMAIN.test(d)) throw new Error("mime: invalid Message-ID domain");
  return `<${randomUUID()}@${d}>`;
}

/** Parse one `addr` / `Name <addr>` input into a validated address. */
function oneAddress(field: string, raw: string): Address {
  assertNoNewline(field, raw);
  const list = parseAddressList(raw);
  const a = list[0];
  if (list.length !== 1 || !a || !isValidEmail(a.email)) throw new Error(`mime: invalid address in ${field}`);
  return a;
}

function quoteDisplayName(name: string): string {
  if (!isPrintableAscii(name)) return encodeHeaderWord(name);
  // Atoms only → bare; otherwise a quoted-string with escapes.
  return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~ -]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, "\\$1")}"`;
}

function renderAddress(a: Address): string {
  return a.name ? `${quoteDisplayName(a.name)} <${a.email}>` : a.email;
}

/** Fold an ASCII header line at spaces so lines stay ≤78 chars where possible. */
function foldLine(line: string): string {
  if (line.length <= 78) return line;
  const words = line.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > 78) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

function header(name: string, value: string): string {
  // Encoded values are already folded (CRLF + space inside); fold only plain ASCII lines.
  return value.includes("\r\n ") ? `${name}: ${value}` : foldLine(`${name}: ${value}`);
}

function wrap76(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

/**
 * Render an outgoing email as a base64url RFC 5322 message (for `users.messages.send`).
 * @param e message fields
 * @returns base64url (no padding) of the full message
 * @throws Error on CR/LF in any header input, an invalid address, no recipients, or a bad Message-ID
 */
export function buildRawMessage(e: OutgoingEmail): string {
  const from = oneAddress("from", e.from);
  const to = e.to.map((v) => oneAddress("to", v));
  const cc = e.cc.map((v) => oneAddress("cc", v));
  if (to.length === 0) throw new Error("mime: no recipients");
  assertNoNewline("subject", e.subject);
  assertNoNewline("messageId", e.messageId);
  if (!MSG_ID.test(e.messageId)) throw new Error("mime: invalid Message-ID");
  if (e.inReplyTo !== undefined) {
    assertNoNewline("inReplyTo", e.inReplyTo);
    if (!/^<[^<>\s]+>$/.test(e.inReplyTo)) throw new Error("mime: invalid In-Reply-To");
  }
  if (e.references !== undefined) {
    assertNoNewline("references", e.references);
    if (!/^(<[^<>\s]+>)( <[^<>\s]+>)*$/.test(e.references.trim())) throw new Error("mime: invalid References");
  }

  const lines = [
    header("From", renderAddress(from)),
    header("To", to.map(renderAddress).join(", ")),
    ...(cc.length ? [header("Cc", cc.map(renderAddress).join(", "))] : []),
    header("Subject", encodeHeaderWord(e.subject)),
    header("Date", (e.date ?? new Date()).toUTCString().replace("GMT", "+0000")),
    header("Message-ID", e.messageId),
    ...(e.inReplyTo ? [header("In-Reply-To", e.inReplyTo)] : []),
    ...(e.references ? [header("References", e.references.trim())] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = e.bodyText.replace(/\r\n?|\n/g, "\r\n");
  const message = `${lines.join("\r\n")}\r\n\r\n${wrap76(Buffer.from(body, "utf8").toString("base64"))}\r\n`;
  return Buffer.from(message, "utf8").toString("base64url");
}
