import "server-only";
// OWNER: 4.1

/**
 * Job kind `briefing_prepare` (master plan §1.3). Calls `prepareBriefing` (briefing/run.ts). Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `briefing_prepare`. Dedupe key: `briefing_prep:<userId>`. */
export const briefingPreparePayload = z.object({ targetAt: z.iso.datetime(), localDate: z.iso.date() });

/** `briefing_prepare` handler (maxAttempts 5). */
export const briefingPrepare = defineJobKind({
  payload: briefingPreparePayload,
  maxAttempts: 5,
  run: async () => {
    throw notImplemented("4.1");
  },
});
