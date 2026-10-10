import "server-only";
// OWNER: 3.4

/**
 * Job kind `canvas_sync` (master plan §1.3; V2-05 §9.1). `{}` (cron / V2-07 inserts) parses as
 * scheduled. Calls `runCanvasSync`, which records expected failures (backoff, revoke, notices)
 * on the integration row and never throws, so the handler always finishes `done`: the next
 * attempt is driven by `integrations.next_sync_at` (the 5-min cron), not by job retries.
 */
import { z } from "zod";
import { runCanvasSync } from "@/server/integrations/canvas/sync";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";

/** Payload of `canvas_sync`. Dedupe key: `canvas_sync:<userId>`. */
export const canvasSyncPayload = z
  .object({
    reason: z.enum(["scheduled", "manual", "email_hint"]).default("scheduled"),
  })
  .strict();

/** `canvas_sync` handler (maxAttempts 5). */
export const canvasSync = defineJobKind({
  payload: canvasSyncPayload,
  maxAttempts: 5,
  run: async (ctx, payload) => {
    if (!ctx.userId) throw new PermanentJobError("canvas_sync: job has no user_id");
    const out = await runCanvasSync(ctx.userId, { reason: payload.reason, now: ctx.now });
    if (!out.ok && out.code === "internal") {
      // Already recorded (or the DB is down); the cron re-materializes the job from next_sync_at.
      console.warn(`[canvas] canvas_sync job ${ctx.jobId.slice(0, 8)} ended internal`);
    }
    return { type: "done" };
  },
});
