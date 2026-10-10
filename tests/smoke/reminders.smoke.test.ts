/**
 * Reminders + schedule core smoke (task 2.6; V2-06 §10 smoke steps 2, 3 (reminder side), 6, 8,
 * plus T5 fire paths).
 *
 * Targets the LOCAL Supabase stack by default (keys from `supabase status -o json`); set
 * `SMOKE_TARGET=env` to use NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY instead.
 * Scheduling steps use a synthetic NOW two local days ahead (noon New York) so the dispatcher
 * never claims the jobs mid-test; fire steps that go through `deliver` use real time and the
 * in-memory dev provider. Everything hangs off one throwaway user (cascade) and is deleted in
 * afterAll, which asserts nothing is left.
 *
 * Gate-pending (other tasks): the due-change ALERT half of V2-06 step 3 is `handleTimelineChanges`
 * (task 4.1); here step 3 checks the reminder side via `recomputeAnchored`.
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
import { addBriefingNote } from "@/server/briefing/notes";
import { onUserScheduleSettingsChanged, scheduleNextBriefing } from "@/server/briefing/scheduler";
import { NotificationSettingsError, getNotificationSettings, updateNotificationSettings } from "@/server/proactive/settings";
import { fireReminder } from "@/server/reminders/fire";
import {
  cancelForItem,
  cancelReminder,
  createReminder,
  ensureAutoNudges,
  listReminders,
  recomputeAnchored,
  reconcileReminderJobs,
} from "@/server/reminders/service";
import { addLocalDays, formatLocalDate, localDateOf, zonedToUtc } from "@/shared/time/tz";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const NY = "America/New_York";
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
/** Noon New York, two local days from today (scheduling steps). */
const NOW = zonedToUtc({ ...addLocalDays(localDateOf(new Date(), NY), 2), hour: 12, minute: 0 }, NY).instant;
const NOW_DATE = formatLocalDate(localDateOf(NOW, NY));

let userId = "";
let item1 = ""; // assignment due NOW + 5h
let item2 = ""; // assignment due NOW + 10d
const ids: Record<string, string> = {};

function must<T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.data === null || r.data === undefined) throw new Error(`${what}: no data`);
  return r.data;
}

async function reminder(id: string) {
  return must(await sb.from("reminders").select("*").eq("id", id).single(), "reminder");
}

async function pendingJobs(key: string) {
  return must(await sb.from("jobs").select("*").eq("dedupe_key", key).eq("status", "pending"), "jobs");
}

async function addItem(dueAt: Date, title: string): Promise<string> {
  const row = must(
    await sb
      .from("timeline_items")
      .insert({ user_id: userId, source: "aria", external_id: `smoke-${randomUUID()}`, kind: "assignment", title, course: "SMOKE 101", due_at: dueAt.toISOString() })
      .select("id")
      .single(),
    "item",
  );
  return row.id;
}

beforeAll(async () => {
  const u = must(await sb.from("users").insert({ name: "smoke reminders", timezone: NY }).select("id").single(), "user");
  userId = u.id;
  const handle = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  must(
    await sb
      .from("channels")
      .insert({ user_id: userId, kind: "imessage", handle, handle_kind: "phone", provider: "dev", is_primary: true, verified_at: new Date().toISOString() })
      .select("id"),
    "channel",
  );
  item1 = await addItem(new Date(NOW.getTime() + 5 * H), "pset 3");
  item2 = await addItem(new Date(NOW.getTime() + 10 * D), "final paper");
});

afterAll(async () => {
  if (!userId) return;
  await sb.from("jobs").delete().eq("user_id", userId);
  await sb.from("users").delete().eq("id", userId);
  const left = await Promise.all([
    sb.from("reminders").select("id").eq("user_id", userId),
    sb.from("jobs").select("id").eq("user_id", userId),
    sb.from("timeline_items").select("id").eq("user_id", userId),
    sb.from("briefing_notes").select("id").eq("user_id", userId),
  ]);
  for (const r of left) expect(r.data ?? []).toHaveLength(0);
});

describe("step 2: createReminder for each `when` variant", () => {
  it("creates rows + matching reminder_fire jobs", async () => {
    const cases = {
      in: { text: "drink water", when: { type: "in" as const, minutes: 20 } },
      at: { text: "call mom", when: { type: "at" as const, local: `${NOW_DATE}T21:00` } },
      anchored: { text: "pset due in 1h", when: { type: "before_item" as const, itemId: item1, minutesBefore: 60 } },
      recurring: {
        text: "stretch",
        when: { type: "recurring" as const, firstLocal: `${formatLocalDate(addLocalDays(localDateOf(NOW, NY), 1))}T09:00`, freq: "daily" as const, interval: 1 },
      },
    };
    const expectedDue = {
      in: new Date(NOW.getTime() + 20 * MIN),
      at: zonedToUtc({ ...localDateOf(NOW, NY), hour: 21, minute: 0 }, NY).instant,
      anchored: new Date(NOW.getTime() + 4 * H),
      recurring: zonedToUtc({ ...addLocalDays(localDateOf(NOW, NY), 1), hour: 9, minute: 0 }, NY).instant,
    };
    for (const [name, input] of Object.entries(cases) as [keyof typeof cases, (typeof cases)[keyof typeof cases]][]) {
      const r = await createReminder(userId, NY, input, NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      ids[name] = r.reminderId;
      const row = await reminder(r.reminderId);
      expect(row).toMatchObject({ kind: name === "in" || name === "at" ? "absolute" : name, origin: "user", status: "scheduled" });
      expect(new Date(row.due_at ?? "").getTime()).toBe(expectedDue[name].getTime());
      const jobs = await pendingJobs(`reminder:${r.reminderId}`);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: "reminder_fire", user_id: userId, id: row.job_id });
      expect(new Date(jobs[0].run_at).getTime()).toBe(expectedDue[name].getTime());
      expect((jobs[0].payload as { dueAt: string }).dueAt).toBe(expectedDue[name].toISOString());
    }
    expect((await reminder(ids.recurring)).rrule).toMatch(/^DTSTART:\d{8}T090000\nRRULE:FREQ=DAILY$/);
  });

  it("rejects a past time without writing a row", async () => {
    const before = must(await sb.from("reminders").select("id").eq("user_id", userId), "count").length;
    const r = await createReminder(userId, NY, { text: "x", when: { type: "at", local: `${NOW_DATE}T09:00` } }, NOW);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already passed/) });
    expect(must(await sb.from("reminders").select("id").eq("user_id", userId), "count")).toHaveLength(before);
  });

  it("listReminders: user reminders soonest first, anchors attached", async () => {
    const views = await listReminders(userId, NY, { includeAuto: false, limit: 10 });
    expect(views.map((v) => v.id)).toEqual([ids.in, ids.anchored, ids.at, ids.recurring]);
    expect(views[1].anchor).toMatchObject({ itemId: item1, title: "pset 3", course: "SMOKE 101" });
    expect(views[3].recurrence).toBe("every day at 9am");
  });
});

describe("auto nudges (T-3h, ≤36h only, idempotent)", () => {
  it("places one nudge for the item due in 5h and none for the 10-day item", async () => {
    expect(await ensureAutoNudges(userId, NOW)).toBe(1);
    expect(await ensureAutoNudges(userId, NOW)).toBe(0);
    const autos = must(await sb.from("reminders").select("*").eq("user_id", userId).eq("origin", "auto"), "autos");
    expect(autos).toHaveLength(1);
    expect(autos[0]).toMatchObject({ anchor_item_id: item1, offset_minutes: 180, status: "scheduled", kind: "anchored" });
    expect(new Date(autos[0].due_at ?? "").getTime()).toBe(NOW.getTime() + 2 * H);
    ids.auto = autos[0].id;
    expect(await pendingJobs(`reminder:${ids.auto}`)).toHaveLength(1);
  });
});

describe("step 3 (reminder side): due date moves +1 day", () => {
  it("re-times anchored user reminder + auto nudge and their jobs", async () => {
    const newDue = new Date(NOW.getTime() + 5 * H + D);
    must(await sb.from("timeline_items").update({ due_at: newDue.toISOString() }).eq("id", item1).select("id"), "move");
    await recomputeAnchored(userId, item1, newDue, NOW);
    for (const [id, offset] of [[ids.anchored, 60], [ids.auto, 180]] as const) {
      const row = await reminder(id);
      const want = newDue.getTime() - offset * MIN;
      expect(row.status).toBe("scheduled");
      expect(new Date(row.due_at ?? "").getTime()).toBe(want);
      const jobs = await pendingJobs(`reminder:${id}`);
      expect(jobs).toHaveLength(1);
      expect(new Date(jobs[0].run_at).getTime()).toBe(want);
    }
  });

  it("item done → cancelForItem(auto) cancels the nudge and its job only", async () => {
    expect(await cancelForItem(userId, item1, "auto", "done")).toBe(1);
    expect((await reminder(ids.auto)).status).toBe("cancelled");
    expect(await pendingJobs(`reminder:${ids.auto}`)).toHaveLength(0);
    expect((await reminder(ids.anchored)).status).toBe("scheduled");
  });

  it("cancelReminder cancels row + job; a second cancel is refused", async () => {
    expect(await cancelReminder(userId, ids.in)).toEqual({ ok: true });
    expect((await reminder(ids.in)).status).toBe("cancelled");
    expect(await pendingJobs(`reminder:${ids.in}`)).toHaveLength(0);
    expect((await cancelReminder(userId, ids.in)).ok).toBe(false);
    expect((await cancelReminder(randomUUID(), ids.at)).ok).toBe(false); // ownership
  });
});

describe("step 6: briefing scheduling", () => {
  it("scheduleNextBriefing sets next_briefing_at and keeps exactly one pending prepare job", async () => {
    const r = await scheduleNextBriefing(userId, NOW);
    const want = zonedToUtc({ ...addLocalDays(localDateOf(NOW, NY), 1), hour: 8, minute: 0 }, NY).instant;
    expect(r?.at.getTime()).toBe(want.getTime());
    await scheduleNextBriefing(userId, NOW);
    const u = must(await sb.from("users").select("next_briefing_at").eq("id", userId).single(), "user");
    expect(new Date(u.next_briefing_at ?? "").getTime()).toBe(want.getTime());
    const jobs = await pendingJobs(`briefing_prep:${userId}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ targetAt: want.toISOString(), localDate: r?.localDate });
    const lead = want.getTime() - new Date(jobs[0].run_at).getTime();
    expect(lead).toBeGreaterThanOrEqual(10 * MIN);
    expect(lead).toBeLessThanOrEqual(20 * MIN);
  });

  it("skips a local date that was already briefed", async () => {
    const first = await scheduleNextBriefing(userId, NOW);
    must(
      await sb
        .from("briefings")
        .insert({ user_id: userId, local_date: first?.localDate ?? "", status: "sent", target_at: first?.at.toISOString() ?? "" })
        .select("id"),
      "briefing",
    );
    const next = await scheduleNextBriefing(userId, NOW);
    expect(next?.at.getTime()).toBe((first?.at.getTime() ?? 0) + D);
    await sb.from("briefings").delete().eq("user_id", userId);
  });

  it("settings: quiet-hours briefing time is refused; disabling clears the job; the hook runs clean", async () => {
    await expect(updateNotificationSettings(userId, { briefingTime: { hour: 6, minute: 30 } })).rejects.toBeInstanceOf(NotificationSettingsError);
    await updateNotificationSettings(userId, { briefingEnabled: false });
    expect((await getNotificationSettings(userId)).briefingEnabled).toBe(false);
    expect(must(await sb.from("users").select("next_briefing_at").eq("id", userId).single(), "user").next_briefing_at).toBeNull();
    expect(await pendingJobs(`briefing_prep:${userId}`)).toHaveLength(0);
    await updateNotificationSettings(userId, { briefingEnabled: true, nudgeMinutes: [120, 120] });
    expect((await getNotificationSettings(userId)).nudgeMinutes).toEqual([120]);
    await expect(onUserScheduleSettingsChanged(userId, NOW)).resolves.toBeUndefined(); // incl. real rebaseTimeline (2.3)
    expect(await pendingJobs(`briefing_prep:${userId}`)).toHaveLength(1);
  });
});

describe("step 8: reconcile", () => {
  it("recreates a deleted job and fixes a drifted one", async () => {
    const [atJob] = await pendingJobs(`reminder:${ids.at}`);
    must(await sb.from("jobs").delete().eq("id", atJob.id).select("id"), "delete job");
    const [recJob] = await pendingJobs(`reminder:${ids.recurring}`);
    must(await sb.from("jobs").update({ run_at: new Date(NOW.getTime() + 99 * D).toISOString() }).eq("id", recJob.id).select("id"), "drift");
    const { fixed } = await reconcileReminderJobs(userId, NOW);
    expect(fixed).toBeGreaterThanOrEqual(2);
    for (const id of [ids.at, ids.recurring]) {
      const row = await reminder(id);
      const jobs = await pendingJobs(`reminder:${id}`);
      expect(jobs).toHaveLength(1);
      expect(new Date(jobs[0].run_at).getTime()).toBe(new Date(row.due_at ?? "").getTime());
    }
    expect((await reconcileReminderJobs(userId, NOW)).fixed).toBe(0);
  });
});

describe("T5: fireReminder paths", () => {
  it("stale (cancelled) and early jobs are harmless", async () => {
    expect(await fireReminder({ reminderId: ids.in, dueAt: NOW.toISOString() }, NOW)).toEqual({ outcome: "stale" });
    const rec = await reminder(ids.recurring);
    expect(await fireReminder({ reminderId: ids.recurring, dueAt: NOW.toISOString() }, NOW)).toEqual({ outcome: "rescheduled" });
    expect((await reminder(ids.recurring)).due_at).toBe(rec.due_at);
    expect(await pendingJobs(`reminder:${ids.recurring}`)).toHaveLength(1);
  });

  it("recurring fired >30 min late skips to the next occurrence", async () => {
    const rec = await reminder(ids.recurring);
    const due = new Date(rec.due_at ?? "");
    const r = await fireReminder({ reminderId: ids.recurring, dueAt: due.toISOString() }, new Date(due.getTime() + 2 * H));
    expect(r).toEqual({ outcome: "skipped" });
    const after = await reminder(ids.recurring);
    expect(new Date(after.due_at ?? "").getTime()).toBe(due.getTime() + D);
    expect(after).toMatchObject({ status: "scheduled", fire_count: 0 });
  });

  it("one-off >12h late expires with a briefing note", async () => {
    const row = await reminder(ids.at);
    const due = new Date(row.due_at ?? "");
    expect(await fireReminder({ reminderId: ids.at, dueAt: due.toISOString() }, new Date(due.getTime() + 13 * H))).toEqual({ outcome: "expired" });
    expect((await reminder(ids.at)).status).toBe("expired");
    expect(must(await sb.from("briefing_notes").select("kind").eq("user_id", userId).eq("kind", "reminder_expired"), "notes")).toHaveLength(1);
  });

  it("anchored on a removed item → cancelled + reminder_cancelled note", async () => {
    const r = await createReminder(userId, NY, { text: "paper soon", when: { type: "before_item", itemId: item2, minutesBefore: 60 } }, NOW);
    if (!r.ok) throw new Error(r.error);
    must(await sb.from("timeline_items").update({ removed_at: new Date().toISOString() }).eq("id", item2).select("id"), "remove");
    const row = await reminder(r.reminderId);
    expect(await fireReminder({ reminderId: r.reminderId, dueAt: row.due_at ?? "" }, new Date(row.due_at ?? ""))).toEqual({ outcome: "cancelled" });
    expect((await reminder(r.reminderId)).status).toBe("cancelled");
    expect(must(await sb.from("briefing_notes").select("id").eq("user_id", userId).eq("kind", "reminder_cancelled"), "notes")).toHaveLength(1);
  });

  it("user reminder goes out via deliver (requested), once; a replay is a no-op", async () => {
    const now = new Date();
    const r = await createReminder(userId, NY, { text: "smoke: stand up", when: { type: "in", minutes: 1 } }, now);
    if (!r.ok) throw new Error(r.error);
    const due = new Date(now.getTime() + MIN);
    const fired = await fireReminder({ reminderId: r.reminderId, dueAt: due.toISOString() }, due);
    expect(fired).toMatchObject({ outcome: "delivered", delivery: "sent", next: null });
    expect(await reminder(r.reminderId)).toMatchObject({ status: "sent", fire_count: 1 });
    expect(await fireReminder({ reminderId: r.reminderId, dueAt: due.toISOString() }, due)).toEqual({ outcome: "stale" });
    // Even if the row were re-armed for the same instant, deliver's dedupe blocks a second send.
    must(await sb.from("reminders").update({ status: "scheduled" }).eq("id", r.reminderId).select("id"), "rearm");
    expect(await fireReminder({ reminderId: r.reminderId, dueAt: due.toISOString() }, due)).toMatchObject({ delivery: "suppressed" });
    expect((await reminder(r.reminderId)).status).toBe("sent");
  });

  it("auto nudges due within 30 min coalesce into one message", async () => {
    const now = new Date();
    const a = await addItem(new Date(now.getTime() + 3 * H + 5 * MIN), "lab report");
    const b = await addItem(new Date(now.getTime() + 3 * H + 20 * MIN), "quiz prep");
    await updateNotificationSettings(userId, { nudgeMinutes: [180] });
    // Force both nudges due now regardless of quiet hours (placement is unit-tested).
    const rows = [a, b].map((itemId) => ({
      user_id: userId, body: "x", kind: "anchored", origin: "auto", status: "scheduled",
      anchor_item_id: itemId, offset_minutes: 180, due_at: now.toISOString(),
    }));
    await sb.from("reminders").delete().eq("user_id", userId).eq("origin", "auto").in("anchor_item_id", [a, b]);
    const ins = must(await sb.from("reminders").insert(rows).select("id"), "autos");
    const fired = await fireReminder({ reminderId: ins[0].id, dueAt: now.toISOString() }, now);
    expect(fired).toMatchObject({ outcome: "delivered", coalesced: 1 });
    const after = must(await sb.from("reminders").select("status").in("id", ins.map((x) => x.id)), "after");
    for (const r of after) expect(r.status === "sent" || r.status === "expired").toBe(true);
    expect(new Set(after.map((r) => r.status)).size).toBe(1);
  });
});

describe("briefing notes", () => {
  it("dedupes unconsumed notes by key", async () => {
    await addBriefingNote(userId, "other", { text: "x" }, { dedupeKey: "smoke:k" });
    await addBriefingNote(userId, "other", { text: "x" }, { dedupeKey: "smoke:k" });
    await addBriefingNote(userId, "item_removed", { title: "gone" }, { itemId: randomUUID() }); // FK miss → kept unlinked
    expect(must(await sb.from("briefing_notes").select("id").eq("user_id", userId).eq("kind", "other"), "notes")).toHaveLength(1);
    expect(must(await sb.from("briefing_notes").select("item_id").eq("user_id", userId).eq("kind", "item_removed"), "notes")).toEqual([{ item_id: null }]);
  });
});
