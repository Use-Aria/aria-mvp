import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/** Pending-action executor registry (master plan §1.5). */
import type { z } from "zod";
import type { PendingActionExecutor, PendingKind } from "@/server/agent/pending/types";
import { deleteAccountExecutor } from "@/server/agent/pending/executors/delete-account";
import { sendEmailExecutor } from "@/server/agent/pending/executors/send-email";

/** Every executor, one per `PendingKind`. */
export const EXECUTORS: readonly PendingActionExecutor<z.ZodType>[] = [
  deleteAccountExecutor /* 3.3 */,
  sendEmailExecutor /* 4.3 */,
];

/**
 * Look up the executor for a kind.
 * @param kind pending-action kind
 * @returns the executor, or undefined for an unknown kind
 */
export function getExecutor(kind: PendingKind | string): PendingActionExecutor<z.ZodType> | undefined {
  return EXECUTORS.find((e) => e.kind === kind);
}
