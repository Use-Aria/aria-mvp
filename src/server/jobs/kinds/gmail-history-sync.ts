import "server-only";
// OWNER: 2.5

/**
 * Job kind `gmail_history_sync` (master plan §1.3; V2-07 §9.1). Runs `runHistorySync` (incl. the
 * 404 → resync path and alerts).
 *
 * - `push` (dedupe `gmail_sync:<uid>`, from `/api/google/gmail-push`) and `retry` (backlog
 *   follow-up) run once.
 * - `periodic` (dedupe `gmail_sync_periodic:<uid>`) reschedules itself every 2h (5 min in dev
 *   without a Pub/Sub topic). If the chain ever dies, the daily `gmail_watch_renew` restores it.
 * - Gmail not connected/active → done, no follow-ups (the chain ends).
 * - Revoked refresh token → `markGoogleUnavailable` + dead (no retry).
 */
import { z } from "zod";
import { enqueueJob } from "@/server/jobs/enqueue";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";
import { GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { markGoogleUnavailable } from "@/server/integrations/google/tokens";
import { periodicSyncIntervalMs, runHistorySync } from "@/server/integrations/google/gmail/sync";

/** Payload of `gmail_history_sync`. Dedupe key: `gmail_sync:<uid>` (push) / `gmail_sync_periodic:<uid>`. */
export const gmailHistorySyncPayload = z.object({ reason: z.enum(["push", "periodic", "retry"]) });

/** Delay of the follow-up run when a sync left work behind (page cap / deadline). */
const BACKLOG_FOLLOWUP_MS = 20_000;

/** `gmail_history_sync` handler (maxAttempts 5). */
export const gmailHistorySync = defineJobKind({
  payload: gmailHistorySyncPayload,
  maxAttempts: 5,
  run: async (ctx, payload) => {
    const userId = ctx.userId;
    if (!userId) throw new PermanentJobError("gmail_history_sync: job has no user");
    let backlog = false;
    try {
      const r = await runHistorySync(userId, { deadline: ctx.deadline });
      if (r.skipped) return { type: "done" };
      backlog = r.backlog;
    } catch (e) {
      if (e instanceof GoogleAuthRevokedError) {
        await markGoogleUnavailable(userId, e.kind);
        throw new PermanentJobError(`gmail_history_sync: google auth revoked (${e.kind})`);
      }
      if (e instanceof GoogleNotConnectedError) return { type: "done" };
      throw e;
    }
    if (backlog) {
      await enqueueJob({
        kind: "gmail_history_sync",
        userId,
        dedupeKey: `gmail_sync:${userId}`,
        runAt: new Date(Date.now() + BACKLOG_FOLLOWUP_MS),
        payload: { reason: "retry" },
        mode: "keep",
      });
    }
    if (payload.reason === "periodic") {
      return { type: "reschedule", runAt: new Date(Date.now() + periodicSyncIntervalMs()), reason: "periodic gmail sync" };
    }
    return { type: "done" };
  },
});
