import "server-only";
// OWNER: 2.3

/**
 * Timeline public API (master plan §1.9 = V2-05 §8.1). One module for every consumer:
 * Canvas sync (`applySnapshot`), Google Calendar (`replaceSourceWindow`, `upsertTimelineItem`,
 * `deleteTimelineItems`), syllabus (`upsertTimelineItems`, `pruneTimelineItems`, `termHintForCourse`),
 * agent tools, briefing/alerts and the web.
 *
 * - Every committed write with ≥ 1 change enqueues a `timeline_changes` job AFTER the RPC commits
 *   (dedupe `tlc:<userId>:<runId>`, at-least-once). Status changes call the subscribers
 *   synchronously instead (`hooks.ts`).
 * - Reads exclude soft-removed rows; urgency is computed at read time; the user's zone is read
 *   from `users.timezone` when not given; `listTimeline` applies `collapseSyllabusDuplicates` once.
 * - Titles and courses are third-party text: model-facing output goes through `renderTimelineForModel`.
 */
import { randomUUID } from "node:crypto";
import { enqueueJob } from "@/server/jobs/enqueue";
import { courseKey } from "@/shared/course-key";
import { formatForChat, safeTimeZone } from "@/shared/time/tz";
import type { ConnectSummaryShape } from "@/shared/canvas-guide";
import { diffIncremental, diffSnapshot, rebaseInstants, type SnapshotDiff } from "@/server/timeline/diff";
import { notifyStatusSubscribers } from "@/server/timeline/hooks";
import { buildBatch } from "@/server/timeline/policy";
import {
  applyDiffRpc,
  findByRefPrefix,
  getItem,
  getUserTimezone,
  loadByExternalIds,
  loadSourceItems,
  loadZoneDependent,
  queryOverdue,
  queryRange,
  updateInstants,
  updateStatus,
} from "@/server/timeline/store";
import { dayLoads, weekLoadLevel } from "@/server/timeline/urgency";
import { rankSearch, resolveRange, toView, type AgendaRange } from "@/server/timeline/view";
import {
  TimelineChangeBatchSchema,
  type ApplyResult,
  type DayLoad,
  type SnapshotScope,
  type TimelineChangeBatch,
  type TimelineItem,
  type TimelineItemInput,
  type TimelineItemView,
  type TimelineKind,
  type TimelineSource,
  type TimelineStatus,
  type TimelineUpsert,
} from "@/server/timeline/types";

export { TimelineChangeSchema, TimelineChangeBatchSchema } from "@/server/timeline/types";
export type * from "@/server/timeline/types";
export { urgencyScore, computeUrgency, dayLoads, weekLoadLevel } from "@/server/timeline/urgency";
export { renderTimelineForModel, resolveRange, toView, rankSearch, refOf } from "@/server/timeline/view";
export type { AgendaRange } from "@/server/timeline/view";
export { classifyDelivery } from "@/server/timeline/policy";

const DAY_MS = 24 * 3_600_000;
/** Max changes per job payload (`TimelineChangeBatchSchema`). */
const BATCH_MAX = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── internals ───────────────────────────────────────────────────────────────

function emptyResult(): ApplyResult {
  return {
    created: 0,
    updated: 0,
    dueChanged: 0,
    removed: 0,
    restored: 0,
    rekeyed: 0,
    unchanged: 0,
    removalsDeferred: 0,
    batch: { initial: false, changes: [] },
  };
}

/**
 * Enqueue a committed batch as `timeline_changes` job(s). Never throws: the write is already
 * committed, so a failure is retried briefly and then logged (counts only, never titles).
 */
async function enqueueBatch(userId: string, batch: TimelineChangeBatch): Promise<void> {
  if (batch.changes.length === 0) return;
  const runId = randomUUID();
  for (let i = 0; i < batch.changes.length; i += BATCH_MAX) {
    const part: TimelineChangeBatch = { initial: batch.initial, changes: batch.changes.slice(i, i + BATCH_MAX) };
    const dedupeKey = `tlc:${userId}:${runId}${i === 0 ? "" : `:${i / BATCH_MAX}`}`;
    for (let attempt = 1; ; attempt++) {
      try {
        await enqueueJob({ kind: "timeline_changes", userId, payload: part, dedupeKey });
        break;
      } catch (err) {
        if (attempt >= 3) {
          const name = err instanceof Error ? err.name : "unknown";
          console.error(`[timeline] enqueue timeline_changes failed: ${name} (changes=${part.changes.length})`);
          break;
        }
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }
}

/** RPC → batch → enqueue (after commit). */
async function commit(
  userId: string,
  source: TimelineSource,
  d: SnapshotDiff,
  initial: boolean,
  now: Date,
): Promise<ApplyResult> {
  const ids = await applyDiffRpc(userId, source, d);
  const batch = buildBatch(d.planned, ids, source, initial, now);
  await enqueueBatch(userId, batch);
  return { ...d.stats, batch };
}

async function zoneOf(userId: string, tz: string | undefined): Promise<string> {
  return tz ?? (await getUserTimezone(userId));
}

function sortByAnchor(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort(
    (a, b) =>
      (a.anchorAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.anchorAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
      a.id.localeCompare(b.id),
  );
}

/** Lazy import: syllabus (3.5) writes through this module, so a static import would be a cycle. */
async function collapse(views: TimelineItemView[], tz: string): Promise<TimelineItemView[]> {
  const { collapseSyllabusDuplicates } = await import("@/server/integrations/syllabus");
  return collapseSyllabusDuplicates(views, tz);
}

// ── Writes ──────────────────────────────────────────────────────────────

/**
 * Full snapshot (Canvas). Diff vs stored rows of (user, source[, prefix]); atomic RPC; window-scoped
 * removals + mass-removal guard; enqueues {kind:"timeline_changes"} when the batch is non-empty.
 * @param p.userId owner
 * @param p.source source of every item
 * @param p.items the complete snapshot
 * @param p.now clock (default now)
 * @param p.initial first sync after connect / URL change (all hints "none")
 * @param p.scope external-id prefix and removal window (default [now − 29d, now + 365d))
 * @param p.removalGuard mass-removal guard (default off)
 * @param p.capSaturatedKinds kinds whose feed hit the cap (no removals)
 * @returns counts and the committed batch
 * @throws on a DB error (nothing committed, nothing enqueued)
 */
export async function applySnapshot(p: {
  userId: string;
  source: TimelineSource;
  items: TimelineItemInput[];
  now?: Date;
  initial?: boolean;
  scope?: SnapshotScope;
  removalGuard?: { enabled: boolean; deferredLastTime: boolean };
  capSaturatedKinds?: TimelineKind[];
}): Promise<ApplyResult> {
  const now = p.now ?? new Date();
  const scope = p.scope ?? {};
  const current = await loadSourceItems(p.userId, p.source, {
    externalIdPrefix: scope.externalIdPrefix,
    includeRemoved: true,
  });
  const items = scope.externalIdPrefix ? p.items.filter((i) => i.externalId.startsWith(scope.externalIdPrefix ?? "")) : p.items;
  const d = diffSnapshot({
    current,
    fresh: items,
    now,
    scope,
    removalGuard: p.removalGuard ?? { enabled: false, deferredLastTime: false },
    capSaturatedKinds: p.capSaturatedKinds,
  });
  return commit(p.userId, p.source, d, p.initial ?? false, now);
}

/**
 * V2-07: upsert all; soft-remove rows of `source` whose anchor ∈ [from,to) and external_id ∉ items. Guard off.
 * @param p.userId owner
 * @param p.source "gcal" | "aria"
 * @param p.from window start (inclusive)
 * @param p.to window end (exclusive)
 * @param p.items every item of the source in the window
 * @param p.now clock
 * @returns rows written (created/updated/restored/moved) and rows soft-removed
 */
export async function replaceSourceWindow(p: {
  userId: string;
  source: "gcal" | "aria";
  from: Date;
  to: Date;
  items: TimelineItemInput[];
  now?: Date;
}): Promise<{ upserted: number; deleted: number }> {
  const now = p.now ?? new Date();
  const current = await loadSourceItems(p.userId, p.source, { includeRemoved: true });
  const d = diffSnapshot({
    current,
    fresh: p.items,
    now,
    scope: { windowStart: p.from, windowEnd: p.to },
    removalGuard: { enabled: false, deferredLastTime: false },
  });
  const r = await commit(p.userId, p.source, d, false, now);
  return { upserted: r.created + r.updated + r.dueChanged + r.restored, deleted: r.removed };
}

/**
 * V2-07: single upsert (push notification path).
 * @param userId owner
 * @param source timeline source
 * @param item the item
 * @returns the row id
 */
export async function upsertTimelineItem(userId: string, source: TimelineSource, item: TimelineItemInput): Promise<{ id: string }> {
  const now = new Date();
  const current = await loadByExternalIds(userId, source, [item.externalId]);
  const d = diffIncremental({ current, upserts: [item], removeExternalIds: [], now });
  const ids = await applyDiffRpc(userId, source, d);
  await enqueueBatch(userId, buildBatch(d.planned, ids, source, false, now));
  const id = ids.get(item.externalId) ?? current.find((r) => r.externalId === item.externalId)?.id;
  if (!id) throw new Error("timeline.upsertTimelineItem: row id missing after apply");
  return { id };
}

/**
 * V2-07/V2-05: soft-remove every row of a source (disconnect); emits `removed` changes.
 * @param userId owner
 * @param source timeline source
 * @returns rows removed
 */
export async function deleteTimelineItems(userId: string, source: TimelineSource): Promise<{ deleted: number }> {
  const now = new Date();
  const live = await loadSourceItems(userId, source);
  const d = diffIncremental({ current: live, upserts: [], removeExternalIds: live.map((r) => r.externalId), now });
  const r = await commit(userId, source, d, false, now);
  return { deleted: r.removed };
}

/**
 * V2-08: batch upsert; items carry `source` (default "syllabus"). Incremental classification; no window removals.
 * One RPC (and one batch) per source.
 * @param userId owner
 * @param items items with optional per-item source
 * @returns merged counts and the merged batch
 */
export async function upsertTimelineItems(userId: string, items: TimelineUpsert[]): Promise<ApplyResult> {
  const now = new Date();
  const bySource = new Map<TimelineSource, TimelineItemInput[]>();
  for (const { source, ...item } of items) {
    const s = source ?? "syllabus";
    bySource.set(s, [...(bySource.get(s) ?? []), item]);
  }
  const total = emptyResult();
  for (const [source, group] of bySource) {
    const current = await loadByExternalIds(userId, source, group.map((i) => i.externalId));
    const d = diffIncremental({ current, upserts: group, removeExternalIds: [], now });
    const r = await commit(userId, source, d, false, now);
    total.created += r.created;
    total.updated += r.updated;
    total.dueChanged += r.dueChanged;
    total.removed += r.removed;
    total.restored += r.restored;
    total.rekeyed += r.rekeyed;
    total.unchanged += r.unchanged;
    total.removalsDeferred += r.removalsDeferred;
    total.batch.changes.push(...r.batch.changes);
  }
  return total;
}

/**
 * V2-08: soft-remove rows of `source` with external_id prefix and not in `keep`.
 * @param p.userId owner
 * @param p.source timeline source
 * @param p.externalIdPrefix e.g. "syl:CPSC323:" (must be non-empty)
 * @param p.keep external ids to keep
 * @returns rows removed
 */
export async function pruneTimelineItems(p: {
  userId: string;
  source: TimelineSource;
  externalIdPrefix: string;
  keep: string[];
}): Promise<{ removed: number }> {
  if (p.externalIdPrefix === "") throw new Error("timeline.pruneTimelineItems: empty externalIdPrefix");
  const now = new Date();
  const keep = new Set(p.keep);
  const live = await loadSourceItems(p.userId, p.source, { externalIdPrefix: p.externalIdPrefix });
  const doomed = live.filter((r) => r.externalId.startsWith(p.externalIdPrefix) && !keep.has(r.externalId));
  if (doomed.length === 0) return { removed: 0 };
  const d = diffIncremental({ current: live, upserts: [], removeExternalIds: doomed.map((r) => r.externalId), now });
  const r = await commit(p.userId, p.source, d, false, now);
  return { removed: r.removed };
}

/**
 * Mark done / dismiss / undo; owner-scoped; idempotent; runs status subscribers (V2-06 cancels nudges).
 * Subscribers run synchronously and only when the status actually changed; their errors are logged.
 * @param userId owner
 * @param itemId timeline_items.id
 * @param status new status
 * @returns the updated view, or not_found
 */
export async function setTimelineItemStatus(
  userId: string,
  itemId: string,
  status: TimelineStatus,
): Promise<{ ok: true; item: TimelineItemView } | { ok: false; code: "not_found" }> {
  const now = new Date();
  const res = await updateStatus(userId, itemId, status);
  if (!res) return { ok: false, code: "not_found" };
  const { before, after } = res;
  if (before.status !== after.status) {
    const anchor = after.anchorAt?.toISOString() ?? null;
    const batch = TimelineChangeBatchSchema.parse({
      initial: false,
      changes: [
        {
          itemId: after.id,
          kind: "status_changed",
          source: after.source,
          itemKind: after.kind,
          title: after.title,
          course: after.course,
          oldDueAt: anchor,
          newDueAt: anchor,
          status: after.status,
          allDay: after.allDay,
          externalId: after.externalId,
          deliveryHint: "none",
        },
      ],
    });
    await notifyStatusSubscribers(userId, batch, now);
  }
  return { ok: true, item: toView(after, now, await getUserTimezone(userId)) };
}

/**
 * V2-04 alias: setTimelineItemStatus(..., "done") → view or null.
 * @param userId owner
 * @param itemId timeline_items.id
 * @returns the updated view, or null when not found
 */
export async function markItemDone(userId: string, itemId: string): Promise<TimelineItemView | null> {
  const r = await setTimelineItemStatus(userId, itemId, "done");
  return r.ok ? r.item : null;
}

/**
 * Recompute date-only/floating instants after a timezone change (no change entries).
 * @param userId owner
 * @param newTimezone the user's new IANA zone (invalid → America/New_York)
 * @returns rows updated
 */
export async function rebaseTimeline(userId: string, newTimezone: string): Promise<{ updated: number }> {
  const tz = safeTimeZone(newTimezone);
  const items = await loadZoneDependent(userId);
  let updated = 0;
  for (const item of items) {
    const next = rebaseInstants(item, tz);
    if (!next) continue;
    await updateInstants(userId, item.id, next);
    updated++;
  }
  return { updated };
}

// ── Reads (exclude removed; urgency computed now; tz read from users when omitted) ───

/** Options shared by both `listTimeline` call styles. */
export interface ListTimelineOpts {
  /** web: true → statuses upcoming+done */
  includeDone?: boolean;
  /** V2-04/V2-06 form; overrides includeDone */
  statuses?: TimelineStatus[];
  /** web: also upcoming items anchored in [overdueSince, from) */
  overdueSince?: Date;
  /** V2-04 form: overdueSince = from − 7d */
  includeOverdue?: boolean;
  kinds?: TimelineKind[];
  sources?: TimelineSource[];
  limit?: number;
  timezone?: string;
  now?: Date;
}

/**
 * Both call styles work: listTimeline(u, {from,to}, opts) and listTimeline(u, {from,to,...opts}).
 * Sorted by anchor (overdue items first); collapseSyllabusDuplicates applied.
 * @param userId owner
 * @param range [from, to) plus (style 2) options
 * @param opts (style 1) options; win over options inside `range`
 * @returns views
 */
export async function listTimeline(
  userId: string,
  range: { from: Date; to: Date } & ListTimelineOpts,
  opts?: ListTimelineOpts,
): Promise<TimelineItemView[]> {
  const { from, to, ...inline } = range;
  const o: ListTimelineOpts = { ...inline, ...opts };
  const now = o.now ?? new Date();
  const tz = await zoneOf(userId, o.timezone);
  const statuses: TimelineStatus[] = o.statuses ?? (o.includeDone ? ["upcoming", "done"] : ["upcoming"]);
  const items = await queryRange(userId, from, to, { kinds: o.kinds, sources: o.sources, statuses, limit: o.limit });

  const overdueSince = o.overdueSince ?? (o.includeOverdue ? new Date(from.getTime() - 7 * DAY_MS) : undefined);
  let overdue: TimelineItem[] = [];
  if (overdueSince && overdueSince.getTime() < from.getTime()) {
    overdue = (await queryOverdue(userId, overdueSince, from)).filter(
      (i) => (!o.kinds || o.kinds.includes(i.kind)) && (!o.sources || o.sources.includes(i.source)),
    );
  }
  const views = sortByAnchor([...overdue, ...items]).map((i) => toView(i, now, tz));
  const collapsed = await collapse(views, tz);
  return o.limit !== undefined ? collapsed.slice(0, Math.max(0, o.limit)) : collapsed;
}

/** V2-06 alias. */
export const listItems: typeof listTimeline = listTimeline;

/**
 * Convenience for tools: named local range (see `resolveRange`).
 * @param userId owner
 * @param range named range or explicit local dates
 * @param opts list options (timezone / now resolved once and reused)
 * @returns views
 */
export async function listTimelineForRange(
  userId: string,
  range: AgendaRange | { from: string; to: string },
  opts?: ListTimelineOpts,
): Promise<TimelineItemView[]> {
  const now = opts?.now ?? new Date();
  const tz = await zoneOf(userId, opts?.timezone);
  const r = resolveRange(range, now, tz);
  return listTimeline(userId, r, { ...opts, timezone: tz, now });
}

/**
 * Ranked search over titles and courses (token AND, course-key aliases).
 * Window: [now − 7d (180d with includePast), now + 365d).
 * @param userId owner
 * @param query words
 * @param opts include done/past, limit (default 10), tz, clock
 * @returns matching views, best first
 */
export async function searchTimeline(
  userId: string,
  query: string,
  opts?: { includeDone?: boolean; includePast?: boolean; limit?: number; timezone?: string; now?: Date },
): Promise<TimelineItemView[]> {
  if (query.trim() === "") return [];
  const now = opts?.now ?? new Date();
  const tz = await zoneOf(userId, opts?.timezone);
  const from = new Date(now.getTime() - (opts?.includePast ? 180 : 7) * DAY_MS);
  const to = new Date(now.getTime() + 365 * DAY_MS);
  const statuses: TimelineStatus[] = opts?.includeDone ? ["upcoming", "done"] : ["upcoming"];
  const items = await queryRange(userId, from, to, { statuses });
  const ranked = rankSearch(items, query, now, { includePast: opts?.includePast });
  const collapsed = await collapse(ranked.map((i) => toView(i, now, tz)), tz);
  return collapsed.slice(0, Math.max(0, opts?.limit ?? 10));
}

/**
 * One item, owner-scoped.
 * @param userId owner
 * @param itemId timeline_items.id
 * @param opts tz, clock
 * @returns the view, or null
 */
export async function getTimelineItem(
  userId: string,
  itemId: string,
  opts?: { timezone?: string; now?: Date },
): Promise<TimelineItemView | null> {
  const item = await getItem(userId, itemId);
  if (!item) return null;
  return toView(item, opts?.now ?? new Date(), await zoneOf(userId, opts?.timezone));
}

/**
 * One live item as the stored model (source, external id, timing key, raw), owner-scoped. For
 * integrations that need more than the view (V2-07: Aria calendar blocks look up their event id);
 * everyone else uses `getTimelineItem`.
 * @param userId owner
 * @param itemId timeline_items.id (non-uuid → null)
 * @returns the item, or null when missing, removed or not the user's
 */
export async function getTimelineItemRow(userId: string, itemId: string): Promise<TimelineItem | null> {
  return getItem(userId, itemId);
}

/**
 * Resolve a `t_` ref or UUID (non-agent callers only; agent tools use `ctx.aliases`).
 * @param userId owner
 * @param ref "t_xxxxxxxx" or uuid
 * @returns the item id, or not_found / ambiguous
 */
export async function resolveItemRef(
  userId: string,
  ref: string,
): Promise<{ ok: true; itemId: string } | { ok: false; error: "not_found" | "ambiguous" }> {
  const r = ref.trim().toLowerCase();
  const m = /^t_([0-9a-f]{8})$/.exec(r);
  if (m) {
    const rows = await findByRefPrefix(userId, m[1]);
    if (rows.length === 0) return { ok: false, error: "not_found" };
    if (rows.length > 1) return { ok: false, error: "ambiguous" };
    return { ok: true, itemId: rows[0].id };
  }
  if (UUID_RE.test(r)) {
    const item = await getItem(userId, r);
    return item ? { ok: true, itemId: item.id } : { ok: false, error: "not_found" };
  }
  return { ok: false, error: "not_found" };
}

/**
 * Per-local-day load for `days` days starting at local date `from` ("YYYY-MM-DD").
 * @param userId owner
 * @param from local start date
 * @param days number of days
 * @param opts tz, clock
 * @returns one entry per day
 */
export async function getDayLoads(
  userId: string,
  from: string,
  days: number,
  opts?: { timezone?: string; now?: Date },
): Promise<DayLoad[]> {
  const tz = await zoneOf(userId, opts?.timezone);
  const n = Math.max(0, Math.floor(days));
  if (n === 0) return [];
  const r = resolveRange({ from, to: from }, opts?.now ?? new Date(), tz);
  // ±1 day so all-day items bucket by their floating date even if instants weren't rebased yet.
  const start = new Date(r.from.getTime() - DAY_MS);
  const end = new Date(r.from.getTime() + (n + 2) * DAY_MS);
  const items = await queryRange(userId, start, end, { kinds: ["assignment", "exam"], statuses: ["upcoming"] });
  return dayLoads(items, tz, from, n);
}

/**
 * 7-day load level (upcoming assignments + exams in [now, now + 7d)).
 * @param userId owner
 * @param opts clock
 * @returns light / busy / heavy
 */
export async function getWeekLoad(userId: string, opts?: { now?: Date }): Promise<"light" | "busy" | "heavy"> {
  const now = opts?.now ?? new Date();
  const items = await queryRange(userId, now, new Date(now.getTime() + 7 * DAY_MS), {
    kinds: ["assignment", "exam"],
    statuses: ["upcoming"],
  });
  return weekLoadLevel(items, now);
}

/**
 * Upcoming summary for a source (Canvas connect confirmation): upcoming assignments + exams due
 * at or after now, their distinct courses (by course key), and the next one.
 * @param userId owner
 * @param source timeline source
 * @param opts tz, clock
 * @returns deadline count, courses, next due (label like "Thu 11:59pm")
 */
export async function summarizeUpcoming(
  userId: string,
  source: TimelineSource,
  opts?: { timezone?: string; now?: Date },
): Promise<ConnectSummaryShape> {
  const now = opts?.now ?? new Date();
  const tz = await zoneOf(userId, opts?.timezone);
  const items = await queryRange(userId, now, new Date(now.getTime() + 400 * DAY_MS), {
    kinds: ["assignment", "exam"],
    sources: [source],
    statuses: ["upcoming"],
  });
  const courses = new Map<string, string>();
  for (const i of items) {
    const k = courseKey(i.course);
    if (k && i.course && !courses.has(k)) courses.set(k, i.course);
  }
  const next = items[0];
  return {
    deadlines: items.length,
    courses: [...courses.values()],
    nextDue: next?.anchorAt
      ? { title: next.title, course: next.course, label: formatForChat(next.anchorAt, tz, now, { allDay: next.allDay }) }
      : null,
  };
}

/**
 * Distinct course labels with upcoming items (profile rendering), one per course key
 * (the label of the nearest item), sorted.
 * @param userId owner
 * @param now clock
 * @returns course strings, e.g. ["CPSC 323 01 (FA26)", "MATH 120"]
 */
export async function listCourses(userId: string, now?: Date): Promise<string[]> {
  const t = now ?? new Date();
  const items = await queryRange(userId, new Date(t.getTime() - 7 * DAY_MS), new Date(t.getTime() + 365 * DAY_MS), {
    statuses: ["upcoming"],
  });
  const courses = new Map<string, string>();
  for (const i of items) {
    const k = courseKey(i.course);
    if (k && i.course && !courses.has(k)) courses.set(k, i.course);
  }
  return [...courses.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * V2-08: min/max Canvas anchor for a courseKey (term hint), or null.
 * @param userId owner
 * @param key a course key or course text (normalized with `courseKey`)
 * @returns earliest and latest anchor, or null when Canvas has no items for that course
 */
export async function termHintForCourse(userId: string, key: string): Promise<{ start: Date; end: Date } | null> {
  const want = courseKey(key);
  if (!want) return null;
  let start: Date | null = null;
  let end: Date | null = null;
  for (const i of await loadSourceItems(userId, "canvas")) {
    if (!i.anchorAt || courseKey(i.course) !== want) continue;
    if (!start || i.anchorAt < start) start = i.anchorAt;
    if (!end || i.anchorAt > end) end = i.anchorAt;
  }
  return start && end ? { start, end } : null;
}
