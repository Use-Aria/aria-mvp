import "server-only";
// OWNER: 1.1

/**
 * Enqueue / cancel jobs (master plan §1.3 = V2-03 §7 `enqueue.ts` + `cancelJobs` filters).
 *
 * `enqueueJob` validates the payload against the kind's zod schema (fail fast, before any DB
 * write), then calls the `enqueue_job` RPC, which upserts on the partial unique index
 * `jobs(dedupe_key) where status = 'pending'` (supabase-js can't target a partial index):
 * - `replace` (default with a dedupe key): latest payload and run_at win (run_at may move earlier)
 * - `keep`: an existing pending row is left untouched (idempotent)
 * - `debounce`: run_at = least(greatest(old, new), created_at + maxDelayMs)
 * - `append`: `payload.items` concatenated, run_at = least(old, new)
 */
import { z } from "zod";
import { db } from "@/server/db";
import type { Database, Json } from "@/server/db/types";
import { JOB_KINDS, type JobKind, type JobPayload } from "@/server/jobs/kinds";

export type EnqueueMode = "keep" | "replace" | "debounce" | "append";
export interface EnqueueInput<K extends JobKind> {
  kind: K;
  userId?: string | null;
  runAt?: Date;
  payload?: JobPayload<K>;
  dedupeKey?: string;
  /** default "replace" when dedupeKey */
  mode?: EnqueueMode;
  /** debounce cap */
  maxDelayMs?: number;
}
export interface EnqueueResult {
  id: string;
  runAt: Date;
  dbNow: Date;
  created: boolean;
}

type EnqueueArgs = Database["public"]["Functions"]["enqueue_job"]["Args"];

/** Attempts used when a kind doesn't set `maxAttempts` (matches the `enqueue_job` default). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Validate a payload for a kind and return the JSON that will be stored (zod output: defaults
 * applied, unknown keys stripped). Pure; exported for tests.
 * @param kind registered job kind
 * @param payload candidate payload (`undefined` means `{}`)
 * @returns the parsed payload as JSON
 * @throws Error naming the kind and the zod issues when the payload is invalid
 */
export function parseJobPayload(kind: JobKind, payload: unknown): Json {
  const schema: z.ZodType = JOB_KINDS[kind].payload;
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw new Error(`enqueueJob(${kind}): invalid payload: ${z.prettifyError(parsed.error)}`);
  }
  // Payload schemas have no transforms, so the output is plain JSON (and re-parses at run time).
  return JSON.parse(JSON.stringify(parsed.data ?? {})) as Json;
}

/**
 * Insert (or upsert on a pending `dedupeKey` per `mode`) one job via the `enqueue_job` RPC.
 * @param input kind, payload, timing, dedupe
 * @returns the job id, effective run time, DB clock, and whether a new row was created
 * @throws on an invalid payload (before touching the DB) or an RPC error
 */
export async function enqueueJob<K extends JobKind>(input: EnqueueInput<K>): Promise<EnqueueResult> {
  const payload = parseJobPayload(input.kind, input.payload);
  if (input.runAt && Number.isNaN(input.runAt.getTime())) {
    throw new Error(`enqueueJob(${input.kind}): invalid runAt`);
  }
  if (input.maxDelayMs !== undefined && !(input.maxDelayMs >= 0)) {
    throw new Error(`enqueueJob(${input.kind}): invalid maxDelayMs`);
  }
  const args: EnqueueArgs = {
    p_kind: input.kind,
    p_user_id: input.userId ?? undefined,
    p_run_at: input.runAt?.toISOString(),
    p_payload: payload,
    p_dedupe_key: input.dedupeKey,
    p_mode: input.mode ?? "replace",
    p_max_delay_ms: input.maxDelayMs === undefined ? undefined : Math.round(input.maxDelayMs),
    p_max_attempts: JOB_KINDS[input.kind].maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };
  const { data, error } = await db().rpc("enqueue_job", args);
  if (error) throw new Error(`enqueueJob(${input.kind}): ${error.message}`);
  const row = data?.[0];
  if (!row) throw new Error(`enqueueJob(${input.kind}): enqueue_job returned no row`);
  return {
    id: row.job_id,
    runAt: new Date(row.job_run_at),
    dbNow: new Date(row.db_now),
    created: row.created,
  };
}

/** Escape `%`, `_` and `\` so a dedupe-key prefix matches literally in LIKE. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * pending → done (last_error='cancelled'). Any combination of filters (ANDed). Returns rows cancelled.
 * Running jobs are never touched (their handler owns them).
 * @param f filters: ids, exact dedupe key, dedupe-key prefix, user, kinds
 * @returns number of rows cancelled
 * @throws when no filter is given (refuses to cancel every pending job) or on a DB error
 */
export async function cancelJobs(f: {
  ids?: string[];
  dedupeKey?: string;
  dedupeKeyPrefix?: string;
  userId?: string;
  kinds?: JobKind[];
}): Promise<number> {
  const hasFilter =
    f.ids !== undefined ||
    f.dedupeKey !== undefined ||
    f.dedupeKeyPrefix !== undefined ||
    f.userId !== undefined ||
    f.kinds !== undefined;
  if (!hasFilter) throw new Error("cancelJobs: at least one filter is required");
  if (f.ids?.length === 0 || f.kinds?.length === 0 || f.dedupeKeyPrefix === "") return 0;

  let q = db()
    .from("jobs")
    .update({ status: "done", finished_at: new Date().toISOString(), last_error: "cancelled" })
    .eq("status", "pending");
  if (f.ids) q = q.in("id", f.ids);
  if (f.dedupeKey !== undefined) q = q.eq("dedupe_key", f.dedupeKey);
  if (f.dedupeKeyPrefix !== undefined) q = q.like("dedupe_key", likePrefix(f.dedupeKeyPrefix));
  if (f.userId !== undefined) q = q.eq("user_id", f.userId);
  if (f.kinds) q = q.in("kind", f.kinds);

  const { data, error } = await q.select("id");
  if (error) throw new Error(`cancelJobs: ${error.message}`);
  return data?.length ?? 0;
}
