import "server-only";
// OWNER: 3.3

/**
 * Job kind `account_purge` (master plan §1.3, §1.16). Enqueued by the `delete_account` executor
 * at +2 min. Purges only a user whose `deleted_at` is set (never an active account), via the one
 * `deleteAccount` contract (`via: "job"`; idempotent). A user already gone is a no-op.
 */
import { z } from "zod";
import { deleteAccount } from "@/server/account/delete";
import { db } from "@/server/db";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `account_purge`. Dedupe key: `purge:<userId>`; job `user_id` is null so the cascade can't delete the running job. */
export const accountPurgePayload = z.object({ userId: z.uuid() });

/** `account_purge` handler (maxAttempts 3). */
export const accountPurge = defineJobKind({
  payload: accountPurgePayload,
  maxAttempts: 3,
  run: async (_ctx, p) => {
    const { data, error } = await db().from("users").select("deleted_at").eq("id", p.userId).maybeSingle();
    if (error) throw new Error(`account_purge: user read failed: ${error.message}`);
    if (!data) return { type: "done" };
    if (!data.deleted_at) {
      console.warn("[account_purge] skipped: user is not marked deleted");
      return { type: "done" };
    }
    await deleteAccount(p.userId, { via: "job" });
    return { type: "done" };
  },
});
