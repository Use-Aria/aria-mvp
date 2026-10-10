import "server-only";
// OWNER: 4.3

/**
 * Job kind `gmail_triage_chunk` (master plan §1.3; V2-07 §2.11, §9.1). One inbox-triage phase
 * step (`runTriageChunk`): list → meta×N → classify → digest, self-chaining via enqueued jobs.
 *
 * - Gmail not connected / not active, or a stale run id → done (the chunk exits quietly).
 * - `classify` still waiting for `meta` chunks → reschedule.
 * - Revoked refresh token → `markGoogleUnavailable` + dead (no retry). Other errors retry (3 attempts).
 */
import { TriagePayloadSchema } from "@/server/integrations/google/gmail/types";
import { GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { markGoogleUnavailable } from "@/server/integrations/google/tokens";
import { runTriageChunk } from "@/server/integrations/google/gmail/triage";
import { defineJobKind, PermanentJobError } from "@/server/jobs/types";

/** Payload of `gmail_triage_chunk`. Dedupe key: `gmail_triage:<uid>:<runId>:<phase>:<offset>`. */
export const gmailTriageChunkPayload = TriagePayloadSchema;

/** `gmail_triage_chunk` handler (maxAttempts 3). */
export const gmailTriageChunk = defineJobKind({
  payload: gmailTriageChunkPayload,
  maxAttempts: 3,
  run: async (ctx, payload) => {
    const userId = ctx.userId;
    if (!userId) throw new PermanentJobError("gmail_triage_chunk: job has no user");
    try {
      const r = await runTriageChunk(userId, payload, { deadline: ctx.deadline, now: () => new Date() });
      if (r.rescheduleAt) return { type: "reschedule", runAt: r.rescheduleAt, reason: "triage waiting for meta chunks" };
      return { type: "done" };
    } catch (e) {
      if (e instanceof GoogleAuthRevokedError) {
        await markGoogleUnavailable(userId, e.kind);
        throw new PermanentJobError(`gmail_triage_chunk: google auth revoked (${e.kind})`);
      }
      if (e instanceof GoogleNotConnectedError) return { type: "done" };
      throw e;
    }
  },
});
