/**
 * Timeline smoke (V2-05 §10.3 items 1–6, 9; task 2.3) against the LOCAL Supabase stack by default
 * (keys from `supabase status -o json`; `SMOKE_TARGET=env` uses NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY). One throwaway user; its rows and
 * jobs are deleted in afterAll. Dates are relative to the real clock.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";
import type { TimelineChangeBatch } from "@/server/timeline/types";

interface Target {
  url: string;
  serviceKey: string;
  anonKey: string;
}

function localTarget(): Target {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set SMOKE_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY, anonKey: s.ANON_KEY };
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
  };
}

const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;

// Capture status-change subscriber calls (hooks.ts lazily imports this module).
const received: TimelineChangeBatch[] = [];
jest.mock("@/server/alerts/timeline-changes", () => ({
  handleTimelineChanges: jest.fn(async (_u: string, batch: TimelineChangeBatch) => {
    received.push(batch);
    return { alerted: 0, noted: 0 };
  }),
}));

// Server modules read env lazily (db() on first call), so importing after the assignment is safe.
import {
  applySnapshot,
  deleteTimelineItems,
  getTimelineItem,
  listItems,
  listTimeline,
  listTimelineForRange,
  markItemDone,
  pruneTimelineItems,
  rebaseTimeline,
  replaceSourceWindow,
  resolveItemRef,
  searchTimeline,
  setTimelineItemStatus,
  summarizeUpcoming,
  termHintForCourse,
  upsertTimelineItem,
  upsertTimelineItems,
  type TimelineItemInput,
} from "@/server/timeline";

type Sb = SupabaseClient<Database>;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const sb: Sb = createClient<Database>(target.url, target.serviceKey, opts);
const anon: Sb = createClient<Database>(target.url, target.anonKey, opts);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = Date.now();
const at = (h: number) => new Date(t0 + h * HOUR);
let userId = "";

async function jobBatches(): Promise<TimelineChangeBatch[]> {
  const { data, error } = await sb
    .from("jobs")
    .select("payload, created_at")
    .eq("user_id", userId)
    .eq("kind", "timeline_changes")
    .like("dedupe_key", `tlc:${userId}:%`)
    .order("created_at");
  if (error) throw error;
  return data.map((r) => r.payload as unknown as TimelineChangeBatch);
}

async function rowOf(externalId: string, source = "canvas") {
  const { data, error } = await sb
    .from("timeline_items")
    .select("id, external_id, status, removed_at, due_at")
    .eq("user_id", userId)
    .eq("source", source)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Canvas-like snapshot (A1 has an override-able match key).
const A1: TimelineItemInput = {
  externalId: "event-assignment-501",
  kind: "assignment",
  title: "Pset 4",
  course: "CPSC 323 01 (FA26)",
  dueAt: at(72),
  timingKey: "U:A1-v1",
  matchKey: "assignment_501",
};
const A2: TimelineItemInput = { externalId: "event-assignment-502", kind: "assignment", title: "Essay 2", course: "ENGL 120", dueAt: at(240), timingKey: "U:A2" };
const E1: TimelineItemInput = { externalId: "event-calendar-event-77", kind: "event", title: "Review session", course: "CPSC 323 01 (FA26)", startsAt: at(30), endsAt: at(31), timingKey: "U:E1" };
const OVERDUE: TimelineItemInput = { externalId: "event-assignment-503", kind: "assignment", title: "Lab 1", course: "CHEM 134L", dueAt: at(-48), timingKey: "U:OD" };
const ALLDAY: TimelineItemInput = {
  externalId: "event-assignment-504",
  kind: "assignment",
  title: "Reading",
  course: "ENGL 120",
  allDay: true,
  timingKey: "D:20991015",
  dueAt: new Date("2099-10-16T03:59:00Z"), // 23:59 EDT
};

beforeAll(async () => {
  const { data, error } = await sb
    .from("users")
    .insert({ name: `smoke-v205-${randomUUID().slice(0, 8)}`, timezone: "America/New_York" })
    .select("id")
    .single();
  if (error) throw error;
  userId = data.id;
});

afterAll(async () => {
  if (!userId) return;
  await sb.from("jobs").delete().eq("user_id", userId);
  await sb.from("jobs").delete().like("dedupe_key", `tlc:${userId}:%`);
  await sb.from("timeline_items").delete().eq("user_id", userId);
  await sb.from("users").delete().eq("id", userId);
});

describe("timeline smoke", () => {
  let a1Id = "";

  it("2. initial applySnapshot → counts + an enqueued timeline_changes job with initial: true", async () => {
    const r = await applySnapshot({ userId, source: "canvas", items: [A1, A2, E1, OVERDUE, ALLDAY], initial: true });
    expect(r).toMatchObject({ created: 5, updated: 0, removed: 0, dueChanged: 0 });
    expect(r.batch.initial).toBe(true);
    expect(r.batch.changes.every((c) => c.kind === "created" && c.deliveryHint === "none")).toBe(true);
    const jobs = await jobBatches();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].initial).toBe(true);
    expect(jobs[0].changes).toHaveLength(5);
    a1Id = (await rowOf(A1.externalId))?.id ?? "";
    expect(a1Id).not.toBe("");

    // Re-applying the same snapshot is a no-op: no changes, no new job.
    const again = await applySnapshot({ userId, source: "canvas", items: [A1, A2, E1, OVERDUE, ALLDAY] });
    expect(again).toMatchObject({ unchanged: 5, created: 0 });
    expect(await jobBatches()).toHaveLength(1);
  });

  it("3. override UID swap → 1 rekey, due_changed hinted immediate, same item id", async () => {
    const override: TimelineItemInput = { ...A1, externalId: "event-assignment-override-9001", dueAt: at(96), timingKey: "U:A1-v2" };
    const r = await applySnapshot({ userId, source: "canvas", items: [override, A2, E1, OVERDUE, ALLDAY] });
    expect(r).toMatchObject({ rekeyed: 1, dueChanged: 1, created: 0, removed: 0 });
    expect(r.batch.changes).toEqual([
      expect.objectContaining({ itemId: a1Id, kind: "due_changed", rekeyed: true, deliveryHint: "immediate" }),
    ]);
    expect((await rowOf("event-assignment-override-9001"))?.id).toBe(a1Id);
    expect(await rowOf(A1.externalId)).toBeNull();
    expect(await jobBatches()).toHaveLength(2);
  });

  it("4. setTimelineItemStatus(done) → subscriber gets status_changed; a later due change hints none", async () => {
    const res = await setTimelineItemStatus(userId, a1Id, "done");
    expect(res.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].changes[0]).toMatchObject({ itemId: a1Id, kind: "status_changed", status: "done", deliveryHint: "none" });
    // Idempotent: same status again → no subscriber call.
    expect((await markItemDone(userId, a1Id))?.status).toBe("done");
    expect(received).toHaveLength(1);

    const moved: TimelineItemInput = { ...A1, externalId: "event-assignment-override-9001", dueAt: at(100), timingKey: "U:A1-v3" };
    const r = await applySnapshot({ userId, source: "canvas", items: [moved, A2, E1, OVERDUE, ALLDAY] });
    expect(r.batch.changes).toEqual([expect.objectContaining({ kind: "due_changed", status: "done", deliveryHint: "none" })]);
    expect((await setTimelineItemStatus(userId, randomUUID(), "done")).ok).toBe(false);
  });

  it("5. resolveItemRef, listTimeline (both call styles), overdueSince, search, summaries", async () => {
    const ref = `t_${a1Id.replace(/-/g, "").slice(0, 8)}`;
    await expect(resolveItemRef(userId, ref)).resolves.toEqual({ ok: true, itemId: a1Id });
    await expect(resolveItemRef(userId, a1Id)).resolves.toEqual({ ok: true, itemId: a1Id });
    await expect(resolveItemRef(randomUUID(), ref)).resolves.toEqual({ ok: false, error: "not_found" });

    const from = new Date(t0);
    const to = new Date(t0 + 30 * DAY);
    const styleA = await listTimeline(userId, { from, to }, { includeDone: true });
    const styleB = await listItems(userId, { from, to, includeDone: true });
    expect(styleA.map((v) => v.id)).toEqual(styleB.map((v) => v.id));
    expect(styleA.map((v) => v.title)).toEqual(["Review session", "Pset 4", "Essay 2"]);
    expect((await listTimeline(userId, { from, to })).map((v) => v.title)).toEqual(["Review session", "Essay 2"]); // done hidden

    const withOverdue = await listTimeline(userId, { from, to }, { overdueSince: new Date(t0 - 7 * DAY) });
    expect(withOverdue[0]).toMatchObject({ title: "Lab 1", urgency: "overdue" });
    expect((await listTimeline(userId, { from, to, includeOverdue: true }))[0].title).toBe("Lab 1");

    const week = await listTimelineForRange(userId, "next_14_days", { kinds: ["assignment"] });
    expect(week.map((v) => v.title)).toEqual(["Essay 2"]);

    expect((await searchTimeline(userId, "323", { includeDone: true })).map((v) => v.title)).toEqual(["Review session", "Pset 4"]);
    expect((await getTimelineItem(userId, a1Id))?.ref).toBe(ref);

    const sum = await summarizeUpcoming(userId, "canvas");
    expect(sum.deadlines).toBe(1); // Essay 2 (Pset 4 is done; the 2099 Reading is beyond the feed horizon)
    expect(sum.nextDue?.title).toBe("Essay 2");
    await expect(termHintForCourse(userId, "cpsc 323")).resolves.toEqual({ start: at(30), end: at(100) });
  });

  it("rebaseTimeline moves date-only instants without change entries", async () => {
    const jobsBefore = (await jobBatches()).length;
    await expect(rebaseTimeline(userId, "America/Los_Angeles")).resolves.toEqual({ updated: 1 });
    expect((await rowOf(ALLDAY.externalId))?.due_at).toBe("2099-10-16T06:59:00+00:00");
    expect((await jobBatches()).length).toBe(jobsBefore);
    await expect(rebaseTimeline(userId, "America/Los_Angeles")).resolves.toEqual({ updated: 0 });
  });

  it("6. replaceSourceWindow deletes only in-window stale rows; pruneTimelineItems by prefix", async () => {
    const g = (id: string, h: number): TimelineItemInput => ({ externalId: id, kind: "event", title: id, startsAt: at(h), endsAt: at(h + 1) });
    const from = new Date(t0);
    expect(await replaceSourceWindow({ userId, source: "gcal", from, to: at(30 * 24), items: [g("g1", 24), g("g2", 72), g("g3", 20 * 24)] })).toEqual({
      upserted: 3,
      deleted: 0,
    });
    expect(await replaceSourceWindow({ userId, source: "gcal", from, to: at(7 * 24), items: [g("g1", 24)] })).toEqual({ upserted: 0, deleted: 1 });
    expect((await rowOf("g2", "gcal"))?.removed_at).not.toBeNull();
    expect((await rowOf("g3", "gcal"))?.removed_at).toBeNull();
    const single = await upsertTimelineItem(userId, "gcal", g("g4", 48));
    expect((await rowOf("g4", "gcal"))?.id).toBe(single.id);

    const syl = await upsertTimelineItems(userId, [
      { externalId: "syl:CPSC323:a", kind: "exam", title: "Midterm", startsAt: at(500), allDay: true, timingKey: "D:20991020" },
      { externalId: "syl:CPSC323:b", kind: "assignment", title: "Project", dueAt: at(600) },
      { externalId: "syl:MATH120:c", kind: "exam", title: "Final", startsAt: at(700) },
    ]);
    expect(syl.created).toBe(3);
    expect(syl.batch.changes.every((c) => c.source === "syllabus" && c.deliveryHint === "none")).toBe(true);
    await expect(pruneTimelineItems({ userId, source: "syllabus", externalIdPrefix: "syl:CPSC323:", keep: ["syl:CPSC323:a"] })).resolves.toEqual({
      removed: 1,
    });
    expect((await rowOf("syl:CPSC323:b", "syllabus"))?.removed_at).not.toBeNull();
    expect((await rowOf("syl:MATH120:c", "syllabus"))?.removed_at).toBeNull();

    await expect(deleteTimelineItems(userId, "gcal")).resolves.toEqual({ deleted: 3 });
    const last = (await jobBatches()).at(-1);
    expect(last?.changes.map((c) => c.kind)).toEqual(["removed", "removed", "removed"]);
  });

  it("9. timeline_apply via the anon key → permission denied", async () => {
    const { error } = await anon.rpc("timeline_apply", { p_user_id: userId, p_source: "canvas" });
    expect(error).not.toBeNull();
    expect(error?.code === "42501" || /permission denied/i.test(error?.message ?? "")).toBe(true);
  });
});
