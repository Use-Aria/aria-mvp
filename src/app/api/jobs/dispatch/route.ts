import "server-only";
// OWNER: 1.1

/**
 * `/api/jobs/dispatch` (V2-03 §2.11 "Dispatch", §7 Routes).
 *
 * - `POST` from pg_cron's 15s tick (`private.jobs_tick()` via pg_net), HMAC-signed timestamp.
 * - `GET` from the daily Vercel Cron backstop, `Authorization: Bearer $CRON_SECRET`.
 *
 * Answers 202 at once (pg_net's timeout is 5s) and runs the claim loop in `after()`, bounded
 * by `maxDuration` (Hobby cap 300s): 270s of budget, 4 concurrent jobs. The body is ignored.
 */
import { after } from "next/server";
import { optionalEnv } from "@/server/env";
import { authorizeDispatchRequest } from "@/server/jobs/auth";
import { deadLetterUnknownKinds, errorText, runDueJobs } from "@/server/jobs/runner";

export const maxDuration = 300;

/** Runner budget inside one invocation (leaves headroom under the 300s cap). */
const BUDGET_MS = 270_000;
const CONCURRENCY = 4;
/** Unknown-kind rows are dead-lettered once due for this long (V2-03 §2.14). */
const UNKNOWN_KIND_AGE_MS = 60 * 60_000;
/** Run the unknown-kind sweep at most this often per warm instance. */
const UNKNOWN_KIND_SWEEP_EVERY_MS = 10 * 60_000;
let lastUnknownSweep = 0;

function respond(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function dispatch(source: string): Promise<void> {
  try {
    if (Date.now() - lastUnknownSweep >= UNKNOWN_KIND_SWEEP_EVERY_MS) {
      lastUnknownSweep = Date.now();
      await deadLetterUnknownKinds(UNKNOWN_KIND_AGE_MS);
    }
  } catch (e) {
    console.error(`[jobs] dispatch(${source}) unknown-kind sweep failed: ${errorText(e)}`);
  }
  try {
    const s = await runDueJobs({ budgetMs: BUDGET_MS, concurrency: CONCURRENCY });
    if (s.claimed > 0 || s.errors > 0) {
      console.info(`[jobs] dispatch(${source}) ${JSON.stringify(s)}`);
    }
  } catch (e) {
    console.error(`[jobs] dispatch(${source}) failed: ${errorText(e)}`);
  }
}

function handle(req: Request, source: string): Response {
  const ok = authorizeDispatchRequest(
    req.method,
    req.headers,
    { dispatchSecret: optionalEnv("JOBS_DISPATCH_SECRET"), cronSecret: optionalEnv("CRON_SECRET") },
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return respond(401, { error: "unauthorized" });
  after(() => dispatch(source));
  return respond(202, { accepted: true });
}

/** pg_cron tick (HMAC). */
export async function POST(req: Request): Promise<Response> {
  return handle(req, "tick");
}

/** Vercel Cron daily backstop (bearer). */
export async function GET(req: Request): Promise<Response> {
  return handle(req, "cron");
}
