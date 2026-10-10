import "server-only";
// OWNER: 3.3

/**
 * Job kind `memory_extract` (master plan §1.3; V2-04 §9.1). Enqueued by the agent loop on every
 * run with inbound (`memx:<userId>`, run +30 min, debounced), so it runs ~30 min after the
 * conversation goes idle. Fact extraction reads ONLY user-authored inbound text
 * (`runMemoryExtraction`); then stale preference questions are re-queued / expired.
 */
import { z } from "zod";
import { defineJobKind } from "@/server/jobs/types";
import { runMemoryExtraction } from "@/server/memory/extraction";
import { expireStaleQuestions } from "@/server/memory/preferences";

/** Payload of `memory_extract`. Dedupe key: `memx:<userId>` (run +30 min). */
export const memoryExtractPayload = z.object({});

/** `memory_extract` handler (maxAttempts 3). */
export const memoryExtract = defineJobKind({
  payload: memoryExtractPayload,
  maxAttempts: 3,
  run: async (ctx) => {
    if (!ctx.userId) return { type: "done" };
    const report = await runMemoryExtraction(ctx.userId, { now: ctx.now, jobId: ctx.jobId, signal: ctx.signal });
    await expireStaleQuestions(ctx.userId, ctx.now);
    if (report.messages > 0) {
      console.info(
        `[memory_extract] msgs=${report.messages} add=${report.added} upd=${report.updated} del=${report.deleted} pref=${report.proposed} dropped=${report.dropped}${report.skipped ? ` skipped=${report.skipped}` : ""}`,
      );
    }
    return { type: "done" };
  },
});
