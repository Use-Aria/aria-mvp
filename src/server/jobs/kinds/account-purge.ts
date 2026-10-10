import "server-only";
// OWNER: 3.3

/**
 * Job kind `account_purge` (master plan §1.3). Calls `deleteAccount(userId, {via: "job"})`. Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `account_purge`. Dedupe key: `purge:<userId>`; job `user_id` is null so the cascade can't delete the running job. */
export const accountPurgePayload = z.object({ userId: z.uuid() });

/** `account_purge` handler (maxAttempts 3). */
export const accountPurge = defineJobKind({
  payload: accountPurgePayload,
  maxAttempts: 3,
  run: async () => {
    throw notImplemented("3.3");
  },
});
