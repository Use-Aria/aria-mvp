import "server-only";
// OWNER: 2.1

/**
 * Fast-path turn scheduling (V2-03 §2.1, §2.3).
 *
 * Debounce lives in the `jobs` row: every inbound upserts one pending `conversation_turn` job
 * (`turn:<userId>`, debounce mode) whose `run_at` moves to now + 2.5s, capped at 8s after the
 * burst's first enqueue. The webhook's `after()` sleeps until that `run_at` (DB clock) and then
 * claims *that job id*; only the last sleeper of a burst finds it due. If the invocation dies,
 * the 15s tick runs the job instead.
 */
import { enqueueJob, type EnqueueResult } from "@/server/jobs/enqueue";
import { errorText, runDueJobs } from "@/server/jobs/runner";
import { PIPELINE } from "@/server/pipeline/config";

/** Extra wait after `run_at` so the claim sees the row as due. */
export const KICK_SLACK_MS = 50;

/** Dedupe key of a user's pending conversation turn. */
export function turnDedupeKey(userId: string): string {
  return `turn:${userId}`;
}

/**
 * Upserts the user's debounced `conversation_turn` job.
 * @param userId users.id
 * @param dbNow DB clock at ingest (default: local clock); `run_at` = dbNow + 2.5s
 * @returns job id, effective run time and DB clock
 */
export async function enqueueTurn(userId: string, dbNow: Date = new Date()): Promise<EnqueueResult> {
  return enqueueJob({
    kind: "conversation_turn",
    userId,
    payload: { userId },
    dedupeKey: turnDedupeKey(userId),
    mode: "debounce",
    runAt: new Date(dbNow.getTime() + PIPELINE.debounceMs),
    maxDelayMs: PIPELINE.maxDebounceMs,
  });
}

/**
 * How long the fast path sleeps before claiming (pure).
 * @param runAt job run_at
 * @param dbNow DB clock when run_at was read
 * @returns milliseconds ≥ 0 (includes `KICK_SLACK_MS`)
 */
export function kickDelayMs(runAt: Date, dbNow: Date): number {
  return Math.max(0, runAt.getTime() - dbNow.getTime()) + KICK_SLACK_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Sleeps, then claims and runs exactly this job inline if it is due (a newer inbound that pushed
 * `run_at`, or the tick, may have taken it, in which case nothing happens). Never throws.
 * @param jobId conversation_turn job id
 * @param delayMs sleep before the claim (`kickDelayMs`)
 * @param opts invocation budget left for the run (default 270s minus the delay)
 */
export async function kickJob(jobId: string, delayMs: number, opts: { budgetMs?: number } = {}): Promise<void> {
  if (delayMs > 0) await sleep(delayMs);
  const budgetMs = opts.budgetMs ?? Math.max(30_000, PIPELINE.runDeadlineMs - delayMs);
  try {
    await runDueJobs({ budgetMs, concurrency: 1, jobId });
  } catch (e) {
    console.error(`[pipeline] kick ${jobId.slice(0, 8)} failed: ${errorText(e)}`);
  }
}

/**
 * End-of-run drain: claims the user's due `turn:<userId>` job inline (messages that arrived at the
 * tail of a run don't wait for the 15s tick). Never throws.
 * @param userId users.id
 * @param opts invocation budget left (default 270s; pass what remains of the current invocation)
 */
export async function drainUserTurn(userId: string, opts: { budgetMs?: number } = {}): Promise<void> {
  try {
    await runDueJobs({
      budgetMs: opts.budgetMs ?? PIPELINE.runDeadlineMs,
      concurrency: 1,
      dedupeKey: turnDedupeKey(userId),
    });
  } catch (e) {
    console.error(`[pipeline] drain failed: ${errorText(e)}`);
  }
}
