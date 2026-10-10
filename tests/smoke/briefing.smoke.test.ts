/**
 * Briefing + change alerts + reconcile smoke (task 4.1; V2-06 §10 smoke steps 1–9).
 *
 * Targets the LOCAL Supabase stack by default (keys from `supabase status -o json`); set
 * `SMOKE_TARGET=env` to use NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY instead.
 * Scheduling uses a synthetic NOW two local days ahead (noon New York) so the dispatcher never
 * claims this test's jobs; deliveries go through the real `deliver` with the in-memory dev
 * provider (quiet hours disabled on the throwaway user so the run is time-of-day independent).
 * The briefing model is a fake by default (no tokens); `SMOKE_LLM=1` with ANTHROPIC_API_KEY
 * exported uses the real `briefing` route. Everything hangs off one throwaway user and is deleted
 * in afterAll (incl. its `llm_calls` rows), which asserts nothing is left.
 *
 *   npm run smoke -- tests/smoke/briefing.smoke.test.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";

interface Target {
  url: string;
  serviceKey: string;
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
  return { url: s.API_URL, serviceKey: s.SERVICE_ROLE_KEY };
}

function envTarget(): Target {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`SMOKE_TARGET=env needs ${k}`);
    return v;
  };
  return { url: need("NEXT_PUBLIC_SUPABASE_URL"), serviceKey: need("SUPABASE_SERVICE_ROLE_KEY") };
}

const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.CHANNEL_PROVIDER = "dev";

// Server modules read env lazily (db() on first call), so importing after the assignment is safe.
import { handleTimelineChanges } from "@/server/alerts/timeline-changes";
import type { BriefingModel } from "@/server/briefing/generate";
import { prepareBriefing, sendBriefing } from "@/server/briefing/run";
import { scheduleNextBriefing } from "@/server/briefing/scheduler";
import { reconcileUser, writeHeartbeat } from "@/server/proactive/reconcile";
import { createReminder, ensureAutoNudges } from "@/server/reminders/service";
import type { TimelineChangeBatch } from "@/server/timeline/types";
import { addLocalDays, formatLocalDate, localDateOf, zonedToUtc } from "@/shared/time/tz";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const NY = "America/New_York";
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
/** Noon New York, two local days from today. */
const NOW = zonedToUtc({ ...addLocalDays(localDateOf(new Date(), NY), 2), hour: 12, minute: 0 }, NY).instant;
const NOW_DATE = formatLocalDate(localDateOf(NOW, NY));
const REAL_LLM = process.env.SMOKE_LLM === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

let userId = "";
let channelId = "";
let item1 = ""; // assignment due NOW + 5h
let item2 = ""; // assignment due NOW + 10d
let item3 = ""; // assignment due on the briefing day, 11:59pm
let userReminder = "";
let firstBriefing: { at: Date; localDate: string } | null = null;
let heartbeatBefore: Database["public"]["Tables"]["system_heartbeat"]["Row"] | null = null;
const modelCalls: string[] = [];

const fakeModel: BriefingModel = async (i) => {
  modelCalls.push(i.user);
  return { bubbles: ["morning! smoke briefing", "full week here:"], costUsd: 0 };
};
const deps = REAL_LLM ? {} : { model: fakeModel };

function must<T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.data === null || r.data === undefined) throw new Error(`${what}: no data`);
  return r.data;
}

async function addItem(dueAt: Date, title: string): Promise<string> {
  return must(
    await sb
      .from("timeline_items")
      .insert({ user_id: userId, source: "canvas", external_id: `smoke-${randomUUID()}`, kind: "assignment", title, course: "SMOKE 101", due_at: dueAt.toISOString() })
      .select("id")
      .single(),
    "item",
  ).id;
}

async function outbound(trigger: string) {
  return must(await sb.from("messages").select("id, body").eq("user_id", userId).eq("direction", "out").eq("trigger", trigger), "messages");
}

async function pendingJobs(key: string) {
  return must(await sb.from("jobs").select("*").eq("dedupe_key", key).eq("status", "pending"), "jobs");
}

async function reminderRows(itemId: string) {
  return must(await sb.from("reminders").select("id, origin, status, due_at").eq("anchor_item_id", itemId), "reminders");
}

function batch(changes: TimelineChangeBatch["changes"]): TimelineChangeBatch {
  return { initial: false, changes };
}

beforeAll(async () => {
  // Step 1: throwaway user (quiet hours off), dev channel, Canvas "connected", items.
  const u = must(
    await sb.from("users").insert({ name: "smoke briefing", timezone: NY, quiet_start: "00:00", quiet_end: "00:00" }).select("id").single(),
    "user",
  );
  userId = u.id;
  const handle = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  channelId = must(
    await sb
      .from("channels")
      .insert({ user_id: userId, kind: "imessage", handle, handle_kind: "phone", provider: "dev", is_primary: true, verified_at: new Date().toISOString() })
      .select("id")
      .single(),
    "channel",
  ).id;
  must(await sb.from("integrations").insert({ user_id: userId, provider: "canvas_ical", status: "active" }).select("id"), "integration");
  item1 = await addItem(new Date(NOW.getTime() + 5 * H), "pset 3");
  item2 = await addItem(new Date(NOW.getTime() + 10 * D), "final paper");
  heartbeatBefore = (await sb.from("system_heartbeat").select("*").eq("id", "gh-actions").maybeSingle()).data;
});

afterAll(async () => {
  if (heartbeatBefore) await sb.from("system_heartbeat").upsert(heartbeatBefore);
  else await sb.from("system_heartbeat").delete().eq("id", "gh-actions");
  if (!userId) return;
  await sb.from("jobs").delete().eq("user_id", userId);
  await sb.from("llm_calls").delete().eq("user_id", userId);
  await sb.from("users").delete().eq("id", userId);
  const left = await Promise.all([
    sb.from("reminders").select("id").eq("user_id", userId),
    sb.from("jobs").select("id").eq("user_id", userId),
    sb.from("timeline_items").select("id").eq("user_id", userId),
    sb.from("briefings").select("id").eq("user_id", userId),
    sb.from("briefing_notes").select("id").eq("user_id", userId),
    sb.from("proactive_dedupe").select("dedupe_key").eq("user_id", userId),
    sb.from("llm_calls").select("id").eq("user_id", userId),
  ]);
  for (const r of left) expect(r.data ?? []).toHaveLength(0);
});

describe("step 2: reminders on item 1 (anchored user reminder + auto nudge)", () => {
  it("creates both", async () => {
    const r = await createReminder(userId, NY, { text: "pset due in 1h", when: { type: "before_item", itemId: item1, minutesBefore: 60 } }, NOW);
    if (!r.ok) throw new Error(r.error);
    userReminder = r.reminderId;
    expect(await ensureAutoNudges(userId, NOW)).toBe(1);
    expect((await reminderRows(item1)).map((x) => x.origin).sort()).toEqual(["auto", "user"]);
  });
});

describe("step 3: due change ≤7 days → reminders re-timed + one urgent alert; replay is a no-op", () => {
  const oldDue = () => new Date(NOW.getTime() + 5 * H);
  const newDue = () => new Date(NOW.getTime() + 29 * H);
  const change = () =>
    batch([
      {
        itemId: item1,
        kind: "due_changed",
        source: "canvas",
        itemKind: "assignment",
        title: "pset 3",
        course: "SMOKE 101",
        oldDueAt: oldDue().toISOString(),
        newDueAt: newDue().toISOString(),
        status: "upcoming",
        deliveryHint: "immediate",
        rekeyed: true,
      },
    ]);

  it("alerts once and moves the anchored reminders + their jobs", async () => {
    must(await sb.from("timeline_items").update({ due_at: newDue().toISOString() }).eq("id", item1).select("id"), "move");
    const r = await handleTimelineChanges(userId, change(), NOW);
    expect(r).toEqual({ alerted: 1, noted: 0 });
    const msgs = await outbound("due_change");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toMatch(/SMOKE 101: pset 3 moved/);
    for (const row of await reminderRows(item1)) {
      const offset = row.origin === "user" ? 60 : 180;
      expect(row.status).toBe("scheduled");
      expect(new Date(row.due_at ?? "").getTime()).toBe(newDue().getTime() - offset * MIN);
      const jobs = await pendingJobs(`reminder:${row.id}`);
      expect(jobs).toHaveLength(1);
      expect(new Date(jobs[0].run_at).getTime()).toBe(newDue().getTime() - offset * MIN);
    }
  });

  it("replaying the same batch sends nothing new", async () => {
    expect(await handleTimelineChanges(userId, change(), NOW)).toEqual({ alerted: 0, noted: 0 });
    expect(await outbound("due_change")).toHaveLength(1);
  });
});

describe("step 4: due change >7 days out → one briefing note, no alert", () => {
  it("notes (deduped on replay)", async () => {
    const newDue = new Date(NOW.getTime() + 11 * D);
    must(await sb.from("timeline_items").update({ due_at: newDue.toISOString() }).eq("id", item2).select("id"), "move");
    const b = batch([
      {
        itemId: item2,
        kind: "due_changed",
        source: "canvas",
        itemKind: "assignment",
        title: "final paper",
        course: "SMOKE 101",
        oldDueAt: new Date(NOW.getTime() + 10 * D).toISOString(),
        newDueAt: newDue.toISOString(),
        status: "upcoming",
        deliveryHint: "briefing",
      },
    ]);
    expect(await handleTimelineChanges(userId, b, NOW)).toEqual({ alerted: 0, noted: 1 });
    await handleTimelineChanges(userId, b, NOW);
    const notes = must(await sb.from("briefing_notes").select("kind, item_id").eq("user_id", userId), "notes");
    expect(notes).toEqual([{ kind: "due_changed", item_id: item2 }]);
    expect(await outbound("due_change")).toHaveLength(1);
  });
});

describe("step 5: item done → auto nudge AND user anchored reminder cancelled, jobs gone", () => {
  it("cancels via the status-change path", async () => {
    const r = await handleTimelineChanges(
      userId,
      batch([
        {
          itemId: item1,
          kind: "status_changed",
          source: "canvas",
          itemKind: "assignment",
          title: "pset 3",
          course: "SMOKE 101",
          oldDueAt: null,
          newDueAt: null,
          status: "done",
          deliveryHint: "none",
        },
      ]),
      NOW,
    );
    expect(r).toEqual({ alerted: 0, noted: 0 });
    for (const row of await reminderRows(item1)) {
      expect(row.status).toBe("cancelled");
      expect(await pendingJobs(`reminder:${row.id}`)).toHaveLength(0);
    }
    expect(userReminder).not.toBe("");
  });
});

describe("steps 6–7: schedule → prepare → send", () => {
  it("scheduleNextBriefing leaves exactly one pending prepare job", async () => {
    firstBriefing = await scheduleNextBriefing(userId, NOW);
    expect(firstBriefing?.localDate).toBe(formatLocalDate(addLocalDays(localDateOf(NOW, NY), 1)));
    expect(await pendingJobs(`briefing_prep:${userId}`)).toHaveLength(1);
    // Content for that day: due 11:59pm on the briefing date.
    item3 = await addItem(zonedToUtc({ ...addLocalDays(localDateOf(NOW, NY), 1), hour: 23, minute: 59 }, NY).instant, "lab report");
  });

  it("prepare: row ready, send job at the target, next day chained; a re-run reuses the plan", async () => {
    const fb = firstBriefing;
    if (!fb) throw new Error("no briefing scheduled");
    const prepNow = new Date(fb.at.getTime() - 15 * MIN);
    const r = await prepareBriefing(userId, { targetAt: fb.at.toISOString(), localDate: fb.localDate }, prepNow, deps);
    expect(r).toMatchObject({ outcome: "ready", kind: "daily" });
    const row = must(await sb.from("briefings").select("*").eq("user_id", userId).eq("local_date", fb.localDate).single(), "briefing");
    expect(row).toMatchObject({ status: "ready", kind: "daily" });
    expect((row.plan as { bubbles: string[] }).bubbles.length).toBeGreaterThan(0);
    const send = await pendingJobs(`briefing_send:${userId}:${fb.localDate}`);
    expect(send).toHaveLength(1);
    expect(new Date(send[0].run_at).getTime()).toBe(fb.at.getTime());
    const u = must(await sb.from("users").select("next_briefing_at").eq("id", userId).single(), "user");
    expect(new Date(u.next_briefing_at ?? "").getTime()).toBe(fb.at.getTime() + D);
    expect(await pendingJobs(`briefing_prep:${userId}`)).toHaveLength(1);
    if (!REAL_LLM) {
      expect(modelCalls).toHaveLength(1);
      expect(modelCalls[0]).toContain("lab report");
      expect(modelCalls[0]).toMatch(/<untrusted source="canvas">/);
    }

    const again = await prepareBriefing(userId, { targetAt: fb.at.toISOString(), localDate: fb.localDate }, prepNow, deps);
    expect(again).toMatchObject({ outcome: "ready", reason: "reused" });
    if (!REAL_LLM) expect(modelCalls).toHaveLength(1);
    expect(await pendingJobs(`briefing_send:${userId}:${fb.localDate}`)).toHaveLength(1);
  });

  it("send: content changed since prepare → regenerated; delivered once; notes consumed", async () => {
    const fb = firstBriefing;
    if (!fb) throw new Error("no briefing scheduled");
    must(await sb.from("timeline_items").update({ title: "lab report (v2)" }).eq("id", item3).select("id"), "retitle");
    const r = await sendBriefing(userId, { localDate: fb.localDate }, fb.at, deps);
    expect(r).toMatchObject({ outcome: "sent", regenerated: true });
    if (!REAL_LLM) expect(modelCalls).toHaveLength(2);
    const row = must(await sb.from("briefings").select("*").eq("user_id", userId).eq("local_date", fb.localDate).single(), "briefing");
    expect(row.status).toBe("sent");
    const notes = must(await sb.from("briefing_notes").select("consumed_by").eq("user_id", userId), "notes");
    expect(notes).toEqual([{ consumed_by: row.id }]);
    const u = must(await sb.from("users").select("last_briefing_sent_at").eq("id", userId).single(), "user");
    expect(u.last_briefing_sent_at).not.toBeNull();
    // Routine → per-user outbox (bundled after the alert); the digest link rides along.
    const outbox = await pendingJobs(`outbox:${userId}`);
    expect(outbox).toHaveLength(1);
    const items = (outbox[0].payload as { items: { reason: string; plan: { link?: { url: string } } }[] }).items;
    expect(items.map((i) => i.reason)).toEqual(["briefing"]);
    expect(items[0].plan.link?.url).toMatch(/\/m\?k=week&n=\d+#t=/);
    const link = must(await sb.from("magic_links").select("purpose").eq("user_id", userId), "links");
    expect(link.map((l) => l.purpose)).toContain("digest");

    expect(await sendBriefing(userId, { localDate: fb.localDate }, fb.at, deps)).toEqual({ outcome: "already_done" });
  });

  it("send deferred past the briefing day (paused) → skipped as stale, nothing queued", async () => {
    const u = must(await sb.from("users").select("next_briefing_at").eq("id", userId).single(), "user");
    const at = new Date(u.next_briefing_at ?? "");
    const localDate = formatLocalDate(localDateOf(at, NY));
    expect(await prepareBriefing(userId, { targetAt: at.toISOString(), localDate }, new Date(at.getTime() - 12 * MIN), deps)).toMatchObject({ outcome: "ready" });
    must(await sb.from("channels").update({ paused_until: new Date(Date.now() + 2 * H).toISOString() }).eq("id", channelId).select("id"), "pause");
    try {
      expect(await sendBriefing(userId, { localDate }, at, deps)).toEqual({ outcome: "skipped", reason: "stale" });
      const row = must(await sb.from("briefings").select("status, skip_reason").eq("user_id", userId).eq("local_date", localDate).single(), "briefing");
      expect(row).toEqual({ status: "skipped", skip_reason: "stale" });
    } finally {
      must(await sb.from("channels").update({ paused_until: null }).eq("id", channelId).select("id"), "unpause");
    }
  });
});

describe("step 8: reconcile", () => {
  it("recreates a deleted reminder job and a deleted prepare job; resolves stuck pending actions", async () => {
    const r = await createReminder(userId, NY, { text: "call mom", when: { type: "at", local: `${NOW_DATE}T21:00` } }, NOW);
    if (!r.ok) throw new Error(r.error);
    must(await sb.from("jobs").delete().eq("dedupe_key", `reminder:${r.reminderId}`).select("id"), "delete reminder job");
    must(await sb.from("jobs").delete().eq("dedupe_key", `briefing_prep:${userId}`).select("id"), "delete prepare job");
    const stuck = must(
      await sb
        .from("pending_actions")
        .insert({
          user_id: userId,
          kind: "delete_account",
          payload: {},
          status: "executing",
          summary: "smoke",
          expires_at: new Date(NOW.getTime() + H).toISOString(),
          updated_at: new Date(Date.now() - 10 * MIN).toISOString(),
        })
        .select("id")
        .single(),
      "stuck action",
    );

    const report = await reconcileUser(userId, NOW);
    expect(report.errors).toEqual([]);
    expect(report.briefing).toBe("fixed");
    expect(report.reminderJobsFixed).toBeGreaterThanOrEqual(1);
    expect(report.stuckActions).toEqual({ done: 0, failed: 1 });
    expect(await pendingJobs(`reminder:${r.reminderId}`)).toHaveLength(1);
    expect(await pendingJobs(`briefing_prep:${userId}`)).toHaveLength(1);
    expect(must(await sb.from("pending_actions").select("status").eq("id", stuck.id).single(), "action").status).toBe("failed");

    const again = await reconcileUser(userId, NOW);
    expect(again).toMatchObject({ briefing: "ok", reminderJobsFixed: 0, stuckActions: { done: 0, failed: 0 }, errors: [] });
  });

  it("heartbeat upserts through PostgREST", async () => {
    await writeHeartbeat("gh-actions", { smoke: true });
    const row = must(await sb.from("system_heartbeat").select("beat_at, detail").eq("id", "gh-actions").single(), "heartbeat");
    expect(row.detail).toEqual({ smoke: true });
    expect(Date.now() - new Date(row.beat_at).getTime()).toBeLessThan(60_000);
  });
});
