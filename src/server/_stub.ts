import "server-only";
// OWNER: 0.2 (deleted by task 5.2 once `grep -rn "@/server/_stub" src/` is empty)

/**
 * Wave 0 stub helpers (master plan §1.0.3).
 *
 * Mutating stubs `throw notImplemented("<task id>")`; tool stubs return `stubToolResult("<task id>")`.
 * Deleting this file (task 5.2) makes `tsc` fail on any stub left behind, so the gate is
 * self-enforcing: `grep -rn "notImplemented(\|stubToolResult(" src/` must list only this file.
 */
import { PermanentJobError } from "@/server/jobs/types";

/**
 * Raised by a Wave 0 stub mutator. Extends `PermanentJobError` so a job that reaches a stub
 * dead-letters at once instead of retrying against code that doesn't exist yet.
 */
export class NotImplementedError extends PermanentJobError {
  /** Task id that owns the missing implementation (e.g. "2.1"). */
  readonly owner: string;

  constructor(owner: string) {
    super(`not implemented yet (owner: task ${owner})`);
    this.name = "NotImplementedError";
    this.owner = owner;
  }
}

/**
 * Build the error a stub mutator throws: `throw notImplemented("2.1")`.
 * @param owner task id that will implement the function
 * @returns a `NotImplementedError` (never thrown by this function itself)
 */
export function notImplemented(owner: string): NotImplementedError {
  return new NotImplementedError(owner);
}

/**
 * Result every Wave 0 agent-tool stub returns from `run` (never a success).
 * @param owner task id that will implement the tool
 * @returns `{ ok: false, error: "not_implemented" }`
 */
export function stubToolResult(owner: string): { ok: false; error: "not_implemented" } {
  void owner; // kept in the call site for the Wave 4 grep gate
  return { ok: false, error: "not_implemented" };
}
