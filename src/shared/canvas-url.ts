// OWNER: 1.4

/**
 * Canvas feed URL normalization (V2-05 §2.6 step 1, §7.1 `canvas-url.ts`). Pure, client-safe
 * (no Node imports: the web's setup page runs this too).
 *
 * The feed URL is a bearer secret. This module never logs; callers log `host` + a fingerprint only.
 */
import { isListedCanvasHost } from "@/shared/universities";

/** Canvas per-student calendar feed path (`SecureRandom.alphanumeric(40)` today; legacy ids vary). */
export const CANVAS_FEED_PATH_RE = /^\/feeds\/calendars\/user_[A-Za-z0-9]{20,64}\.ics$/;

/** Feeds that exist but lack the per-student calendar (friendly error instead of "not a feed"). */
const OTHER_FEED_PATH_RE = /^\/feeds\/calendars\/(?:course|enrollment|group_membership|group)_[A-Za-z0-9]+\.ics$/i;

const INSTRUCTURE_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.instructure\.com$/;
const DNS_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const IPV4_LITERAL_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const ALLOWED_SCHEMES = new Set(["https", "http", "webcal", "webcals"]);
/** Leading/trailing wrappers people paste around links (markdown, chat apps, smart quotes). */
const LEADING_JUNK = new Set(["<", "(", '"', "'", "`", "“", "‘", "[", "{"]);
const TRAILING_JUNK = new Set([">", ")", '"', "'", "`", "”", "’", "]", "}", ".", ",", ";", ":", "!", "?"]);
const SCHEME_START_RE = /(?:webcals?|https?):\/\//i;
const FEED_MARKER = "/feeds/calendars/";

/** How much we trust a feed host (V2-05 §2.6 step 2). */
export type CanvasHostClass = "instructure" | "listed" | "unlisted";

/** Why a pasted string is not an acceptable Canvas feed URL. */
export type FeedUrlError =
  | "empty"
  | "not_a_url"
  | "bad_scheme"
  | "has_credentials"
  | "bad_port"
  | "ip_literal"
  | "bad_host"
  | "has_query"
  | "course_feed"
  | "not_feed_path"
  | "parser_mismatch";

/** A normalized Canvas user calendar feed URL. */
export interface CanvasFeedUrl {
  href: string;
  host: string;
  hostClass: CanvasHostClass;
}

/** Result of {@link normalizeCanvasFeedUrl}. */
export type NormalizeResult = { ok: true; url: CanvasFeedUrl } | { ok: false; error: FeedUrlError };

/**
 * Full normalization, shape check, and host classification (server and client).
 * Steps: trim and unwrap; `webcal://`/`http://` → `https://`; WHATWG parse; reject userinfo, a
 * non-default port, IP literals, single-label hosts, a query, `%2f`/`..`; lower-case host and drop a
 * trailing dot; require the exact feed path; drop the fragment; re-serialize from parts and reject
 * if re-parsing disagrees on the host.
 * @param input raw text the user pasted (may include `<…>`, quotes, trailing punctuation)
 * @returns `{ok:true, url}` with `href = "https://<host>/feeds/calendars/user_<id>.ics"`, or an error code
 */
export function normalizeCanvasFeedUrl(input: string): NormalizeResult {
  if (typeof input !== "string") return { ok: false, error: "empty" };
  let s = unwrap(input);
  if (s === "") return { ok: false, error: "empty" };
  if (hasSpaceOrControl(s)) return { ok: false, error: "not_a_url" };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (scheme && s.slice(scheme[0].length).startsWith("//")) {
    if (!ALLOWED_SCHEMES.has(scheme[1].toLowerCase())) return { ok: false, error: "bad_scheme" };
    s = `https:${s.slice(scheme[0].length)}`;
  } else if (scheme && !/^[a-z0-9-]+(\.[a-z0-9-]+)+:\d+/i.test(s)) {
    // "javascript:…", "mailto:…" (but not a scheme-less "host:port/…", handled below)
    return { ok: false, error: "bad_scheme" };
  } else {
    if (!s.includes(".") || s.startsWith("/")) return { ok: false, error: "not_a_url" };
    s = `https://${s}`;
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "not_a_url" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "bad_scheme" };
  if (u.username !== "" || u.password !== "") return { ok: false, error: "has_credentials" };
  if (u.port !== "") return { ok: false, error: "bad_port" };

  const rawHost = u.hostname;
  if (rawHost.startsWith("[")) return { ok: false, error: "ip_literal" };
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  if (IPV4_LITERAL_RE.test(host)) return { ok: false, error: "ip_literal" };
  if (host.length === 0 || host.length > 253 || !DNS_HOST_RE.test(host)) {
    return { ok: false, error: "bad_host" };
  }
  if (host.split(".").some((label) => label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
    return { ok: false, error: "bad_host" };
  }

  if (u.search !== "") return { ok: false, error: "has_query" };

  const path = u.pathname;
  if (/%2f|%5c|%2e/i.test(path) || path.includes("..") || path.includes("//")) {
    return { ok: false, error: "not_feed_path" };
  }
  if (OTHER_FEED_PATH_RE.test(path)) return { ok: false, error: "course_feed" };
  if (!CANVAS_FEED_PATH_RE.test(path)) return { ok: false, error: "not_feed_path" };

  const href = `https://${host}${path}`;
  let reparsed: URL;
  try {
    reparsed = new URL(href);
  } catch {
    return { ok: false, error: "parser_mismatch" };
  }
  if (reparsed.hostname !== host || reparsed.pathname !== path || reparsed.href !== href) {
    return { ok: false, error: "parser_mismatch" };
  }

  return { ok: true, url: { href, host, hostClass: classifyCanvasHost(host) } };
}

/**
 * Codes the client pre-check can show (each has copy in `CANVAS_ERROR_COPY`). `empty` is
 * client-only; the rest are exactly the `CanvasConnectError`s the server returns for a URL failure.
 */
export type PrecheckErrorCode = "empty" | "not_a_url" | "not_ical" | "course_feed" | "private_address";

/**
 * Maps a normalization failure to the user-facing code. The server's `connectErrorForUrl`
 * (`integrations/canvas/connect.ts`) calls this too (turning the client-only `empty` into
 * `not_a_url`), so the pre-check and the server always show the same copy.
 * @param e `normalizeCanvasFeedUrl` error
 * @returns user-facing code
 */
export function precheckErrorFor(e: FeedUrlError): PrecheckErrorCode {
  switch (e) {
    case "empty":
      return "empty";
    case "not_a_url":
    case "bad_scheme":
      return "not_a_url";
    case "ip_literal":
      return "private_address";
    case "course_feed":
      return "course_feed";
    default:
      return "not_ical";
  }
}

/**
 * Client pre-check shape for the web setup form (wrapper over {@link normalizeCanvasFeedUrl}).
 * @param raw pasted text
 * @returns `{ok:true, normalized}` (the https href) or the specific error code for inline copy
 *   (`course_feed` for a one-course feed, `private_address` for an IP literal, else `not_ical`)
 */
export function precheckIcalUrl(raw: string): { ok: true; normalized: string } | { ok: false; code: PrecheckErrorCode } {
  const r = normalizeCanvasFeedUrl(raw);
  if (r.ok) return { ok: true, normalized: r.url.href };
  return { ok: false, code: precheckErrorFor(r.error) };
}

/**
 * Classifies a normalized host.
 * @param host lower-case host
 * @returns "instructure" for `*.instructure.com`, "listed" for a host in `universities.ts`, else "unlisted"
 *   (unlisted is accepted only when the fetched response proves it is Canvas)
 */
export function classifyCanvasHost(host: string): CanvasHostClass {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (INSTRUCTURE_HOST_RE.test(h)) return "instructure";
  if (isListedCanvasHost(h)) return "listed";
  return "unlisted";
}

/**
 * Canvas feed URLs in free text (user-authored chat), normalized, deduped by href, in order.
 * Linear time: scans whitespace-separated tokens, no backtracking regex over the whole text.
 * @param text message body
 * @returns accepted feed URLs (rejected candidates are skipped)
 */
export function findCanvasFeedUrls(text: string): CanvasFeedUrl[] {
  if (typeof text !== "string" || text === "") return [];
  const out: CanvasFeedUrl[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\S+/g)) {
    const span = candidateSpan(m[0]);
    if (!span) continue;
    const r = normalizeCanvasFeedUrl(m[0].slice(span.start, span.end));
    if (r.ok && !seen.has(r.url.href)) {
      seen.add(r.url.href);
      out.push(r.url);
    }
  }
  return out;
}

/**
 * Replaces Canvas feed URLs in text with a placeholder (chat-history redaction after connect).
 * Errs on the side of secrecy: any token containing `/feeds/calendars/` is redacted, accepted or not.
 * @param text message body
 * @param placeholder replacement (default "[Canvas feed link]")
 * @returns text with each feed URL replaced; surrounding punctuation and whitespace are kept
 */
export function redactCanvasFeedUrls(text: string, placeholder = "[Canvas feed link]"): string {
  if (typeof text !== "string" || text === "") return text;
  return text.replace(/\S+/g, (token) => {
    const span = candidateSpan(token);
    if (!span) return token;
    return token.slice(0, span.start) + placeholder + token.slice(span.end);
  });
}

/**
 * Short, non-secret hint for status UIs.
 * @param url normalized feed URL
 * @returns e.g. "yale.instructure.com/feeds/…a1b2" (last 4 chars of the feed id only)
 */
export function feedUrlHint(url: CanvasFeedUrl): string {
  const m = /user_([A-Za-z0-9]+)\.ics$/.exec(url.href);
  const tail = m ? m[1].slice(-4) : "";
  return `${url.host}/feeds/…${tail}`;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Strips whitespace, wrapping brackets/quotes, and trailing sentence punctuation. */
function unwrap(input: string): string {
  let s = input.trim();
  for (let i = 0; i < 3; i++) {
    const next = s.slice(leadingJunkLength(s), trailingJunkStart(s)).trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Count of leading wrapper characters (linear scan; no regex backtracking). */
function leadingJunkLength(s: string): number {
  let i = 0;
  while (i < s.length && LEADING_JUNK.has(s[i])) i++;
  return i;
}

/** Index where trailing wrapper/punctuation characters begin (s.length if none). */
function trailingJunkStart(s: string): number {
  let i = s.length;
  while (i > 0 && TRAILING_JUNK.has(s[i - 1])) i--;
  return i;
}

/** True if `s` contains whitespace or an ASCII control character. */
function hasSpaceOrControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff) return true;
  }
  return false;
}

/**
 * Where a feed URL sits inside one whitespace-free token, or null if the token has none.
 * Starts at a scheme if present (so "link:https://…" works), else after leading wrappers.
 */
function candidateSpan(token: string): { start: number; end: number } | null {
  const lower = token.toLowerCase();
  const marker = lower.indexOf(FEED_MARKER);
  if (marker < 0) return null;
  const schemeMatch = SCHEME_START_RE.exec(token);
  let start: number;
  if (schemeMatch && schemeMatch.index < marker) {
    start = schemeMatch.index;
  } else {
    start = leadingJunkLength(token);
  }
  const end = trailingJunkStart(token);
  if (end <= start || end <= marker) return null;
  return { start, end };
}
