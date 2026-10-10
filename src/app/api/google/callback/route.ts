import "server-only";
// OWNER: 3.6
/**
 * `GET /api/google/callback` — finish Google sign-in (master plan §1.12; V2-07 §2.3 steps 1–11).
 *
 * Always answers 303 to `/setup?google=<GoogleConnectStatus>` (fixed codes only, never echoed
 * query text), clears the OAuth cookie, and sets `Cache-Control: no-store`. Freshness is not
 * re-checked here (consent can take minutes; the 10-minute state expiry bounds it), but the
 * state must verify and be bound to this browser (cookie nonce) and this session.
 *
 * Code mapping:
 * - `error=access_denied` → `denied`; `error=admin_policy_enforced` → `admin_blocked`; other `error` → `error`
 * - state malformed / bad signature / expired, cookie missing or mismatched → `expired`
 * - no session, or a different session/user than the one that started → `stale`
 * - code exchange: `invalid_grant` (code reused/expired) → `expired`; anything else → `error`
 * - `completeConnect`: `missing_required_scopes` → `missing_scopes`; `account_in_use` →
 *   `account_in_use`; `no_refresh_token` / `email_unverified` / thrown → `error`
 * - connected with every feature → `connected`; connected with some boxes unticked → `missing_scopes`
 *   (the `/setup` banner tells the two `missing_scopes` cases apart by the Google status)
 *
 * On success this route enqueues `google_post_connect` itself (`completeConnect` does not).
 */
import { NextResponse, type NextRequest } from "next/server";
import { appBaseUrl } from "@/server/env";
import { enqueueJob } from "@/server/jobs/enqueue";
import type { GoogleConnectStatus } from "@/server/integrations/google";
import { FEATURE_ORDER } from "@/server/integrations/google/config";
import { GoogleApiError } from "@/server/integrations/google/errors";
import {
  checkGoogleCallback,
  clearedOAuthCookie,
  completeConnect,
  exchangeCode,
  OAUTH_COOKIE_NAME,
  type TokenResponse,
} from "@/server/integrations/google/oauth/flow";
import { readSession, SESSION_COOKIE } from "@/server/security/sessions";

function finish(code: GoogleConnectStatus): NextResponse {
  const res = NextResponse.redirect(`${appBaseUrl()}/setup?google=${code}`, 303);
  res.headers.set("Cache-Control", "no-store");
  const c = clearedOAuthCookie();
  res.cookies.set(c.name, c.value, c.options);
  return res;
}

function errorParamCode(error: string): GoogleConnectStatus {
  if (error === "access_denied") return "denied";
  // [verify] Where Google reports a Workspace admin block on the redirect (V2-07 §12 item 16).
  if (error === "admin_policy_enforced" || error.includes("admin_policy")) return "admin_blocked";
  return "error";
}

/**
 * Handle Google's redirect back.
 * @param req incoming request (`code`, `state`, `error` query; session + OAuth cookies)
 * @returns 303 to `/setup?google=<code>`
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const error = q.get("error");
  if (error) return finish(errorParamCode(error));

  const rawSessionId = req.cookies.get(SESSION_COOKIE)?.value;
  let session: { userId: string; rawSessionId: string } | null = null;
  try {
    const s = rawSessionId ? await readSession(rawSessionId) : null;
    session = s && rawSessionId ? { userId: s.userId, rawSessionId } : null;
  } catch {
    return finish("error");
  }

  let binding: ReturnType<typeof checkGoogleCallback>;
  try {
    binding = checkGoogleCallback({ state: q.get("state"), cookieValue: req.cookies.get(OAUTH_COOKIE_NAME)?.value, session });
  } catch (e) {
    console.error(`[google] callback check failed: ${e instanceof Error ? e.message : "error"}`);
    return finish("error");
  }
  if (!binding.ok) {
    return finish(binding.reason === "no_session" || binding.reason === "session_mismatch" ? "stale" : "expired");
  }
  const userId = binding.payload.u;

  const code = q.get("code");
  if (!code) return finish("error");

  let tokens: TokenResponse;
  try {
    tokens = await exchangeCode(code, binding.verifier);
  } catch (e) {
    const reason = e instanceof GoogleApiError ? e.reason : undefined;
    console.warn(`[google] code exchange failed user=${userId}: ${e instanceof Error ? e.message : "error"}`);
    return finish(reason === "invalid_grant" ? "expired" : "error");
  }

  let result: Awaited<ReturnType<typeof completeConnect>>;
  try {
    result = await completeConnect({ userId, tokens });
  } catch (e) {
    console.error(`[google] connect failed user=${userId}: ${e instanceof Error ? e.message : "error"}`);
    return finish("error");
  }
  if (!result.ok) {
    console.info(`[google] connect refused user=${userId} reason=${result.reason}`);
    if (result.reason === "missing_required_scopes") return finish("missing_scopes");
    if (result.reason === "account_in_use") return finish("account_in_use");
    return finish("error");
  }

  try {
    await enqueueJob({ kind: "google_post_connect", userId, dedupeKey: `google_post_connect:${userId}`, payload: {} });
  } catch (e) {
    // The row is active but nothing will sync until a reconnect; say so rather than "connected".
    console.error(`[google] post-connect enqueue failed user=${userId}: ${e instanceof Error ? e.message : "error"}`);
    return finish("error");
  }
  const complete = FEATURE_ORDER.every((f) => result.features.includes(f));
  console.info(`[google] connected user=${userId} features=${result.features.join(",")}`);
  return finish(complete ? "connected" : "missing_scopes");
}
