import "server-only";
// OWNER: 1.1

/**
 * Auth for `/api/jobs/dispatch` (V2-03 §2.11 "HMAC", §2.12 "Dispatch").
 *
 * - **POST (pg_cron → pg_net tick):** `x-aria-ts` = epoch seconds, `x-aria-sig` = hex
 *   HMAC-SHA256 of `"v1." + ts` keyed with `JOBS_DISPATCH_SECRET` (= Vault `aria_dispatch_secret`;
 *   `private.jobs_tick()` signs with pgcrypto). Accepted when |now − ts| ≤ 60s. The body is ignored.
 * - **GET (Vercel Cron backstop):** `Authorization: Bearer $CRON_SECRET`.
 *
 * Pure (node:crypto only). Every comparison is constant-time; an empty secret never verifies.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Default accepted clock skew between the signer and this server. */
export const DISPATCH_SKEW_SEC = 60;

const TS_RE = /^\d{1,12}$/;
const SIG_RE = /^[0-9a-f]{64}$/i;

/**
 * Sign a dispatch timestamp exactly as `private.jobs_tick()` does.
 * @param tsSec epoch seconds
 * @param secret shared dispatch secret
 * @returns lowercase hex HMAC-SHA256 of `"v1." + tsSec`
 */
export function signDispatch(tsSec: number, secret: string): string {
  return createHmac("sha256", secret).update(`v1.${Math.floor(tsSec)}`).digest("hex");
}

/**
 * Verify the tick's `x-aria-ts` / `x-aria-sig` headers.
 * @param h raw header values (null when absent)
 * @param secret shared dispatch secret (empty → always false)
 * @param nowSec this server's epoch seconds
 * @param skewSec max |now − ts| accepted (default 60)
 * @returns true only for a well-formed, fresh, correctly signed request
 */
export function verifyDispatch(
  h: { ts: string | null; sig: string | null },
  secret: string,
  nowSec: number,
  skewSec: number = DISPATCH_SKEW_SEC,
): boolean {
  if (!secret || !h.ts || !h.sig) return false;
  if (!TS_RE.test(h.ts) || !SIG_RE.test(h.sig)) return false;
  const ts = Number(h.ts);
  if (Math.abs(nowSec - ts) > skewSec) return false;
  const expected = Buffer.from(signDispatch(ts, secret), "hex");
  const given = Buffer.from(h.sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Verify a Vercel Cron `Authorization: Bearer <CRON_SECRET>` header.
 * @param authz raw `Authorization` header (null when absent)
 * @param secret `CRON_SECRET` (empty → always false)
 * @returns true when the bearer token equals the secret (constant-time)
 */
export function verifyCronBearer(authz: string | null, secret: string): boolean {
  if (!secret || !authz) return false;
  const m = /^Bearer (.+)$/.exec(authz);
  if (!m) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * Decide whether a dispatch request is authorized. POST accepts only the tick HMAC; GET accepts
 * only the Vercel Cron bearer (V2-03 §2.12). Any other method is rejected.
 * @param method HTTP method
 * @param headers request headers (anything with `get`)
 * @param secrets `JOBS_DISPATCH_SECRET` / `CRON_SECRET` (unset → that path is closed)
 * @param nowSec this server's epoch seconds
 * @returns true when the request may trigger a dispatch
 */
export function authorizeDispatchRequest(
  method: string,
  headers: { get(name: string): string | null },
  secrets: { dispatchSecret?: string; cronSecret?: string },
  nowSec: number,
): boolean {
  if (method === "POST") {
    return verifyDispatch(
      { ts: headers.get("x-aria-ts"), sig: headers.get("x-aria-sig") },
      secrets.dispatchSecret ?? "",
      nowSec,
    );
  }
  if (method === "GET") return verifyCronBearer(headers.get("authorization"), secrets.cronSecret ?? "");
  return false;
}
