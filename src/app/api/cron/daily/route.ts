import "server-only";
// OWNER: 4.1

/**
 * `GET /api/cron/daily` (V2-06 §2.7, §7 Routes; master plan §1.18, C39). Vercel Cron, once a day
 * (`0 10 * * *` in vercel.json), `Authorization: Bearer $CRON_SECRET`; `?source=gh` marks a
 * GitHub Actions call. Writes the keepalive heartbeat through PostgREST (Supabase Free pause rule),
 * then runs the self-healing reconcile for every active user (bounded to 250s). Answers JSON
 * counts; 500 when the heartbeat write fails (surfaces a paused/unreachable project in logs).
 * Idempotent: Vercel cron delivery is best-effort and may duplicate.
 * Local dev without `CRON_SECRET`: only loopback hosts are accepted (`curl localhost:3000/api/cron/daily`).
 */
import { isProduction, optionalEnv } from "@/server/env";
import { isCronAuthorized, reconcileAll, writeHeartbeat, type HeartbeatSource } from "@/server/proactive/reconcile";

export const maxDuration = 300;

function respond(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

/** Daily cron: heartbeat + reconcile. */
export async function GET(req: Request): Promise<Response> {
  const ok = isCronAuthorized({
    authorization: req.headers.get("authorization"),
    secret: optionalEnv("CRON_SECRET"),
    production: isProduction,
    host: req.headers.get("host"),
  });
  if (!ok) return respond(401, { error: "unauthorized" });

  const source: HeartbeatSource = new URL(req.url).searchParams.get("source") === "gh" ? "gh-actions" : "daily-cron";
  const started = Date.now();
  try {
    await writeHeartbeat(source, { phase: "start" });
  } catch (e) {
    console.error(`[cron] heartbeat failed: ${errName(e)}`);
    return respond(500, { error: "heartbeat_failed" });
  }

  try {
    const reports = await reconcileAll(new Date());
    const summary = {
      users: reports.length,
      briefingsFixed: reports.filter((r) => r.briefing === "fixed").length,
      reminderJobsFixed: reports.reduce((n, r) => n + r.reminderJobsFixed, 0),
      nudgesPlaced: reports.reduce((n, r) => n + r.nudgesPlaced, 0),
      stuckActionsResolved: reports.reduce((n, r) => n + r.stuckActions.done + r.stuckActions.failed, 0),
      usersWithErrors: reports.filter((r) => r.errors.length > 0).length,
      ms: Date.now() - started,
    };
    if (summary.usersWithErrors > 0) console.warn(`[cron] reconcile: ${summary.usersWithErrors} user(s) had step errors`);
    try {
      await writeHeartbeat(source, { phase: "done", ...summary });
    } catch (e) {
      console.warn(`[cron] final heartbeat failed: ${errName(e)}`);
    }
    return respond(200, { ok: true, source, ...summary });
  } catch (e) {
    console.error(`[cron] reconcile failed: ${errName(e)}`);
    return respond(500, { error: "reconcile_failed" });
  }
}
