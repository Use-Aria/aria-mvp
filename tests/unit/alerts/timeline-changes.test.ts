/**
 * src/server/alerts/timeline-changes.ts — pure planning of a change batch (V2-06 §2.8) and the
 * alert texts: initial imports, due-change routing/urgency, Canvas extensions (`rekeyed`), new
 * items, done/removed cancellation, removal-storm collapse, deterministic dedupe keys.
 */
import {
  dueChangeKey,
  planTimelineChanges,
  renderAlertBubbles,
  type AlertCandidate,
} from "@/server/alerts/timeline-changes";
import type { TimelineChange, TimelineChangeBatch } from "@/server/timeline/types";

const NOW = new Date("2026-10-12T16:00:00Z"); // Mon 12:00 EDT
const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function change(p: Partial<TimelineChange> & Pick<TimelineChange, "kind">): TimelineChange {
  return {
    itemId: id(),
    source: "canvas",
    itemKind: "assignment",
    title: "pset",
    course: "CS 1",
    oldDueAt: null,
    newDueAt: null,
    status: "upcoming",
    ...p,
  };
}
const batch = (changes: TimelineChange[], initial = false): TimelineChangeBatch => ({ initial, changes });

describe("planTimelineChanges", () => {
  it("initial import: nudges for everything, no alerts or notes", () => {
    const p = planTimelineChanges(
      batch([change({ kind: "created", newDueAt: iso(5 * H), deliveryHint: "none" }), change({ kind: "created", newDueAt: iso(3 * D) })], true),
      NOW,
    );
    expect(p).toMatchObject({ ensure: "all", alerts: [], notes: [] });
  });

  it("due change ≤48h → urgent alert; 5 days out → routine alert; 10 days → briefing note", () => {
    const soon = change({ kind: "due_changed", oldDueAt: iso(5 * H), newDueAt: iso(29 * H), deliveryHint: "immediate" });
    const mid = change({ kind: "due_changed", oldDueAt: iso(4 * D), newDueAt: iso(5 * D), deliveryHint: "immediate" });
    const far = change({ kind: "due_changed", oldDueAt: iso(10 * D), newDueAt: iso(11 * D), deliveryHint: "briefing" });
    const p = planTimelineChanges(batch([soon, mid, far]), NOW);
    expect(p.recompute.map((r) => r.itemId)).toEqual([soon.itemId, mid.itemId, far.itemId]);
    expect(p.alerts.map((a) => [a.itemId, a.urgent])).toEqual([
      [soon.itemId, true],
      [mid.itemId, false],
    ]);
    expect(p.notes).toEqual([
      expect.objectContaining({ kind: "due_changed", itemId: far.itemId, dedupeKey: dueChangeKey(far.itemId, new Date(iso(11 * D))) }),
    ]);
  });

  it("moved earlier is urgent; an extension (rekeyed) alerts like any due change", () => {
    const earlier = change({ kind: "due_changed", oldDueAt: iso(6 * D), newDueAt: iso(5 * D), deliveryHint: "immediate" });
    const ext = change({ kind: "due_changed", oldDueAt: iso(3 * D), newDueAt: iso(4 * D), rekeyed: true, deliveryHint: "immediate" });
    const p = planTimelineChanges(batch([earlier, ext]), NOW);
    expect(p.alerts.map((a) => [a.itemId, a.urgent])).toEqual([
      [earlier.itemId, true],
      [ext.itemId, false],
    ]);
  });

  it("hint none (non-Canvas source) and sub-5-minute moves only re-time reminders", () => {
    const gcal = change({ kind: "due_changed", source: "gcal", itemKind: "event", oldDueAt: iso(2 * H), newDueAt: iso(3 * H), deliveryHint: "none" });
    const tiny = change({ kind: "due_changed", oldDueAt: iso(5 * H), newDueAt: iso(5 * H + 60_000), deliveryHint: "immediate" });
    const p = planTimelineChanges(batch([gcal, tiny]), NOW);
    expect(p.recompute).toHaveLength(2);
    expect(p.alerts).toEqual([]);
    expect(p.notes).toEqual([]);
  });

  it("new item due ≤24h alerts once (key new_item:<id>); later ones only get nudges", () => {
    const c1 = change({ kind: "created", newDueAt: iso(6 * H), deliveryHint: "immediate" });
    const c2 = change({ kind: "created", newDueAt: iso(3 * D), deliveryHint: "briefing" });
    const p = planTimelineChanges(batch([c1, c2]), NOW);
    expect(p.alerts).toEqual([expect.objectContaining({ itemId: c1.itemId, change: "created", urgent: true, key: `new_item:${c1.itemId}` })]);
    expect(p.ensure).toEqual([c1.itemId, c2.itemId]);
  });

  it("done/dismissed → cancel; undo → re-ensure nudges", () => {
    const done = change({ kind: "status_changed", status: "done", deliveryHint: "none" });
    const dis = change({ kind: "status_changed", status: "dismissed", deliveryHint: "none" });
    const undo = change({ kind: "status_changed", status: "upcoming", deliveryHint: "none" });
    const p = planTimelineChanges(batch([done, dis, undo]), NOW);
    expect(p.cancelDone).toEqual([done.itemId, dis.itemId]);
    expect(p.ensure).toEqual([undo.itemId]);
  });

  it("removed: cancel always; note only for hint briefing; a storm (>5) collapses into one note", () => {
    const one = change({ kind: "removed", oldDueAt: iso(2 * D), deliveryHint: "briefing" });
    const quiet = change({ kind: "removed", oldDueAt: iso(30 * D), deliveryHint: "none" });
    const p = planTimelineChanges(batch([one, quiet]), NOW);
    expect(p.cancelRemoved.map((r) => r.itemId)).toEqual([one.itemId, quiet.itemId]);
    expect(p.notes).toEqual([expect.objectContaining({ kind: "item_removed", itemId: one.itemId, dedupeKey: `item_removed:${one.itemId}` })]);

    const storm = Array.from({ length: 8 }, () => change({ kind: "removed", oldDueAt: iso(D), deliveryHint: "briefing" }));
    const ps = planTimelineChanges(batch(storm), NOW);
    expect(ps.notes).toHaveLength(1);
    expect(ps.notes[0]).toMatchObject({ kind: "item_removed", itemId: null, payload: { count: 8 } });
    // Replaying the same storm yields the same dedupe key (no second note).
    expect(planTimelineChanges(batch([...storm].reverse()), NOW).notes[0].dedupeKey).toBe(ps.notes[0].dedupeKey);
  });

  it("is deterministic for a replayed batch", () => {
    const b = batch([change({ kind: "due_changed", oldDueAt: iso(5 * H), newDueAt: iso(29 * H), deliveryHint: "immediate" })]);
    expect(planTimelineChanges(b, NOW)).toEqual(planTimelineChanges(b, NOW));
  });
});

describe("renderAlertBubbles", () => {
  const a = (p: Partial<AlertCandidate>): AlertCandidate => ({
    itemId: id(),
    change: "due_changed",
    title: "pset 3",
    course: "CS 1",
    oldDueAt: new Date("2026-10-15T03:59:00Z"),
    newDueAt: new Date("2026-10-16T21:00:00Z"),
    urgent: false,
    key: "k",
    ...p,
  });
  it("one move + one new item → local-time sentences", () => {
    const r = renderAlertBubbles(
      [a({}), a({ change: "created", title: "lab 2", oldDueAt: null, newDueAt: new Date("2026-10-13T03:59:00Z") })],
      "America/New_York",
      NOW,
      "casual",
      false,
    );
    expect(r.summary).toBe(false);
    expect(r.texts).toEqual(["heads up: CS 1: pset 3 moved, Wed 11:59pm → Fri 5pm", "new on Canvas: CS 1: lab 2, due today 11:59pm 👀"]);
  });
  it(">5 changes → one summary line (link or linkless variant)", () => {
    const many = Array.from({ length: 6 }, () => a({}));
    expect(renderAlertBubbles(many, "America/New_York", NOW, "casual", true)).toEqual({
      texts: ["6 deadlines just changed on Canvas, here's your updated week:"],
      summary: true,
    });
    expect(renderAlertBubbles(many, "America/New_York", NOW, "neutral", false).texts[0]).toMatch(/Text me "week"/);
  });
});
