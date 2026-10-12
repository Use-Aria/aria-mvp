/**
 * `reminders/fire.ts` pure helpers (5.5 #9): same-item sibling nudges are settled with the firing
 * one instead of firing again, and the deliver dedupe key folds same-item, same-instant auto nudges
 * into one send while keeping user reminders separate and retries stable.
 */
import { fireDedupeKey, partitionNudgeSiblings } from "@/server/reminders/fire";

const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";
const ITEM_DEAD = "33333333-3333-4333-8333-333333333333";
const DUE = new Date("2026-10-12T20:45:00Z");

const row = (id: string, anchor: string | null) => ({ id, anchor_item_id: anchor });
const live = (id: string) => id !== ITEM_DEAD;

describe("partitionNudgeSiblings", () => {
  it("a second nudge on the firing row's item is covered, not coalesced", () => {
    const { coalesce, covered } = partitionNudgeSiblings(ITEM_A, [row("n2", ITEM_A)], live);
    expect(coalesce).toEqual([]);
    expect(covered.map((r) => r.id)).toEqual(["n2"]);
  });

  it("other items coalesce once each; their duplicates are covered", () => {
    const { coalesce, covered } = partitionNudgeSiblings(
      ITEM_A,
      [row("b1", ITEM_B), row("a2", ITEM_A), row("b2", ITEM_B)],
      live,
    );
    expect(coalesce.map((r) => r.id)).toEqual(["b1"]);
    expect(covered.map((r) => r.id)).toEqual(["a2", "b2"]);
  });

  it("dead or missing anchors are left to their own job", () => {
    const { coalesce, covered } = partitionNudgeSiblings(ITEM_A, [row("d", ITEM_DEAD), row("x", null)], live);
    expect(coalesce).toEqual([]);
    expect(covered).toEqual([]);
  });
});

describe("fireDedupeKey", () => {
  it("two auto nudges on the same item at the same instant share one key", () => {
    const k1 = fireDedupeKey({ id: "r1", origin: "auto", anchor_item_id: ITEM_A }, DUE);
    const k2 = fireDedupeKey({ id: "r2", origin: "auto", anchor_item_id: ITEM_A }, new Date(DUE.getTime()));
    expect(k1).toBe(k2);
    expect(k1).toBe(`nudge:${ITEM_A}:${DUE.toISOString()}`);
  });

  it("differs per item and per instant", () => {
    const a = fireDedupeKey({ id: "r1", origin: "auto", anchor_item_id: ITEM_A }, DUE);
    expect(fireDedupeKey({ id: "r1", origin: "auto", anchor_item_id: ITEM_B }, DUE)).not.toBe(a);
    expect(fireDedupeKey({ id: "r1", origin: "auto", anchor_item_id: ITEM_A }, new Date(DUE.getTime() + 60_000))).not.toBe(a);
  });

  it("a user reminder anchored on the same item keeps its own per-row key", () => {
    const user = fireDedupeKey({ id: "u1", origin: "user", anchor_item_id: ITEM_A }, DUE);
    expect(user).toBe(`reminder:u1:${DUE.toISOString()}`);
    expect(user).not.toBe(fireDedupeKey({ id: "r1", origin: "auto", anchor_item_id: ITEM_A }, DUE));
  });

  it("is stable for a retry of the same row", () => {
    const r = { id: "r1", origin: "auto", anchor_item_id: ITEM_A };
    expect(fireDedupeKey(r, DUE)).toBe(fireDedupeKey(r, new Date(DUE.toISOString())));
  });
});
