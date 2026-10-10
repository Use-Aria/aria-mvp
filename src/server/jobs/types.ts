import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Job handler contract (master plan §1.3; V2-03 §7 `jobs/types.ts` verbatim + `PermanentJobError`).
 *
 * A job kind is one file under `src/server/jobs/kinds/` exporting `defineJobKind({...})`, plus one
 * line in the frozen registry `kinds/index.ts`. The runner (task 1.1) zod-parses `payload` before
 * calling `run`; a thrown error means "retry with backoff" unless it is a `PermanentJobError`.
 */
import type { z } from "zod";

/** What the runner hands a handler for one claimed job. */
export interface JobContext {
  jobId: string;
  kind: string;
  userId: string | null;
  /** 1-based attempt number of this run. */
  attempt: number;
  maxAttempts: number;
  /** Claim token (finish_job compare-and-set). */
  token: string;
  now: Date;
  /** Epoch ms after which the handler must stop starting new work. */
  deadline: number;
  signal: AbortSignal;
}

/** How a handler run ended. Returning `void` means `done`. */
export type JobOutcome =
  | { type: "done" }
  | { type: "retry"; error: string; delayMs?: number }
  | { type: "reschedule"; runAt: Date; reason: string }
  | { type: "dead"; error: string };

/** One job kind: payload schema, attempt budget, and the handler body. */
export interface JobHandler<S extends z.ZodType> {
  payload: S;
  /** Attempts before dead-lettering (master plan §1.3 table). */
  maxAttempts?: number;
  run(ctx: JobContext, payload: z.output<S>): Promise<JobOutcome | void>;
}

/**
 * Declare a job kind. Identity function that pins the payload type for `run`.
 * @param h payload schema, maxAttempts, handler
 * @returns the same handler, typed
 */
export function defineJobKind<S extends z.ZodType>(h: JobHandler<S>): JobHandler<S> {
  return h;
}

/** Throw from a handler → job goes straight to `dead` (no retry). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
