/**
 * Runner logic (V2-03 §2.11, §11 T2) against an in-memory store that mirrors the claim_jobs /
 * finish_job semantics: outcome mapping, retry → backoff → dead after max attempts, permanent
 * errors, invalid payloads, concurrency, single-job mode, budget, and storage failures.
 */
import { z } from "zod";
import { retryDelayMs } from "@/server/jobs/backoff";
import {
  decideFinish,
  errorText,
  executeJob,
  runClaimed,
  runDueJobs,
  type FinishDecision,
  type FinishResult,
  type JobRegistry,
  type JobRow,
  type JobStore,
} from "@/server/jobs/runner";
import { defineJobKind, PermanentJobError, type JobContext } from "@/server/jobs/types";

const T0 = Date.parse("2026-10-10T12:00:00Z");
const half = () => 0.5;

function row(p: Partial<JobRow> & { kind: string }): JobRow {
  return {
    id: p.id ?? `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
    kind: p.kind,
    user_id: p.user_id ?? null,
    run_at: p.run_at ?? new Date(T0 - 1000).toISOString(),
    payload: p.payload ?? {},
    status: p.status ?? "pending",
    attempts: p.attempts ?? 0,
    max_attempts: p.max_attempts ?? 5,
    locked_until: p.locked_until ?? null,
    locked_by: p.locked_by ?? null,
    dedupe_key: p.dedupe_key ?? null,
    last_error: p.last_error ?? null,
    created_at: p.created_at ?? new Date(T0 - 5000).toISOString(),
    started_at: p.started_at ?? null,
    finished_at: p.finished_at ?? null,
  };
}

/** In-memory mirror of claim_jobs / finish_job (single-threaded, so SKIP LOCKED is trivial). */
class MemoryStore implements JobStore {
  rows: JobRow[];
  claimCalls: number[] = [];
  failClaim = false;
  failFinish = false;
  constructor(rows: JobRow[], private clock: () => number) {
    this.rows = rows;
  }
  async claim(token: string, kinds: readonly string[], limit: number, f: { jobId?: string; dedupeKey?: string }) {
    this.claimCalls.push(limit);
    if (this.failClaim) throw new Error("boom");
    const now = this.clock();
    const due = this.rows
      .filter((r) => kinds.includes(r.kind))
      .filter(
        (r) =>
          (r.status === "pending" && Date.parse(r.run_at) <= now) ||
          (r.status === "running" && r.locked_until !== null && Date.parse(r.locked_until) < now),
      )
      .filter((r) => !f.jobId || r.id === f.jobId)
      .filter((r) => !f.dedupeKey || r.dedupe_key === f.dedupeKey)
      .sort((a, b) => Date.parse(a.run_at) - Date.parse(b.run_at))
      .slice(0, limit);
    for (const r of due) {
      r.status = "running";
      r.attempts += 1;
      r.locked_by = token;
      r.locked_until = new Date(now + 330_000).toISOString();
    }
    return due.map((r) => ({ ...r }));
  }
  async finish(id: string, token: string, d: FinishDecision): Promise<FinishResult> {
    if (this.failFinish) throw new Error("finish down");
    const r = this.rows.find((x) => x.id === id && x.locked_by === token && x.status === "running");
    if (!r) return "lost";
    r.locked_by = null;
    r.locked_until = null;
    if (d.outcome === "done") {
      r.status = "done";
      return "done";
    }
    if (d.outcome === "dead" || (d.outcome === "retry" && r.attempts >= r.max_attempts)) {
      r.status = "dead";
      r.last_error = d.error;
      return "dead";
    }
    r.status = "pending";
    r.run_at = (d.runAt ?? new Date(this.clock())).toISOString();
    if (d.outcome === "retry") r.last_error = d.error;
    else r.attempts = Math.max(r.attempts - 1, 0);
    return "pending";
  }
}

describe("decideFinish", () => {
  it("void and {type:'done'} finish done", () => {
    expect(decideFinish({ ok: true, outcome: undefined }, 1, T0)).toEqual({ outcome: "done", runAt: null, error: null });
    expect(decideFinish({ ok: true, outcome: { type: "done" } }, 1, T0).outcome).toBe("done");
  });

  it("a throw retries after retryDelayMs(attempt)", () => {
    const d = decideFinish({ ok: false, error: new Error("flaky") }, 3, T0, half);
    expect(d.outcome).toBe("retry");
    expect(d.runAt?.getTime()).toBe(T0 + retryDelayMs(3, half));
    expect(d.error).toBe("Error: flaky");
  });

  it("PermanentJobError goes straight to dead", () => {
    expect(decideFinish({ ok: false, error: new PermanentJobError("nope") }, 1, T0).outcome).toBe("dead");
  });

  it("maps explicit outcomes", () => {
    expect(decideFinish({ ok: true, outcome: { type: "retry", error: "x", delayMs: 500 } }, 1, T0).runAt?.getTime()).toBe(T0 + 500);
    const at = new Date(T0 + 3000);
    expect(decideFinish({ ok: true, outcome: { type: "reschedule", runAt: at, reason: "lease held" } }, 1, T0)).toEqual({
      outcome: "reschedule",
      runAt: at,
      error: null,
    });
    expect(decideFinish({ ok: true, outcome: { type: "dead", error: "gone" } }, 1, T0)).toEqual({
      outcome: "dead",
      runAt: null,
      error: "gone",
    });
  });

  it("errorText is single-line and bounded", () => {
    expect(errorText(new Error("a\n  b"))).toBe("Error: a b");
    expect(errorText("x".repeat(2000)).length).toBe(500);
    expect(errorText(42)).toBe("42");
  });
});

describe("executeJob", () => {
  let seen: { ctx: JobContext; payload: unknown } | null = null;
  const registry: JobRegistry = {
    echo: defineJobKind({
      payload: z.object({ n: z.number(), mode: z.enum(["a", "b"]).default("a") }),
      run: async (ctx, payload) => {
        seen = { ctx, payload };
      },
    }),
  };

  beforeEach(() => {
    seen = null;
  });

  it("parses the payload (defaults applied) and builds JobContext with the injected now", async () => {
    const r = row({ kind: "echo", payload: { n: 1 }, attempts: 2, max_attempts: 4, user_id: "u1" });
    const fixedNow = new Date("2026-01-01T00:00:00Z");
    const d = await executeJob(r, "tok", T0 + 10_000, { registry, now: () => fixedNow, clock: () => T0 });
    expect(d.outcome).toBe("done");
    expect(seen?.payload).toEqual({ n: 1, mode: "a" });
    expect(seen?.ctx).toMatchObject({
      jobId: r.id,
      kind: "echo",
      userId: "u1",
      attempt: 2,
      maxAttempts: 4,
      token: "tok",
      now: fixedNow,
      deadline: T0 + 10_000,
    });
    expect(seen?.ctx.signal.aborted).toBe(false);
  });

  it("dead-letters an invalid payload without calling the handler", async () => {
    const d = await executeJob(row({ kind: "echo", payload: { n: "x" } }), "tok", T0, { registry });
    expect(d.outcome).toBe("dead");
    expect(d.error).toMatch(/^invalid payload: n:/);
    expect(seen).toBeNull();
  });

  it("dead-letters an unknown kind (incl. prototype keys)", async () => {
    expect((await executeJob(row({ kind: "nope" }), "tok", T0, { registry })).outcome).toBe("dead");
    expect((await executeJob(row({ kind: "toString" }), "tok", T0, { registry })).error).toMatch(/unknown job kind/);
  });

  it("aborts ctx.signal at the deadline", async () => {
    const slow: JobRegistry = {
      slow: defineJobKind({
        payload: z.object({}),
        run: (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve({ type: "retry", error: "aborted" }));
          }),
      }),
    };
    const d = await executeJob(row({ kind: "slow" }), "tok", Date.now() + 20, { registry: slow });
    expect(d).toMatchObject({ outcome: "retry", error: "aborted" });
  });
});

describe("runDueJobs", () => {
  function setup(rows: JobRow[], registry: JobRegistry) {
    let now = T0;
    const clock = () => now;
    const store = new MemoryStore(rows, clock);
    return {
      store,
      advance: (ms: number) => {
        now += ms;
      },
      run: (o: { budgetMs?: number; concurrency?: number; jobId?: string; dedupeKey?: string } = {}) =>
        runDueJobs({
          budgetMs: o.budgetMs ?? 270_000,
          concurrency: o.concurrency ?? 4,
          jobId: o.jobId,
          dedupeKey: o.dedupeKey,
          deps: { store, registry, clock, now: () => new Date(clock()), rng: half },
        }),
    };
  }
  const ok: JobRegistry = { ok: defineJobKind({ payload: z.object({}), run: async () => undefined }) };

  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("runs every due job once and leaves future and unregistered rows alone", async () => {
    const due = [row({ kind: "ok" }), row({ kind: "ok" }), row({ kind: "ok" })];
    const future = row({ kind: "ok", run_at: new Date(T0 + 60_000).toISOString() });
    const alien = row({ kind: "smoke_test" });
    const { store, run } = setup([...due, future, alien], ok);
    const s = await run();
    expect(s).toMatchObject({ claimed: 3, done: 3, retried: 0, dead: 0, errors: 0 });
    expect(due.map((r) => r.status)).toEqual(["done", "done", "done"]);
    expect(future.status).toBe("pending");
    expect(alien.status).toBe("pending");
    // 3 < 4 free slots → a short batch ends claiming (no extra empty claim).
    expect(store.claimCalls).toEqual([4]);
  });

  it("never exceeds the concurrency limit and keeps claiming as slots free", async () => {
    let inFlight = 0;
    let peak = 0;
    const gated: JobRegistry = {
      g: defineJobKind({
        payload: z.object({}),
        run: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
        },
      }),
    };
    const rows = Array.from({ length: 7 }, () => row({ kind: "g" }));
    const { store, run } = setup(rows, gated);
    const s = await run({ concurrency: 2 });
    expect(s.done).toBe(7);
    expect(peak).toBe(2);
    expect(store.claimCalls[0]).toBe(2);
    expect(store.claimCalls.every((n) => n >= 1 && n <= 2)).toBe(true);
  });

  it("a throwing handler retries with backoff and ends dead after max attempts", async () => {
    const boom: JobRegistry = {
      boom: defineJobKind({
        payload: z.object({}),
        run: async () => {
          throw new Error("upstream 503");
        },
      }),
    };
    const r = row({ kind: "boom", max_attempts: 3 });
    const { run, advance } = setup([r], boom);

    expect(await run()).toMatchObject({ claimed: 1, retried: 1 });
    expect(r).toMatchObject({ status: "pending", attempts: 1, last_error: "Error: upstream 503" });
    expect(Date.parse(r.run_at)).toBe(T0 + 15_000);

    expect((await run()).claimed).toBe(0); // backoff not elapsed
    advance(15_000);
    expect(await run()).toMatchObject({ claimed: 1, retried: 1 });
    expect(r.attempts).toBe(2);
    expect(Date.parse(r.run_at)).toBe(T0 + 15_000 + 30_000);

    advance(30_000);
    expect(await run()).toMatchObject({ claimed: 1, dead: 1 });
    expect(r).toMatchObject({ status: "dead", attempts: 3 });
  });

  it("PermanentJobError dead-letters on the first attempt", async () => {
    const perm: JobRegistry = {
      perm: defineJobKind({
        payload: z.object({}),
        run: async () => {
          throw new PermanentJobError("bad input");
        },
      }),
    };
    const r = row({ kind: "perm" });
    const { run } = setup([r], perm);
    expect(await run()).toMatchObject({ dead: 1 });
    expect(r).toMatchObject({ status: "dead", attempts: 1, last_error: "PermanentJobError: bad input" });
  });

  it("reschedule gives the attempt back", async () => {
    const later: JobRegistry = {
      later: defineJobKind({
        payload: z.object({}),
        run: async (ctx) => ({ type: "reschedule", runAt: new Date(ctx.now.getTime() + 3000), reason: "lease held" }),
      }),
    };
    const r = row({ kind: "later", attempts: 0 });
    const { run } = setup([r], later);
    expect(await run()).toMatchObject({ rescheduled: 1 });
    expect(r).toMatchObject({ status: "pending", attempts: 0 });
    expect(Date.parse(r.run_at)).toBe(T0 + 3000);
  });

  it("jobId mode claims only that row, once", async () => {
    const a = row({ kind: "ok" });
    const b = row({ kind: "ok" });
    const { store, run } = setup([a, b], ok);
    expect(await run({ jobId: b.id })).toMatchObject({ claimed: 1, done: 1 });
    expect([a.status, b.status]).toEqual(["pending", "done"]);
    expect(store.claimCalls).toHaveLength(1);
  });

  it("dedupeKey mode claims only matching rows", async () => {
    const a = row({ kind: "ok", dedupe_key: "turn:u1" });
    const b = row({ kind: "ok", dedupe_key: "turn:u2" });
    const { run } = setup([a, b], ok);
    expect((await run({ dedupeKey: "turn:u2" })).done).toBe(1);
    expect([a.status, b.status]).toEqual(["pending", "done"]);
  });

  it("does not claim when less than the reserve is left, but finishes in-flight work", async () => {
    const { store, run } = setup([row({ kind: "ok" })], ok);
    // budget 0 → stopClaimingAt == start → nothing claimed
    expect((await run({ budgetMs: 0 })).claimed).toBe(0);
    expect(store.claimCalls).toHaveLength(0);
  });

  it("stops claiming once the budget is spent and waits for running handlers", async () => {
    let now = T0;
    const rows = Array.from({ length: 5 }, () => row({ kind: "tick" }));
    const store = new MemoryStore(rows, () => now);
    const tick: JobRegistry = {
      tick: defineJobKind({
        payload: z.object({}),
        run: async () => {
          now += 100_000; // each job "takes" 100s of wall clock
        },
      }),
    };
    const s = await runDueJobs({
      budgetMs: 270_000,
      concurrency: 1,
      deps: { store, registry: tick, clock: () => now, now: () => new Date(now), rng: half },
    });
    // Claiming stops at 270s − 60s reserve = 210s: claims at t=0, 100s, 200s; none at 300s.
    expect(s.claimed).toBe(3);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
  });

  it("survives claim and finish failures without throwing", async () => {
    const { store, run } = setup([row({ kind: "ok" })], ok);
    store.failClaim = true;
    expect(await run()).toMatchObject({ claimed: 0, errors: 1 });
    store.failClaim = false;
    store.failFinish = true;
    expect(await run()).toMatchObject({ claimed: 1, done: 0, errors: 1 });
  });

  it("counts a lost lock when another runner reclaimed the row", async () => {
    const r = row({ kind: "ok" });
    const steal: JobRegistry = {
      ok: defineJobKind({
        payload: z.object({}),
        run: async () => {
          r.locked_by = "someone-else";
        },
      }),
    };
    const { run } = setup([r], steal);
    expect(await run()).toMatchObject({ claimed: 1, lost: 1, done: 0 });
  });
});

describe("runClaimed", () => {
  it("runs one already-claimed row and returns the finish result", async () => {
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    const r = row({ kind: "ok", status: "running", attempts: 1, locked_by: "tok" });
    const store = new MemoryStore([r], () => T0);
    const registry: JobRegistry = { ok: defineJobKind({ payload: z.object({}), run: async () => undefined }) };
    await expect(runClaimed({ ...r }, "tok", T0 + 1000, { store, registry })).resolves.toBe("done");
    await expect(runClaimed({ ...r }, "tok", T0 + 1000, { store, registry })).resolves.toBe("lost");
    jest.restoreAllMocks();
  });
});
