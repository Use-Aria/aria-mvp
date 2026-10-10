import "server-only";
// OWNER: 3.3

/**
 * Job kind `memory_extract` (master plan §1.3). Background fact extraction from user-authored text only. Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `memory_extract`. Dedupe key: `memx:<userId>` (run +30 min). */
export const memoryExtractPayload = z.object({});

/** `memory_extract` handler (maxAttempts 3). */
export const memoryExtract = defineJobKind({
  payload: memoryExtractPayload,
  maxAttempts: 3,
  run: async () => {
    throw notImplemented("3.3");
  },
});
