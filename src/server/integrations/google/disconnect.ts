import "server-only";
// OWNER: 3.6

/**
 * Google disconnect (master plan §1.12, C21; V2-07 §2.14). Called by the web server action
 * (`reason: "user"`, task 4.5/4.6) and by `deleteAccount` (`reason: "account_deleted"`, 4.6).
 * There is no `/api/google/disconnect` route (C20).
 *
 * Order (each step idempotent, so a retry after a partial failure is safe):
 * 1. Claim the one-time "Google stopped working" notice, so a refresh that hits `invalid_grant`
 *    while we tear down doesn't text the user about a disconnect they asked for.
 * 2. Stop the calendar channel and the Gmail watch while the tokens still work (best effort at
 *    Google; `stopGmailWatch` also clears the Gmail cursor and cancels the Gmail jobs).
 * 3. Revoke the grant at `oauth2.googleapis.com/revoke` (removes every scope for the project).
 * 4. Cancel every pending Google job.
 * 5. `reason: "user"` → soft-remove the `gcal` and `aria` timeline rows (account deletion
 *    cascades them instead). Delete `email_items` and the integration row.
 *
 * Tokens are decrypted only to revoke and are never logged.
 */
import { db } from "@/server/db";
import { requireEnv } from "@/server/env";
import { cancelJobs } from "@/server/jobs/enqueue";
import { decryptSecret, parseKey } from "@/server/security/crypto";
import { deleteTimelineItems } from "@/server/timeline";
import { revokeToken } from "@/server/integrations/google/oauth/flow";
import { claimStatusNotice, getGoogleIntegration, type GoogleIntegration } from "@/server/integrations/google/store";
import { stopGmailWatch } from "@/server/integrations/google/gmail/sync";
import { stopCalendarWatch } from "@/server/integrations/google/calendar/watch";

/** Every Google job kind (cancelled on disconnect). */
export const GOOGLE_JOB_KINDS = [
  "google_post_connect",
  "gcal_sync",
  "gcal_watch_renew",
  "gmail_watch_renew",
  "gmail_history_sync",
  "gmail_triage_chunk",
] as const;

/** Injectable seams (tests / smoke): the revoke endpoint's fetch. */
export interface DisconnectDeps {
  fetch?: typeof fetch;
}

/**
 * Revoke the stored grant at Google.
 * @returns true when Google confirmed, or there is no live grant to revoke (`revoked` / `disconnected`
 *   rows already lost their tokens to `invalid_grant`); false when a grant may remain (the call
 *   failed, the token is unreadable, or an admin-blocked row whose tokens were wiped)
 */
async function revokeGrant(row: GoogleIntegration, deps: DisconnectDeps | undefined): Promise<boolean> {
  const enc = row.enc_refresh_token ?? row.enc_access_token;
  if (!enc) return row.status === "revoked" || row.status === "disconnected";
  let token: string;
  try {
    token = decryptSecret(enc, parseKey(requireEnv("APP_ENCRYPTION_KEY")));
  } catch {
    console.error(`[google] disconnect: stored token unreadable user=${row.user_id}`);
    return false;
  }
  try {
    await revokeToken(token, deps?.fetch);
    return true;
  } catch (e) {
    console.warn(`[google] revoke failed user=${row.user_id}: ${e instanceof Error ? e.message : "error"}`);
    return false;
  }
}

/** Run a best-effort teardown step; DB errors are logged, not fatal (the row delete still happens). */
async function step(name: string, userId: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`[google] disconnect step ${name} failed user=${userId}: ${e instanceof Error ? e.message : "error"}`);
  }
}

/**
 * Revoke the Google grant, stop the Gmail watch and the calendar channel, cancel Google jobs,
 * remove derived `gcal`/`aria` timeline rows (user disconnects only) and `email_items`, and delete
 * the integration row. Idempotent: a user with no Google row gets `{revoked: true}`.
 * @param userId owner
 * @param opts why: "user" (web settings/setup) or "account_deleted" (account deletion; the
 *   cascade removes timeline rows, so they aren't soft-removed first)
 * @param deps revoke-endpoint fetch (tests / smoke)
 * @returns `revoked`: false only when a grant may still exist at Google (the web then points the
 *   user to myaccount.google.com/permissions)
 * @throws on a DB error deleting the integration row (the caller may retry)
 */
export async function disconnectGoogle(
  userId: string,
  opts: { reason: "user" | "account_deleted" },
  deps?: DisconnectDeps,
): Promise<{ revoked: boolean }> {
  const row = await getGoogleIntegration(userId);
  if (!row) return { revoked: true };

  await step("claim_notice", userId, () => claimStatusNotice(row.id, new Date().toISOString()));
  await step("calendar_watch", userId, () => stopCalendarWatch(userId));
  await step("gmail_watch", userId, () => stopGmailWatch(userId));
  const revoked = await revokeGrant(row, deps);
  await step("cancel_jobs", userId, () => cancelJobs({ userId, kinds: [...GOOGLE_JOB_KINDS] }));

  if (opts.reason === "user") {
    await step("timeline_gcal", userId, () => deleteTimelineItems(userId, "gcal"));
    await step("timeline_aria", userId, () => deleteTimelineItems(userId, "aria"));
  }
  await step("email_items", userId, async () => {
    const { error } = await db().from("email_items").delete().eq("user_id", userId);
    if (error) throw new Error(error.message);
  });

  const { error } = await db().from("integrations").delete().eq("id", row.id).eq("provider", "google");
  if (error) throw new Error(`disconnectGoogle: ${error.message}`);
  console.info(`[google] disconnected user=${userId} reason=${opts.reason} revoked=${revoked}`);
  return { revoked };
}
