import "server-only";
// OWNER: 3.6

/**
 * Job kind `gcal_watch_renew` (master plan §1.3). Calls `renewCalendarWatch`. Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `gcal_watch_renew`. Dedupe key: `gcal_watch_renew:<uid>`. */
export const gcalWatchRenewPayload = z.object({});

/** `gcal_watch_renew` handler (maxAttempts 5). */
export const gcalWatchRenew = defineJobKind({
  payload: gcalWatchRenewPayload,
  maxAttempts: 5,
  run: async () => {
    throw notImplemented("3.6");
  },
});
