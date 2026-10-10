import "server-only";
// OWNER: 2.5

/**
 * Pure Gmail header / body helpers (V2-07 §7.3 `gmail/headers.ts`). No I/O.
 *
 * - `parseAddressList`: RFC 5322 address lists (quoted names with commas, RFC 2047 encoded words,
 *   bare addresses, groups, comments)
 * - `metaFromGmail`: `format=metadata` message → `EmailMeta`
 * - `extractPlainText`: MIME walk of a `format=full` message → readable text (plain preferred,
 *   HTML converted, quoted history stripped, capped). The result is for an in-memory prompt only;
 *   it is never persisted.
 * - `gmailPermalink`, `decodePushData`
 */
import type { Address, EmailMeta } from "@/server/integrations/google/gmail/types";
import type {
  GmailHeaderT,
  GmailMessageFullT,
  GmailMessageMetaT,
  GmailMessagePartT,
} from "@/server/integrations/google/gmail/schemas";

export type { Address, EmailMeta };

// ── RFC 2047 encoded words ──────────────────────────────────────────────────

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.toLowerCase().split("*")[0]; // RFC 2231 language suffix: "utf-8*en"
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function qWordBytes(text: string): Uint8Array {
  const s = text.replace(/_/g, " ");
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Decode RFC 2047 encoded words (`=?UTF-8?B?…?=`, `=?ISO-8859-1?Q?…?=`) in a header value.
 * Whitespace between two adjacent encoded words is dropped (RFC 2047 §6.2).
 * @param v raw header value
 * @returns decoded text (unknown charsets fall back to UTF-8; malformed words are left as is)
 */
export function decodeEncodedWords(v: string): string {
  if (!v.includes("=?")) return v;
  // Join adjacent encoded words first so multi-byte sequences split across words decode together.
  const joined = v.replace(/(\?=)\s+(?==\?)/g, "$1");
  return joined.replace(ENCODED_WORD, (whole, charset: string, enc: string, text: string) => {
    try {
      const bytes = enc.toUpperCase() === "B" ? Uint8Array.from(Buffer.from(text, "base64")) : qWordBytes(text);
      return decodeBytes(bytes, charset);
    } catch {
      return whole;
    }
  });
}

// ── Address lists ───────────────────────────────────────────────────────────

const BARE_EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Split on top-level separators (`,` and group `;`), respecting quotes, angles and comments. */
function splitTopLevel(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (inQuote) {
      cur += c;
      if (c === "\\" && i + 1 < v.length) cur += v[++i];
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"' && comment === 0) inQuote = true;
    else if (c === "(") comment++;
    else if (c === ")" && comment > 0) comment--;
    else if (comment === 0 && c === "<") angle++;
    else if (comment === 0 && c === ">" && angle > 0) angle--;
    else if (comment === 0 && angle === 0 && c === ":") {
      // Group syntax "Team: a@x, b@y;" → drop the display name, keep the members.
      cur = "";
      continue;
    } else if (comment === 0 && angle === 0 && (c === "," || c === ";")) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function stripComments(s: string): { text: string; comments: string[] } {
  const comments: string[] = [];
  let text = "";
  let depth = 0;
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (depth === 0 && c === '"') inQuote = !inQuote;
    if (!inQuote && c === "(") {
      if (depth > 0) buf += c;
      depth++;
      continue;
    }
    if (!inQuote && c === ")" && depth > 0) {
      depth--;
      if (depth === 0) {
        comments.push(buf.trim());
        buf = "";
      } else buf += c;
      continue;
    }
    if (depth > 0) buf += c;
    else text += c;
  }
  return { text, comments };
}

function unquoteName(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  s = decodeEncodedWords(s).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

function cleanEmail(raw: string): string | null {
  const e = raw.trim().replace(/^mailto:/i, "").toLowerCase();
  return BARE_EMAIL.test(e) ? e : null;
}

/**
 * Parse an RFC 5322 address-list header (`From`, `To`, `Cc`, `Reply-To`).
 * @param v raw header value (may contain encoded words, quoted names with commas, groups)
 * @returns addresses with lower-cased emails; entries without a valid address are dropped
 */
export function parseAddressList(v: string): Address[] {
  const out: Address[] = [];
  for (const piece of splitTopLevel(v.replace(/\r?\n[ \t]+/g, " "))) {
    const lt = piece.lastIndexOf("<");
    const gt = piece.lastIndexOf(">");
    if (lt !== -1 && gt > lt) {
      const email = cleanEmail(piece.slice(lt + 1, gt));
      if (!email) continue;
      const { text, comments } = stripComments(piece.slice(0, lt));
      out.push({ email, name: unquoteName(text) ?? (comments[0] ? unquoteName(comments[0]) : null) });
      continue;
    }
    const { text, comments } = stripComments(piece);
    const email = cleanEmail(text);
    if (!email) continue;
    out.push({ email, name: comments[0] ? unquoteName(comments[0]) : null });
  }
  return out;
}

/**
 * Format an address for display (`Name <email>` or the bare email).
 * @param a address
 * @returns display string
 */
export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

// ── Message metadata ────────────────────────────────────────────────────────

/** Headers requested with `format=metadata` (V2-07 §2.9 step 5). */
export const METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "Message-ID",
  "References",
  "List-Unsubscribe",
  "Reply-To",
  "Auto-Submitted",
  "Precedence",
] as const;

/**
 * First header with this name (case-insensitive).
 * @param headers Gmail header array
 * @param name header name
 * @returns the unfolded value, or null
 */
export function headerValue(headers: readonly GmailHeaderT[] | undefined, name: string): string | null {
  const lower = name.toLowerCase();
  const h = headers?.find((x) => x.name.toLowerCase() === lower);
  return h ? h.value.replace(/\r?\n[ \t]+/g, " ").trim() : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  zwnj: "",
  zwj: "",
};

/**
 * Decode HTML entities (named subset + numeric). Gmail snippets are entity-encoded.
 * @param s text with entities
 * @returns decoded text
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function messageIdToken(v: string | null): string | null {
  if (!v) return null;
  const m = /<[^<>\s]+>/.exec(v);
  if (m) return m[0];
  const bare = v.trim();
  return bare && !/\s/.test(bare) ? `<${bare}>` : null;
}

/**
 * Map a `format=metadata` Gmail message to `EmailMeta`.
 * @param m validated Gmail message (metadata format)
 * @returns normalized metadata (decoded subject/names, lower-cased emails, received time)
 */
export function metaFromGmail(m: GmailMessageMetaT): EmailMeta {
  const headers = m.payload?.headers;
  const h = (n: string) => headerValue(headers, n);
  const fromList = parseAddressList(h("From") ?? "");
  let internalDate = new Date(Number(m.internalDate ?? NaN));
  if (Number.isNaN(internalDate.getTime())) {
    const d = new Date(h("Date") ?? "");
    internalDate = Number.isNaN(d.getTime()) ? new Date(0) : d;
  }
  const auto = h("Auto-Submitted");
  const precedence = h("Precedence");
  return {
    id: m.id,
    threadId: m.threadId,
    labels: m.labelIds ?? [],
    snippet: decodeHtmlEntities(m.snippet ?? ""),
    internalDate,
    from: fromList[0] ?? null,
    replyTo: parseAddressList(h("Reply-To") ?? ""),
    to: parseAddressList(h("To") ?? ""),
    cc: parseAddressList(h("Cc") ?? ""),
    subject: decodeEncodedWords(h("Subject") ?? "").replace(/\s+/g, " ").trim(),
    messageId: messageIdToken(h("Message-ID")),
    references: h("References"),
    listUnsubscribe: h("List-Unsubscribe") !== null,
    autoSubmitted: auto ? auto.toLowerCase() : null,
    precedence: precedence ? precedence.toLowerCase() : null,
  };
}

// ── Body text ───────────────────────────────────────────────────────────────

function b64urlToBytes(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

/** Content-Type parameter (e.g. charset), unquoted. */
function ctParam(contentType: string | null, name: string): string | null {
  if (!contentType) return null;
  const m = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(contentType);
  return m ? (m[2] ?? m[1]) : null;
}

/**
 * Decode quoted-printable bytes (RFC 2045 §6.7).
 * @param s QP text
 * @returns raw bytes
 */
function qpToBytes(s: string): Uint8Array {
  const soft = s.replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const c = soft[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      out.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = soft.charCodeAt(i);
      if (code < 0x80) out.push(code);
      else for (const b of Buffer.from(c, "utf8")) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Decode one leaf part's body to text. Gmail normally returns transfer-decoded bytes; if the part
 * still looks quoted-printable (soft line breaks / `=3D`), decode QP as a fallback.
 */
function partText(p: GmailMessagePartT): string {
  const data = p.body?.data;
  if (!data) return "";
  const charset = ctParam(headerValue(p.headers, "Content-Type"), "charset") ?? "utf-8";
  const bytes = b64urlToBytes(data);
  const cte = (headerValue(p.headers, "Content-Transfer-Encoding") ?? "").toLowerCase();
  if (cte === "quoted-printable") {
    const latin = Buffer.from(bytes).toString("latin1");
    if (/=\r?\n|=[0-9A-F]{2}/.test(latin)) return decodeBytes(qpToBytes(latin), charset);
  }
  return decodeBytes(bytes, charset);
}

function isAttachment(p: GmailMessagePartT): boolean {
  if (p.filename) return true;
  const disp = (headerValue(p.headers, "Content-Disposition") ?? "").toLowerCase();
  return disp.startsWith("attachment");
}

function mimeOf(p: GmailMessagePartT): string {
  return (p.mimeType ?? "").toLowerCase();
}

/** Pick the best text body of a part tree: `{kind, text}` or null. */
function bestBody(p: GmailMessagePartT): { kind: "plain" | "html"; text: string } | null {
  const mime = mimeOf(p);
  if (mime.startsWith("multipart/")) {
    const kids = (p.parts ?? []).filter((k) => !isAttachment(k));
    if (mime === "multipart/alternative") {
      // Prefer plain; fall back to html; then any nested multipart.
      let html: { kind: "plain" | "html"; text: string } | null = null;
      for (const k of kids) {
        const b = bestBody(k);
        if (b?.kind === "plain" && b.text.trim()) return b;
        if (b && !html) html = b;
      }
      return html;
    }
    // mixed / related / signed / report: concatenate readable children in order.
    const pieces: { kind: "plain" | "html"; text: string }[] = [];
    for (const k of kids) {
      const b = bestBody(k);
      if (b && b.text.trim()) pieces.push(b);
    }
    if (pieces.length === 0) return null;
    return { kind: "plain", text: pieces.map((b) => (b.kind === "html" ? htmlToText(b.text) : b.text)).join("\n\n") };
  }
  if (isAttachment(p)) return null;
  if (mime === "text/plain" || mime === "") return { kind: "plain", text: partText(p) };
  if (mime === "text/html") return { kind: "html", text: partText(p) };
  return null;
}

/**
 * Convert HTML to readable text: drops scripts, styles, head, comments and Gmail/Outlook quoted
 * blocks; block tags become newlines; entities are decoded.
 * @param html HTML source
 * @returns plain text
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    // Gmail quoted history and Outlook's reply container.
    .replace(/<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][\s\S]*$/i, "")
    .replace(/<blockquote\b[\s\S]*?<\/blockquote\s*>/gi, "")
    .replace(/<div[^>]*id=["']?(divRplyFwdMsg|appendonsend)["']?[\s\S]*$/i, "");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(s)
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Remove quoted reply history from plain text: everything from an "On … wrote:" attribution,
 * an "-----Original Message-----" separator or an Outlook "From: … Sent: …" block, plus any
 * remaining `>`-quoted lines.
 * @param text plain text body
 * @returns the new content only
 */
export function stripQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const two = `${l} ${(lines[i + 1] ?? "").trim()}`;
    if (
      /^-{2,}\s*original message\s*-{2,}$/i.test(l) ||
      /^_{10,}$/.test(l) ||
      /^on\b.{0,200}\bwrote:$/i.test(l) ||
      (/^on\b/i.test(l) && !/wrote:$/i.test(l) && /^on\b.{0,250}\bwrote:$/i.test(two)) ||
      (/^from:\s/i.test(l) && /^(sent|date):\s/i.test((lines[i + 1] ?? "").trim()))
    ) {
      cut = i;
      break;
    }
  }
  return lines
    .slice(0, cut)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Readable text of a full Gmail message, for an in-memory prompt only (never persisted).
 * MIME walk (plain preferred over HTML, attachments ignored), base64url / QP decoding, charset
 * conversion, HTML → text, quoted history stripped, capped at `maxChars`.
 * @param m validated `format=full` message
 * @param maxChars maximum characters returned (an ellipsis marks truncation)
 * @returns plain text ("" when the message has no readable body)
 */
export function extractPlainText(m: GmailMessageFullT, maxChars: number): string {
  if (!m.payload || maxChars <= 0) return "";
  const body = bestBody(m.payload);
  if (!body) return "";
  const text = stripQuotedHistory(body.kind === "html" ? htmlToText(body.text) : body.text);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

// ── Links + push payload ────────────────────────────────────────────────────

/**
 * Gmail web permalink for a message (searches by RFC 822 Message-ID in the right account).
 * @param rfc822MessageId Message-ID header, with or without angle brackets
 * @param accountEmail the connected Google account (selects the signed-in account)
 * @returns `https://mail.google.com/mail/u/<account>/#search/rfc822msgid%3A<id>`
 */
export function gmailPermalink(rfc822MessageId: string, accountEmail: string): string {
  const id = rfc822MessageId.trim().replace(/^<|>$/g, "");
  return `https://mail.google.com/mail/u/${encodeURIComponent(accountEmail.trim().toLowerCase())}/#search/${encodeURIComponent(`rfc822msgid:${id}`)}`;
}

/**
 * Decode a Gmail Pub/Sub `message.data` (base64 or base64url JSON `{emailAddress, historyId}`).
 * @param b64 base64 / base64url string, padding optional
 * @returns the lower-cased mailbox and history id, or null for anything malformed
 */
export function decodePushData(b64: string): { emailAddress: string; historyId: string } | null {
  if (typeof b64 !== "string" || b64.length === 0 || b64.length > 4096) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (typeof json !== "object" || json === null) return null;
    const rec = json as Record<string, unknown>;
    const email = typeof rec.emailAddress === "string" ? rec.emailAddress.trim().toLowerCase() : "";
    const hid = typeof rec.historyId === "number" ? String(rec.historyId) : rec.historyId;
    if (!BARE_EMAIL.test(email) || typeof hid !== "string" || !/^[0-9]{1,20}$/.test(hid)) return null;
    return { emailAddress: email, historyId: hid };
  } catch {
    return null;
  }
}
