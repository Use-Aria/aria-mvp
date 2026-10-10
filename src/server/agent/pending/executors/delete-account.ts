import "server-only";
// OWNER: 3.3

/**
 * `delete_account` executor (master plan §1.5/§1.16, conflict C17). Chat path only:
 *  1. `users.deleted_at = now` (the pipeline and `deliver` ignore the user from here on),
 *  2. `revokeAllSessions` (web links stop working at once),
 *  3. enqueue `account_purge` at +2 min with job `user_id` NULL (so the cascade can't delete the
 *     running job) and payload `{userId}`; that job calls `deleteAccount(…, {via:"job"})`.
 * Idempotent: a second run keeps the first `deleted_at` and the dedupe key keeps one purge job.
 */
import { z } from "zod";
import { definePendingAction } from "@/server/agent/pending/types";
import { db } from "@/server/db";
import { cancelJobs, enqueueJob } from "@/server/jobs/enqueue";
import { revokeAllSessions } from "@/server/security/sessions";

/** Payload of a `delete_account` pending action (none). */
export const DeleteAccountPayload = z.object({}).strict();

/** Delay between the in-chat confirmation and the hard delete. */
export const ACCOUNT_PURGE_DELAY_MS = 2 * 60_000;

/**
 * Dedupe key of a user's purge job.
 * @param userId user being deleted
 * @returns `purge:<userId>`
 */
export function accountPurgeKey(userId: string): string {
  return `purge:${userId}`;
}

/** Executor for `delete_account` (1h TTL). */
export const deleteAccountExecutor = definePendingAction({
  kind: "delete_account",
  payload: DeleteAccountPayload,
  ttlMs: 60 * 60_000,
  describe: () => "delete your Aria account and all data",
  execute: async (ctx) => {
    // Purge job first: if marking the user fails we cancel it, so a "deleted" user is never
    // left without a purge (the pipeline ignores them, so they couldn't ask again).
    const job = await enqueueJob({
      kind: "account_purge",
      userId: null,
      runAt: new Date(ctx.now.getTime() + ACCOUNT_PURGE_DELAY_MS),
      payload: { userId: ctx.userId },
      dedupeKey: accountPurgeKey(ctx.userId),
      mode: "keep",
    });
    const { error } = await db()
      .from("users")
      .update({ deleted_at: ctx.now.toISOString() })
      .eq("id", ctx.userId)
      .is("deleted_at", null);
    if (error) {
      await cancelJobs({ dedupeKey: accountPurgeKey(ctx.userId) }).catch(() => 0);
      return { ok: false, error: "mark_deleted_failed", retryable: true };
    }
    try {
      await revokeAllSessions(ctx.userId);
    } catch (e) {
      // Sessions die with the user at purge time anyway (cascade).
      console.warn("[delete_account] revokeAllSessions failed", e instanceof Error ? e.name : "error");
    }
    return { ok: true, summary: "account scheduled for deletion", result: { purge_at: job.runAt.toISOString() } };
  },
});
