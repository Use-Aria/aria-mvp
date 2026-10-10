import "server-only";
// OWNER: 4.3

/**
 * Job kind `gmail_triage_chunk` (master plan §1.3). One inbox-triage phase step (V2-07 §2.11). Wave 0 stub.
 */
import { notImplemented } from "@/server/_stub";
import { TriagePayloadSchema } from "@/server/integrations/google/gmail/types";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `gmail_triage_chunk`. Dedupe key: `gmail_triage:<uid>:<runId>:<phase>:<offset>`. */
export const gmailTriageChunkPayload = TriagePayloadSchema;

/** `gmail_triage_chunk` handler (maxAttempts 3). */
export const gmailTriageChunk = defineJobKind({
  payload: gmailTriageChunkPayload,
  maxAttempts: 3,
  run: async () => {
    throw notImplemented("4.3");
  },
});
