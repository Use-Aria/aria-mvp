/**
 * `syncCalendarWindow` against a scripted Google (V2-07 07a-4): the right window and items reach
 * `replaceSourceWindow` (spied at the module boundary), the Aria calendar syncs as `aria`, gone
 * calendars are skipped, a failing calendar aborts the run before any prune, push reuses the
 * stored list, and a missing calendar-list scope falls back to the primary calendar.
 */
import { randomBytes } from "node:crypto";
import { GoogleApiError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { syncCalendarWindow, type CalendarSyncDeps } from "@/server/integrations/google/calendar/sync";
import type { GoogleIntegration } from "@/server/integrations/google/store";
import type { TimelineItemInput } from "@/server/timeline/types";
import { apiError, googleRow, json, MemoryStore, scriptedFetch, type Call } from "./fakes";

const key = randomBytes(32);
const BASE = "https://www.googleapis.com/calendar/v3";
const LIST = `${BASE}/users/me/calendarList`;
const PRIMARY = "student@example.edu";
const CLUB = "club@group.calendar.google.com";
const ARIA = "aria@group.calendar.google.com";
const events = (cal: string) => `${BASE}/calendars/${encodeURIComponent(cal)}/events`;
const NOW = new Date("2026-10-10T15:00:00Z");

const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

interface Replace {
  source: string;
  from: Date;
  to: Date;
  items: TimelineItemInput[];
}

function setup(rowOver: Partial<GoogleIntegration>, routes: Record<string, ((c: Call) => Response)[]>) {
  const row = googleRow(key, { scopes: SCOPES, now: NOW, ...rowOver });
  const store = new MemoryStore(row);
  const { fetch, calls } = scriptedFetch(routes);
  const replaced: Replace[] = [];
  const updates: Partial<GoogleIntegration>[] = [];
  const deps: CalendarSyncDeps = {
    api: { fetch, tokens: { store, key, now: () => NOW }, sleep: async () => undefined },
    now: () => NOW,
    load: async () => row,
    update: async (_id, patch) => {
      updates.push(patch);
    },
    context: async () => ({ tz: "America/New_York", courses: ["CPSC 323"] }),
    replace: async (p) => {
      replaced.push({ source: p.source, from: p.from, to: p.to, items: p.items });
      return { upserted: p.items.length, deleted: 1 };
    },
  };
  return { deps, calls, replaced, updates };
}

const timed = (id: string, summary: string, extra: Record<string, unknown> = {}) => ({
  id,
  summary,
  status: "confirmed",
  start: { dateTime: "2026-10-12T14:00:00Z" },
  end: { dateTime: "2026-10-12T15:00:00Z" },
  organizer: { self: true },
  ...extra,
});

beforeEach(() => {
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("syncCalendarWindow", () => {
  it("reads selected calendars + the Aria calendar and replaces both windows", async () => {
    const t = setup({ gcal_aria_calendar_id: ARIA }, {
      [LIST]: [
        () =>
          json(200, {
            items: [
              { id: PRIMARY, primary: true, selected: true },
              { id: CLUB, selected: true },
              { id: "en.usa#holiday@group.v.calendar.google.com", selected: true },
              { id: ARIA, selected: true },
            ],
          }),
      ],
      [events(PRIMARY)]: [
        () => json(200, { items: [timed("e1", "CPSC 323 lecture"), { id: "bad" /* no start → skipped */ }], nextPageToken: "p2" }),
        () => json(200, { items: [timed("e2", "Dinner", { status: "cancelled" }), timed("e3", "Gym")] }),
      ],
      [events(CLUB)]: [() => json(200, { items: [timed("c1", "Club meeting", { organizer: { self: false } })] })],
      [events(ARIA)]: [() => json(200, { items: [timed("a1", "Study block", { extendedProperties: { private: { aria_key: "k1" } } })] })],
    });

    const r = await syncCalendarWindow("user-1", "periodic", t.deps);
    expect(r).toEqual({ upserted: 4, deleted: 2, calendars: 3 });

    expect(t.replaced.map((x) => x.source)).toEqual(["gcal", "aria"]);
    const [g, a] = t.replaced as [Replace, Replace];
    expect(g.from).toEqual(new Date("2026-10-09T04:00:00Z"));
    expect(g.to).toEqual(new Date("2026-10-25T04:00:00Z"));
    expect(g.items.map((i) => i.externalId)).toEqual([`${PRIMARY}|e1`, `${PRIMARY}|e3`, `${CLUB}|c1`]);
    expect(g.items[0]).toMatchObject({ kind: "class", course: "CPSC 323" });
    expect(g.items[2]?.raw).toMatchObject({ external: true });
    expect(a.items).toEqual([expect.objectContaining({ externalId: `${ARIA}|a1`, kind: "block" })]);

    // The stored list excludes the holiday and Aria calendars; synced_at is stamped.
    expect(t.updates[0]).toEqual({ gcal_calendar_ids: [PRIMARY, CLUB] });
    expect(t.updates.at(-1)).toEqual({ synced_at: NOW.toISOString() });

    // Request shape: expanded instances, the window, the field mask without description, page 2 token.
    const first = new URL((t.calls.find((c) => c.url.startsWith(events(PRIMARY))) as Call).url);
    expect(first.searchParams.get("singleEvents")).toBe("true");
    expect(first.searchParams.get("timeMin")).toBe("2026-10-09T04:00:00.000Z");
    expect(first.searchParams.get("timeMax")).toBe("2026-10-25T04:00:00.000Z");
    expect(first.searchParams.get("fields")).not.toContain("description");
    expect(t.calls.some((c) => new URL(c.url).searchParams.get("pageToken") === "p2")).toBe(true);
    expect(t.calls.every((c) => c.auth === "Bearer at-old")).toBe(true);
  });

  it("push reuses the stored calendar list (no calendarList call)", async () => {
    const t = setup({ gcal_calendar_ids: [PRIMARY] }, {
      [events(PRIMARY)]: [() => json(200, { items: [timed("e1", "Gym")] })],
    });
    await syncCalendarWindow("user-1", "push", t.deps);
    expect(t.calls.some((c) => c.url.startsWith(LIST))).toBe(false);
    expect(t.replaced).toHaveLength(1);
  });

  it("a gone calendar (404) is skipped and its rows pruned; the Aria calendar 404 → empty aria window", async () => {
    const t = setup({ gcal_calendar_ids: [PRIMARY, CLUB], gcal_aria_calendar_id: ARIA }, {
      [events(PRIMARY)]: [() => json(200, { items: [timed("e1", "Gym")] })],
      [events(CLUB)]: [() => apiError(404, "notFound")],
      [events(ARIA)]: [() => apiError(410, "deleted")],
    });
    const r = await syncCalendarWindow("user-1", "push", t.deps);
    expect(r.calendars).toBe(1);
    expect(t.replaced.map((x) => [x.source, x.items.length])).toEqual([
      ["gcal", 1],
      ["aria", 0],
    ]);
  });

  it("any other calendar failure aborts before anything is pruned", async () => {
    const t = setup({ gcal_calendar_ids: [PRIMARY, CLUB] }, {
      [events(PRIMARY)]: [() => json(200, { items: [timed("e1", "Gym")] })],
      [events(CLUB)]: [() => apiError(400, "badRequest")],
    });
    await expect(syncCalendarWindow("user-1", "push", t.deps)).rejects.toBeInstanceOf(GoogleApiError);
    expect(t.replaced).toEqual([]);
  });

  it("without the calendar-list scope (403) it falls back to the primary calendar", async () => {
    const t = setup({}, {
      [LIST]: [() => apiError(403, "insufficientPermissions")],
      [events(PRIMARY)]: [() => json(200, { items: [] })],
    });
    await syncCalendarWindow("user-1", "connect", t.deps);
    expect(t.updates[0]).toEqual({ gcal_calendar_ids: [PRIMARY] });
    expect(t.replaced).toHaveLength(1);
  });

  it("inactive integration or no calendar scope → GoogleNotConnectedError, nothing fetched", async () => {
    for (const over of [{ status: "revoked" }, { scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"] }]) {
      const t = setup(over, {});
      await expect(syncCalendarWindow("user-1", "periodic", t.deps)).rejects.toBeInstanceOf(GoogleNotConnectedError);
      expect(t.calls).toEqual([]);
    }
  });
});
