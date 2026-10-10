import { diffIncremental, diffSnapshot, normalizeInput, rebaseInstants } from "@/server/timeline/diff";
import type { TimelineItem, TimelineItemInput } from "@/server/timeline/types";
import { at, DAY, input, NOW, row } from "./helpers";

const OFF = { enabled: false, deferredLastTime: false };
const ON = { enabled: true, deferredLastTime: false };

function snap(current: TimelineItem[], fresh: TimelineItemInput[], extra: Partial<Parameters<typeof diffSnapshot>[0]> = {}) {
  return diffSnapshot({ current, fresh, now: NOW, scope: {}, removalGuard: OFF, ...extra });
}

describe("normalizeInput", () => {
  it("applies defaults: allDay false, timingKey = ISO anchor, nulls", () => {
    const n = normalizeInput({ externalId: "x", kind: "event", title: "T", startsAt: at(1) });
    expect(n).toMatchObject({ allDay: false, course: null, url: null, matchKey: null, raw: null, dueAt: null, endsAt: null });
    expect(n.timingKey).toBe(at(1).toISOString());
    expect(normalizeInput({ externalId: "y", kind: "event", title: "T" }).timingKey).toBeNull();
  });
});

describe("diffSnapshot", () => {
  it("created / silent update / unchanged", () => {
    const a = row({ externalId: "event-assignment-1" });
    const b = row({ externalId: "event-assignment-2" });
    const d = snap([a, b], [
      input(a),
      input(b, { title: "Pset 5 (renamed)", course: "CPSC 323 02 (FA26)" }),
      { externalId: "event-assignment-3", kind: "assignment", title: "New", dueAt: at(100) },
    ]);
    expect(d.stats).toMatchObject({ created: 1, updated: 1, unchanged: 1, dueChanged: 0, removed: 0 });
    expect(d.planned.map((p) => [p.externalId, p.kind])).toEqual([["event-assignment-3", "created"]]);
    expect(d.upserts.map((u) => u.externalId).sort()).toEqual(["event-assignment-2", "event-assignment-3"]);
  });

  it("due_changed is detected via timing_key", () => {
    const a = row({ externalId: "e1", timingKey: "U:20261016T035900Z" });
    const d = snap([a], [input(a, { dueAt: at(72), timingKey: "U:20261017T035900Z" })]);
    expect(d.stats.dueChanged).toBe(1);
    expect(d.planned[0]).toMatchObject({ kind: "due_changed", existingId: a.id, oldAnchor: a.anchorAt, newAnchor: at(72) });
  });

  it("timezone change (same timing key, new instant) → silent upsert, no change", () => {
    const a = row({ externalId: "e1", allDay: true, timingKey: "D:20261015", dueAt: new Date("2026-10-16T03:59:00Z") });
    const d = snap([a], [input(a, { dueAt: new Date("2026-10-16T06:59:00Z") })]);
    expect(d.stats).toMatchObject({ updated: 1, dueChanged: 0 });
    expect(d.planned).toEqual([]);
    expect(d.upserts).toHaveLength(1);
  });

  it("raw dtstamp churn alone is not an update", () => {
    const a = row({ externalId: "e1", raw: { uid: "e1", dtstamp: "20261014T000000Z" } });
    const d = snap([a], [input(a, { raw: { uid: "e1", dtstamp: "20261014T010000Z" } })]);
    expect(d.stats.unchanged).toBe(1);
    expect(d.upserts).toEqual([]);
  });

  it("override rekey → one rekey + due_changed on the same row id", () => {
    const a = row({ externalId: "event-assignment-412345", matchKey: "assignment_412345", timingKey: "U:20261016T035900Z" });
    const fresh: TimelineItemInput = {
      ...input(a),
      externalId: "event-assignment-override-99",
      dueAt: at(96),
      timingKey: "U:20261018T035900Z",
    };
    const d = snap([a], [fresh]);
    expect(d.rekeys).toEqual([{ id: a.id, newExternalId: "event-assignment-override-99" }]);
    expect(d.removeIds).toEqual([]);
    expect(d.stats).toMatchObject({ rekeyed: 1, dueChanged: 1, created: 0, removed: 0 });
    expect(d.planned).toEqual([
      expect.objectContaining({ kind: "due_changed", rekeyed: true, existingId: a.id, externalId: "event-assignment-override-99" }),
    ]);
  });

  it("rekey keeps done status in the planned change", () => {
    const a = row({ externalId: "old", matchKey: "assignment_1", status: "done" });
    const d = snap([a], [{ ...input(a), externalId: "new", timingKey: "X", dueAt: at(5) }]);
    expect(d.planned[0]).toMatchObject({ status: "done", rekeyed: true });
  });

  it("non-1:1 match keys (sub-assignments / two fresh) → remove + create", () => {
    const a = row({ externalId: "event-sub_assignment-1", matchKey: null });
    const d1 = snap([a], [{ externalId: "event-sub_assignment-2", kind: "assignment", title: "Part B", dueAt: at(50) }]);
    expect(d1.rekeys).toEqual([]);
    expect(d1.stats).toMatchObject({ created: 1, removed: 1 });

    const b = row({ externalId: "old", matchKey: "assignment_7" });
    const d2 = snap([b], [
      { externalId: "o1", kind: "assignment", title: "A", dueAt: at(50), matchKey: "assignment_7" },
      { externalId: "o2", kind: "assignment", title: "A", dueAt: at(60), matchKey: "assignment_7" },
    ]);
    expect(d2.rekeys).toEqual([]);
    expect(d2.stats).toMatchObject({ created: 2, removed: 1 });
  });

  it("rekey is blocked when the new UID exists as a removed row (restore + remove instead)", () => {
    const live = row({ externalId: "old", matchKey: "assignment_9" });
    const gone = row({ externalId: "new", matchKey: "assignment_9", removedAt: at(-48) });
    const d = snap([live, gone], [{ ...input(gone), removedAt: undefined } as TimelineItemInput]);
    expect(d.rekeys).toEqual([]);
    expect(d.stats).toMatchObject({ restored: 1, removed: 1, rekeyed: 0 });
    expect(d.planned.find((p) => p.kind === "created")).toMatchObject({ restored: true, existingId: gone.id });
  });

  it("restored → created + restored, keeps done", () => {
    const gone = row({ externalId: "e1", removedAt: at(-2), status: "done" });
    const d = snap([gone], [input(gone)]);
    expect(d.planned).toEqual([expect.objectContaining({ kind: "created", restored: true, status: "done" })]);
    expect(d.stats.restored).toBe(1);
  });

  it("a 40-day-old missing item is not removed; a 10-day-old one is", () => {
    const old = row({ externalId: "old", dueAt: new Date(NOW.getTime() - 40 * DAY) });
    const recent = row({ externalId: "recent", dueAt: new Date(NOW.getTime() - 10 * DAY) });
    const d = snap([old, recent], []);
    expect(d.removeIds).toEqual([recent.id]);
  });

  it("explicit window is half-open [start, end)", () => {
    const inside = row({ externalId: "in", dueAt: at(1) });
    const edge = row({ externalId: "edge", dueAt: at(24) });
    const d = snap([inside, edge], [], { scope: { windowStart: NOW, windowEnd: at(24) } });
    expect(d.removeIds).toEqual([inside.id]);
  });

  it("mass-removal guard defers, then applies on the next sync", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ externalId: `e${i}`, dueAt: at(24 * (i + 1)) }));
    const keep = rows.slice(0, 3).map((r) => input(r));
    const d1 = snap(rows, keep, { removalGuard: ON });
    expect(d1.removalsDeferred).toBe(true);
    expect(d1.removeIds).toEqual([]);
    expect(d1.stats.removalsDeferred).toBe(7);
    const d2 = snap(rows, keep, { removalGuard: { enabled: true, deferredLastTime: true } });
    expect(d2.removalsDeferred).toBe(false);
    expect(d2.removeIds).toHaveLength(7);
  });

  it("guard does not trigger for ≤ 5 removals or ≤ 50%", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ externalId: `e${i}`, dueAt: at(24 * (i + 1)) }));
    expect(snap(rows, [input(rows[0])], { removalGuard: ON }).removeIds).toHaveLength(5); // 5 is not > 5
    const many = Array.from({ length: 20 }, (_, i) => row({ externalId: `m${i}`, dueAt: at(24 * (i + 1)) }));
    expect(snap(many, many.slice(0, 10).map((r) => input(r)), { removalGuard: ON }).removeIds).toHaveLength(10); // 50% is not > 50%
  });

  it("an empty feed trips the guard", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row({ externalId: `e${i}`, dueAt: at(24 * (i + 1)) }));
    expect(snap(rows, [], { removalGuard: ON }).removalsDeferred).toBe(true);
  });

  it("cap-saturated kinds → no removals of that kind", () => {
    const a = row({ externalId: "a", kind: "assignment" });
    const e = row({ externalId: "e", kind: "event", dueAt: null, startsAt: at(5) });
    const d = snap([a, e], [], { capSaturatedKinds: ["assignment"] });
    expect(d.removeIds).toEqual([e.id]);
  });

  it("initial sync (empty current) → all created", () => {
    const d = snap([], [
      { externalId: "a", kind: "assignment", title: "A", dueAt: at(5) },
      { externalId: "b", kind: "event", title: "B", startsAt: at(6) },
    ]);
    expect(d.planned.map((p) => p.kind)).toEqual(["created", "created"]);
    expect(d.stats.created).toBe(2);
  });

  it("duplicate external ids: last wins", () => {
    const d = snap([], [
      { externalId: "a", kind: "assignment", title: "first", dueAt: at(5) },
      { externalId: "a", kind: "assignment", title: "second", dueAt: at(6) },
    ]);
    expect(d.duplicates).toBe(1);
    expect(d.upserts.map((u) => u.title)).toEqual(["second"]);
  });
});

describe("diffIncremental", () => {
  it("classifies upserts and explicit removals; never removes by window", () => {
    const a = row({ externalId: "syl:CPSC323:a" });
    const b = row({ externalId: "syl:CPSC323:b" });
    const c = row({ externalId: "syl:CPSC323:c", removedAt: at(-1) });
    const d = diffIncremental({
      current: [a, b, c],
      upserts: [input(a, { timingKey: "D:20261020", dueAt: at(150) }), { externalId: "syl:CPSC323:new", kind: "exam", title: "Mid", startsAt: at(200) }],
      removeExternalIds: ["syl:CPSC323:b", "syl:CPSC323:c", "missing"],
      now: NOW,
    });
    expect(d.stats).toMatchObject({ dueChanged: 1, created: 1, removed: 1 });
    expect(d.removeIds).toEqual([b.id]);
    expect(d.rekeys).toEqual([]);
  });

  it("an id both upserted and removed is upserted", () => {
    const a = row({ externalId: "x" });
    const d = diffIncremental({ current: [a], upserts: [input(a)], removeExternalIds: ["x"], now: NOW });
    expect(d.removeIds).toEqual([]);
    expect(d.stats.unchanged).toBe(1);
  });
});

describe("rebaseInstants", () => {
  it("date-only assignment keeps 23:59 local in the new zone (NY → LA)", () => {
    const a = row({ externalId: "a", allDay: true, timingKey: "D:20261015", dueAt: new Date("2026-10-16T03:59:00Z") });
    expect(rebaseInstants(a, "America/Los_Angeles")).toEqual({ startsAt: null, endsAt: null, dueAt: new Date("2026-10-16T06:59:00Z") });
    expect(rebaseInstants(a, "America/New_York")).toBeNull();
  });

  it("all-day event keeps local midnights and its day count (gcal YYYY-MM-DD key)", () => {
    const e = row({
      externalId: "g",
      source: "gcal",
      kind: "event",
      allDay: true,
      timingKey: "2026-10-15",
      dueAt: null,
      startsAt: new Date("2026-10-15T04:00:00Z"),
      endsAt: new Date("2026-10-17T04:00:00Z"),
    });
    expect(rebaseInstants(e, "Asia/Kolkata")).toEqual({
      startsAt: new Date("2026-10-14T18:30:00Z"),
      endsAt: new Date("2026-10-16T18:30:00Z"),
      dueAt: null,
    });
  });

  it("floating items shift to the same wall time; timed items are untouched", () => {
    const f = row({
      externalId: "f",
      kind: "event",
      dueAt: null,
      startsAt: new Date("2026-10-15T21:00:00Z"),
      endsAt: new Date("2026-10-15T22:00:00Z"),
      timingKey: "F:20261015T170000",
    });
    expect(rebaseInstants(f, "America/Chicago")).toEqual({
      startsAt: new Date("2026-10-15T22:00:00Z"),
      endsAt: new Date("2026-10-15T23:00:00Z"),
      dueAt: null,
    });
    expect(rebaseInstants(row({ externalId: "t", timingKey: "U:20261016T035900Z" }), "Asia/Tokyo")).toBeNull();
  });
});
