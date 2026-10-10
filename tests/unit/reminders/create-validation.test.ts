/**
 * src/server/reminders/service.ts `resolveWhen` (pure part of createReminder, V2-06 §10):
 * "in", "at" (gap shift, past, offset ISO), "before_item", recurring validation.
 */
import { resolveWhen, type AnchorInfo } from "@/server/reminders/service";

const NY = "America/New_York";
const NOW = new Date("2026-10-12T16:00:00Z"); // Mon 12:00 EDT
const ITEM = "11111111-2222-4333-8444-555555555555";
const anchor = (iso: string | null, status = "upcoming", removed = false): AnchorInfo => ({
  itemId: ITEM,
  anchorAt: iso ? new Date(iso) : null,
  status,
  removed,
});

describe("resolveWhen", () => {
  it("in: now + minutes, absolute", () => {
    const r = resolveWhen({ type: "in", minutes: 20 }, NY, NOW);
    expect(r).toEqual({ ok: true, kind: "absolute", dueAt: new Date("2026-10-12T16:20:00Z") });
  });

  it("at: local wall time in the user's zone", () => {
    const r = resolveWhen({ type: "at", local: "2026-10-13T21:00" }, NY, NOW);
    expect(r).toEqual({ ok: true, kind: "absolute", dueAt: new Date("2026-10-14T01:00:00Z") });
  });

  it("at: a time in the spring-forward gap is shifted forward and reported", () => {
    const r = resolveWhen({ type: "at", local: "2027-03-14T02:30" }, NY, NOW);
    expect(r).toMatchObject({ ok: true, kind: "absolute", adjusted: "gap_shifted" });
    if (r.ok) expect(r.dueAt.toISOString()).toBe("2027-03-14T07:30:00.000Z"); // 03:30 EDT
  });

  it("at: a past time is an error that names the current time", () => {
    const r = resolveWhen({ type: "at", local: "2026-10-12T09:00" }, NY, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already passed.*Mon Oct 12, 12:00 PM EDT/);
  });

  it("at: an ISO string with an offset is accepted as an instant", () => {
    const r = resolveWhen({ type: "at", local: "2026-10-13T21:00:00-05:00" }, NY, NOW);
    expect(r).toEqual({ ok: true, kind: "absolute", dueAt: new Date("2026-10-14T02:00:00Z") });
  });

  it("at: garbage and > 1 year out are errors", () => {
    expect(resolveWhen({ type: "at", local: "tomorrow 9" }, NY, NOW).ok).toBe(false);
    expect(resolveWhen({ type: "at", local: "2027-11-01T09:00" }, NY, NOW).ok).toBe(false);
  });

  it("before_item: anchor − minutes, anchored", () => {
    const r = resolveWhen({ type: "before_item", itemId: ITEM, minutesBefore: 120 }, NY, NOW, anchor("2026-10-13T03:59:00Z"));
    expect(r).toEqual({ ok: true, kind: "anchored", dueAt: new Date("2026-10-13T01:59:00Z"), anchorItemId: ITEM, offsetMinutes: 120 });
  });

  it("before_item: already-passed fire time names the due time", () => {
    const r = resolveWhen({ type: "before_item", itemId: ITEM, minutesBefore: 180 }, NY, NOW, anchor("2026-10-12T18:00:00Z"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already passed: it's due Mon Oct 12, 2:00 PM EDT/);
  });

  it("before_item: unknown / done / removed / past / no due time", () => {
    expect(resolveWhen({ type: "before_item", itemId: ITEM, minutesBefore: 60 }, NY, NOW, null).ok).toBe(false);
    expect(resolveWhen({ type: "before_item", itemId: ITEM, minutesBefore: 60 }, NY, NOW, anchor("2026-10-14T00:00:00Z", "done")).ok).toBe(false);
    expect(resolveWhen({ type: "before_item", itemId: ITEM, minutesBefore: 60 }, NY, NOW, anchor("2026-10-14T00:00:00Z", "upcoming", true)).ok).toBe(false);
    expect(resolveWhen({ type: "before_item", itemId: ITEM, minutesBefore: 0 }, NY, NOW, anchor("2026-10-12T10:00:00Z")).ok).toBe(false);
    expect(resolveWhen({ type: "before_item", itemId: ITEM, minutesBefore: 60 }, NY, NOW, anchor(null)).ok).toBe(false);
  });

  it("recurring: weekdays 8:30 → first occurrence tomorrow, serialized + described", () => {
    const r = resolveWhen(
      { type: "recurring", firstLocal: "2026-10-12T08:30", freq: "weekly", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] },
      NY,
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "recurring") {
      expect(r.dueAt.toISOString()).toBe("2026-10-13T12:30:00.000Z");
      expect(r.rrule).toBe("DTSTART:20261012T083000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
      expect(r.recurrence).toBe("every weekday at 8:30am");
    }
  });

  it("recurring: until + count together is an error", () => {
    const r = resolveWhen(
      { type: "recurring", firstLocal: "2026-10-13T09:00", freq: "daily", interval: 1, until: "2026-12-01", count: 3 },
      NY,
      NOW,
    );
    expect(r).toEqual({ ok: false, error: "use either count or until, not both" });
  });

  it("recurring: exhausted / unsupported shapes are errors", () => {
    expect(resolveWhen({ type: "recurring", firstLocal: "2026-10-01T09:00", freq: "daily", interval: 1, count: 2 }, NY, NOW).ok).toBe(false);
    expect(resolveWhen({ type: "recurring", firstLocal: "2026-10-13T09:00", freq: "monthly", interval: 1, byDay: ["MO"] }, NY, NOW).ok).toBe(false);
    expect(resolveWhen({ type: "recurring", firstLocal: "2026-10-13T09:00", freq: "daily", interval: 1, until: "2026-02-30" }, NY, NOW).ok).toBe(false);
  });
});
