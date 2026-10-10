import "server-only";
// OWNER: 4.1

/**
 * Job kind `briefing_send` (master plan §1.3; V2-06 §2.5, §2.6). Runs at the briefing time (or at
 * a deferred time with `regenerate`) and calls `sendBriefing` (briefing/run.ts). A delivery
 * failure throws → retry with backoff; deferrals re-enqueue this kind themselves.
 */
import { z } from "zod";
import { sendBriefing } from "@/server/briefing/run";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";

/** Payload of `briefing_send`. Dedupe key: `briefing_send:<userId>:<localDate>`. */
export const briefingSendPayload = z.object({
  localDate: z.iso.date(),
  regenerate: z.boolean().optional(),
  kind: z.enum(["catchup"]).optional(),
});

/** `briefing_send` handler (maxAttempts 5). */
export const briefingSend = defineJobKind({
  payload: briefingSendPayload,
  maxAttempts: 5,
  run: async (ctx, payload) => {
    if (!ctx.userId) throw new PermanentJobError("briefing_send: job has no user_id");
    await sendBriefing(ctx.userId, payload, ctx.now, { signal: ctx.signal, jobId: ctx.jobId });
  },
});
