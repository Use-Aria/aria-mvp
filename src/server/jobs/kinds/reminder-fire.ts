import "server-only";
// OWNER: 2.6

/**
 * Job kind `reminder_fire` (master plan §1.3). Calls `fireReminder` (reminders/fire.ts), which
 * re-validates against the `reminders` row, so stale/early/duplicate jobs are harmless.
 * A thrown error (delivery failure, DB error) retries with backoff.
 */
import { z } from "zod";
import { defineJobKind } from "@/server/jobs/types";
import { fireReminder } from "@/server/reminders/fire";

/** Payload of `reminder_fire`. Dedupe key: `reminder:<reminderId>`. */
export const reminderFirePayload = z.object({ reminderId: z.uuid(), dueAt: z.iso.datetime() });

/** `reminder_fire` handler (maxAttempts 5). */
export const reminderFire = defineJobKind({
  payload: reminderFirePayload,
  maxAttempts: 5,
  run: async (ctx, payload) => {
    await fireReminder(payload, ctx.now);
  },
});
