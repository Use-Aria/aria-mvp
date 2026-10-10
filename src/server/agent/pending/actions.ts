import "server-only";
// OWNER: 3.3

/**
 * Pending actions — the ONE path for chat and web (master plan §1.5). Wave 0 stub:
 * reads return neutral values, mutators throw.
 */
import { notImplemented } from "@/server/_stub";
import type { ToolCtx } from "@/server/agent/types";
import type { OpenAction, PendingActionView, PendingKind } from "@/server/agent/pending/types";
import type { JsonValue } from "@/server/timeline/types";

/**
 * Create a pending action from a tool (payload validated against the executor's schema).
 * @param ctx tool context (user, run, aliases)
 * @param i kind, payload, model-facing summary, optional superseded action id
 * @returns the new row id and its `a_` alias
 */
export async function createPendingAction(
  ctx: ToolCtx,
  i: { kind: PendingKind; payload: unknown; summary: string; supersedes?: string },
): Promise<{ id: string; alias: string }> {
  void ctx;
  void i;
  throw notImplemented("3.3");
}

/**
 * Open (pending, unexpired) actions for the agent's "now" block.
 * @param userId owner
 * @returns open actions, newest first
 */
export async function listOpenActions(userId: string): Promise<OpenAction[]> {
  void userId;
  return [];
}

/**
 * One action, owner-scoped (web §8 shape).
 * @param userId owner
 * @param id pending_actions.id
 * @returns the view, or null when missing / not owned
 */
export async function getPendingAction(userId: string, id: string): Promise<PendingActionView | null> {
  void userId;
  void id;
  return null;
}

/**
 * Patch a pending action's payload under a version guard (web edits subject/body only).
 * @param userId owner
 * @param id action id
 * @param expectedVersion version the editor saw
 * @param patch payload fields to merge
 * @param via surface
 * @returns new version, or why not
 */
export async function revisePendingAction(
  userId: string,
  id: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
  via: "chat" | "web",
): Promise<{ ok: true; version: number } | { ok: false; code: "not_found" | "not_pending" | "expired" | "version_conflict" }> {
  void userId;
  void id;
  void expectedVersion;
  void patch;
  void via;
  throw notImplemented("3.3");
}

/** Atomic pending→executing (version + expiry + same-run guards), run executor, →done|failed. At-most-once. */
export async function confirmPendingAction(
  userId: string,
  id: string,
  o: { via: "chat" | "web"; expectedVersion?: number; runId?: string },
): Promise<
  | { ok: true; summary: string; result?: Record<string, JsonValue> }
  | {
      ok: false;
      code:
        | "not_found"
        | "not_pending"
        | "expired"
        | "version_conflict"
        | "same_run"
        | "executor_failed"
        | "google_disconnected";
    }
> {
  void userId;
  void id;
  void o;
  throw notImplemented("3.3");
}

/**
 * Cancel a pending action (pending → cancelled).
 * @param userId owner
 * @param id action id
 * @param via surface
 * @returns ok, or why not
 */
export async function cancelPendingAction(
  userId: string,
  id: string,
  via: "chat" | "web",
): Promise<{ ok: true } | { ok: false; code: "not_found" | "not_pending" }> {
  void userId;
  void id;
  void via;
  throw notImplemented("3.3");
}
