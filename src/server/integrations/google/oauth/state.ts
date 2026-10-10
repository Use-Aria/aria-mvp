import "server-only";
// OWNER: 2.4

/**
 * OAuth CSRF state, PKCE and the browser-binding cookie (V2-07 §2.3, §2.14; master plan §1.12).
 * Pure: only `node:crypto` and the AES-GCM helpers, no network or DB.
 *
 * - **State** = `base64url(JSON payload) + "." + base64url(HMAC-SHA256(stateKey, payloadPart))`.
 *   `stateKey = HKDF-SHA256(APP_ENCRYPTION_KEY, info "aria/google-oauth-state/v1")`, so no new
 *   secret is needed and the raw encryption key is never used as an HMAC key.
 * - The payload binds the user (`u`), a 16-hex prefix of sha256(raw session cookie) (`s`),
 *   a browser nonce (`n`), the expiry in epoch ms (`e`) and a same-site return path (`r`).
 * - **Cookie** `__Host-aria-goauth` (`aria-goauth` in dev) holds `encryptSecret({v, n, u})`:
 *   the PKCE verifier, the same nonce, and the user. The callback requires cookie.n === state.n.
 *
 * Never log a state, cookie value, verifier or nonce.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import { GOOGLE_AUTH_URL } from "@/server/integrations/google/config";

/** Signed state payload. `e` is an absolute expiry in epoch milliseconds. */
export interface OAuthStatePayload {
  u: string;
  s: string;
  n: string;
  e: number;
  r: string;
}

/** Encrypted cookie payload: PKCE verifier (null when PKCE is off), nonce, user id. */
export interface OAuthCookiePayload {
  v: string | null;
  n: string;
  u: string;
}

/** State and cookie lifetime (V2-07 §2.3: 10 minutes). */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

const STATE_INFO = "aria/google-oauth-state/v1";
const B64URL = /^[A-Za-z0-9_-]+$/;

const StatePayloadSchema = z.strictObject({
  u: z.string().min(1).max(64),
  s: z.string().regex(/^[0-9a-f]{16}$/),
  n: z.string().min(8).max(128),
  e: z.number().int().positive(),
  // Same-site path only: "/x", never "//host" or "/\host".
  r: z.string().regex(/^\/(?![/\\])[^\s]*$/).max(512),
});

const CookiePayloadSchema = z.strictObject({
  v: z.string().min(43).max(128).nullable(),
  n: z.string().min(8).max(128),
  u: z.string().min(1).max(64),
});

/**
 * Derive the state HMAC key from the app encryption key (HKDF-SHA256, empty salt).
 * @param appKey the 32-byte `APP_ENCRYPTION_KEY` (from `parseKey`)
 * @returns a 32-byte key distinct from `appKey`
 */
export function deriveStateKey(appKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", appKey, Buffer.alloc(0), STATE_INFO, 32));
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Sign a state payload.
 * @param p payload (`e` in epoch ms)
 * @param key key from `deriveStateKey`
 * @returns `payload.signature`, both base64url
 */
export function signState(p: OAuthStatePayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify({ u: p.u, s: p.s, n: p.n, e: p.e, r: p.r }), "utf8").toString("base64url");
  return `${body}.${hmac(key, body).toString("base64url")}`;
}

/**
 * Verify a state string: shape, then the HMAC (constant time), then the payload schema, then
 * the expiry. The payload is never trusted before the signature checks out.
 * @param state the `state` query parameter
 * @param key key from `deriveStateKey`
 * @param now current time in epoch ms
 * @returns the payload, or the failure reason
 */
export function verifyState(
  state: string,
  key: Buffer,
  now: number,
): { ok: true; payload: OAuthStatePayload } | { ok: false; reason: "malformed" | "bad_sig" | "expired" } {
  if (typeof state !== "string" || state.length > 2048) return { ok: false, reason: "malformed" };
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  if (!B64URL.test(body) || !B64URL.test(sig)) return { ok: false, reason: "malformed" };

  const expected = hmac(key, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_sig" };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = StatePayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (now > parsed.data.e) return { ok: false, reason: "expired" };
  return { ok: true, payload: parsed.data };
}

/**
 * S256 code challenge for a PKCE verifier (RFC 7636 §4.2).
 * @param verifier code verifier
 * @returns base64url(sha256(verifier))
 */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Fresh PKCE pair: a 32-byte random verifier (43 base64url chars) and its S256 challenge.
 * @returns verifier and challenge
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

/**
 * Random browser nonce for the state/cookie pair.
 * @returns 16 random bytes, base64url
 */
export function createNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Bind a state to one web session without storing the session id: first 16 hex chars of
 * sha256(raw session cookie value).
 * @param rawSessionId raw session cookie value
 * @returns 16 lowercase hex chars
 */
export function sessionBinding(rawSessionId: string): string {
  return createHash("sha256").update(rawSessionId, "utf8").digest("hex").slice(0, 16);
}

/**
 * Google authorization URL (V2-07 §2.3 step 6): offline access, `prompt=consent select_account`,
 * `include_granted_scopes=true`, and S256 PKCE when a challenge is given.
 * @param input client id, exact redirect URI, scopes, signed state, optional PKCE challenge
 * @returns absolute URL to 303 to
 */
export function buildAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scopes.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state: input.state,
  });
  if (input.codeChallenge) {
    params.set("code_challenge", input.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  // URLSearchParams encodes spaces as "+"; use %20 (a literal "+" is already %2B).
  return `${GOOGLE_AUTH_URL}?${params.toString().replace(/\+/g, "%20")}`;
}

/**
 * Encrypt the cookie payload (AES-256-GCM via `encryptSecret`).
 * @param p verifier, nonce, user id
 * @param appKey the 32-byte app encryption key
 * @returns cookie value (`v1:…`)
 */
export function sealOAuthCookie(p: OAuthCookiePayload, appKey: Buffer): string {
  return encryptSecret(JSON.stringify({ v: p.v, n: p.n, u: p.u }), appKey);
}

/**
 * Decrypt and validate the cookie payload.
 * @param value raw cookie value (may be undefined)
 * @param appKey the 32-byte app encryption key
 * @returns the payload, or null when absent, tampered or malformed
 */
export function openOAuthCookie(value: string | undefined | null, appKey: Buffer): OAuthCookiePayload | null {
  if (!value || value.length > 4096) return null;
  try {
    const parsed = CookiePayloadSchema.safeParse(JSON.parse(decryptSecret(value, appKey)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Why a callback's state/cookie/session binding was rejected. */
export type CallbackBindingFailure =
  | "malformed"
  | "bad_sig"
  | "expired"
  | "missing_cookie"
  | "cookie_mismatch"
  | "no_session"
  | "session_mismatch";

/**
 * All callback binding checks of V2-07 §2.3 steps 2–4 in one pure function:
 * state signature + expiry, cookie present and matching (nonce + user), and the current
 * session belonging to the same user with the same session-hash prefix. Freshness is NOT
 * re-checked here (consent can take minutes; the 10-minute state expiry bounds it).
 * @param input raw state, raw cookie value, current session (user id + raw cookie), keys, now (ms)
 * @returns the verified payload and PKCE verifier, or the failure reason
 */
export function verifyCallbackBinding(input: {
  state: string | null | undefined;
  cookieValue: string | null | undefined;
  session: { userId: string; rawSessionId: string } | null;
  stateKey: Buffer;
  appKey: Buffer;
  now: number;
}):
  | { ok: true; payload: OAuthStatePayload; verifier: string | null }
  | { ok: false; reason: CallbackBindingFailure } {
  if (!input.state) return { ok: false, reason: "malformed" };
  const st = verifyState(input.state, input.stateKey, input.now);
  if (!st.ok) return st;
  const cookie = openOAuthCookie(input.cookieValue, input.appKey);
  if (!cookie) return { ok: false, reason: "missing_cookie" };
  if (!safeEq(cookie.n, st.payload.n) || cookie.u !== st.payload.u) return { ok: false, reason: "cookie_mismatch" };
  if (!input.session) return { ok: false, reason: "no_session" };
  if (input.session.userId !== st.payload.u || !safeEq(sessionBinding(input.session.rawSessionId), st.payload.s)) {
    return { ok: false, reason: "session_mismatch" };
  }
  return { ok: true, payload: st.payload, verifier: cookie.v };
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
