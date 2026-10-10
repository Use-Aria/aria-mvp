import "server-only";
// OWNER: 3.3

/**
 * Job kind `conversation_summary` (master plan §1.3; V2-04 §9.1). Enqueued by the agent loop when
 * the history window exceeds 30 messages (`sum:<userId>`, run +5 s). Folds the oldest window
 * messages into the rolling summary (`runConversationSummary`).
 */
import { z } from "zod";
import { defineJobKind } from "@/server/jobs/types";
import { runConversationSummary } from "@/server/memory/summary";

/** Payload of `conversation_summary`. Dedupe key: `sum:<userId>`. */
export const conversationSummaryPayload = z.object({});

/** `conversation_summary` handler (maxAttempts 3). */
export const conversationSummary = defineJobKind({
  payload: conversationSummaryPayload,
  maxAttempts: 3,
  run: async (ctx) => {
    if (!ctx.userId) return { type: "done" };
    await runConversationSummary(ctx.userId, { jobId: ctx.jobId, signal: ctx.signal });
    return { type: "done" };
  },
});
