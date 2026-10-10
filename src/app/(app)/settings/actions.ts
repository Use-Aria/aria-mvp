"use server";

/**
 * /settings server actions (web plan §7.6, §2.3 freshness matrix). Every action re-checks Origin,
 * session, and freshness inside itself (`requireActionViewer`), validates its inputs with zod, and
 * returns a small `ActionResult` (never a DB row). Memory changes are owner-scoped by the session's
 * user id and rate-limited (30 per 10 min).
 *
 * Freshness: edit a preference or fact, keep a suggestion → `recent` (< 60 min); delete a memory,
 * don't keep a suggestion → `any`; delete the account → `fresh_setup` (< 15 min setup link).
 */
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { accountDeletionStarted, deleteAccount } from "@/server/account/delete";
import { answerProposal, deleteFact, editFact, editPreference, removePreference } from "@/server/memory";
import { rateLimit } from "@/server/ratelimit";
import { clearedSessionCookie } from "@/server/security/sessions";
import { requireActionViewer, type Need } from "@/server/web/guard";
import { actionFail, actionOk, type ActionResult } from "@/shared/action-result";

const Id = z.uuid();
const Statement = z.string().trim().min(1).max(280);
const FactContent = z.string().trim().min(1).max(500);

type MemoryOp = (userId: string) => Promise<{ ok: true } | { ok: false; code: "not_found" | "not_pending" }>;

/**
 * Shared body of the memory actions: guard → rate limit → op → refresh.
 * @param need freshness level
 * @param op the memory API call for the viewer's user id
 * @returns action result
 */
async function memoryAction(need: Need, op: MemoryOp): Promise<ActionResult> {
  const guard = await requireActionViewer(need);
  if (!guard.ok) return actionFail(guard.code);
  const userId = guard.viewer.userId;
  if (!(await rateLimit(`memory_edit:${userId}`, 30, 600))) return actionFail("rate_limited");
  try {
    const r = await op(userId);
    if (!r.ok) return actionFail(r.code);
  } catch (e) {
    console.error(`[settings] memory action failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    return actionFail("server");
  }
  refresh();
  return actionOk();
}

/**
 * Edit an active or suggested preference's wording (`recent`; 1–280 chars).
 * @param prefId preference id from the page
 * @param statement new wording
 * @returns action result
 */
export async function editPreferenceAction(prefId: string, statement: string): Promise<ActionResult> {
  const id = Id.safeParse(prefId);
  const text = Statement.safeParse(statement);
  if (!id.success || !text.success) return actionFail("invalid");
  return memoryAction("recent", (userId) => editPreference(userId, id.data, text.data));
}

/**
 * Delete (retire) a preference (`any`: privacy-positive).
 * @param prefId preference id
 * @returns action result
 */
export async function removePreferenceAction(prefId: string): Promise<ActionResult> {
  const id = Id.safeParse(prefId);
  if (!id.success) return actionFail("invalid");
  return memoryAction("any", (userId) => removePreference(userId, id.data));
}

/**
 * "Keep it" (`recent`: a kept rule steers the agent) or "Don't keep" (`any`: privacy-positive,
 * like delete) on one of Aria's suggestions.
 * @param prefId suggestion id
 * @param keep true = keep as a rule
 * @returns action result
 */
export async function answerProposalAction(prefId: string, keep: boolean): Promise<ActionResult> {
  const id = Id.safeParse(prefId);
  if (!id.success || typeof keep !== "boolean") return actionFail("invalid");
  return memoryAction(keep ? "recent" : "any", (userId) => answerProposal(userId, id.data, keep));
}

/**
 * Edit a remembered fact (`recent`; 1–500 chars).
 * @param factId fact id
 * @param content new text
 * @returns action result
 */
export async function editFactAction(factId: string, content: string): Promise<ActionResult> {
  const id = Id.safeParse(factId);
  const text = FactContent.safeParse(content);
  if (!id.success || !text.success) return actionFail("invalid");
  return memoryAction("recent", (userId) => editFact(userId, id.data, text.data));
}

/**
 * Forget a fact for real (hard delete; `any`).
 * @param factId fact id
 * @returns action result
 */
export async function deleteFactAction(factId: string): Promise<ActionResult> {
  const id = Id.safeParse(factId);
  if (!id.success) return actionFail("invalid");
  return memoryAction("any", (userId) => deleteFact(userId, id.data));
}

/**
 * Delete the account (`fresh_setup` + the typed word "delete"), clear this browser's cookie, and
 * land on /account-deleted (`?g=0` when Google didn't confirm the revoke). If deletion threw after
 * the account was already marked deleted, the safety-net purge finishes it, so the page still
 * confirms (with `?g=0`, since the revoke is unconfirmed).
 * @param _prev previous state (`useActionState`)
 * @param form the dialog form (`confirm`)
 * @returns an error result; on success it redirects instead
 */
export async function deleteAccountAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const guard = await requireActionViewer("fresh_setup");
  if (!guard.ok) return actionFail(guard.code);
  const confirm = form.get("confirm");
  if (typeof confirm !== "string" || confirm.trim().toLowerCase() !== "delete") return actionFail("invalid");
  const userId = guard.viewer.userId;

  let googleRevoked = false;
  try {
    ({ googleRevoked } = await deleteAccount(userId, { via: "web" }));
  } catch (e) {
    console.error(`[settings] delete account failed: ${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`);
    if (!(await accountDeletionStarted(userId))) return actionFail("server");
  }
  const c = clearedSessionCookie();
  (await cookies()).set(c.name, c.value, c.options);
  redirect(googleRevoked ? "/account-deleted" : "/account-deleted?g=0");
}
