import "server-only";
// OWNER: 4.1

/**
 * Job kind `briefing_prepare` (master plan §1.3; V2-06 §2.5). Runs 10–20 min before the user's
 * briefing time and calls `prepareBriefing` (briefing/run.ts): chain tomorrow's prepare, generate
 * the briefing, enqueue `briefing_send` at the target. Thrown errors retry with backoff.
 */
import { z } from "zod";
import { prepareBriefing } from "@/server/briefing/run";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";

/** Payload of `briefing_prepare`. Dedupe key: `briefing_prep:<userId>`. */
export const briefingPreparePayload = z.object({ targetAt: z.iso.datetime(), localDate: z.iso.date() });

/** `briefing_prepare` handler (maxAttempts 5). */
export const briefingPrepare = defineJobKind({
  payload: briefingPreparePayload,
  maxAttempts: 5,
  run: async (ctx, payload) => {
    if (!ctx.userId) throw new PermanentJobError("briefing_prepare: job has no user_id");
    await prepareBriefing(ctx.userId, payload, ctx.now, { signal: ctx.signal, jobId: ctx.jobId });
  },
});
