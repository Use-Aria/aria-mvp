import "server-only";
// OWNER: 3.6

/**
 * Job kind `gcal_watch_renew` (master plan §1.3; V2-07 §2.6, §9.1). Renews the primary-calendar
 * push channel (new channel first, then stop the old), reschedules itself at
 * min(expiry − 24h, now + 6d), and restores the periodic `gcal_sync` chain if it died.
 * Calendar not connected / no HTTPS push address → done (the chain ends).
 */
import { z } from "zod";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";
import { GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { getGoogleIntegration } from "@/server/integrations/google/store";
import { markGoogleUnavailable } from "@/server/integrations/google/tokens";
import { ensurePeriodicCalendarSync } from "@/server/integrations/google/calendar/sync";
import { nextWatchRenewAt, renewCalendarWatch } from "@/server/integrations/google/calendar/watch";

/** Payload of `gcal_watch_renew`. Dedupe key: `gcal_watch_renew:<uid>`. */
export const gcalWatchRenewPayload = z.object({});

/** `gcal_watch_renew` handler (maxAttempts 5). */
export const gcalWatchRenew = defineJobKind({
  payload: gcalWatchRenewPayload,
  maxAttempts: 5,
  run: async (ctx) => {
    const userId = ctx.userId;
    if (!userId) throw new PermanentJobError("gcal_watch_renew: job has no user");
    const row = await getGoogleIntegration(userId);
    if (!row || row.status !== "active") return { type: "done" };
    let expiresAt: Date | null;
    try {
      expiresAt = await renewCalendarWatch(userId);
    } catch (e) {
      if (e instanceof GoogleNotConnectedError) return { type: "done" };
      if (e instanceof GoogleAuthRevokedError) {
        if (row.enc_refresh_token) await markGoogleUnavailable(userId, e.kind, { expectEncRefreshToken: row.enc_refresh_token });
        throw new PermanentJobError(`gcal_watch_renew: google auth revoked (${e.kind})`);
      }
      throw e;
    }
    if (!expiresAt) return { type: "done" };
    const now = new Date();
    await ensurePeriodicCalendarSync(userId, now);
    return { type: "reschedule", runAt: nextWatchRenewAt(expiresAt, now), reason: "calendar watch renew" };
  },
});
