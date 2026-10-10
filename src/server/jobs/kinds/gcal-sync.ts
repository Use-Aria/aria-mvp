import "server-only";
// OWNER: 3.6

/**
 * Job kind `gcal_sync` (master plan §1.3; V2-07 §9.1). Runs `syncCalendarWindow`.
 *
 * - `push` (dedupe `gcal_sync:<uid>`, +20s from `/api/google/calendar-push`), `connect` and
 *   `manual` run once.
 * - `periodic` (dedupe `gcal_sync_periodic:<uid>`) reschedules itself every 3h ± 15 min (15 min
 *   without an HTTPS push address). If the chain dies, `gcal_watch_renew` restores it.
 * - Calendar not connected / inactive → done, no follow-up (the chain ends).
 * - Revoked refresh token → the token layer already marked the integration; dead (no retry).
 */
import { z } from "zod";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";
import { GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { getGoogleIntegration } from "@/server/integrations/google/store";
import { markGoogleUnavailable } from "@/server/integrations/google/tokens";
import { nextPeriodicSyncAt, syncCalendarWindow } from "@/server/integrations/google/calendar/sync";

/** Payload of `gcal_sync`. Dedupe key: `gcal_sync:<uid>` (push) / `gcal_sync_periodic:<uid>`. */
export const gcalSyncPayload = z.object({ reason: z.enum(["push", "periodic", "connect", "manual"]) });

/** `gcal_sync` handler (maxAttempts 5). */
export const gcalSync = defineJobKind({
  payload: gcalSyncPayload,
  maxAttempts: 5,
  run: async (ctx, payload) => {
    const userId = ctx.userId;
    if (!userId) throw new PermanentJobError("gcal_sync: job has no user");
    const row = await getGoogleIntegration(userId);
    if (!row || row.status !== "active") return { type: "done" };
    try {
      await syncCalendarWindow(userId, payload.reason);
    } catch (e) {
      if (e instanceof GoogleNotConnectedError) return { type: "done" };
      if (e instanceof GoogleAuthRevokedError) {
        // Normally already done by the token layer; the CAS guard makes this a no-op then.
        if (row.enc_refresh_token) await markGoogleUnavailable(userId, e.kind, { expectEncRefreshToken: row.enc_refresh_token });
        throw new PermanentJobError(`gcal_sync: google auth revoked (${e.kind})`);
      }
      throw e;
    }
    if (payload.reason === "periodic") {
      return { type: "reschedule", runAt: nextPeriodicSyncAt(new Date()), reason: "periodic gcal sync" };
    }
    return { type: "done" };
  },
});
