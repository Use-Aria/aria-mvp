import "server-only";
// OWNER: 2.4

/**
 * The only Google network seam for user-authorized API calls (V2-07 §2.2, §7.1 `http.ts`).
 *
 * - Bearer token from `getGoogleAccess` (refresh-before-use, per-user refresh lock).
 * - 401 → force one refresh (passing the rejected token), then retry once.
 * - 429, 5xx, 403 `rateLimitExceeded`/`userRateLimitExceeded`, and network errors → backoff
 *   (0.5s, 2s, each scaled by up to 1.3x jitter; `Retry-After` honoured up to 10s), 3 tries in total.
 * - `retry: "none"` (non-idempotent writes: Gmail `messages.send`, Calendar `events.insert` and
 *   `calendars.insert`): never retried automatically. A failure that may have reached Google
 *   (timeout, network error, 5xx, 429, 403 rate limit, or a 2xx whose body can't be read) throws
 *   `GoogleWriteUnknownError` so the caller checks whether the write happened (Sent folder,
 *   `aria_key`, calendar list) instead of resending. A definite rejection (other 4xx) is a plain
 *   `GoogleApiError`. The 401 → refresh → resend-once stays: a 401 means Google didn't act.
 * - JSON responses are validated with the caller's zod schema; a mismatch throws
 *   (`GoogleApiError` reason `invalid_response`), never silently passes.
 *
 * Error messages carry the method, host+path, status and Google's `reason` only: never the
 * query string, the token, or the response body.
 */
import type { z } from "zod";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getGoogleAccess, type GoogleTokenDeps } from "@/server/integrations/google/tokens";

/** Retry policy: `"default"` (backoff on transient failures) or `"none"` (non-idempotent writes). */
export type GoogleRetryPolicy = "default" | "none";

export interface GoogleRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  query?: Record<string, string | string[] | number | boolean | undefined>;
  body?: unknown;
  /**
   * `"none"` disables every automatic retry (timeouts and network errors included) and turns an
   * ambiguous failure into `GoogleWriteUnknownError`. Required for any non-idempotent POST
   * (a resend could duplicate an email, event or calendar). Default `"default"`.
   */
  retry?: GoogleRetryPolicy;
}

/**
 * A no-retry write failed in a way that leaves its outcome unknown: Google may or may not have
 * carried it out (timeout, network error, 5xx, 429/rate limit, or an unreadable 2xx body).
 * Callers must check whether the write happened before doing anything else, and must never
 * resend blindly. `retryable` is always false.
 */
export class GoogleWriteUnknownError extends GoogleApiError {
  readonly outcome = "unknown" as const;

  constructor(message: string, o: { status: number; reason?: string }) {
    super(message, { status: o.status, reason: o.reason, retryable: false });
    this.name = "GoogleWriteUnknownError";
  }
}

/**
 * Type guard for `GoogleWriteUnknownError`.
 * @param e anything thrown
 * @returns true when a no-retry write's outcome is unknown
 */
export function isWriteOutcomeUnknown(e: unknown): e is GoogleWriteUnknownError {
  return e instanceof GoogleWriteUnknownError;
}

/** Injectable dependencies. `fetch` is used for both the API call and any token refresh. */
export interface GoogleFetchDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1) (tests pin it). */
  random?: () => number;
  /** Token-layer overrides (tests: in-memory store, fixed key, revoke hook). */
  tokens?: Omit<GoogleTokenDeps, "fetch">;
}

/** Total tries for retryable failures. */
export const MAX_TRIES = 3;
/** Backoff before try 2 and try 3. */
export const BACKOFF_MS: readonly number[] = [500, 2000];
const MAX_RETRY_AFTER_MS = 10_000;
const REQUEST_TIMEOUT_MS = 25_000;
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build the request URL with query parameters (arrays repeat the key; `undefined` is skipped).
 * Only `https://*.googleapis.com` URLs are allowed (tokens never go anywhere else).
 * @param req request
 * @returns absolute URL
 * @throws on a non-Google or non-HTTPS URL
 */
export function buildGoogleUrl(req: GoogleRequest): URL {
  const url = new URL(req.url);
  if (url.protocol !== "https:" || !(url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com"))) {
    throw new GoogleApiError("googleFetch: refusing a non-Google URL", { status: 0, reason: "bad_url", retryable: false });
  }
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, String(v));
  }
  return url;
}

/** Google's JSON error envelope → `reason` (errors[0].reason, else error.status). */
async function errorReason(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as { error?: { status?: unknown; errors?: { reason?: unknown }[] } | string };
    if (typeof j?.error === "string") return j.error;
    const first = j?.error?.errors?.[0]?.reason;
    if (typeof first === "string") return first;
    return typeof j?.error?.status === "string" ? j.error.status : undefined;
  } catch {
    return undefined;
  }
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS) : null;
}

function label(method: string, url: URL): string {
  return `${method} ${url.host}${url.pathname}`;
}

/**
 * Send with auth, 401-refresh-once and retry/backoff. Returns the successful (2xx) response.
 */
async function send(userId: string, req: GoogleRequest, deps: GoogleFetchDeps | undefined): Promise<Response> {
  const f = deps?.fetch ?? fetch;
  const sleep = deps?.sleep ?? realSleep;
  const random = deps?.random ?? Math.random;
  const tokenDeps: GoogleTokenDeps = { ...deps?.tokens, fetch: deps?.fetch };
  const method = req.method ?? "GET";
  const url = buildGoogleUrl(req);
  const hasBody = req.body !== undefined;
  const noRetry = req.retry === "none";

  let { accessToken } = await getGoogleAccess(userId, { deps: tokenDeps });
  let refreshed = false;

  for (let tryNo = 1; ; tryNo++) {
    let failure: { err: GoogleApiError; wait: number | null };
    try {
      const res = await f(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          ...(hasBody ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await res.body?.cancel().catch(() => undefined);
        ({ accessToken } = await getGoogleAccess(userId, { forceRefresh: true, staleAccessToken: accessToken, deps: tokenDeps }));
        tryNo--; // the auth retry doesn't consume a backoff try
        continue;
      }
      const reason = await errorReason(res);
      const retryable =
        res.status === 429 || res.status >= 500 || (res.status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason));
      failure = {
        err: new GoogleApiError(`${label(method, url)} failed (${res.status}${reason ? ` ${reason}` : ""})`, {
          status: res.status,
          reason,
          retryable,
        }),
        wait: retryable ? retryAfterMs(res) : null,
      };
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      const name = errName(err);
      failure = {
        err: new GoogleApiError(`${label(method, url)} network error (${name})`, { status: 0, reason: "network", retryable: true }),
        wait: null,
      };
    }

    if (noRetry) {
      // Never resend a non-idempotent write: a transient failure may already have taken effect.
      if (!failure.err.retryable) throw failure.err;
      throw new GoogleWriteUnknownError(`${failure.err.message}; outcome unknown, not retried`, {
        status: failure.err.status,
        reason: failure.err.reason,
      });
    }
    if (!failure.err.retryable || tryNo >= MAX_TRIES) throw failure.err;
    const base = BACKOFF_MS[Math.min(tryNo - 1, BACKOFF_MS.length - 1)] ?? 2000;
    const backoff = Math.round(base * (1 + 0.3 * random()));
    await sleep(Math.max(backoff, failure.wait ?? 0));
  }
}

/**
 * Errors thrown by `fetch` itself (DNS, reset, timeout) — not our own typed errors from the refresh
 * path. Checked by `name`, not `instanceof Error`: the timeout is a `DOMException`, which may come
 * from another realm (e.g. under Jest's VM context).
 */
function isNetworkError(err: unknown): boolean {
  const name = errName(err);
  return name === "TypeError" || name === "AbortError" || name === "TimeoutError";
}

function errName(err: unknown): string {
  if (typeof err !== "object" || err === null || !("name" in err)) return "unknown";
  return typeof err.name === "string" ? err.name : "unknown";
}

/**
 * Authenticated call with 401→refresh-once, 429/5xx backoff (3 tries, jitter), zod-validated JSON.
 * With `req.retry: "none"` nothing is retried and an ambiguous failure (including a 2xx whose body
 * can't be read or validated) throws `GoogleWriteUnknownError`.
 * @param userId owner of the Google token
 * @param req method, googleapis.com URL, query, JSON body, retry policy
 * @param schema zod schema for the response JSON (an empty body parses as `{}`)
 * @param deps injectable fetch / sleep / jitter / token-layer overrides (tests)
 * @returns the validated response
 * @throws GoogleApiError (`retryable` set), GoogleWriteUnknownError (no-retry writes only),
 *   GoogleAuthRevokedError, GoogleNotConnectedError
 */
export async function googleFetch<T>(
  userId: string,
  req: GoogleRequest,
  schema: z.ZodType<T>,
  deps?: GoogleFetchDeps,
): Promise<T> {
  const res = await send(userId, req, deps);
  const url = buildGoogleUrl(req);
  const lbl = label(req.method ?? "GET", url);
  // A no-retry write got a 2xx: it happened. If its body can't be read, the caller still has to
  // find the result some other way (never resend), so the error says "outcome unknown".
  const bad = (message: string): GoogleApiError =>
    req.retry === "none"
      ? new GoogleWriteUnknownError(`${message}; outcome unknown, not retried`, { status: res.status, reason: "invalid_response" })
      : new GoogleApiError(message, { status: res.status, reason: "invalid_response", retryable: false });
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (req.retry !== "none") throw err;
    throw bad(`${lbl} response body unreadable (${errName(err)})`);
  }
  let json: unknown;
  try {
    json = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw bad(`${lbl} returned non-JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const paths = parsed.error.issues
      .slice(0, 3)
      .map((i) => i.path.join(".") || "(root)")
      .join(", ");
    throw bad(`${lbl} response failed validation at ${paths}`);
  }
  return parsed.data;
}

/**
 * Authenticated call that expects no response body (e.g. DELETE, channels.stop, users.stop).
 * Same auth/retry behaviour as `googleFetch`; any 2xx counts as success.
 * @param userId owner of the token
 * @param req request
 * @param deps injectable fetch (and the other `googleFetch` deps)
 * @throws GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError
 */
export async function googleFetchNoContent(userId: string, req: GoogleRequest, deps?: GoogleFetchDeps): Promise<void> {
  const res = await send(userId, req, deps);
  await res.body?.cancel().catch(() => undefined);
}
