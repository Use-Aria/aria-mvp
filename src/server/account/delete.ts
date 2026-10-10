import "server-only";
// OWNER: 4.6

/**
 * Account deletion (master plan §1.16, conflict C17; web plan §7.6 order). One function for every
 * surface:
 *  - `via: "web"` (settings delete) and `via: "chat"` delete right away;
 *  - `via: "job"` is the `account_purge` job (3.3), after the `delete_account` executor already set
 *    `users.deleted_at`, revoked sessions and scheduled the purge.
 *
 * Order (every step idempotent, so a second call, or a retry after a partial failure, finishes the job):
 *  0. For `web`/`chat`, first schedule an `account_purge` safety net (+10 min, job `user_id` NULL):
 *     if this call dies halfway, the purge finishes it (otherwise a soft-deleted user could neither
 *     sign in nor text Aria to try again). Then mark `users.deleted_at` (kept if already set) and
 *     revoke every web session, so the pipeline and the web ignore the user while teardown runs.
 *  1. `disconnectGoogle(userId, {reason: "account_deleted"})`: stop watches, revoke at Google, delete
 *     the row. Retried once if it throws; `googleRevoked` is false only if a grant may remain.
 *  2. `disconnectCanvas(userId)` (best effort: the user cascade removes whatever it leaves behind).
 *  3. Delete `signups` matched to the user or sharing one of their phone handles (they would
 *     otherwise survive via `on delete set null`).
 *  4. `delete from users` → everything else cascades. `llm_calls.user_id` / `run_id` are set null by
 *     design (V2-04: no content, kept for cost accounting), so they are not deleted here.
 *  5. Cancel the safety-net purge (web/chat) and log `account_deleted` with a masked handle only.
 *
 * Neither disconnect texts the user (3.6 claims the "Google stopped working" notice first; Canvas
 * teardown sends nothing), and `deleted_at` is set before either runs.
 */
import { accountPurgeKey } from "@/server/agent/pending/executors/delete-account";
import { db } from "@/server/db";
import { disconnectCanvas } from "@/server/integrations/canvas";
import { disconnectGoogle } from "@/server/integrations/google";
import { cancelJobs, enqueueJob } from "@/server/jobs/enqueue";
import { maskHandle } from "@/server/phone";
import { revokeAllSessions } from "@/server/security/sessions";

/** Delay of the web/chat safety-net purge (well past a normal teardown). */
export const DELETE_SAFETY_NET_MS = 10 * 60_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 160) : "error";
}

/**
 * Google teardown with one retry when it throws (a DB error deleting the row). A returned
 * `revoked:false` is not retried: the row is already gone, and a second call would wrongly report
 * success. Two throws → `false` (the user cascade still deletes the row and tokens).
 * @param userId owner
 * @returns whether Google confirmed (or nothing was left to revoke)
 */
async function teardownGoogle(userId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { revoked } = await disconnectGoogle(userId, { reason: "account_deleted" });
      return revoked;
    } catch (e) {
      console.warn(`[account] google teardown attempt ${attempt} failed: ${errMsg(e)}`);
    }
  }
  return false;
}

/**
 * Delete the signups that belong to this person: matched to the user, or carrying one of their phones.
 * @param userId owner
 * @param phones the user's E.164 phone handles
 */
async function deleteSignups(userId: string, phones: string[]): Promise<void> {
  const byMatch = await db().from("signups").delete().eq("matched_user_id", userId);
  if (byMatch.error) throw new Error(`deleteAccount(signups): ${byMatch.error.message}`);
  if (phones.length === 0) return;
  const byPhone = await db().from("signups").delete().in("phone_e164", phones);
  if (byPhone.error) throw new Error(`deleteAccount(signups): ${byPhone.error.message}`);
}

/**
 * Hard-delete a user and everything they own.
 * @param userId user to delete
 * @param o which surface asked
 * @returns ok + whether the Google token was revoked at Google
 */
export async function deleteAccount(userId: string, o: { via: "web" | "chat" | "job" }): Promise<{ ok: true; googleRevoked: boolean }> {
  const user = await db().from("users").select("id, deleted_at").eq("id", userId).maybeSingle();
  if (user.error) throw new Error(`deleteAccount(users): ${user.error.message}`);
  if (!user.data) return { ok: true, googleRevoked: true }; // already gone: the cascade took the rest

  const channels = await db().from("channels").select("handle, handle_kind").eq("user_id", userId);
  if (channels.error) throw new Error(`deleteAccount(channels): ${channels.error.message}`);
  const handles = channels.data ?? [];
  const phones = handles.filter((c) => c.handle_kind === "phone").map((c) => c.handle);
  const masked = handles[0] ? maskHandle(handles[0].handle) : "none";

  // 0. Safety net (web/chat) BEFORE the soft-delete, so a marked user always has a purge coming;
  //    if scheduling fails, nothing has changed yet and the caller can retry.
  const safetyNet = o.via !== "job";
  if (safetyNet) {
    await enqueueJob({
      kind: "account_purge",
      userId: null,
      runAt: new Date(Date.now() + DELETE_SAFETY_NET_MS),
      payload: { userId },
      dedupeKey: accountPurgeKey(userId),
      mode: "keep",
    });
  }
  // Soft-delete: the pipeline, deliver and the web stop seeing the user.
  if (!user.data.deleted_at) {
    const mark = await db().from("users").update({ deleted_at: new Date().toISOString() }).eq("id", userId).is("deleted_at", null);
    if (mark.error) {
      if (safetyNet) await cancelJobs({ dedupeKey: accountPurgeKey(userId) }).catch(() => 0);
      throw new Error(`deleteAccount(mark): ${mark.error.message}`);
    }
  }
  try {
    await revokeAllSessions(userId);
  } catch (e) {
    console.warn(`[account] revokeAllSessions failed: ${errMsg(e)}`); // sessions cascade with the user
  }

  // 1–2. Integrations (neither texts the user).
  const googleRevoked = await teardownGoogle(userId);
  try {
    await disconnectCanvas(userId);
  } catch (e) {
    console.warn(`[account] canvas teardown failed (cascade covers it): ${errMsg(e)}`);
  }

  // 3–4. Signups, then the user row (cascade).
  await deleteSignups(userId, phones);
  const del = await db().from("users").delete().eq("id", userId);
  if (del.error) throw new Error(`deleteAccount(delete): ${del.error.message}`);

  // 5. Done: drop the safety net (a no-op purge would also be harmless).
  if (safetyNet) {
    await cancelJobs({ dedupeKey: accountPurgeKey(userId) }).catch((e: unknown) => {
      console.warn(`[account] safety-net cancel failed: ${errMsg(e)}`);
    });
  }
  console.info(`[account] account_deleted via=${o.via} handle=${masked} googleRevoked=${googleRevoked}`);
  return { ok: true, googleRevoked };
}

/**
 * Whether a deletion is already under way or done (user gone, or `deleted_at` set). The web uses
 * it after `deleteAccount` threw: a marked user is finished by the safety-net purge, so the page
 * can still confirm the deletion.
 * @param userId user
 * @returns true when the user is gone or soft-deleted; false when still active (or unreadable)
 */
export async function accountDeletionStarted(userId: string): Promise<boolean> {
  const { data, error } = await db().from("users").select("deleted_at").eq("id", userId).maybeSingle();
  if (error) return false;
  return !data || data.deleted_at !== null;
}
