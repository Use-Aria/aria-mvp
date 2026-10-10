import "server-only";
// OWNER: 3.3

/**
 * `delete_account` executor (master plan §1.5/§1.16): sets `users.deleted_at`, `revokeAllSessions`,
 * enqueues `account_purge` at +2 min (job `user_id` null). Wave 0 stub.
 */
import { z } from "zod";
import { notImplemented } from "@/server/_stub";
import { definePendingAction } from "@/server/agent/pending/types";

/** Payload of a `delete_account` pending action (none). */
export const DeleteAccountPayload = z.object({}).strict();

/** Executor for `delete_account` (1h TTL). */
export const deleteAccountExecutor = definePendingAction({
  kind: "delete_account",
  payload: DeleteAccountPayload,
  ttlMs: 60 * 60_000,
  describe: () => "delete your Aria account and all data",
  execute: async () => {
    throw notImplemented("3.3");
  },
});
