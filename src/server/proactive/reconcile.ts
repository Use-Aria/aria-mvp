import "server-only";
// OWNER: 4.1

/**
 * Daily self-healing sweep + keepalive heartbeat (V2-06 §2.7, §7 `proactive/reconcile.ts`; T8).
 * Run by `GET /api/cron/daily` (Vercel Cron, once a day). Per active user:
 * 1. briefing chain: `users.next_briefing_at` must be in the future and match the pending
 *    `briefing_prepare` job (`briefing_prep:<userId>`); otherwise `scheduleNextBriefing`.
 * 2. `reconcileReminderJobs`: every scheduled reminder has a matching `reminder_fire` job
 *    (overdue ones are re-armed now; the fire handler's late policy expires them).
 * 3. `ensureAutoNudges` for deadlines due ≤36h.
 * 4. `recoverStuckActions` (3.3): pending actions stuck in `executing` (nothing else runs it).
 * Every step is independent (one failure doesn't stop the others) and the whole sweep is time-boxed.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import { recoverStuckActions } from "@/server/agent/pending/actions";
import { briefingPrepKey, scheduleNextBriefing } from "@/server/briefing/scheduler";
import { db } from "@/server/db";
import type { Json } from "@/server/db/types";
import { loadUserSchedule } from "@/server/proactive/settings";
import { ensureAutoNudges, reconcileReminderJobs } from "@/server/reminders/service";

/** What reconciling one user did. */
export interface ReconcileReport {
  userId: string;
  briefing: "ok" | "fixed" | "disabled" | "error";
  reminderJobsFixed: number;
  nudgesPlaced: number;
  stuckActions: { done: number; failed: number };
  /** failed step names (no messages: they may carry third-party text) */
  errors: string[];
}

/** Heartbeat row ids (`system_heartbeat.id`). */
export type HeartbeatSource = "daily-cron" | "gh-actions";

/** Total time budget of `reconcileAll` (Vercel Hobby cap 300s). */
export const RECONCILE_BUDGET_MS = 250_000;
const PAGE = 200;
/** A prepare job that is running counts as healthy. */
const RUNNING = "running";

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

/**
 * Pure health check of a user's briefing chain.
 * @param a next_briefing_at, the pending/running prepare job (if any), clock
 * @returns true when nothing needs fixing
 */
export function briefingChainHealthy(a: {
  nextBriefingAt: Date | null;
  job: { status: string; payload: unknown } | null;
  now: Date;
}): boolean {
  if (!a.nextBriefingAt || a.nextBriefingAt.getTime() <= a.now.getTime()) return false;
  if (!a.job) return false;
  if (a.job.status === RUNNING) return true;
  const target = (a.job.payload as { targetAt?: unknown } | null)?.targetAt;
  return typeof target === "string" && new Date(target).getTime() === a.nextBriefingAt.getTime();
}

async function checkBriefing(userId: string, now: Date): Promise<ReconcileReport["briefing"]> {
  const s = await loadUserSchedule(userId);
  if (!s || s.deleted || !s.settings.briefingEnabled) {
    // Keep disabled users clean (no pending prepare job, next_briefing_at null).
    if (s && !s.deleted && s.nextBriefingAt) await scheduleNextBriefing(userId, now);
    return "disabled";
  }
  const { data, error } = await db()
    .from("jobs")
    .select("status, payload")
    .eq("user_id", userId)
    .eq("kind", "briefing_prepare")
    .eq("dedupe_key", briefingPrepKey(userId))
    .in("status", ["pending", "running"])
    .order("run_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`reconcile(briefing job): ${error.message}`);
  const job = data?.[0] ?? null;
  if (briefingChainHealthy({ nextBriefingAt: s.nextBriefingAt, job, now })) return "ok";
  await scheduleNextBriefing(userId, now);
  return "fixed";
}

/**
 * Reconcile one user (each step independent; failures are reported, not thrown).
 * @param userId owner
 * @param now clock
 * @returns what was fixed
 */
export async function reconcileUser(userId: string, now: Date): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    userId,
    briefing: "ok",
    reminderJobsFixed: 0,
    nudgesPlaced: 0,
    stuckActions: { done: 0, failed: 0 },
    errors: [],
  };
  try {
    report.briefing = await checkBriefing(userId, now);
  } catch (e) {
    report.briefing = "error";
    report.errors.push(`briefing:${errName(e)}`);
  }
  try {
    report.reminderJobsFixed = (await reconcileReminderJobs(userId, now)).fixed;
  } catch (e) {
    report.errors.push(`reminders:${errName(e)}`);
  }
  try {
    report.nudgesPlaced = await ensureAutoNudges(userId, now);
  } catch (e) {
    report.errors.push(`nudges:${errName(e)}`);
  }
  try {
    report.stuckActions = await recoverStuckActions(userId, now);
  } catch (e) {
    report.errors.push(`actions:${errName(e)}`);
  }
  return report;
}

/**
 * Reconcile every non-deleted user, oldest first, within `budgetMs`.
 * @param now clock
 * @param o time budget (default 250s) and an injectable monotonic clock
 * @returns one report per user reached (users past the budget are picked up tomorrow)
 * @throws on a DB error listing users
 */
export async function reconcileAll(now: Date, o: { budgetMs?: number; clock?: () => number } = {}): Promise<ReconcileReport[]> {
  const clock = o.clock ?? Date.now;
  const deadline = clock() + (o.budgetMs ?? RECONCILE_BUDGET_MS);
  const reports: ReconcileReport[] = [];
  for (let offset = 0; clock() < deadline; offset += PAGE) {
    const { data, error } = await db()
      .from("users")
      .select("id")
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`reconcileAll(users): ${error.message}`);
    const ids = (data ?? []).map((r) => r.id);
    for (const id of ids) {
      if (clock() >= deadline) break;
      reports.push(await reconcileUser(id, now));
    }
    if (ids.length < PAGE) break;
  }
  return reports;
}

/**
 * Upsert the keepalive heartbeat row through PostgREST (counts as database activity for the
 * Supabase Free pause rule).
 * @param source which pinger
 * @param detail small JSON summary (counts only)
 * @throws on a DB error (the cron route answers 500, which surfaces a paused project)
 */
export async function writeHeartbeat(source: HeartbeatSource, detail: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from("system_heartbeat")
    .upsert({ id: source, beat_at: new Date().toISOString(), detail: detail as Json }, { onConflict: "id" });
  if (error) throw new Error(`writeHeartbeat: ${error.message}`);
}

/**
 * Authorize a `/api/cron/daily` request: `Authorization: Bearer $CRON_SECRET` (constant-time).
 * Without a secret, only non-production requests to a loopback host are accepted (local dev).
 * @param a raw Authorization header, configured secret, production flag, request host
 * @returns true when the request may run the sweep
 */
export function isCronAuthorized(a: { authorization: string | null; secret: string | undefined; production: boolean; host: string | null }): boolean {
  if (a.secret) {
    const m = a.authorization ? /^Bearer (.+)$/.exec(a.authorization) : null;
    if (!m) return false;
    const x = createHash("sha256").update(m[1]).digest();
    const y = createHash("sha256").update(a.secret).digest();
    return timingSafeEqual(x, y);
  }
  if (a.production) return false;
  const host = (a.host ?? "").toLowerCase().replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
