import "server-only";
// OWNER: 1.4

/**
 * SSRF-safe Canvas feed fetch (V2-05 §2.6 steps 5–9, §7.2 `fetch-feed.ts`).
 *
 * - `node:https` to a pre-validated, pinned IP (custom `lookup` never re-resolves), with SNI and
 *   certificate checks against the real hostname. No global `fetch` (it can't pin).
 * - Redirects are never auto-followed: each `Location` is re-normalized and re-resolved (≤ 3 hops).
 * - 10 MiB cap on raw and on decompressed bytes (gzip-bomb safe); connect/header/total timeouts.
 * - Never throws for network or policy failures, and never logs (the URL is a bearer secret).
 */
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";
import { gunzipSync, inflateSync } from "node:zlib";
import { appBaseUrl } from "@/server/env";
import { resolvePublicHost, type ResolvedAddress, type Resolver } from "@/server/integrations/canvas/ssrf";
import { CANVAS_FEED_PATH_RE, normalizeCanvasFeedUrl, type CanvasFeedUrl } from "@/shared/canvas-url";

export type FeedFetchErrorCode =
  | "feed_not_found"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "dns_failed"
  | "non_public_address"
  | "tls_error"
  | "too_large"
  | "not_calendar"
  | "redirect_rejected"
  | "too_many_redirects"
  | "network";
export type FeedFetchClass = "ok" | "definitive" | "slow_transient" | "transient" | "rejected";

/** A fetched calendar body. `canvasMeta` = the final response carried `x-canvas-meta`. */
export interface FeedFetchOk {
  ok: true;
  body: Uint8Array;
  finalUrl: CanvasFeedUrl;
  contentType: string;
  canvasMeta: boolean;
}
/** A classified failure (`cls` drives backoff / revocation in `schedule.ts`). */
export interface FeedFetchErr {
  ok: false;
  code: FeedFetchErrorCode;
  cls: FeedFetchClass;
  status?: number;
}

/** One request to an already-validated address. */
export interface PinnedRequest {
  url: URL;
  pinned: ResolvedAddress;
  headers: Record<string, string>;
  timeoutMs: number;
}
/** Response handle; `abort()` tears down the connection without reading the rest. */
export interface PinnedResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  abort(): void;
}
/** HTTP transport (injectable for tests). Rejects with {@link TransportError} on failure. */
export interface FeedTransport {
  request(args: PinnedRequest): Promise<PinnedResponse>;
}

/** Transport-level failure kind. */
export type TransportErrorCode = "timeout" | "tls_error" | "network";

/** Error a {@link FeedTransport} rejects with. */
export class TransportError extends Error {
  /** Failure kind, mapped to a {@link FeedFetchErrorCode}. */
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message?: string) {
    super(message ?? `transport ${code}`);
    this.name = "TransportError";
    this.code = code;
  }
}

/** Options for {@link fetchCanvasFeed}. */
export interface FetchFeedOptions {
  resolver?: Resolver;
  transport?: FeedTransport;
  maxBytes?: number;
  maxRedirects?: number;
  totalTimeoutMs?: number;
}

/** 10 MiB body cap (raw and decompressed). */
export const MAX_FEED_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 5_000;
const HEADERS_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "EPROTO",
]);

/**
 * `lookup` for `https.request` that always answers with the pinned address and never touches DNS.
 * Handles both callback shapes (`all: true` is used by Node's happy-eyeballs path).
 * @param pinned the validated address
 * @returns a `net.LookupFunction`
 */
export function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: { all?: boolean } | number | undefined, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    const all = typeof options === "object" && options !== null && options.all === true;
    if (all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  }) as LookupFunction;
}

/** Test seams for {@link createHttpsTransport}; production uses the defaults (port 443, system CAs). */
export interface HttpsTransportOptions {
  port?: number;
  ca?: string | Buffer;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
}

/**
 * Builds a `node:https` transport pinned to `args.pinned`: `host` and `servername` are the URL's
 * hostname (SNI + certificate verification), `lookup` returns the pinned IP, no agent reuse, no cookies.
 * @param opts test seams (port/CA); omit in production
 * @returns a {@link FeedTransport}
 */
export function createHttpsTransport(opts: HttpsTransportOptions = {}): FeedTransport {
  return {
    request(args: PinnedRequest): Promise<PinnedResponse> {
      return new Promise<PinnedResponse>((resolve, reject) => {
        let settled = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        const clear = () => timers.forEach((t) => clearTimeout(t));
        const req = https.request({
          protocol: "https:",
          host: args.url.hostname,
          servername: args.url.hostname,
          port: opts.port ?? 443,
          path: args.url.pathname,
          method: "GET",
          headers: args.headers,
          lookup: pinnedLookup(args.pinned),
          agent: false,
          ca: opts.ca,
        });
        const fail = (err: TransportError) => {
          if (settled) return;
          settled = true;
          clear();
          req.destroy();
          reject(err);
        };
        const connectMs = Math.min(opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, args.timeoutMs);
        const headersMs = Math.min(opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS, args.timeoutMs);
        const connectTimer = setTimeout(() => fail(new TransportError("timeout", "connect timeout")), connectMs);
        timers.push(connectTimer, setTimeout(() => fail(new TransportError("timeout", "headers timeout")), headersMs));
        req.on("socket", (socket) => {
          socket.once("secureConnect", () => clearTimeout(connectTimer));
        });
        req.on("response", (res) => {
          if (settled) {
            res.destroy();
            return;
          }
          settled = true;
          clear();
          resolve({
            status: res.statusCode ?? 0,
            headers: flattenHeaders(res.headers),
            body: res,
            abort: () => {
              res.destroy();
              req.destroy();
            },
          });
        });
        req.on("error", (err: NodeJS.ErrnoException) => fail(toTransportError(err)));
        req.end();
      });
    },
  };
}

/** Production transport: `node:https`, port 443, system CAs, pinned lookup. */
export const httpsTransport: FeedTransport = createHttpsTransport();

/**
 * SSRF-safe fetch of a normalized feed URL. Resolves + validates every hop, follows at most
 * `maxRedirects` redirects manually, caps the body, and checks it is a calendar.
 * @param url normalized feed URL from `normalizeCanvasFeedUrl`
 * @param opts injectable resolver/transport and limits (defaults: system DNS, `httpsTransport`, 10 MiB, 3, 20s)
 * @returns the body and final URL, or a classified error. Never throws for network/policy errors.
 */
export async function fetchCanvasFeed(url: CanvasFeedUrl, opts: FetchFeedOptions = {}): Promise<FeedFetchOk | FeedFetchErr> {
  const resolver = opts.resolver;
  const transport = opts.transport ?? httpsTransport;
  const maxBytes = opts.maxBytes ?? MAX_FEED_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const deadline = Date.now() + (opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  const headers = requestHeaders();

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return err("timeout", "transient");

    const resolved = await raceDeadline(resolvePublicHost(current.host, resolver), deadline);
    if (resolved === TIMED_OUT) return err("timeout", "transient");
    if (!resolved.ok) {
      if (resolved.error === "dns_failed") return err("dns_failed", "transient");
      return hop === 0 ? err("non_public_address", "rejected") : err("redirect_rejected", "rejected");
    }

    let res: PinnedResponse;
    try {
      const pending = transport.request({
        url: new URL(current.href),
        pinned: resolved.pinned,
        headers,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      const r = await raceDeadline(pending, deadline);
      if (r === TIMED_OUT) {
        pending.then((late) => late.abort(), () => undefined);
        return err("timeout", "transient");
      }
      res = r;
    } catch (e) {
      const code = e instanceof TransportError ? e.code : "network";
      return err(code, "transient");
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      res.abort();
      const next = nextHop(current, res.headers.location);
      if (!next.ok) return { ...next.err, status: res.status };
      current = next.url;
      continue;
    }

    const contentType = mediaType(res.headers["content-type"]);
    if (res.status !== 200 || contentType === "text/html") {
      res.abort();
      return classifyHttpFailure(res.status, res.headers, contentType);
    }

    const body = await readCapped(res, maxBytes, deadline);
    if (!body.ok) return body.err;

    const decoded = decodeBody(body.bytes, res.headers["content-encoding"], maxBytes);
    if (!decoded.ok) return decoded.err;
    // text/calendar, text/plain, octet-stream, or anything else: the body must prove it's a calendar.
    if (!startsWithVcalendar(decoded.bytes)) return err("not_calendar", "definitive", 200);

    return {
      ok: true,
      body: decoded.bytes,
      finalUrl: current,
      contentType: contentType || "text/calendar",
      canvasMeta: typeof res.headers["x-canvas-meta"] === "string",
    };
  }
  return err("too_many_redirects", "rejected");
}

/**
 * Maps a non-OK HTTP outcome to an error code and class (pure).
 * - 400 + `x-canvas-meta` with `n=public_feed`, 404, 410 → `feed_not_found` / definitive
 * - other 400 → `feed_not_found` / slow_transient (unproven, so never revokes on its own)
 * - 401/403 → `forbidden` / slow_transient (may be a WAF blocking our egress)
 * - 429 → `rate_limited`, 5xx and anything else → `server_error` (transient)
 * - 200 `text/html` → `not_calendar` / definitive (login or error page)
 * @param status HTTP status
 * @param headers lower-cased response headers
 * @param contentType media type, lower-case, no parameters
 * @returns the classified failure
 */
export function classifyHttpFailure(
  status: number,
  headers: Record<string, string | undefined>,
  contentType: string,
): FeedFetchErr {
  if (status >= 200 && status < 300) {
    // 2xx reaches here only for a non-calendar page (text/html login/error page)
    void contentType;
    return err("not_calendar", "definitive", status);
  }
  if (status === 400) {
    const meta = headers["x-canvas-meta"] ?? "";
    return /(?:^|;)\s*n=public_feed\s*(?:;|$)/.test(meta)
      ? err("feed_not_found", "definitive", status)
      : err("feed_not_found", "slow_transient", status);
  }
  if (status === 404 || status === 410) return err("feed_not_found", "definitive", status);
  if (status === 401 || status === 403) return err("forbidden", "slow_transient", status);
  if (status === 429) return err("rate_limited", "transient", status);
  return err("server_error", "transient", status);
}

/**
 * Whether a fetched feed may be accepted for its host class (V2-05 §2.6 step 2): instructure and
 * listed hosts always; unlisted hosts only with `x-canvas-meta` AND a Canvas-shaped body.
 * @param fetched the successful fetch
 * @param looksLikeCanvas `ParsedCanvasFeed.looksLikeCanvas` for the body
 * @returns true when the source is acceptable
 */
export function isAcceptableFeedSource(fetched: FeedFetchOk, looksLikeCanvas: boolean): boolean {
  if (fetched.finalUrl.hostClass !== "unlisted") return true;
  return fetched.canvasMeta && looksLikeCanvas;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const TIMED_OUT = Symbol("timed_out");

function err(code: FeedFetchErrorCode, cls: FeedFetchClass, status?: number): FeedFetchErr {
  return status === undefined ? { ok: false, code, cls } : { ok: false, code, cls, status };
}

function requestHeaders(): Record<string, string> {
  let base = "";
  try {
    base = appBaseUrl();
  } catch {
    base = "";
  }
  return {
    accept: "text/calendar",
    "accept-encoding": "gzip",
    "user-agent": base ? `AriaCalendarSync/1.0 (+${base})` : "AriaCalendarSync/1.0",
  };
}

/** Resolves `p`, or {@link TIMED_OUT} once `deadline` (epoch ms) passes. */
async function raceDeadline<T>(p: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  p.catch(() => undefined); // a late rejection after the deadline must not go unhandled
  const ms = deadline - Date.now();
  if (ms <= 0) return TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Validates a redirect target: https only, feed path (else `feed_not_found`), full URL policy. */
function nextHop(
  current: CanvasFeedUrl,
  location: string | undefined,
): { ok: true; url: CanvasFeedUrl } | { ok: false; err: FeedFetchErr } {
  if (!location) return { ok: false, err: err("server_error", "transient") };
  let target: URL;
  try {
    target = new URL(location, current.href);
  } catch {
    return { ok: false, err: err("redirect_rejected", "rejected") };
  }
  if (target.protocol !== "https:") return { ok: false, err: err("redirect_rejected", "rejected") };
  if (!CANVAS_FEED_PATH_RE.test(target.pathname)) {
    // e.g. a redirect to /login: the feed is gone or private. No request is made to the target.
    return { ok: false, err: err("feed_not_found", "definitive") };
  }
  const normalized = normalizeCanvasFeedUrl(target.href);
  if (!normalized.ok) return { ok: false, err: err("redirect_rejected", "rejected") };
  return { ok: true, url: normalized.url };
}

async function readCapped(
  res: PinnedResponse,
  maxBytes: number,
  deadline: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; err: FeedFetchErr }> {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.abort();
    return { ok: false, err: err("too_large", "transient", 200) };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const it = res.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await raceDeadline(it.next(), deadline);
      if (step === TIMED_OUT) {
        res.abort();
        return { ok: false, err: err("timeout", "transient", 200) };
      }
      if (step.done) break;
      const chunk = step.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        res.abort();
        return { ok: false, err: err("too_large", "transient", 200) };
      }
      chunks.push(chunk);
    }
  } catch (e) {
    res.abort();
    return { ok: false, err: err(e instanceof TransportError ? e.code : "network", "transient", 200) };
  }
  return { ok: true, bytes: concat(chunks, total) };
}

/** Decompresses gzip/deflate with an output cap (zip-bomb safe). */
function decodeBody(
  bytes: Uint8Array,
  encodingHeader: string | undefined,
  maxBytes: number,
): { ok: true; bytes: Uint8Array } | { ok: false; err: FeedFetchErr } {
  const enc = (encodingHeader ?? "").trim().toLowerCase();
  if (enc === "" || enc === "identity") return { ok: true, bytes };
  try {
    if (enc === "gzip" || enc === "x-gzip") return { ok: true, bytes: new Uint8Array(gunzipSync(bytes, { maxOutputLength: maxBytes })) };
    if (enc === "deflate") return { ok: true, bytes: new Uint8Array(inflateSync(bytes, { maxOutputLength: maxBytes })) };
  } catch (e) {
    const tooBig = e instanceof RangeError || (e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE";
    return { ok: false, err: tooBig ? err("too_large", "transient", 200) : err("network", "transient", 200) };
  }
  return { ok: false, err: err("network", "transient", 200) };
}

/** True if the body starts with `BEGIN:VCALENDAR` after an optional BOM and whitespace. */
function startsWithVcalendar(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0d || bytes[i] === 0x0a)) i++;
  const head = new TextDecoder("utf-8").decode(bytes.subarray(i, i + 15));
  return head.toUpperCase() === "BEGIN:VCALENDAR";
}

function mediaType(header: string | undefined): string {
  return (header ?? "").split(";")[0].trim().toLowerCase();
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function flattenHeaders(h: IncomingHttpHeaders): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function toTransportError(e: NodeJS.ErrnoException): TransportError {
  const code = e.code ?? "";
  if (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_")) {
    return new TransportError("tls_error");
  }
  if (code === "ETIMEDOUT") return new TransportError("timeout");
  return new TransportError("network");
}
