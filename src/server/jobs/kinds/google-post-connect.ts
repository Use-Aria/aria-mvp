import "server-only";
// OWNER: 3.6

/**
 * Job kind `google_post_connect` (master plan §1.3). Ack → calendar list → gcal sync → watches → (Gmail) watch + `startTriage`. Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `google_post_connect`. Dedupe key: `google_post_connect:<userId>`. */
export const googlePostConnectPayload = z.object({});

/** `google_post_connect` handler (maxAttempts 3). */
export const googlePostConnect = defineJobKind({
  payload: googlePostConnectPayload,
  maxAttempts: 3,
  run: async () => {
    throw notImplemented("3.6");
  },
});
