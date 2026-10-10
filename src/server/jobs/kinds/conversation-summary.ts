import "server-only";
// OWNER: 3.3

/**
 * Job kind `conversation_summary` (master plan §1.3). Folds the oldest window messages into the rolling summary. Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `conversation_summary`. Dedupe key: `sum:<userId>`. */
export const conversationSummaryPayload = z.object({});

/** `conversation_summary` handler (maxAttempts 3). */
export const conversationSummary = defineJobKind({
  payload: conversationSummaryPayload,
  maxAttempts: 3,
  run: async () => {
    throw notImplemented("3.3");
  },
});
