import "server-only";
// OWNER: 2.4

/**
 * Google OIDC JWT verification with `jose` (V2-07 §2.2): the `id_token` from the code exchange
 * and the Pub/Sub push `Authorization: Bearer` JWT (F14).
 *
 * Signature against Google's JWKS (RS256 only), issuer, audience and expiry are checked by
 * `jwtVerify`; the claim shape is then validated with zod. `checkPushClaims` /
 * `checkIdTokenClaims` are the pure post-checks. Never log a token.
 */
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { GOOGLE_ISSUERS, GOOGLE_JWKS_URL } from "@/server/integrations/google/config";

/** The claims Aria reads from a Google-signed JWT. */
export interface GoogleIdClaims {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  exp: number;
}

/** Options for `verifyGoogleJwt`. Only `audience` is required; the rest exist for tests. */
export interface VerifyGoogleJwtOptions {
  /** Expected `aud` (the OAuth client id, or the Pub/Sub push audience). */
  audience: string;
  /** Fetch used to load the JWKS (tests serve a local JWKS through a stub). */
  fetch?: typeof fetch;
  /** Pre-built key resolver (overrides `fetch`). */
  keys?: JWTVerifyGetKey;
  /** Clock for `exp`/`nbf` checks (default: now). */
  currentDate?: Date;
  /** Allowed clock skew in seconds (default 300, V2-07 §2.9). */
  clockToleranceSec?: number;
}

const ClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  exp: z.number(),
  email: z.string().optional(),
  // Google sends a boolean; tolerate the legacy "true"/"false" string form.
  email_verified: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === "true")),
});

let defaultKeys: JWTVerifyGetKey | null = null;

function keysFor(opts: VerifyGoogleJwtOptions): JWTVerifyGetKey {
  if (opts.keys) return opts.keys;
  const url = new URL(GOOGLE_JWKS_URL);
  if (opts.fetch) {
    const f = opts.fetch;
    return createRemoteJWKSet(url, { [customFetch]: (u: string, init: RequestInit) => f(u, init) });
  }
  // Module-level cache: jose caches the JWKS and refetches on an unknown `kid` (rate-limited).
  defaultKeys ??= createRemoteJWKSet(url);
  return defaultKeys;
}

/**
 * Verify a Google-signed JWT (RS256, Google issuer, expected audience, not expired).
 * @param token compact JWT
 * @param opts expected audience; optional JWKS fetch / key resolver / clock for tests
 * @returns validated claims (`aud` is the expected audience)
 * @throws on any signature, claim or shape failure (callers map this to 401 / connect error)
 */
export async function verifyGoogleJwt(token: string, opts: VerifyGoogleJwtOptions): Promise<GoogleIdClaims> {
  const { payload } = await jwtVerify(token, keysFor(opts), {
    issuer: [...GOOGLE_ISSUERS],
    audience: opts.audience,
    algorithms: ["RS256"],
    clockTolerance: opts.clockToleranceSec ?? 300,
    currentDate: opts.currentDate,
    requiredClaims: ["exp", "sub", "iss", "aud"],
  });
  return toClaims(payload, opts.audience);
}

function toClaims(payload: JWTPayload, audience: string): GoogleIdClaims {
  const c = ClaimsSchema.parse(payload);
  const out: GoogleIdClaims = { iss: c.iss, aud: audience, sub: c.sub, exp: c.exp };
  if (c.email !== undefined) out.email = c.email;
  if (c.email_verified !== undefined) out.email_verified = c.email_verified;
  return out;
}

/**
 * Pub/Sub push post-check (F14): the token's `email` is the configured push service account
 * (case-insensitive) and `email_verified === true`. Pure.
 * @param c verified claims
 * @param expected the push service-account email
 * @returns true when the push is authentic
 */
export function checkPushClaims(c: GoogleIdClaims, expected: { serviceAccount: string }): boolean {
  if (c.email_verified !== true || !c.email) return false;
  const want = expected.serviceAccount.trim().toLowerCase();
  return want.length > 0 && c.email.trim().toLowerCase() === want;
}

/**
 * `id_token` post-check for the connect flow: a verified email is present. Pure.
 * @param c verified claims
 * @returns the lower-cased account email, or null when missing/unverified
 */
export function checkIdTokenClaims(c: GoogleIdClaims): string | null {
  if (c.email_verified !== true || !c.email) return null;
  const email = c.email.trim().toLowerCase();
  return email.includes("@") ? email : null;
}
