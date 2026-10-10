import "server-only";
// OWNER: 3.4

/**
 * Job kind `canvas_sync` (master plan §1.3). `{}` (cron/V2-07 inserts) parses as scheduled. Calls `runCanvasSync`. Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `canvas_sync`. Dedupe key: `canvas_sync:<userId>`. */
export const canvasSyncPayload = z
  .object({
    reason: z.enum(["scheduled", "manual", "email_hint"]).default("scheduled"),
  })
  .strict();

/** `canvas_sync` handler (maxAttempts 5). */
export const canvasSync = defineJobKind({
  payload: canvasSyncPayload,
  maxAttempts: 5,
  run: async () => {
    throw notImplemented("3.4");
  },
});
