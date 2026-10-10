/**
 * /setup schedule + tone + time zone actions and /week data + mark done (task 4.4; web W4 + W7),
 * against the LOCAL Supabase stack by default (`SMOKE_TARGET=env` for the env project).
 *
 * The real server actions run end to end (guard → DB → hook). Only the Next request context is
 * faked: `next/headers` serves an Origin header and the session cookie, `next/cache.refresh` is a
 * spy. The schedule hook is the real `onUserScheduleSettingsChanged`, wrapped in a spy.
 *
 * 1. Schedule save persists to `users`, calls the hook once (→ `next_briefing_at` + one
 *    `briefing_prepare` job), a double submit is a no-op, "off" clears the briefing, off-list
 *    values are refused, guard codes (bad_origin / signed_out) come back typed.
 * 2. Tone save merges into `persona_prefs` (other keys kept); a bad tone → invalid.
 * 3. Time zone save canonicalizes, sets `timezone_source='user'`, calls the hook; abbreviations refused.
 * 4. `getWeekView`: today+6 window in the user's zone, all-day item on its floating date, "still
 *    open" tail, done items, `?w=1`.
 * 5. `setItemStatusAction` goes through `setTimelineItemStatus`: done/undo persist, idempotent,
 *    another user's item → not_found (untouched), bad id → invalid.
 *
 * Every throwaway row (users cascade sessions + timeline; jobs by user) is deleted in afterAll.
 * The global `runDueJobs` is never called.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types";

// ── Target selection (before any server module calls db()) ─────────────────
function localTarget(): { url: string; serviceKey: string } {
  let out = "";
  try {
    out = execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
  if (!json) throw new Error("local Supabase stack not running (`supabase start`), or set SMOKE_TARGET=env");
  const s = JSON.parse(json) as Record<string, string>;
  return { url: s.API_URL as string, serviceKey: s.SERVICE_ROLE_KEY as string };
}
function envTarget(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SMOKE_TARGET=env needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  return { url, serviceKey };
}
const target = process.env.SMOKE_TARGET === "env" ? envTarget() : localTarget();
process.env.NEXT_PUBLIC_SUPABASE_URL = target.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = target.serviceKey;
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.SESSION_SECRET = `smoke-${randomUUID()}`;
process.env.APP_BASE_URL = "http://localhost:3000";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.CHANNEL_PROVIDER = "dev";

// ── Fake Next request context ───────────────────────────────────────────────
const request: { origin: string | null; cookie: string | null } = { origin: null, cookie: null };

jest.mock("next/headers", () => ({
  headers: async () => {
    const h = new Headers();
    if (request.origin) h.set("origin", request.origin);
    return h;
  },
  cookies: async () => ({
    get: (name: string) => {
      // Lazy require: SESSION_COOKIE depends on NODE_ENV only.
      const { SESSION_COOKIE: cookieName } = jest.requireActual<typeof import("@/server/security/sessions")>(
        "@/server/security/sessions",
      );
      return name === cookieName && request.cookie ? { name, value: request.cookie } : undefined;
    },
  }),
}));

jest.mock("next/cache", () => ({ refresh: jest.fn() }));

jest.mock("@/server/briefing/scheduler", () => {
  const actual = jest.requireActual<typeof import("@/server/briefing/scheduler")>("@/server/briefing/scheduler");
  return {
    ...actual,
    onUserScheduleSettingsChanged: jest.fn((userId: string, now?: Date) => actual.onUserScheduleSettingsChanged(userId, now)),
  };
});

import { refresh } from "next/cache";
import { saveScheduleAction, saveTimezoneAction, saveToneAction } from "@/app/(app)/setup/actions";
import { setItemStatusAction } from "@/app/(app)/week/actions";
import { briefingPrepKey, onUserScheduleSettingsChanged } from "@/server/briefing/scheduler";
import { createSession } from "@/server/security/sessions";
import { upsertTimelineItem } from "@/server/timeline";
import type { Viewer } from "@/server/viewer";
import { getWeekView } from "@/server/web/week-data";
import type { ActionResult } from "@/shared/action-result";
import { addLocalDays, formatLocalDate, localDateOf, zonedToUtc, type LocalDate } from "@/shared/time/tz";

type Sb = SupabaseClient<Database>;
const sb: Sb = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ORIGIN = "http://localhost:3000";
const hook = onUserScheduleSettingsChanged as jest.MockedFunction<typeof onUserScheduleSettingsChanged>;
const refreshSpy = refresh as jest.MockedFunction<typeof refresh>;

let userId = "";
let otherUserId = "";
let viewRaw = "";

function must<T>(res: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (res.error || res.data === null || res.data === undefined) throw new Error(`${what}: ${res.error?.message ?? "no data"}`);
  return res.data as NonNullable<T>;
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function signedIn(): void {
  request.origin = ORIGIN;
  request.cookie = viewRaw;
}

async function userRow() {
  return must(
    await sb
      .from("users")
      .select("briefing_time, briefing_enabled, quiet_start, quiet_end, timezone, timezone_source, persona_prefs, next_briefing_at")
      .eq("id", userId)
      .single(),
    "user row",
  );
}

async function prepJobs() {
  return must(
    await sb
      .from("jobs")
      .select("id, run_at, status")
      .eq("user_id", userId)
      .eq("kind", "briefing_prepare")
      .eq("dedupe_key", briefingPrepKey(userId))
      .in("status", ["pending", "running"]),
    "prep jobs",
  );
}

beforeAll(async () => {
  const u = must(
    await sb
      .from("users")
      .insert({
        name: "smoke schedule",
        timezone: "America/New_York",
        briefing_time: "08:00",
        quiet_start: "22:00",
        quiet_end: "08:00",
        persona_prefs: { tone: "mirror", keep_me: "yes" },
      })
      .select("id")
      .single(),
    "user",
  );
  userId = u.id;
  const o = must(await sb.from("users").insert({ name: "smoke schedule other" }).select("id").single(), "other user");
  otherUserId = o.id;
  viewRaw = (await createSession(userId, "view")).value;
});

afterAll(async () => {
  for (const id of [userId, otherUserId].filter(Boolean)) {
    await sb.from("jobs").delete().eq("user_id", id);
    await sb.from("users").delete().eq("id", id);
  }
  const left = await Promise.all(
    [userId, otherUserId].filter(Boolean).flatMap((id) => [
      sb.from("jobs").select("id").eq("user_id", id),
      sb.from("timeline_items").select("id").eq("user_id", id),
      sb.from("web_sessions").select("user_id").eq("user_id", id),
    ]),
  );
  for (const r of left) expect(r.data ?? []).toHaveLength(0);
});

beforeEach(() => {
  hook.mockClear();
  refreshSpy.mockClear();
  signedIn();
});

describe("1. saveScheduleAction", () => {
  it("persists briefing + quiet hours, then runs the schedule hook", async () => {
    const res = await saveScheduleAction(null, form({ briefing: "09:30", quietStart: "23:00", quietEnd: "07:00" }));
    expect(res).toEqual({ ok: true, data: undefined });
    const row = await userRow();
    expect(row.briefing_time.slice(0, 5)).toBe("09:30");
    expect(row.briefing_enabled).toBe(true);
    expect(row.quiet_start.slice(0, 5)).toBe("23:00");
    expect(row.quiet_end.slice(0, 5)).toBe("07:00");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(userId);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // The real hook ran: next briefing computed and exactly one prepare job queued.
    expect(row.next_briefing_at).not.toBeNull();
    const at = new Date(row.next_briefing_at as string);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    expect(local).toBe("09:30");
    expect(await prepJobs()).toHaveLength(1);
  });

  it("is a no-op on a double submit (no second hook call)", async () => {
    const res = await saveScheduleAction(null, form({ briefing: "09:30", quietStart: "23:00", quietEnd: "07:00" }));
    expect(res.ok).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    expect(await prepJobs()).toHaveLength(1);
  });

  it("accepts a briefing inside quiet hours (sent at quiet end)", async () => {
    const res = await saveScheduleAction(null, form({ briefing: "07:00", quietStart: "22:00", quietEnd: "09:00" }));
    expect(res.ok).toBe(true);
    const row = await userRow();
    const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
      new Date(row.next_briefing_at as string),
    );
    expect(local).toBe("09:00");
  });

  it("turns the briefing off: no next briefing, no prepare job, time kept", async () => {
    const res = await saveScheduleAction(null, form({ briefing: "off", quietStart: "22:00", quietEnd: "09:00" }));
    expect(res.ok).toBe(true);
    const row = await userRow();
    expect(row.briefing_enabled).toBe(false);
    expect(row.briefing_time.slice(0, 5)).toBe("07:00");
    expect(row.next_briefing_at).toBeNull();
    expect(await prepJobs()).toHaveLength(0);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("refuses values that aren't offered (unless already stored)", async () => {
    expect(await saveScheduleAction(null, form({ briefing: "05:00", quietStart: "22:00", quietEnd: "09:00" }))).toEqual({ ok: false, code: "invalid" });
    expect(await saveScheduleAction(null, form({ briefing: "08:00", quietStart: "20:00", quietEnd: "09:00" }))).toEqual({ ok: false, code: "invalid" });
    expect(await saveScheduleAction(null, form({ briefing: "08:00" }))).toEqual({ ok: false, code: "invalid" });
    // A stored off-list value (set in chat) saves unchanged.
    must(await sb.from("users").update({ briefing_time: "06:30", briefing_enabled: true }).eq("id", userId).select("id"), "seed 06:30");
    expect((await saveScheduleAction(null, form({ briefing: "06:30", quietStart: "22:00", quietEnd: "09:00" }))).ok).toBe(true);
    expect(hook).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("returns typed guard codes and writes nothing", async () => {
    const before = await userRow();
    const attempt = () => saveScheduleAction(null, form({ briefing: "10:00", quietStart: "22:00", quietEnd: "09:00" }));
    request.origin = null;
    expect(await attempt()).toEqual({ ok: false, code: "bad_origin" });
    request.origin = "https://evil.example";
    expect(await attempt()).toEqual({ ok: false, code: "bad_origin" });
    request.origin = ORIGIN;
    request.cookie = null;
    expect(await attempt()).toEqual({ ok: false, code: "signed_out" });
    request.cookie = "not-a-real-session";
    expect(await attempt()).toEqual({ ok: false, code: "signed_out" });
    expect((await userRow()).briefing_time).toBe(before.briefing_time);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("2. saveToneAction", () => {
  it("merges the tone into persona_prefs, keeping other keys", async () => {
    expect((await saveToneAction(null, form({ tone: "polished" }))).ok).toBe(true);
    expect((await userRow()).persona_prefs).toEqual({ tone: "polished", keep_me: "yes" });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown tone", async () => {
    expect(await saveToneAction(null, form({ tone: "sarcastic" }))).toEqual({ ok: false, code: "invalid" });
    expect(await saveToneAction(null, form({}))).toEqual({ ok: false, code: "invalid" });
    expect(((await userRow()).persona_prefs as { tone: string }).tone).toBe("polished");
  });
});

describe("3. saveTimezoneAction", () => {
  it("refuses abbreviations and garbage", async () => {
    for (const tz of ["EST", "PST", "Not/AZone", "", "../../etc"]) {
      expect(await saveTimezoneAction(null, form({ timezone: tz }))).toEqual({ ok: false, code: "invalid" });
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it("saves the phone's zone with timezone_source=user and runs the hook", async () => {
    expect(await saveTimezoneAction(null, form({ timezone: "America/Los_Angeles" }))).toEqual({ ok: true, data: undefined });
    const row = await userRow();
    expect(row.timezone).toBe("America/Los_Angeles");
    expect(row.timezone_source).toBe("user");
    expect(hook).toHaveBeenCalledTimes(1);
    // Same zone again → no-op.
    hook.mockClear();
    expect((await saveTimezoneAction(null, form({ timezone: "America/Los_Angeles" }))).ok).toBe(true);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("4–5. /week data and mark done", () => {
  const TZ = "America/Los_Angeles";
  let today: LocalDate;
  const ids: Record<string, string> = {};

  function at(d: LocalDate, hour: number, minute: number): Date {
    return zonedToUtc({ ...d, hour, minute }, TZ).instant;
  }
  function key(d: LocalDate): string {
    return formatLocalDate(d);
  }
  function viewer(): Viewer {
    return { session: { userId, scope: "view", createdAt: new Date() }, userId, name: "smoke", timezone: TZ, school: null };
  }

  beforeAll(async () => {
    today = localDateOf(new Date(), TZ);
    const plus = (n: number) => addLocalDays(today, n);
    const up = async (name: string, source: "canvas" | "gcal" | "aria", input: Parameters<typeof upsertTimelineItem>[2]) => {
      ids[name] = (await upsertTimelineItem(userId, source, input)).id;
    };
    await up("pset", "canvas", {
      externalId: "smoke-week-pset",
      kind: "assignment",
      title: "Pset <b>4</b>",
      course: "CPSC 323",
      dueAt: at(plus(1), 23, 59),
      url: "https://yale.instructure.com/courses/1/assignments/2",
    });
    // All-day exam on today+2 whose stored anchor (04:00Z that day) is the previous LA evening.
    const d2 = plus(2);
    await up("midterm", "canvas", {
      externalId: "smoke-week-midterm",
      kind: "exam",
      title: "Midterm",
      allDay: true,
      dueAt: new Date(Date.UTC(d2.year, d2.month - 1, d2.day, 4, 0)),
      timingKey: `D:${key(d2).replace(/-/g, "")}`,
    });
    await up("overdue", "canvas", { externalId: "smoke-week-overdue", kind: "assignment", title: "Late lab", dueAt: at(plus(-3), 17, 0) });
    await up("olddone", "canvas", { externalId: "smoke-week-olddone", kind: "assignment", title: "Old done", dueAt: at(plus(-2), 17, 0) });
    await up("lecture", "gcal", {
      externalId: "smoke-week-lecture",
      kind: "class",
      title: "Lecture",
      startsAt: at(plus(1), 10, 0),
      endsAt: at(plus(1), 11, 15),
      url: "https://www.google.com/calendar/event?eid=abc",
    });
    await up("later", "aria", { externalId: "smoke-week-later", kind: "assignment", title: "Next week thing", dueAt: at(plus(9), 12, 0) });
    must(await sb.from("timeline_items").update({ status: "done" }).eq("id", ids.olddone).select("id"), "olddone");
    const other = await upsertTimelineItem(otherUserId, "aria", {
      externalId: "smoke-week-other",
      kind: "assignment",
      title: "Not yours",
      dueAt: at(plus(1), 12, 0),
    });
    ids.other = other.id;
  });

  it("groups the rolling week in the user's zone, with the all-day item on its floating date", async () => {
    const v = await getWeekView(viewer(), { offsetWeeks: 0 });
    expect(v.timeZone).toBe(TZ);
    expect(v.week.days.map((d) => d.key)).toEqual(Array.from({ length: 7 }, (_, i) => key(addLocalDays(today, i))));
    expect(v.week.days[0].label).toBe("Today");
    expect(v.week.days[1].label).toBe("Tomorrow");

    const day1 = v.week.days[1];
    expect(day1.deadlines.map((i) => i.id)).toEqual([ids.pset]);
    expect(day1.deadlines[0].title).toBe("Pset <b>4</b>");
    expect(day1.schedule.map((i) => i.id)).toEqual([ids.lecture]);

    const day2 = v.week.days[2];
    expect(day2.deadlines.map((i) => i.id)).toEqual([ids.midterm]);
    expect(day2.deadlines[0].allDay).toBe(true);
    expect(day2.deadlines[0].allDayDate).toBe(key(addLocalDays(today, 2)));
    expect(day2.load).toBe("busy"); // exam = 2 points

    expect(v.week.stillOpen.map((i) => i.id)).toEqual([ids.overdue]);
    const all = [...v.week.stillOpen, ...v.week.days.flatMap((d) => [...d.deadlines, ...d.schedule])].map((i) => i.id);
    expect(all).not.toContain(ids.olddone);
    expect(all).not.toContain(ids.later);
    expect(all).not.toContain(ids.other);
    expect(v.week.dueCount).toBe(2);
    expect(v.canvas.connected).toBe(false);
    expect(v.googleConnected).toBe(false);
    expect(v.allowHosts).toContain("*.instructure.com");
  });

  it("shows the following 7 days for ?w=1 (no still-open tail)", async () => {
    const v = await getWeekView(viewer(), { offsetWeeks: 1 });
    expect(v.week.days[0].key).toBe(key(addLocalDays(today, 7)));
    expect(v.week.days[2].deadlines.map((i) => i.id)).toEqual([ids.later]);
    expect(v.week.stillOpen).toEqual([]);
  });

  it("marks done and undoes through setTimelineItemStatus (idempotent)", async () => {
    const status = async (id: string) => must(await sb.from("timeline_items").select("status").eq("id", id).single(), "status").status;
    expect(await setItemStatusAction(ids.pset, true)).toEqual({ ok: true, data: undefined });
    expect(await status(ids.pset)).toBe("done");
    expect((await setItemStatusAction(ids.pset, true)).ok).toBe(true); // double tap
    expect(await status(ids.pset)).toBe("done");
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    const v = await getWeekView(viewer(), { offsetWeeks: 0 });
    expect(v.week.days[1].deadlines[0].status).toBe("done");
    expect(v.week.dueCount).toBe(1);

    expect((await setItemStatusAction(ids.pset, false)).ok).toBe(true);
    expect(await status(ids.pset)).toBe("upcoming");
  });

  it("refuses another user's item, unknown ids, and bad input", async () => {
    const r1: ActionResult = await setItemStatusAction(ids.other, true);
    expect(r1).toEqual({ ok: false, code: "not_found" });
    expect(must(await sb.from("timeline_items").select("status").eq("id", ids.other).single(), "other").status).toBe("upcoming");
    expect(await setItemStatusAction(randomUUID(), true)).toEqual({ ok: false, code: "not_found" });
    expect(await setItemStatusAction("not-a-uuid", true)).toEqual({ ok: false, code: "invalid" });
    expect(refreshSpy).not.toHaveBeenCalled();
    request.origin = "https://evil.example";
    expect(await setItemStatusAction(ids.pset, true)).toEqual({ ok: false, code: "bad_origin" });
  });
});
