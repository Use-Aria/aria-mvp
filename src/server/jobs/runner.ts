import "server-only";
// OWNER: 1.1

/**
 * Jobs runner (V2-03 §2.11 "Claim", "Finish", "Handler contract", "Dispatch"; §2.14 unknown kinds).
 *
 * claim (`claim_jobs`, SKIP LOCKED, also reclaims expired locks) → dispatch by the kind registry →
 * finish (`finish_job`, owner-checked) with retry/backoff/dead-letter:
 * - handler returns `void` / `{type:"done"}` → done
 * - handler throws → retry after `retryDelayMs(attempt)`; `finish_job` turns a retry on the last
 *   attempt into `dead`
 * - handler throws `PermanentJobError` (incl. `NotImplementedError`) or the payload fails zod → dead
 * - `{type:"reschedule"}` gives the attempt back
 *
 * Every invocation is bounded (Vercel Hobby: 300s hard cap), so the claim lock is a global 330s
 * and there are no per-kind leases. Delivery is at-least-once: if the process dies mid-handler the
 * lock expires and the next tick reclaims the row.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { db, type Tables } from "@/server/db";
import { retryDelayMs } from "@/server/jobs/backoff";
import { JOB_KINDS, REGISTERED_KINDS } from "@/server/jobs/kinds";
import { PermanentJobError, type JobContext, type JobHandler, type JobOutcome } from "@/server/jobs/types";

/** A `jobs` row as returned by `claim_jobs`. */
export type JobRow = Tables<"jobs">;

/** Global claim lock (master plan §1.3): longer than the 300s invocation cap. */
export const LOCK_SECONDS = 330;
/** Stop claiming new work when less than this much budget is left (V2-03 §2.11). */
export const CLAIM_RESERVE_MS = 60_000;
/** Max stored error length (`finish_job` also truncates to 1000). */
const MAX_ERROR_CHARS = 500;

/** `finish_job` outcome argument. */
export type FinishOutcome = "done" | "retry" | "reschedule" | "dead";
/** `finish_job` return value. */
export type FinishResult = "done" | "pending" | "dead" | "superseded" | "lost";

/** What the runner asks `finish_job` to do for one run. */
export interface FinishDecision {
  outcome: FinishOutcome;
  /** New run time for retry/reschedule; null otherwise. */
  runAt: Date | null;
  /** Stored in `jobs.last_error` (retry/dead). */
  error: string | null;
}

/** Storage seam for the runner (the DB in production; in-memory fakes in unit tests). */
export interface JobStore {
  claim(
    token: string,
    kinds: readonly string[],
    limit: number,
    filter: { jobId?: string; dedupeKey?: string },
  ): Promise<JobRow[]>;
  finish(id: string, token: string, d: FinishDecision): Promise<FinishResult>;
}

/** Registry shape the runner dispatches on (`JOB_KINDS` in production). */
export type JobRegistry = Readonly<Record<string, JobHandler<z.ZodType>>>;

/** Injectable dependencies (all optional; production defaults). */
export interface RunnerDeps {
  store: JobStore;
  registry: JobRegistry;
  /** Logical "now" handed to handlers as `ctx.now`. */
  now: () => Date;
  /** Wall clock (epoch ms) for budgets and deadlines. */
  clock: () => number;
  /** Jitter source for backoff. */
  rng: () => number;
}

/** Counts from one `runDueJobs` call. */
export interface RunSummary {
  claimed: number;
  done: number;
  retried: number;
  rescheduled: number;
  dead: number;
  /** finish_job said the lock was lost (another runner reclaimed the row). */
  lost: number;
  /** finish_job turned a retry/reschedule into done because a newer pending row owns the dedupe key. */
  superseded: number;
  /** claim/finish RPC failures (the job's lock expires and it is reclaimed later). */
  errors: number;
  elapsedMs: number;
}

/** The production store: `claim_jobs` / `finish_job` RPCs via the service-role client. */
export const dbJobStore: JobStore = {
  async claim(token, kinds, limit, filter) {
    const { data, error } = await db().rpc("claim_jobs", {
      p_token: token,
      p_kinds: [...kinds],
      p_limit: limit,
      p_lock_seconds: LOCK_SECONDS,
      p_job_id: filter.jobId,
      p_dedupe_key: filter.dedupeKey,
    });
    if (error) throw new Error(`claim_jobs: ${error.message}`);
    return data ?? [];
  },
  async finish(id, token, d) {
    const { data, error } = await db().rpc("finish_job", {
      p_id: id,
      p_token: token,
      p_outcome: d.outcome,
      p_run_at: d.runAt?.toISOString(),
      p_error: d.error ?? undefined,
    });
    if (error) throw new Error(`finish_job: ${error.message}`);
    return data as FinishResult;
  },
};

function defaultDeps(): RunnerDeps {
  return {
    store: dbJobStore,
    registry: JOB_KINDS,
    now: () => new Date(),
    clock: Date.now,
    rng: Math.random,
  };
}

function withDeps(deps?: Partial<RunnerDeps>): RunnerDeps {
  return { ...defaultDeps(), ...deps };
}

/** Short, single-line error text for `last_error` and logs (never payloads). */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…` : line;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Map a handler result (or throw) to a `finish_job` call. Pure.
 * @param result `{ok: true, outcome}` when the handler returned, `{ok: false, error}` when it threw
 * @param attempt 1-based attempt number of this run (drives the backoff)
 * @param nowMs wall clock in epoch ms
 * @param rng jitter source for `retryDelayMs`
 * @returns the finish decision
 */
export function decideFinish(
  result: { ok: true; outcome: JobOutcome | void } | { ok: false; error: unknown },
  attempt: number,
  nowMs: number,
  rng: () => number = Math.random,
): FinishDecision {
  if (!result.ok) {
    if (result.error instanceof PermanentJobError) {
      return { outcome: "dead", runAt: null, error: errorText(result.error) };
    }
    return {
      outcome: "retry",
      runAt: new Date(nowMs + retryDelayMs(attempt, rng)),
      error: errorText(result.error),
    };
  }
  const o = result.outcome ?? { type: "done" };
  switch (o.type) {
    case "done":
      return { outcome: "done", runAt: null, error: null };
    case "retry": {
      const delay = o.delayMs !== undefined && o.delayMs >= 0 ? o.delayMs : retryDelayMs(attempt, rng);
      return { outcome: "retry", runAt: new Date(nowMs + delay), error: errorText(o.error) };
    }
    case "reschedule":
      return { outcome: "reschedule", runAt: o.runAt, error: null };
    case "dead":
      return { outcome: "dead", runAt: null, error: errorText(o.error) };
  }
}

/**
 * Run one claimed row's handler without touching storage: resolve the kind, zod-parse the
 * payload, build the `JobContext`, call `run`, and decide how to finish.
 * @param row claimed `jobs` row (attempts already incremented by the claim)
 * @param token claim token
 * @param deadline epoch ms after which the handler must stop starting new work (`ctx.deadline`;
 *   `ctx.signal` aborts at this time)
 * @param deps registry, clocks and rng (store unused)
 * @returns the finish decision
 */
export async function executeJob(
  row: JobRow,
  token: string,
  deadline: number,
  deps?: Partial<RunnerDeps>,
): Promise<FinishDecision> {
  const d = withDeps(deps);
  const handler = Object.hasOwn(d.registry, row.kind) ? d.registry[row.kind] : undefined;
  if (!handler) {
    return { outcome: "dead", runAt: null, error: `unknown job kind: ${row.kind}` };
  }
  const parsed = handler.payload.safeParse(row.payload);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { outcome: "dead", runAt: null, error: errorText(`invalid payload: ${issues}`) };
  }

  const controller = new AbortController();
  const msLeft = deadline - d.clock();
  const timer = setTimeout(() => controller.abort(new Error("job deadline reached")), Math.max(0, msLeft));
  timer.unref?.();
  const ctx: JobContext = {
    jobId: row.id,
    kind: row.kind,
    userId: row.user_id,
    attempt: row.attempts,
    maxAttempts: row.max_attempts,
    token,
    now: d.now(),
    deadline,
    signal: controller.signal,
  };
  try {
    const outcome = await handler.run(ctx, parsed.data);
    return decideFinish({ ok: true, outcome }, row.attempts, d.clock(), d.rng);
  } catch (e) {
    return decideFinish({ ok: false, error: e }, row.attempts, d.clock(), d.rng);
  } finally {
    clearTimeout(timer);
  }
}

/** One run of a claimed row: handler, then `finish_job`. Never throws. */
async function runOne(
  row: JobRow,
  token: string,
  deadline: number,
  d: RunnerDeps,
): Promise<{ decision: FinishDecision; result: FinishResult | null }> {
  const started = d.clock();
  const decision = await executeJob(row, token, deadline, d);
  const tag = `[jobs] ${row.kind} ${shortId(row.id)} attempt ${row.attempts}/${row.max_attempts}`;
  let result: FinishResult | null;
  try {
    result = await d.store.finish(row.id, token, decision);
  } catch (e) {
    console.error(`${tag}: finish failed (${errorText(e)}); the lock will expire and the job is reclaimed`);
    return { decision, result: null };
  }
  const ms = d.clock() - started;
  if (result === "dead") {
    console.error(`${tag}: dead after ${ms}ms: ${decision.error ?? "(no error)"}`);
  } else if (result === "lost") {
    console.warn(`${tag}: lock lost (reclaimed by another runner) after ${ms}ms`);
  } else if (decision.outcome === "retry") {
    console.warn(`${tag}: ${result}, retry at ${decision.runAt?.toISOString()}: ${decision.error}`);
  } else {
    console.info(`${tag}: ${decision.outcome} → ${result} in ${ms}ms`);
  }
  return { decision, result };
}

/**
 * Run one claimed row end to end: handler (via `executeJob`) then `finish_job`. Never throws;
 * failures are logged and the job's lock expiry makes it reclaimable.
 * @param row claimed `jobs` row
 * @param token claim token that owns the row
 * @param deadline epoch ms budget for the handler
 * @param deps optional injected store/registry/clocks (tests, smoke)
 * @returns the `finish_job` result, or null when the finish RPC failed
 */
export async function runClaimed(
  row: JobRow,
  token: string,
  deadline: number,
  deps?: Partial<RunnerDeps>,
): Promise<FinishResult | null> {
  return (await runOne(row, token, deadline, withDeps(deps))).result;
}

function tally(s: RunSummary, decision: FinishOutcome, result: FinishResult | null): void {
  if (result === null) s.errors += 1;
  else if (result === "lost") s.lost += 1;
  else if (result === "superseded") s.superseded += 1;
  else if (result === "dead") s.dead += 1;
  else if (result === "done") s.done += 1;
  else if (decision === "reschedule") s.rescheduled += 1;
  else s.retried += 1;
}

/**
 * Claim and run due jobs with bounded concurrency until claims come back short/empty or less than
 * `CLAIM_RESERVE_MS` (at most half the budget) is left; then wait for in-flight handlers.
 * With `jobId` it makes a single claim for that row (the webhook fast path); with `dedupeKey` it
 * only claims rows with that key (the end-of-run drain).
 * @param opts budget (ms), concurrency (slots), optional single-row filters, optional deps
 * @returns counts of what happened
 */
export async function runDueJobs(
  opts: { budgetMs: number; concurrency: number; jobId?: string; dedupeKey?: string } & {
    deps?: Partial<RunnerDeps>;
  },
): Promise<RunSummary> {
  const d = withDeps(opts.deps);
  const start = d.clock();
  const deadline = start + Math.max(0, opts.budgetMs);
  const stopClaimingAt = deadline - Math.min(CLAIM_RESERVE_MS, opts.budgetMs / 2);
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const kinds = opts.deps?.registry ? Object.keys(d.registry) : [...REGISTERED_KINDS];
  const token = randomUUID();
  const summary: RunSummary = {
    claimed: 0, done: 0, retried: 0, rescheduled: 0, dead: 0, lost: 0, superseded: 0, errors: 0, elapsedMs: 0,
  };
  const active = new Set<Promise<void>>();
  let exhausted = kinds.length === 0;

  while (true) {
    const free = concurrency - active.size;
    if (!exhausted && free > 0 && d.clock() < stopClaimingAt) {
      let rows: JobRow[] = [];
      try {
        rows = await d.store.claim(token, kinds, free, { jobId: opts.jobId, dedupeKey: opts.dedupeKey });
      } catch (e) {
        console.error(`[jobs] claim failed: ${errorText(e)}`);
        summary.errors += 1;
        exhausted = true;
      }
      // A short batch means nothing else is due right now; the next tick picks up later work.
      if (rows.length < free || opts.jobId) exhausted = true;
      for (const row of rows) {
        summary.claimed += 1;
        const p: Promise<void> = (async () => {
          const { decision, result } = await runOne(row, token, deadline, d);
          tally(summary, decision.outcome, result);
        })().finally(() => active.delete(p));
        active.add(p);
      }
      continue;
    }
    if (active.size === 0) break;
    await Promise.race(active);
  }

  summary.elapsedMs = d.clock() - start;
  return summary;
}

/**
 * Dead-letter rows whose kind this deploy doesn't know, once they've been due for `olderThanMs`
 * (V2-03 §2.14) — otherwise `private.jobs_tick()` would keep POSTing for them forever. Covers
 * pending rows due before the cutoff and running rows whose lock expired before it.
 * @param olderThanMs how long a row must have been due / expired (e.g. 1h)
 * @param deps optional registry/clock override
 * @returns number of rows dead-lettered
 */
export async function deadLetterUnknownKinds(
  olderThanMs: number,
  deps?: Partial<Pick<RunnerDeps, "registry" | "clock">>,
): Promise<number> {
  const registry = deps?.registry ?? JOB_KINDS;
  const clock = deps?.clock ?? Date.now;
  const kinds = Object.keys(registry);
  const cutoff = new Date(clock() - olderThanMs).toISOString();
  // Kind names are snake_case identifiers, so they are safe inside a PostgREST in-list.
  const known = `(${kinds.map((k) => `"${k}"`).join(",")})`;
  const { data, error } = await db()
    .from("jobs")
    .update({
      status: "dead",
      finished_at: new Date(clock()).toISOString(),
      locked_by: null,
      locked_until: null,
      last_error: "unknown job kind (not registered in this deploy)",
    })
    .not("kind", "in", known)
    .or(`and(status.eq.pending,run_at.lt.${cutoff}),and(status.eq.running,locked_until.lt.${cutoff})`)
    .select("id, kind");
  if (error) throw new Error(`deadLetterUnknownKinds: ${error.message}`);
  const n = data?.length ?? 0;
  if (n > 0) {
    const names = [...new Set((data ?? []).map((r) => r.kind))].join(", ");
    console.error(`[jobs] dead-lettered ${n} job(s) of unregistered kind(s): ${names}`);
  }
  return n;
}
