import "server-only";
// OWNER: 2.5

/**
 * Gmail Pub/Sub push verification (V2-07 §2.9 push route steps 1–3; F10, F14).
 *
 * 1. `Authorization: Bearer <jwt>`: Google-signed (JWKS), Google issuer, `aud` = the configured
 *    push audience, `email` = the push service account with `email_verified` (2.4's `oidc.ts`).
 *    Only `exp` is enforced (tokens "may be up to an hour old"), 300s clock tolerance.
 * 2. Optional `subscription` match (`GMAIL_PUSH_SUBSCRIPTION`).
 * 3. `message.data` → `{emailAddress, historyId}`. The pushed historyId is ignored: the sync job
 *    always reads from the stored cursor.
 *
 * Failures are 401 (auth / config) or 400 (malformed body); Pub/Sub retries non-2xx with backoff.
 *
 * `handleGmailPush` is the whole `POST /api/google/gmail-push` body (the route file only
 * delegates, since Next route modules may not export helpers): verify → find the ONE active
 * integration for the mailbox (unique `lower(account_email)`, AUD-01) → enqueue
 * `gmail_history_sync` (dedupe `gmail_sync:<uid>`, +3s, `keep` so a burst collapses into one run)
 * → 204. Unknown or inactive mailboxes are acked with 204 (never fanned out, never retried).
 */
import { enqueueJob } from "@/server/jobs/enqueue";
import { gmailPushConfig } from "@/server/integrations/google/config";
import { findIntegrationByAccountEmail } from "@/server/integrations/google/store";
import { checkPushClaims, verifyGoogleJwt, type VerifyGoogleJwtOptions } from "@/server/integrations/google/oidc";
import { decodePushData } from "@/server/integrations/google/gmail/headers";
import { PubSubPushBody } from "@/server/integrations/google/gmail/schemas";

/** Push bodies are tiny (~300 bytes); anything larger is rejected unread. */
export const MAX_PUSH_BODY_BYTES = 16 * 1024;

/** Test seams for JWT verification (JWKS fetch / key resolver / clock). */
export type GmailPushVerifyDeps = Omit<VerifyGoogleJwtOptions, "audience">;

/**
 * Verify a Gmail Pub/Sub push request and extract the mailbox it is about.
 * @param req incoming request (body is consumed)
 * @param deps JWT verification seams (tests)
 * @returns the lower-cased mailbox address, or the status to answer with
 */
export async function verifyGmailPush(
  req: Request,
  deps: GmailPushVerifyDeps = {},
): Promise<{ ok: true; emailAddress: string } | { ok: false; status: 401 | 400 }> {
  let cfg: ReturnType<typeof gmailPushConfig>;
  try {
    cfg = gmailPushConfig();
  } catch {
    cfg = null; // topic set but service account missing: misconfigured → reject
  }
  if (!cfg) return { ok: false, status: 401 };

  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth.trim());
  if (!m) return { ok: false, status: 401 };
  try {
    const claims = await verifyGoogleJwt(m[1], { ...deps, audience: cfg.audience });
    if (!checkPushClaims(claims, { serviceAccount: cfg.serviceAccount })) return { ok: false, status: 401 };
  } catch {
    return { ok: false, status: 401 };
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_PUSH_BODY_BYTES) return { ok: false, status: 400 };
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, status: 400 };
  }
  if (raw.length > MAX_PUSH_BODY_BYTES) return { ok: false, status: 400 };

  let body;
  try {
    body = PubSubPushBody.safeParse(JSON.parse(raw));
  } catch {
    return { ok: false, status: 400 };
  }
  if (!body.success) return { ok: false, status: 400 };
  if (cfg.subscription && body.data.subscription !== cfg.subscription) return { ok: false, status: 401 };

  const data = decodePushData(body.data.message.data ?? "");
  if (!data) return { ok: false, status: 400 };
  return { ok: true, emailAddress: data.emailAddress };
}

/** Delay before the push-triggered sync runs (absorbs bursts; F10 caps pushes at 1/s/user). */
export const PUSH_SYNC_DELAY_MS = 3_000;

function reply(status: number): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Handle one Pub/Sub push delivery (the `/api/google/gmail-push` POST body).
 * @param req Pub/Sub push request (`Authorization: Bearer <OIDC JWT>`, JSON envelope)
 * @param deps JWT verification seams (tests)
 * @returns 204 ack; 401/400 on verification failure; 500 if the lookup/enqueue failed (Pub/Sub retries)
 */
export async function handleGmailPush(req: Request, deps: GmailPushVerifyDeps = {}): Promise<Response> {
  const v = await verifyGmailPush(req, deps);
  if (!v.ok) return reply(v.status);
  try {
    const integ = await findIntegrationByAccountEmail(v.emailAddress);
    if (!integ || integ.status !== "active") return reply(204);
    await enqueueJob({
      kind: "gmail_history_sync",
      userId: integ.user_id,
      dedupeKey: `gmail_sync:${integ.user_id}`,
      runAt: new Date(Date.now() + PUSH_SYNC_DELAY_MS),
      payload: { reason: "push" },
      mode: "keep",
    });
    return reply(204);
  } catch (e) {
    console.error(`[gmail-push] enqueue failed: ${e instanceof Error ? e.message : "error"}`);
    return reply(500);
  }
}
