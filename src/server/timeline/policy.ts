import "server-only";
// OWNER: 2.3

/**
 * Delivery hints and change-batch assembly (V2-05 §7.3 `policy.ts`, §8.3 table). Pure.
 * V2-06's `handleTimelineChanges` makes the final call; this is only the hint.
 */
import type { PlannedChange } from "@/server/timeline/diff";
import type {
  Delivery,
  TimelineChange,
  TimelineChangeBatch,
  TimelineKind,
  TimelineSource,
  TimelineStatus,
} from "@/server/timeline/types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function within(t: Date | null, start: number, end: number): boolean {
  if (!t) return false;
  const x = t.getTime();
  return x >= start && x <= end;
}

/**
 * §8.3 `deliveryHint` table (anchor = due_at ?? starts_at; `now` = sync time):
 * initial / non-canvas / done-or-dismissed / status_changed → none;
 * due_changed: |Δ| < 60s → none; old or new in [now, now+7d] → immediate; new > now → briefing; else none;
 * created (assignment/exam): new in [now, now+24h] → immediate; (now+24h, now+14d] → briefing; else none;
 * removed (assignment/exam): old in [now, now+7d] → briefing; else none.
 * @param c the change facts
 * @param now clock
 * @returns the hint
 */
export function classifyDelivery(
  c: {
    source: TimelineSource;
    itemKind: TimelineKind;
    kind: TimelineChange["kind"];
    oldDueAt: Date | null;
    newDueAt: Date | null;
    status: TimelineStatus;
    initial: boolean;
  },
  now: Date,
): Delivery {
  if (c.initial) return "none";
  if (c.source !== "canvas") return "none";
  if (c.status !== "upcoming") return "none";
  const t = now.getTime();
  const deadline = c.itemKind === "assignment" || c.itemKind === "exam";
  switch (c.kind) {
    case "status_changed":
      return "none";
    case "due_changed": {
      if (c.oldDueAt && c.newDueAt && Math.abs(c.newDueAt.getTime() - c.oldDueAt.getTime()) < 60_000) return "none";
      if (within(c.oldDueAt, t, t + 7 * DAY_MS) || within(c.newDueAt, t, t + 7 * DAY_MS)) return "immediate";
      if (c.newDueAt && c.newDueAt.getTime() > t) return "briefing";
      return "none";
    }
    case "created": {
      if (!deadline || !c.newDueAt) return "none";
      const x = c.newDueAt.getTime();
      if (x >= t && x <= t + DAY_MS) return "immediate";
      if (x > t + DAY_MS && x <= t + 14 * DAY_MS) return "briefing";
      return "none";
    }
    case "removed":
      return deadline && within(c.oldDueAt, t, t + 7 * DAY_MS) ? "briefing" : "none";
  }
}

/**
 * Build the change batch from planned changes and the RPC's id map. Changes are ordered by
 * anchor (new ?? old; unanchored last); a change whose id is unknown is dropped.
 * @param planned planned changes from the diff
 * @param idByExternalId externalId → row id (from `timeline_apply`)
 * @param source source of every planned change
 * @param initial first sync after connect / URL change (all hints "none")
 * @param now clock used for hints
 * @returns a batch that parses with `TimelineChangeBatchSchema`
 */
export function buildBatch(
  planned: PlannedChange[],
  idByExternalId: Map<string, string>,
  source: TimelineSource,
  initial: boolean,
  now: Date,
): TimelineChangeBatch {
  const anchorMs = (p: PlannedChange): number => (p.newAnchor ?? p.oldAnchor)?.getTime() ?? Number.POSITIVE_INFINITY;
  const ordered = planned
    .map((p, i) => ({ p, i }))
    .sort((a, b) => anchorMs(a.p) - anchorMs(b.p) || a.i - b.i)
    .map((x) => x.p);
  const changes: TimelineChange[] = [];
  for (const p of ordered) {
    const itemId = p.existingId ?? idByExternalId.get(p.externalId);
    if (!itemId) continue;
    const change: TimelineChange = {
      itemId,
      kind: p.kind,
      source,
      itemKind: p.itemKind,
      title: p.title,
      course: p.course,
      oldDueAt: p.kind === "created" ? null : (p.oldAnchor?.toISOString() ?? null),
      newDueAt: p.kind === "removed" ? null : (p.newAnchor?.toISOString() ?? null),
      status: p.status,
      allDay: p.allDay,
      externalId: p.externalId,
      deliveryHint: classifyDelivery(
        {
          source,
          itemKind: p.itemKind,
          kind: p.kind,
          oldDueAt: p.oldAnchor,
          newDueAt: p.newAnchor,
          status: p.status,
          initial,
        },
        now,
      ),
    };
    if (p.restored) change.restored = true;
    if (p.rekeyed) change.rekeyed = true;
    changes.push(change);
  }
  return { initial, changes };
}
