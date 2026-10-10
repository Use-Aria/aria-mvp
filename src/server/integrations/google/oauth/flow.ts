import "server-only";
// OWNER: 2.4

/**
 * Side-effecting OAuth steps (V2-07 §2.3, §2.4, §7.1 `oauth/flow.ts`).
 *
 * - `beginGoogleOAuth` / `checkGoogleCallback` wrap the pure state module with env keys, for the
 *   `GET /api/google/oauth` and `/api/google/callback` routes (task 3.6).
 * - `exchangeCode`, `refreshAccessToken`, `revokeToken` are the token-endpoint calls; `fetch` is
 *   injectable (the only mock seam in tests).
 * - `completeConnect` verifies the `id_token`, enforces scopes / refresh token / account
 *   uniqueness, encrypts the tokens and upserts `integrations`.
 *
 * Tokens, codes, verifiers and state values are never logged or put in error messages.
 */
import { z } from "zod";
import { db } from "@/server/db";
import { isProduction, requireEnv } from "@/server/env";
import { maskHandle } from "@/server/phone";
import { encryptSecret, parseKey } from "@/server/security/crypto";
import type { GoogleFeature } from "@/server/integrations/google";
import {
  featureList,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  googleClient,
  googleRedirectUri,
  missingRequiredScopes,
  normalizeScopes,
  pkceEnabled,
  REQUESTED_SCOPES,
} from "@/server/integrations/google/config";
import { GoogleApiError, GoogleAuthRevokedError } from "@/server/integrations/google/errors";
import { checkIdTokenClaims, verifyGoogleJwt } from "@/server/integrations/google/oidc";
import { findIntegrationByAccountEmail, getGoogleIntegration } from "@/server/integrations/google/store";
import {
  buildAuthUrl,
  createNonce,
  createPkcePair,
  deriveStateKey,
  OAUTH_STATE_TTL_MS,
  sealOAuthCookie,
  sessionBinding,
  signState,
  verifyCallbackBinding,
  type CallbackBindingFailure,
  type OAuthStatePayload,
} from "@/server/integrations/google/oauth/state";

/** Token endpoint response (authorization_code and refresh_token grants). */
export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
  token_type: "Bearer";
}

const TOKEN_TIMEOUT_MS = 15_000;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional().default(""),
  id_token: z.string().min(1).optional(),
  token_type: z
    .string()
    .refine((t) => t.toLowerCase() === "bearer")
    .transform((): "Bearer" => "Bearer"),
});

const TokenErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  error_subtype: z.string().optional(),
});

// ── Cookie + state wiring for the routes (3.6) ─────────────────────────────

/** Name of the encrypted PKCE/nonce cookie (`__Host-` prefix needs HTTPS, so dev drops it). */
export const OAUTH_COOKIE_NAME = isProduction ? "__Host-aria-goauth" : "aria-goauth";

/** Cookie attributes shared by set and clear. */
export interface OAuthCookie {
  name: string;
  value: string;
  options: { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/"; maxAge: number };
}

function appKey(): Buffer {
  return parseKey(requireEnv("APP_ENCRYPTION_KEY"));
}

/**
 * Build the authorization redirect and the cookie for `GET /api/google/oauth`. The caller has
 * already checked the `fresh_setup` session and `Sec-Fetch-Site`; it sets the cookie and 303s
 * to `url` with `Cache-Control: no-store`.
 * @param input user id, raw session cookie value (bound into the state, never stored), return path, clock
 * @returns the Google URL and the cookie to set
 */
export function beginGoogleOAuth(input: { userId: string; rawSessionId: string; returnTo?: string; now?: number }): {
  url: string;
  cookie: OAuthCookie;
} {
  const now = input.now ?? Date.now();
  const key = appKey();
  const nonce = createNonce();
  const pkce = pkceEnabled() ? createPkcePair() : null;
  const payload: OAuthStatePayload = {
    u: input.userId,
    s: sessionBinding(input.rawSessionId),
    n: nonce,
    e: now + OAUTH_STATE_TTL_MS,
    r: input.returnTo ?? "/setup",
  };
  const url = buildAuthUrl({
    clientId: googleClient().clientId,
    redirectUri: googleRedirectUri(),
    scopes: REQUESTED_SCOPES,
    state: signState(payload, deriveStateKey(key)),
    codeChallenge: pkce?.challenge,
  });
  return {
    url,
    cookie: {
      name: OAUTH_COOKIE_NAME,
      value: sealOAuthCookie({ v: pkce?.verifier ?? null, n: nonce, u: input.userId }, key),
      options: { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: OAUTH_STATE_TTL_MS / 1000 },
    },
  };
}

/**
 * A cookie that deletes the OAuth cookie (set it on every callback response).
 * @returns cookie with an empty value and `maxAge: 0`
 */
export function clearedOAuthCookie(): OAuthCookie {
  return {
    name: OAUTH_COOKIE_NAME,
    value: "",
    options: { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: 0 },
  };
}

/**
 * Callback binding checks (V2-07 §2.3 steps 2–4) with the env keys.
 * @param input raw `state`, raw OAuth cookie value, current session (user + raw cookie), clock
 * @returns verified state payload + PKCE verifier, or the failure reason
 */
export function checkGoogleCallback(input: {
  state: string | null | undefined;
  cookieValue: string | null | undefined;
  session: { userId: string; rawSessionId: string } | null;
  now?: number;
}): { ok: true; payload: OAuthStatePayload; verifier: string | null } | { ok: false; reason: CallbackBindingFailure } {
  const key = appKey();
  return verifyCallbackBinding({
    state: input.state,
    cookieValue: input.cookieValue,
    session: input.session,
    stateKey: deriveStateKey(key),
    appKey: key,
    now: input.now ?? Date.now(),
  });
}

// ── Token endpoint ─────────────────────────────────────────────────────────

async function postForm(url: string, form: Record<string, string>, f: typeof fetch): Promise<Response> {
  try {
    return await f(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    throw new GoogleApiError(`google token endpoint unreachable (${name})`, { status: 0, reason: "network", retryable: true });
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function tokenError(res: Response): Promise<{ code?: string; subtype?: string }> {
  const parsed = TokenErrorSchema.safeParse(await readJson(res));
  return parsed.success ? { code: parsed.data.error, subtype: parsed.data.error_subtype } : {};
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function parseTokenResponse(res: Response, what: string): Promise<TokenResponse> {
  const parsed = TokenResponseSchema.safeParse(await readJson(res));
  if (!parsed.success) {
    throw new GoogleApiError(`google ${what}: unexpected token response shape`, {
      status: res.status,
      reason: "invalid_response",
      retryable: false,
    });
  }
  const t = parsed.data;
  const out: TokenResponse = { access_token: t.access_token, expires_in: t.expires_in, scope: t.scope, token_type: t.token_type };
  if (t.refresh_token) out.refresh_token = t.refresh_token;
  if (t.id_token) out.id_token = t.id_token;
  return out;
}

/**
 * Exchange an authorization code (with the PKCE verifier when PKCE was used).
 * @param code `code` from the callback
 * @param verifier PKCE verifier from the cookie, or null
 * @param f fetch (injectable)
 * @returns token response
 * @throws GoogleApiError (`invalid_grant` = bad/expired/reused code; never a revocation)
 */
export async function exchangeCode(code: string, verifier: string | null, f: typeof fetch = fetch): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleClient();
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: googleRedirectUri(),
    client_id: clientId,
    client_secret: clientSecret,
  };
  if (verifier) form.code_verifier = verifier;
  const res = await postForm(GOOGLE_TOKEN_URL, form, f);
  if (!res.ok) {
    const e = await tokenError(res);
    throw new GoogleApiError(`google code exchange failed (${res.status}${e.code ? ` ${e.code}` : ""})`, {
      status: res.status,
      reason: e.code,
      retryable: retryableStatus(res.status),
    });
  }
  return parseTokenResponse(res, "code exchange");
}

/**
 * Refresh an access token.
 * @param refreshToken decrypted refresh token
 * @param f fetch (injectable)
 * @returns token response (`refresh_token` present only when Google rotated it)
 * @throws GoogleAuthRevokedError on `invalid_grant` / `admin_policy_enforced`; GoogleApiError otherwise
 */
export async function refreshAccessToken(refreshToken: string, f: typeof fetch = fetch): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleClient();
  const res = await postForm(
    GOOGLE_TOKEN_URL,
    { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret },
    f,
  );
  if (!res.ok) {
    const e = await tokenError(res);
    // [verify] Where Google reports a Workspace block on refresh (`error` vs `error_subtype`).
    if (e.code === "admin_policy_enforced" || e.subtype === "admin_policy_enforced") {
      throw new GoogleAuthRevokedError("admin_policy_enforced");
    }
    if (e.code === "invalid_grant") throw new GoogleAuthRevokedError("invalid_grant");
    throw new GoogleApiError(`google token refresh failed (${res.status}${e.code ? ` ${e.code}` : ""})`, {
      status: res.status,
      reason: e.code,
      retryable: retryableStatus(res.status),
    });
  }
  return parseTokenResponse(res, "token refresh");
}

/**
 * Revoke a token at Google (removes every scope granted to the project, F16). An already-invalid
 * token (400 `invalid_token`) counts as revoked.
 * @param token refresh token (preferred) or access token
 * @param f fetch (injectable)
 * @throws GoogleApiError on any other failure
 */
export async function revokeToken(token: string, f: typeof fetch = fetch): Promise<void> {
  const res = await postForm(GOOGLE_REVOKE_URL, { token }, f);
  if (res.ok) return;
  const e = await tokenError(res);
  if (res.status === 400 && (e.code === "invalid_token" || e.code === "invalid_grant")) return;
  throw new GoogleApiError(`google revoke failed (${res.status}${e.code ? ` ${e.code}` : ""})`, {
    status: res.status,
    reason: e.code,
    retryable: retryableStatus(res.status),
  });
}

// ── Connect ────────────────────────────────────────────────────────────────

const UNIQUE_VIOLATION = "23505";

/**
 * Persist a successful code exchange (V2-07 §2.3 steps 6–10):
 * verify the `id_token` (aud = client id, Google issuer, `email_verified`), require
 * `openid email calendar.events.readonly`, require a refresh token, refuse a Google account that
 * is already connected to another Aria user, then encrypt the tokens and upsert `integrations`.
 * A reconnect nulls the Calendar/Gmail watch fields (post-connect re-creates them) and keeps the
 * Gmail cursor and Aria calendar only when the account is unchanged. The caller (callback route)
 * clears the cookie, enqueues `google_post_connect` and redirects.
 * @param input user, token response; optional JWKS fetch and clock (tests)
 * @returns integration id, account email and enabled features, or a refusal reason
 * @throws when the `id_token` is missing or fails verification, or on a DB error
 */
export async function completeConnect(input: {
  userId: string;
  tokens: TokenResponse;
  fetch?: typeof fetch;
  now?: Date;
}): Promise<
  | { ok: true; integrationId: string; accountEmail: string; features: GoogleFeature[] }
  | { ok: false; reason: "missing_required_scopes" | "no_refresh_token" | "account_in_use" | "email_unverified" }
> {
  const { userId, tokens } = input;
  const now = input.now ?? new Date();
  if (!tokens.id_token) {
    throw new GoogleApiError("google connect: token response has no id_token", { status: 200, reason: "no_id_token", retryable: false });
  }
  const claims = await verifyGoogleJwt(tokens.id_token, {
    audience: googleClient().clientId,
    fetch: input.fetch,
    currentDate: now,
    clockToleranceSec: 60,
  });
  const email = checkIdTokenClaims(claims);
  if (!email) return { ok: false, reason: "email_unverified" };

  const scopes = normalizeScopes(tokens.scope);
  if (missingRequiredScopes(scopes).length > 0) return { ok: false, reason: "missing_required_scopes" };
  if (!tokens.refresh_token) return { ok: false, reason: "no_refresh_token" };

  const owner = await findIntegrationByAccountEmail(email);
  if (owner && owner.user_id !== userId) {
    console.warn(`[google] connect refused: ${maskHandle(email)} already linked to another user`);
    return { ok: false, reason: "account_in_use" };
  }

  const existing = await getGoogleIntegration(userId);
  const sameAccount = existing?.account_email?.toLowerCase() === email;
  const key = parseKey(requireEnv("APP_ENCRYPTION_KEY"));
  const row = {
    user_id: userId,
    provider: "google",
    account_email: email,
    scopes,
    enc_access_token: encryptSecret(tokens.access_token, key),
    enc_refresh_token: encryptSecret(tokens.refresh_token, key),
    token_expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
    status: "active",
    status_reason: null,
    status_notified_at: null,
    last_error: null,
    last_error_at: null,
    consecutive_failures: 0,
    connected_at: now.toISOString(),
    // Watches are re-established by google_post_connect.
    gcal_channel_id: null,
    gcal_channel_token_hash: null,
    gcal_resource_id: null,
    gcal_watch_expires_at: null,
    gmail_watch_expires_at: null,
    ...(sameAccount
      ? {}
      : {
          gmail_history_id: null,
          gmail_synced_at: null,
          gmail_triage: null,
          gcal_aria_calendar_id: null,
          gcal_calendar_ids: [],
          synced_at: null,
        }),
  };

  const { data, error } = await db().from("integrations").upsert(row, { onConflict: "user_id,provider" }).select("id").single();
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      console.warn(`[google] connect refused (race): ${maskHandle(email)} already linked`);
      return { ok: false, reason: "account_in_use" };
    }
    throw new Error(`completeConnect: ${error.message}`);
  }
  return { ok: true, integrationId: data.id, accountEmail: email, features: featureList(scopes) };
}
