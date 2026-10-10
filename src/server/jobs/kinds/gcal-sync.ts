import "server-only";
// OWNER: 3.6

/**
 * Job kind `gcal_sync` (master plan §1.3). Calls `syncCalendarWindow`; the periodic run re-enqueues itself. Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `gcal_sync`. Dedupe key: `gcal_sync:<uid>` (push) / `gcal_sync_periodic:<uid>`. */
export const gcalSyncPayload = z.object({ reason: z.enum(["push", "periodic", "connect", "manual"]) });

/** `gcal_sync` handler (maxAttempts 5). */
export const gcalSync = defineJobKind({
  payload: gcalSyncPayload,
  maxAttempts: 5,
  run: async () => {
    throw notImplemented("3.6");
  },
});
