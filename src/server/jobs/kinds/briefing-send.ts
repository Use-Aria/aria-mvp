import "server-only";
// OWNER: 4.1

/**
 * Job kind `briefing_send` (master plan §1.3). Calls `sendBriefing` (briefing/run.ts). Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `briefing_send`. Dedupe key: `briefing_send:<userId>:<localDate>`. */
export const briefingSendPayload = z.object({
  localDate: z.iso.date(),
  regenerate: z.boolean().optional(),
  kind: z.enum(["catchup"]).optional(),
});

/** `briefing_send` handler (maxAttempts 5). */
export const briefingSend = defineJobKind({
  payload: briefingSendPayload,
  maxAttempts: 5,
  run: async () => {
    throw notImplemented("4.1");
  },
});
