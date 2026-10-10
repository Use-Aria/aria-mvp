import "server-only";
// OWNER: 2.5

/**
 * Job kind `gmail_watch_renew` (master plan §1.3; V2-07 §9.1). Daily: renews `users.watch`
 * (Google requires ≤7 days, recommends daily), writing only `gmail_watch_expires_at` — never a
 * non-NULL history cursor — then reschedules itself at now + 24h ± 1h and makes sure the periodic
 * `gmail_history_sync` chain exists. Gmail not connected/active → done (the chain ends).
 */
import { z } from "zod";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";
import { GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { markGoogleUnavailable } from "@/server/integrations/google/tokens";
import { ensurePeriodicGmailSync, nextRenewAt, renewGmailWatchIfActive } from "@/server/integrations/google/gmail/sync";

/** Payload of `gmail_watch_renew`. Dedupe key: `gmail_watch_renew:<uid>`. */
export const gmailWatchRenewPayload = z.object({});

/** `gmail_watch_renew` handler (maxAttempts 5). */
export const gmailWatchRenew = defineJobKind({
  payload: gmailWatchRenewPayload,
  maxAttempts: 5,
  run: async (ctx) => {
    const userId = ctx.userId;
    if (!userId) throw new PermanentJobError("gmail_watch_renew: job has no user");
    try {
      if (!(await renewGmailWatchIfActive(userId))) return { type: "done" };
    } catch (e) {
      if (e instanceof GoogleAuthRevokedError) {
        await markGoogleUnavailable(userId, e.kind);
        throw new PermanentJobError(`gmail_watch_renew: google auth revoked (${e.kind})`);
      }
      if (e instanceof GoogleNotConnectedError) return { type: "done" };
      throw e;
    }
    const now = new Date();
    // Restore the periodic sync chain if it died (dead-lettered); a pending one is left alone.
    await ensurePeriodicGmailSync(userId, now);
    return { type: "reschedule", runAt: nextRenewAt(now), reason: "daily gmail watch renew" };
  },
});
