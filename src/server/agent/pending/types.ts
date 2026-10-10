import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Pending-action contracts (master plan §1.5, conflict C15). One path for chat and web:
 * create → (revise) → confirm (atomic pending→executing, executor, done|failed) | cancel | expire.
 */
import type { z } from "zod";
import type { JsonValue } from "@/server/timeline/types";

export type PendingKind = "send_email" | "delete_account";
export type PendingStatus = "pending" | "executing" | "done" | "failed" | "cancelled" | "expired";

export interface ExecContext {
  userId: string;
  actionId: string;
  via: "chat" | "web";
  now: Date;
}

/** Executor result. */
export type ExecResult =
  | { ok: true; summary: string; result?: Record<string, JsonValue> }
  | { ok: false; error: string; retryable: boolean };

export interface PendingActionExecutor<P extends z.ZodType = z.ZodType> {
  kind: PendingKind;
  payload: P;
  ttlMs: number;
  describe(p: z.output<P>): string;
  execute(ctx: ExecContext, p: z.output<P>): Promise<ExecResult>;
  /** For rows stuck in `executing` > 5 min: decide whether the side effect already happened (send_email: sent-folder lookup). */
  recover?(ctx: ExecContext, p: z.output<P>): Promise<"done" | "not_done">;
}

/**
 * Declare a pending-action executor. Identity function that pins the payload type.
 * @param e executor definition
 * @returns the same executor, typed
 */
export function definePendingAction<P extends z.ZodType>(e: PendingActionExecutor<P>): PendingActionExecutor<P> {
  return e;
}

/** An open (pending, unexpired) action, as listed for the agent's "now" block. */
export interface OpenAction {
  id: string;
  kind: PendingKind;
  summary: string;
  version: number;
  runId: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Read model for chat and web (web §8 shape; `status` is `PendingStatus`). */
export interface PendingActionView {
  id: string;
  kind: PendingKind;
  version: number;
  status: PendingStatus;
  /** parse with the executor's schema (send_email: `SendEmailPayload`) */
  payload: unknown;
  summary: string | null;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decidedVia: "chat" | "web" | null;
  result: Record<string, JsonValue> | null;
  error: string | null;
}
