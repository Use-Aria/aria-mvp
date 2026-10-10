import { randomUUID } from "node:crypto";
import type { PlannedChange } from "@/server/timeline/diff";
import { buildBatch, classifyDelivery } from "@/server/timeline/policy";
import { TimelineChangeBatchSchema, type Delivery, type TimelineChange, type TimelineKind, type TimelineSource, type TimelineStatus } from "@/server/timeline/types";
import { at, DAY, HOUR, NOW } from "./helpers";

interface Row {
  name: string;
  kind: TimelineChange["kind"];
  source?: TimelineSource;
  itemKind?: TimelineKind;
  old: Date | null;
  new: Date | null;
  status?: TimelineStatus;
  initial?: boolean;
  want: Delivery;
}

const ms = (x: number) => new Date(NOW.getTime() + x);

const TABLE: Row[] = [
  { name: "initial → none", kind: "created", old: null, new: at(2), initial: true, want: "none" },
  { name: "gcal → none", kind: "due_changed", source: "gcal", old: at(2), new: at(5), want: "none" },
  { name: "syllabus → none", kind: "created", source: "syllabus", old: null, new: at(2), want: "none" },
  { name: "aria → none", kind: "removed", source: "aria", old: at(2), new: null, want: "none" },
  { name: "gmail → none", kind: "created", source: "gmail", old: null, new: at(2), want: "none" },
  { name: "done → none", kind: "due_changed", old: at(2), new: at(5), status: "done", want: "none" },
  { name: "dismissed → none", kind: "created", old: null, new: at(2), status: "dismissed", want: "none" },
  { name: "status_changed → none", kind: "status_changed", old: at(2), new: at(2), want: "none" },
  // due_changed
  { name: "due <60s → none", kind: "due_changed", old: at(10), new: ms(10 * HOUR + 59_000), want: "none" },
  { name: "due exactly 60s → immediate", kind: "due_changed", old: at(10), new: ms(10 * HOUR + 60_000), want: "immediate" },
  { name: "due old within 7d → immediate", kind: "due_changed", old: at(5), new: at(400), want: "immediate" },
  { name: "due new exactly 7d → immediate", kind: "due_changed", old: at(30 * 24), new: ms(7 * DAY), want: "immediate" },
  { name: "due new 7d+1ms → briefing", kind: "due_changed", old: at(30 * 24), new: ms(7 * DAY + 1), want: "briefing" },
  { name: "due old now exactly → immediate", kind: "due_changed", old: NOW, new: at(30 * 24), want: "immediate" },
  { name: "due both past → none", kind: "due_changed", old: at(-50), new: at(-10), want: "none" },
  { name: "due past → past but new far → briefing", kind: "due_changed", old: at(-50), new: at(10 * 24), want: "briefing" },
  // created
  { name: "created +1h assignment → immediate", kind: "created", old: null, new: at(1), want: "immediate" },
  { name: "created exactly 24h → immediate", kind: "created", old: null, new: ms(DAY), want: "immediate" },
  { name: "created 24h+1ms → briefing", kind: "created", old: null, new: ms(DAY + 1), want: "briefing" },
  { name: "created exactly 14d exam → briefing", kind: "created", itemKind: "exam", old: null, new: ms(14 * DAY), want: "briefing" },
  { name: "created 14d+1ms → none", kind: "created", old: null, new: ms(14 * DAY + 1), want: "none" },
  { name: "created past → none", kind: "created", old: null, new: at(-1), want: "none" },
  { name: "created event → none", kind: "created", itemKind: "event", old: null, new: at(1), want: "none" },
  // removed
  { name: "removed assignment within 7d → briefing", kind: "removed", old: at(30), new: null, want: "briefing" },
  { name: "removed exactly 7d → briefing", kind: "removed", old: ms(7 * DAY), new: null, want: "briefing" },
  { name: "removed 8d → none", kind: "removed", old: at(8 * 24), new: null, want: "none" },
  { name: "removed past → none", kind: "removed", old: at(-1), new: null, want: "none" },
  { name: "removed class → none", kind: "removed", itemKind: "class", old: at(3), new: null, want: "none" },
];

describe("classifyDelivery (§8.3 table)", () => {
  it.each(TABLE)("$name", (r) => {
    expect(
      classifyDelivery(
        {
          source: r.source ?? "canvas",
          itemKind: r.itemKind ?? "assignment",
          kind: r.kind,
          oldDueAt: r.old,
          newDueAt: r.new,
          status: r.status ?? "upcoming",
          initial: r.initial ?? false,
        },
        NOW,
      ),
    ).toBe(r.want);
  });
});

describe("buildBatch", () => {
  const base = (p: Partial<PlannedChange> & { externalId: string; kind: PlannedChange["kind"] }): PlannedChange => ({
    itemKind: "assignment",
    title: "Pset 4",
    course: "CPSC 323",
    oldAnchor: null,
    newAnchor: null,
    status: "upcoming",
    allDay: false,
    ...p,
  });

  it("orders by anchor, maps ids, emits ISO strings, and parses with the schema", () => {
    const ids = new Map([
      ["a", randomUUID()],
      ["b", randomUUID()],
    ]);
    const removedId = randomUUID();
    const planned: PlannedChange[] = [
      base({ externalId: "a", kind: "created", newAnchor: at(48) }),
      base({ externalId: "b", kind: "due_changed", oldAnchor: at(100), newAnchor: at(5), rekeyed: true }),
      base({ externalId: "gone", kind: "removed", oldAnchor: at(20), existingId: removedId }),
      base({ externalId: "unknown", kind: "created", newAnchor: at(1) }),
    ];
    const batch = buildBatch(planned, ids, "canvas", false, NOW);
    expect(TimelineChangeBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch.changes.map((c) => c.externalId)).toEqual(["b", "gone", "a"]); // "unknown" has no id → dropped
    const [b, gone, a] = batch.changes;
    expect(b).toMatchObject({ itemId: ids.get("b"), oldDueAt: at(100).toISOString(), newDueAt: at(5).toISOString(), rekeyed: true, deliveryHint: "immediate" });
    expect(gone).toMatchObject({ itemId: removedId, newDueAt: null, oldDueAt: at(20).toISOString(), deliveryHint: "briefing" });
    expect(a).toMatchObject({ oldDueAt: null, deliveryHint: "briefing", source: "canvas", allDay: false });
    expect(a.restored).toBeUndefined();
  });

  it("initial batches carry hint none everywhere", () => {
    const id = randomUUID();
    const batch = buildBatch([base({ externalId: "a", kind: "created", newAnchor: at(1), restored: true })], new Map([["a", id]]), "canvas", true, NOW);
    expect(batch).toEqual({
      initial: true,
      changes: [expect.objectContaining({ itemId: id, deliveryHint: "none", restored: true })],
    });
  });
});
