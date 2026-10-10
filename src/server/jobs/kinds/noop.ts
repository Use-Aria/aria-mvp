import "server-only";
// OWNER: 1.1

/**
 * Job kind `noop` (master plan §1.3). Health and smoke checks; always succeeds.
 */
import { z } from "zod";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `noop`. Dedupe key: none. */
export const noopPayload = z.object({ note: z.string().optional() });

/** `noop` handler (maxAttempts 1). */
export const noop = defineJobKind({
  payload: noopPayload,
  maxAttempts: 1,
  run: async () => ({ type: "done" }),
});
