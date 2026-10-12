import "server-only";
// OWNER: 1.1

/**
 * Job kind `retention_purge` (master plan §1.3; V2-03 §2.11 "Retention", Q9; V2-06 Q11).
 *
 * Enqueued daily by pg_cron `aria-retention-enqueue` (dedupe `retention_purge`, keep). Deletes:
 * - `messages` older than 180 days, in batches (reactions cascade), **except** the first-contact
 *   welcome rows (`direction='out'`, `trigger='welcome'`, at most two per channel): the pipeline
 *   decides first contact by their presence (`pipeline/turn.ts#welcomeSent`), so purging them
 *   would re-welcome a returning user. Their bodies (Aria's template plus the student's first
 *   name) are nulled past the same window, so the kept rows carry no content.
 * - `done` / `dead` jobs finished more than 30 days ago
 * - `agent_runs` older than 180 days
 * - `magic_links` and `web_sessions` expired (or revoked) more than 7 days ago
 * - `signups` expired more than 7 days ago, matched or not (phone + IP are PII)
 * - `proactive_dedupe` rows older than 30 days
 * and nulls `briefings.plan` (rendered bubbles) older than 180 days.
 * `purge_messages_before` (003) is no longer called: it can't spare the welcome rows, and a new
 * migration was ruled out (Daniel, 2026-10-11).
 * Stops at 240s and re-enqueues itself when messages are left. `llm_calls` are kept (no PII).
 */
import { z } from "zod";
import { db } from "@/server/db";
import { enqueueJob } from "@/server/jobs/enqueue";
import { defineJobKind } from "@/server/jobs/types";

/** Payload of `retention_purge`. Dedupe key: `retention_purge` (keep). */
export const retentionPurgePayload = z.object({});

const DAY_MS = 24 * 60 * 60_000;

/** Retention windows in days. */
export const RETENTION_DAYS = {
  messages: 180,
  jobs: 30,
  agentRuns: 180,
  magicLinks: 7,
  webSessions: 7,
  signups: 7,
  proactiveDedupe: 30,
  briefingPlans: 180,
  welcomeBodies: 180,
} as const;

/** Self-imposed budget per run (V2-03 §2.11: "stops at 240s"). */
export const RETENTION_BUDGET_MS = 240_000;
/** Message ids selected per purge batch (≤ PostgREST `max_rows`, 1000 on Supabase). */
export const MESSAGE_BATCH = 1000;
/** Ids per DELETE request (keeps the `id=in.(…)` URL short, ~7.5 KB). */
export const MESSAGE_DELETE_CHUNK = 200;
/**
 * PostgREST `or` filter for messages the purge may delete: everything but the first-contact
 * welcome rows (`direction='out' and trigger='welcome'`). A null trigger is purgeable.
 */
export const PURGEABLE_MESSAGE_FILTER = "direction.eq.in,trigger.is.null,trigger.neq.welcome";
/** Dedupe key shared with the pg_cron enqueue. */
export const RETENTION_DEDUPE_KEY = "retention_purge";

export type RetentionTarget = keyof typeof RETENTION_DAYS;

/** Rows affected per target, plus whether every target finished within budget. */
export type RetentionReport = Record<RetentionTarget, number> & { complete: boolean };

/**
 * ISO cutoffs for every retention target. Pure.
 * @param now logical "now"
 * @returns target → ISO timestamp; rows older than it are purged
 */
export function retentionCutoffs(now: Date): Record<RetentionTarget, string> {
  const out = {} as Record<RetentionTarget, string>;
  for (const k of Object.keys(RETENTION_DAYS) as RetentionTarget[]) {
    out[k] = new Date(now.getTime() - RETENTION_DAYS[k] * DAY_MS).toISOString();
  }
  return out;
}

function fail(step: string, message: string): never {
  throw new Error(`retention ${step}: ${message}`);
}

/**
 * Purge everything past retention.
 * @param now logical "now" for cutoffs (`ctx.now`)
 * @param stopAt epoch ms after which no new message batch starts
 * @param clock wall clock (epoch ms)
 * @returns per-target counts; `complete` is false when messages were left for a follow-up run
 * @throws after running every step if any step failed (so the job retries)
 */
export async function purgeExpired(
  now: Date,
  stopAt: number,
  clock: () => number = Date.now,
): Promise<RetentionReport> {
  const c = retentionCutoffs(now);
  const report: RetentionReport = {
    messages: 0, jobs: 0, agentRuns: 0, magicLinks: 0, webSessions: 0, signups: 0,
    proactiveDedupe: 0, briefingPlans: 0, welcomeBodies: 0, complete: true,
  };
  const failures: string[] = [];
  const step = async (name: RetentionTarget, fn: () => Promise<number>): Promise<void> => {
    try {
      report[name] = await fn();
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  };
  const sb = db();

  await step("jobs", async () => {
    const { count, error } = await sb
      .from("jobs")
      .delete({ count: "exact" })
      .in("status", ["done", "dead"])
      .or(`finished_at.lt.${c.jobs},and(finished_at.is.null,created_at.lt.${c.jobs})`);
    return error ? fail("jobs", error.message) : (count ?? 0);
  });
  await step("agentRuns", async () => {
    const { count, error } = await sb.from("agent_runs").delete({ count: "exact" }).lt("started_at", c.agentRuns);
    return error ? fail("agent_runs", error.message) : (count ?? 0);
  });
  await step("magicLinks", async () => {
    const { count, error } = await sb.from("magic_links").delete({ count: "exact" }).lt("expires_at", c.magicLinks);
    return error ? fail("magic_links", error.message) : (count ?? 0);
  });
  await step("webSessions", async () => {
    const { count, error } = await sb
      .from("web_sessions")
      .delete({ count: "exact" })
      .or(`expires_at.lt.${c.webSessions},revoked_at.lt.${c.webSessions}`);
    return error ? fail("web_sessions", error.message) : (count ?? 0);
  });
  await step("signups", async () => {
    const { count, error } = await sb.from("signups").delete({ count: "exact" }).lt("expires_at", c.signups);
    return error ? fail("signups", error.message) : (count ?? 0);
  });
  await step("proactiveDedupe", async () => {
    const { count, error } = await sb
      .from("proactive_dedupe")
      .delete({ count: "exact" })
      .lt("delivered_at", c.proactiveDedupe);
    return error ? fail("proactive_dedupe", error.message) : (count ?? 0);
  });
  await step("briefingPlans", async () => {
    const { count, error } = await sb
      .from("briefings")
      .update({ plan: null }, { count: "exact" })
      .not("plan", "is", null)
      .lt("created_at", c.briefingPlans);
    return error ? fail("briefings.plan", error.message) : (count ?? 0);
  });
  await step("welcomeBodies", async () => {
    const { count, error } = await sb
      .from("messages")
      .update({ body: null }, { count: "exact" })
      .eq("direction", "out")
      .eq("trigger", "welcome")
      .not("body", "is", null)
      .lt("created_at", c.welcomeBodies);
    return error ? fail("welcome bodies", error.message) : (count ?? 0);
  });
  // Messages last: the only step that can be large enough to need several runs.
  await step("messages", async () => {
    let total = 0;
    while (true) {
      if (clock() >= stopAt) {
        report.complete = false;
        return total;
      }
      const { data, error } = await sb
        .from("messages")
        .select("id")
        .lt("created_at", c.messages)
        .or(PURGEABLE_MESSAGE_FILTER)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(MESSAGE_BATCH);
      if (error) fail("messages", error.message);
      const ids = (data ?? []).map((r) => r.id);
      if (ids.length === 0) return total;
      let deleted = 0;
      for (let i = 0; i < ids.length; i += MESSAGE_DELETE_CHUNK) {
        // The same filters again: a row that changed since the select is never deleted by mistake.
        const del = await sb
          .from("messages")
          .delete({ count: "exact" })
          .in("id", ids.slice(i, i + MESSAGE_DELETE_CHUNK))
          .lt("created_at", c.messages)
          .or(PURGEABLE_MESSAGE_FILTER);
        if (del.error) fail("messages", del.error.message);
        deleted += del.count ?? 0;
      }
      total += deleted;
      // Loop until a select comes back empty (a lower `max_rows` only shortens the pages). A page
      // that deleted nothing would only repeat itself: stop.
      if (deleted === 0) return total;
    }
  });

  if (failures.length > 0) throw new Error(failures.join("; "));
  return report;
}

/** `retention_purge` handler (maxAttempts 3). */
export const retentionPurge = defineJobKind({
  payload: retentionPurgePayload,
  maxAttempts: 3,
  run: async (ctx) => {
    const stopAt = Math.min(ctx.deadline, Date.now() + RETENTION_BUDGET_MS);
    const report = await purgeExpired(ctx.now, stopAt);
    const { complete, ...counts } = report;
    console.info(`[jobs] retention_purge ${JSON.stringify(counts)}${complete ? "" : " (more left)"}`);
    if (!complete) {
      // This row is `running`, so the partial unique index (pending only) admits the follow-up.
      await enqueueJob({
        kind: "retention_purge",
        payload: {},
        dedupeKey: RETENTION_DEDUPE_KEY,
        mode: "keep",
        runAt: new Date(Date.now() + 60_000),
      });
    }
    return { type: "done" };
  },
});
