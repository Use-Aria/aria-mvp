/**
 * Jobs smoke (V2-03 §10.2 items 3–5, 8, 9 + task 1.1 runner/retention checks).
 *
 * Targets the LOCAL Supabase stack by default (keys from `supabase status -o json`). Set
 * `SMOKE_TARGET=env` to use NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
 * NEXT_PUBLIC_SUPABASE_ANON_KEY from the environment instead (and SMOKE_DB_URL for the psql
 * tick check). Rows use kind `smoke_test` (unregistered, so no dispatcher claims them), dedupe
 * keys under a per-run prefix, or hang off a throwaway user; all are deleted in afterAll.
 *
 * Note: `deadLetterUnknownKinds` and the retention purge act on the whole target database by
 * design (that's what production runs daily).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/server/db/types";

// ── Target selection (before any server module calls db()) ─────────────────
interface Target {
  url: string;
  serviceKey: string;
  anonKey: string;
  dbUrl: string | null;
}

function localTarget(): Target {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // `supabase status` exits 1 when optional services are stopped but still prints the JSON.
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set SMOKE_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY, anonKey: s.ANON_KEY, dbUrl: s.DB_URL ?? null };
}

function envTarget(): Target {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`SMOKE_TARGET=env needs ${k}`);
    return v;
  };
  return {
    url: need("NEXT_PUBLIC_SUPABASE_URL"),
    serviceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
    anonKey: need("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    dbUrl: process.env.SMOKE_DB_URL ?? null,
  };
}

const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;

// Server modules read env lazily (db() on first call), so importing after the assignment is safe.
import { cancelJobs, enqueueJob } from "@/server/jobs/enqueue";
import { purgeExpired } from "@/server/jobs/kinds/retention-purge";
import { deadLetterUnknownKinds, runDueJobs, type JobRegistry } from "@/server/jobs/runner";
import { defineJobKind } from "@/server/jobs/types";
import { z } from "zod";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon: Sb = createClient<Database>(target.url, target.anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const RUN = randomUUID().slice(0, 8);
const P = `smoke:jobs:${RUN}:`;
const SMOKE = "smoke_test";
const DAY = 24 * 60 * 60_000;
const jobIds = new Set<string>();
const signupIds: string[] = [];
let userId: string | null = null;

const iso = (ms: number) => new Date(ms).toISOString();

async function rpcEnqueue(o: {
  key?: string;
  runAt?: number;
  mode?: "keep" | "replace" | "debounce" | "append";
  maxDelayMs?: number;
  maxAttempts?: number;
  payload?: Json;
}) {
  const { data, error } = await sb.rpc("enqueue_job", {
    p_kind: SMOKE,
    p_run_at: o.runAt === undefined ? undefined : iso(o.runAt),
    p_payload: o.payload ?? {},
    p_dedupe_key: o.key,
    p_mode: o.mode ?? "replace",
    p_max_delay_ms: o.maxDelayMs,
    p_max_attempts: o.maxAttempts ?? 5,
  });
  if (error) throw new Error(error.message);
  const r = data[0];
  jobIds.add(r.job_id);
  return r;
}

async function claim(token: string, filter: { key?: string; id?: string }, limit = 1) {
  const { data, error } = await sb.rpc("claim_jobs", {
    p_token: token,
    p_kinds: [SMOKE],
    p_limit: limit,
    p_lock_seconds: 330,
    p_job_id: filter.id,
    p_dedupe_key: filter.key,
  });
  if (error) throw new Error(error.message);
  return data;
}

async function finish(id: string, token: string, outcome: string, runAt?: number, err?: string) {
  const { data, error } = await sb.rpc("finish_job", {
    p_id: id,
    p_token: token,
    p_outcome: outcome,
    p_run_at: runAt === undefined ? undefined : iso(runAt),
    p_error: err,
  });
  if (error) throw new Error(error.message);
  return data;
}

async function job(id: string) {
  const { data, error } = await sb.from("jobs").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data;
}

type DbResult = { error: { message: string } | null };

function must(res: DbResult, label: string): void {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
}

function idsOf(res: DbResult & { data: { id: string }[] | null }, label: string): string[] {
  must(res, label);
  return (res.data ?? []).map((r) => r.id);
}

async function expireLock(id: string) {
  const { error } = await sb.from("jobs").update({ locked_until: iso(Date.now() - 5000) }).eq("id", id);
  if (error) throw new Error(error.message);
}

beforeAll(() => {
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  jest.restoreAllMocks();
  const errors: string[] = [];
  const ids = [...jobIds];
  if (ids.length) {
    const { error } = await sb.from("jobs").delete().in("id", ids);
    if (error) errors.push(error.message);
  }
  const { error: e2 } = await sb.from("jobs").delete().like("dedupe_key", `${P}%`);
  if (e2) errors.push(e2.message);
  if (signupIds.length) {
    const { error } = await sb.from("signups").delete().in("id", signupIds);
    if (error) errors.push(error.message);
  }
  if (userId) {
    const { error } = await sb.from("users").delete().eq("id", userId);
    if (error) errors.push(error.message);
  }
  // Leak check: nothing from this run survives.
  const { count } = await sb.from("jobs").select("id", { count: "exact", head: true }).like("dedupe_key", `${P}%`);
  expect(errors).toEqual([]);
  expect(count ?? 0).toBe(0);
});

// ── §10.2 item 3: enqueue_job modes ─────────────────────────────────────────
describe("enqueue_job", () => {
  it("debounce pushes run_at on the same row, capped at created_at + max_delay", async () => {
    const now = Date.now();
    const a = await rpcEnqueue({ key: `${P}deb`, runAt: now + 30_000, mode: "debounce", maxDelayMs: 60_000 });
    const b = await rpcEnqueue({ key: `${P}deb`, runAt: now + 31_000, mode: "debounce", maxDelayMs: 60_000 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job_id).toBe(a.job_id);
    expect(Date.parse(b.job_run_at)).toBe(now + 31_000);

    const c = await rpcEnqueue({ key: `${P}cap`, runAt: now + 60_000, mode: "debounce", maxDelayMs: 2000 });
    const d = await rpcEnqueue({ key: `${P}cap`, runAt: now + 90_000, mode: "debounce", maxDelayMs: 2000 });
    const row = await job(c.job_id);
    expect(d.job_id).toBe(c.job_id);
    expect(Date.parse(d.job_run_at)).toBe(Date.parse(row.created_at) + 2000);
  });

  it("append concatenates payload.items and keeps the earlier run_at", async () => {
    const now = Date.now();
    const a = await rpcEnqueue({ key: `${P}app`, runAt: now + 60_000, mode: "append", payload: { items: [1] } });
    const b = await rpcEnqueue({ key: `${P}app`, runAt: now + 30_000, mode: "append", payload: { items: [2, 3] } });
    expect(b.job_id).toBe(a.job_id);
    const row = await job(a.job_id);
    expect(row.payload).toEqual({ items: [1, 2, 3] });
    expect(Date.parse(row.run_at)).toBe(now + 30_000);
  });

  it("keep leaves the pending row unchanged; replace overwrites and may move earlier", async () => {
    const now = Date.now();
    const k1 = await rpcEnqueue({ key: `${P}keep`, runAt: now + 60_000, mode: "keep", payload: { v: 1 } });
    const k2 = await rpcEnqueue({ key: `${P}keep`, runAt: now + 10_000, mode: "keep", payload: { v: 2 } });
    expect(k2).toMatchObject({ job_id: k1.job_id, created: false });
    expect(await job(k1.job_id)).toMatchObject({ payload: { v: 1 }, run_at: expect.any(String) });
    expect(Date.parse((await job(k1.job_id)).run_at)).toBe(now + 60_000);

    const r1 = await rpcEnqueue({ key: `${P}rep`, runAt: now + 60_000, payload: { v: 1 } });
    const r2 = await rpcEnqueue({ key: `${P}rep`, runAt: now + 10_000, payload: { v: 2 } });
    expect(r2.job_id).toBe(r1.job_id);
    const row = await job(r1.job_id);
    expect(row.payload).toEqual({ v: 2 });
    expect(Date.parse(row.run_at)).toBe(now + 10_000);
  });

  it("enqueueJob validates, stores the kind's maxAttempts, upserts by dedupe key; cancelJobs filters", async () => {
    const runAt = new Date(Date.now() + 3_600_000);
    const a = await enqueueJob({ kind: "noop", payload: { note: "a" }, dedupeKey: `${P}n_1`, runAt });
    const b = await enqueueJob({ kind: "noop", payload: { note: "b" }, dedupeKey: `${P}n_1`, runAt });
    const c = await enqueueJob({ kind: "noop", payload: {}, dedupeKey: `${P}nX1`, runAt });
    [a, b, c].forEach((r) => jobIds.add(r.id));
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ id: a.id, created: false });
    expect(Math.abs(a.dbNow.getTime() - Date.now())).toBeLessThan(30_000);
    expect(await job(a.id)).toMatchObject({ kind: "noop", payload: { note: "b" }, max_attempts: 1, status: "pending" });

    // `_` in the prefix is literal, so `nX1` must not match `n_`.
    expect(await cancelJobs({ dedupeKeyPrefix: `${P}n_` })).toBe(1);
    expect(await job(a.id)).toMatchObject({ status: "done", last_error: "cancelled" });
    expect((await job(c.id)).status).toBe("pending");
    expect(await cancelJobs({ ids: [c.id], kinds: ["reminder_fire"] })).toBe(0);
    expect(await cancelJobs({ ids: [c.id], kinds: ["noop"] })).toBe(1);
    expect(await cancelJobs({ ids: [c.id] })).toBe(0); // already done
  });
});

// ── §10.2 item 4: claim_jobs ────────────────────────────────────────────────
describe("claim_jobs", () => {
  it("two parallel claims on one due row: exactly one wins (SKIP LOCKED)", async () => {
    await rpcEnqueue({ key: `${P}race`, runAt: Date.now() - 1000 });
    const [x, y] = await Promise.all([claim(randomUUID(), { key: `${P}race` }), claim(randomUUID(), { key: `${P}race` })]);
    expect(x.length + y.length).toBe(1);
    expect([...x, ...y][0]).toMatchObject({ status: "running", attempts: 1 });
  });

  it("does not claim a row that is not yet due", async () => {
    await rpcEnqueue({ key: `${P}future`, runAt: Date.now() + 3_600_000 });
    expect(await claim(randomUUID(), { key: `${P}future` })).toEqual([]);
  });

  it("reclaims an expired running row with attempts incremented; the old token is lost", async () => {
    const t1 = randomUUID();
    const t2 = randomUUID();
    const { job_id } = await rpcEnqueue({ key: `${P}expired`, runAt: Date.now() - 1000 });
    expect(await claim(t1, { id: job_id })).toHaveLength(1);
    expect(await claim(t2, { id: job_id })).toEqual([]); // lock still held
    await expireLock(job_id);
    const again = await claim(t2, { id: job_id });
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ attempts: 2, locked_by: t2 });
    expect(await finish(job_id, t1, "done")).toBe("lost");
    expect(await finish(job_id, t2, "done")).toBe("done");
  });

  it("dead-letters an expired row that has used up its attempts", async () => {
    const { job_id } = await rpcEnqueue({ key: `${P}exhausted`, runAt: Date.now() - 1000, maxAttempts: 1 });
    expect(await claim(randomUUID(), { id: job_id })).toHaveLength(1);
    await expireLock(job_id);
    expect(await claim(randomUUID(), { id: job_id })).toEqual([]);
    expect(await job(job_id)).toMatchObject({ status: "dead", locked_by: null });
  });
});

// ── §10.2 item 5: finish_job ────────────────────────────────────────────────
describe("finish_job", () => {
  it("a wrong token gets 'lost'", async () => {
    const { job_id } = await rpcEnqueue({ key: `${P}wrongtok`, runAt: Date.now() - 1000 });
    await claim(randomUUID(), { id: job_id });
    expect(await finish(job_id, randomUUID(), "done")).toBe("lost");
    expect((await job(job_id)).status).toBe("running");
  });

  it("reschedule gives the attempt back", async () => {
    const t = randomUUID();
    const { job_id } = await rpcEnqueue({ key: `${P}resched`, runAt: Date.now() - 1000 });
    await claim(t, { id: job_id });
    expect(await finish(job_id, t, "reschedule", Date.now() + 3_600_000)).toBe("pending");
    expect(await job(job_id)).toMatchObject({ status: "pending", attempts: 0, locked_by: null });
  });

  it("retry back to pending collides with a newer pending row → superseded", async () => {
    const t = randomUUID();
    const old = await rpcEnqueue({ key: `${P}super`, runAt: Date.now() - 1000 });
    await claim(t, { id: old.job_id });
    const newer = await rpcEnqueue({ key: `${P}super`, runAt: Date.now() + 3_600_000 });
    expect(newer.created).toBe(true);
    expect(newer.job_id).not.toBe(old.job_id);
    expect(await finish(old.job_id, t, "retry", Date.now() + 15_000, "boom")).toBe("superseded");
    expect(await job(old.job_id)).toMatchObject({ status: "done", last_error: "superseded by newer pending job" });
    expect((await job(newer.job_id)).status).toBe("pending");
  });

  it("retry on the last attempt dead-letters", async () => {
    const t = randomUUID();
    const { job_id } = await rpcEnqueue({ key: `${P}lastretry`, runAt: Date.now() - 1000, maxAttempts: 1 });
    await claim(t, { id: job_id });
    expect(await finish(job_id, t, "retry", Date.now() + 15_000, "still broken")).toBe("dead");
    expect(await job(job_id)).toMatchObject({ status: "dead", last_error: "still broken" });
  });
});

// ── Runner end to end (T2 criteria) ─────────────────────────────────────────
describe("runner", () => {
  it("runs a due noop job to done", async () => {
    const e = await enqueueJob({ kind: "noop", payload: { note: "smoke" }, dedupeKey: `${P}noop` });
    jobIds.add(e.id);
    const s = await runDueJobs({ budgetMs: 30_000, concurrency: 1, jobId: e.id });
    expect(s).toMatchObject({ claimed: 1, done: 1, errors: 0 });
    expect(await job(e.id)).toMatchObject({ status: "done", attempts: 1, locked_by: null });
  });

  it("a throwing handler retries with backoff, then ends dead after max attempts", async () => {
    const registry: JobRegistry = {
      [SMOKE]: defineJobKind({
        payload: z.object({}),
        run: async () => {
          throw new Error("smoke failure");
        },
      }),
    };
    const { job_id } = await rpcEnqueue({ key: `${P}throw`, runAt: Date.now() - 1000, maxAttempts: 2 });
    const before = Date.now();
    const s1 = await runDueJobs({ budgetMs: 30_000, concurrency: 1, jobId: job_id, deps: { registry } });
    expect(s1).toMatchObject({ claimed: 1, retried: 1 });
    const r1 = await job(job_id);
    expect(r1).toMatchObject({ status: "pending", attempts: 1, last_error: "Error: smoke failure" });
    const delay = Date.parse(r1.run_at) - before;
    expect(delay).toBeGreaterThanOrEqual(12_000 - 2000);
    expect(delay).toBeLessThanOrEqual(18_000 + 5000);

    await sb.from("jobs").update({ run_at: iso(Date.now() - 1000) }).eq("id", job_id);
    const s2 = await runDueJobs({ budgetMs: 30_000, concurrency: 1, jobId: job_id, deps: { registry } });
    expect(s2).toMatchObject({ claimed: 1, dead: 1 });
    expect(await job(job_id)).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("dead-letters unknown kinds due for more than 1h, but not fresh ones", async () => {
    const stale = await rpcEnqueue({ key: `${P}stale`, runAt: Date.now() - 2 * 3_600_000 });
    const fresh = await rpcEnqueue({ key: `${P}fresh`, runAt: Date.now() - 1000 });
    expect(await deadLetterUnknownKinds(3_600_000)).toBeGreaterThanOrEqual(1);
    expect(await job(stale.job_id)).toMatchObject({ status: "dead", last_error: expect.stringMatching(/unknown job kind/) });
    expect((await job(fresh.job_id)).status).toBe("pending");
  });
});

// ── Retention ───────────────────────────────────────────────────────────────
describe("retention_purge", () => {
  it("purges past-retention rows and keeps recent ones", async () => {
    const now = Date.now();
    const ago = (days: number) => iso(now - days * DAY);
    const { data: u, error: ue } = await sb.from("users").insert({ name: "smoke jobs" }).select("id").single();
    if (ue) throw new Error(ue.message);
    userId = u.id;
    const handle = `+1555010${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`;
    const { data: ch, error: ce } = await sb
      .from("channels")
      .insert({ user_id: userId, kind: "imessage", handle, handle_kind: "phone", provider: "dev" })
      .select("id")
      .single();
    if (ce) throw new Error(ce.message);

    const msgs = await sb
      .from("messages")
      .insert([
        { user_id: userId, channel_id: ch.id, direction: "in", body: "old", created_at: ago(181) },
        { user_id: userId, channel_id: ch.id, direction: "in", body: "new", created_at: ago(1) },
      ], { defaultToNull: false })
      .select("id");
    const [oldMsg, newMsg] = idsOf(msgs, "messages");
    const [oldReaction] = idsOf(
      await sb.from("reactions").insert({ message_id: oldMsg, actor: "user", type: "love" }).select("id"),
      "reactions",
    );
    const [oldRun, newRun] = idsOf(
      await sb
        .from("agent_runs")
        .insert([
          { user_id: userId, started_at: ago(181) },
          { user_id: userId, started_at: ago(1) },
        ], { defaultToNull: false })
        .select("id"),
      "agent_runs",
    );
    const [oldJob, newJob, oldPending] = idsOf(
      await sb
        .from("jobs")
        .insert([
          { kind: SMOKE, user_id: userId, status: "done", finished_at: ago(31), dedupe_key: `${P}r1` },
          { kind: SMOKE, user_id: userId, status: "dead", finished_at: ago(1), dedupe_key: `${P}r2` },
          { kind: SMOKE, user_id: userId, status: "pending", created_at: ago(31), run_at: iso(now + DAY), dedupe_key: `${P}r3` },
        ], { defaultToNull: false })
        .select("id"),
      "jobs",
    );
    [oldJob, newJob, oldPending].forEach((id) => jobIds.add(id));
    must(
      await sb.from("magic_links").insert([
        { token_hash: `smoke-${RUN}-ml-old`, user_id: userId, purpose: "view", expires_at: ago(8) },
        { token_hash: `smoke-${RUN}-ml-new`, user_id: userId, purpose: "view", expires_at: ago(1) },
      ], { defaultToNull: false }),
      "magic_links",
    );
    must(
      await sb.from("web_sessions").insert([
        { session_hash: `smoke-${RUN}-ws-exp`, user_id: userId, expires_at: ago(8) },
        { session_hash: `smoke-${RUN}-ws-rev`, user_id: userId, expires_at: iso(now + DAY), revoked_at: ago(8) },
        { session_hash: `smoke-${RUN}-ws-live`, user_id: userId, expires_at: iso(now + DAY) },
      ], { defaultToNull: false }),
      "web_sessions",
    );
    signupIds.push(
      ...idsOf(
        await sb
          .from("signups")
          .insert([
            { name: "smoke old", phone_e164: "+15550100998", expires_at: ago(8) },
            { name: "smoke new", phone_e164: "+15550100999", expires_at: iso(now + DAY) },
          ], { defaultToNull: false })
          .select("id"),
        "signups",
      ),
    );
    must(
      await sb.from("proactive_dedupe").insert([
        { user_id: userId, dedupe_key: `${P}pd-old`, delivered_at: ago(31) },
        { user_id: userId, dedupe_key: `${P}pd-new`, delivered_at: ago(1) },
      ], { defaultToNull: false }),
      "proactive_dedupe",
    );
    const [oldBrief, newBrief] = idsOf(
      await sb
        .from("briefings")
        .insert([
          { user_id: userId, local_date: "2026-01-01", target_at: ago(181), plan: { bubbles: ["x"] }, created_at: ago(181) },
          { user_id: userId, local_date: "2026-10-01", target_at: ago(1), plan: { bubbles: ["y"] } },
        ], { defaultToNull: false })
        .select("id"),
      "briefings",
    );

    const report = await purgeExpired(new Date(now), Date.now() + 60_000);
    expect(report.complete).toBe(true);
    for (const k of ["messages", "jobs", "agentRuns", "magicLinks", "webSessions", "signups", "proactiveDedupe", "briefingPlans"] as const) {
      expect(report[k]).toBeGreaterThanOrEqual(1);
    }

    const ids = async (table: "messages" | "reactions" | "agent_runs" | "jobs", list: string[]) =>
      ((await sb.from(table).select("id").in("id", list)).data ?? []).map((r) => r.id).sort();
    expect(await ids("messages", [oldMsg, newMsg])).toEqual([newMsg]);
    expect(await ids("reactions", [oldReaction])).toEqual([]);
    expect(await ids("agent_runs", [oldRun, newRun])).toEqual([newRun]);
    expect(await ids("jobs", [oldJob, newJob, oldPending])).toEqual([newJob, oldPending].sort());
    const ml = (await sb.from("magic_links").select("token_hash").eq("user_id", userId)).data ?? [];
    expect(ml.map((r) => r.token_hash)).toEqual([`smoke-${RUN}-ml-new`]);
    const ws = (await sb.from("web_sessions").select("session_hash").eq("user_id", userId)).data ?? [];
    expect(ws.map((r) => r.session_hash)).toEqual([`smoke-${RUN}-ws-live`]);
    const su = (await sb.from("signups").select("id").in("id", signupIds)).data ?? [];
    expect(su.map((r) => r.id)).toEqual([signupIds[1]]);
    const pd = (await sb.from("proactive_dedupe").select("dedupe_key").eq("user_id", userId)).data ?? [];
    expect(pd.map((r) => r.dedupe_key)).toEqual([`${P}pd-new`]);
    const br = (await sb.from("briefings").select("id, plan").in("id", [oldBrief, newBrief])).data ?? [];
    expect(br.find((r) => r.id === oldBrief)?.plan).toBeNull();
    expect(br.find((r) => r.id === newBrief)?.plan).toEqual({ bubbles: ["y"] });
  });

  it("runs as a job (keep-mode dedupe) to done", async () => {
    await cancelJobs({ dedupeKey: "retention_purge" }); // a pending one from pg_cron may be scheduled later
    const e = await enqueueJob({ kind: "retention_purge", payload: {}, dedupeKey: "retention_purge", mode: "keep" });
    jobIds.add(e.id);
    expect(e.created).toBe(true);
    const s = await runDueJobs({ budgetMs: 60_000, concurrency: 1, jobId: e.id });
    expect(s).toMatchObject({ claimed: 1, done: 1 });
    expect(await job(e.id)).toMatchObject({ status: "done", max_attempts: 3 });
  });
});

// ── §10.2 items 8 + 9: grants and tick ───────────────────────────────────────
describe("grants and tick", () => {
  it("anon cannot call the jobs RPCs", async () => {
    const c = await anon.rpc("claim_jobs", { p_token: randomUUID(), p_kinds: [SMOKE] });
    expect(c.error).not.toBeNull();
    expect(c.error?.code).toBe("42501");
    const e = await anon.rpc("enqueue_job", { p_kind: SMOKE });
    expect(e.error?.code).toBe("42501");
    const f = await anon.rpc("finish_job", { p_id: randomUUID(), p_token: randomUUID(), p_outcome: "done" });
    expect(f.error?.code).toBe("42501");
    const p = await anon.rpc("purge_messages_before", { p_before: iso(0) });
    expect(p.error?.code).toBe("42501");
  });

  it("private.jobs_tick() is a no-op (null) until Vault is configured (informational)", () => {
    if (!target.dbUrl) {
      console.warn("skipping tick check: no DB URL (set SMOKE_DB_URL)");
      return;
    }
    const q = (sql: string) =>
      execFileSync("psql", [target.dbUrl as string, "-Atc", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    let configured: string;
    try {
      configured = q("select count(*) from vault.secrets where name in ('aria_dispatch_url','aria_dispatch_secret')");
    } catch {
      console.warn("skipping tick check: psql unavailable");
      return;
    }
    const tick = q("select private.jobs_tick()");
    if (configured === "2") expect(tick).toMatch(/^\d*$/); // request id, or empty when nothing is due
    else expect(tick).toBe("");
  });
});
