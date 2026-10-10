import "server-only";
// OWNER: 2.3

/**
 * Timeline persistence (V2-05 §7.3 `store.ts`). Every query is owner-scoped (`user_id`), and
 * reads exclude soft-removed rows unless asked. Writes of diffs go through the atomic
 * `timeline_apply` RPC (003; service_role only).
 */
import { db, type Tables } from "@/server/db";
import type { Json } from "@/server/db/types";
import { safeTimeZone } from "@/shared/time/tz";
import type { NormalizedInput, SnapshotDiff } from "@/server/timeline/diff";
import type {
  JsonValue,
  TimelineItem,
  TimelineKind,
  TimelineSource,
  TimelineStatus,
} from "@/server/timeline/types";

type Row = Tables<"timeline_items">;

/** PostgREST's default max rows per response on Supabase. */
const PAGE = 1000;
/** Keep `in.(…)` filters well under URL limits. */
const IN_CHUNK = 100;

const COLUMNS =
  "id,user_id,source,external_id,kind,title,course,starts_at,ends_at,due_at,all_day,url,timing_key,match_key,status,anchor_at,removed_at,updated_at,raw";

const SOURCES: ReadonlySet<string> = new Set<TimelineSource>(["canvas", "gcal", "gmail", "syllabus", "aria"]);
const KINDS: ReadonlySet<string> = new Set<TimelineKind>(["assignment", "exam", "event", "class", "block"]);
const STATUSES: ReadonlySet<string> = new Set<TimelineStatus>(["upcoming", "done", "dismissed"]);

function date(s: string | null): Date | null {
  return s === null ? null : new Date(s);
}

function isJsonObject(v: Json | null): v is { [k: string]: Json | undefined } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * DB row → `TimelineItem` (DB check constraints guarantee the enums; unknown values fall back safely).
 * @param r timeline_items row
 * @returns the item
 */
export function rowToItem(r: Row): TimelineItem {
  return {
    id: r.id,
    userId: r.user_id,
    source: (SOURCES.has(r.source) ? r.source : "aria") as TimelineSource,
    externalId: r.external_id,
    kind: (KINDS.has(r.kind) ? r.kind : "event") as TimelineKind,
    title: r.title ?? "",
    course: r.course,
    startsAt: date(r.starts_at),
    endsAt: date(r.ends_at),
    dueAt: date(r.due_at),
    allDay: r.all_day,
    url: r.url,
    timingKey: r.timing_key,
    matchKey: r.match_key,
    status: (STATUSES.has(r.status) ? r.status : "upcoming") as TimelineStatus,
    anchorAt: date(r.anchor_at),
    removedAt: date(r.removed_at),
    updatedAt: new Date(r.updated_at),
    raw: isJsonObject(r.raw) ? (JSON.parse(JSON.stringify(r.raw)) as { [k: string]: JsonValue }) : null,
  };
}

function fail(op: string, message: string): never {
  throw new Error(`timeline.${op}: ${message}`);
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Every row of (user, source), optionally restricted to an external-id prefix.
 * @param userId owner
 * @param source timeline source
 * @param opts externalIdPrefix; includeRemoved (default false)
 * @returns items (paged past the 1,000-row response cap)
 */
export async function loadSourceItems(
  userId: string,
  source: TimelineSource,
  opts?: { externalIdPrefix?: string; includeRemoved?: boolean },
): Promise<TimelineItem[]> {
  const out: TimelineItem[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db().from("timeline_items").select(COLUMNS).eq("user_id", userId).eq("source", source);
    if (opts?.externalIdPrefix) {
      const escaped = opts.externalIdPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      q = q.like("external_id", `${escaped}%`);
    }
    if (!opts?.includeRemoved) q = q.is("removed_at", null);
    const { data, error } = await q.order("id").range(from, from + PAGE - 1);
    if (error) fail("loadSourceItems", error.message);
    out.push(...data.map(rowToItem));
    if (data.length < PAGE) return out;
  }
}

/**
 * Rows of (user, source) with the given external ids, removed rows included.
 * @param userId owner
 * @param source timeline source
 * @param ids external ids
 * @returns matching items (any order)
 */
export async function loadByExternalIds(userId: string, source: TimelineSource, ids: string[]): Promise<TimelineItem[]> {
  const out: TimelineItem[] = [];
  for (const part of chunk([...new Set(ids)], IN_CHUNK)) {
    const { data, error } = await db()
      .from("timeline_items")
      .select(COLUMNS)
      .eq("user_id", userId)
      .eq("source", source)
      .in("external_id", part);
    if (error) fail("loadByExternalIds", error.message);
    out.push(...data.map(rowToItem));
  }
  return out;
}

/**
 * Non-removed items anchored in [from, to), sorted by anchor.
 * @param userId owner
 * @param from range start (inclusive)
 * @param to range end (exclusive)
 * @param o optional kind / source / status filters and a row limit (default: all, paged)
 * @returns items
 */
export async function queryRange(
  userId: string,
  from: Date,
  to: Date,
  o: { kinds?: TimelineKind[]; sources?: TimelineSource[]; statuses?: TimelineStatus[]; limit?: number },
): Promise<TimelineItem[]> {
  const limit = o.limit !== undefined ? Math.max(0, Math.floor(o.limit)) : Number.POSITIVE_INFINITY;
  if (limit === 0 || o.kinds?.length === 0 || o.sources?.length === 0 || o.statuses?.length === 0) return [];
  const out: TimelineItem[] = [];
  for (let start = 0; out.length < limit; start += PAGE) {
    const size = Math.min(PAGE, limit - out.length);
    let q = db()
      .from("timeline_items")
      .select(COLUMNS)
      .eq("user_id", userId)
      .is("removed_at", null)
      .gte("anchor_at", from.toISOString())
      .lt("anchor_at", to.toISOString());
    if (o.kinds) q = q.in("kind", o.kinds);
    if (o.sources) q = q.in("source", o.sources);
    if (o.statuses) q = q.in("status", o.statuses);
    const { data, error } = await q.order("anchor_at").order("id").range(start, start + size - 1);
    if (error) fail("queryRange", error.message);
    out.push(...data.map(rowToItem));
    if (data.length < size) break;
  }
  return out;
}

/**
 * Upcoming (not done) assignments/exams anchored in [since, before): the "still open" list.
 * @param userId owner
 * @param since earliest anchor (inclusive)
 * @param before latest anchor (exclusive)
 * @returns items sorted by anchor
 */
export async function queryOverdue(userId: string, since: Date, before: Date): Promise<TimelineItem[]> {
  if (before.getTime() <= since.getTime()) return [];
  return queryRange(userId, since, before, { kinds: ["assignment", "exam"], statuses: ["upcoming"] });
}

/** RPC payload row (snake_case, ISO instants) for one upsert. */
function upsertRow(i: NormalizedInput): { [k: string]: Json } {
  return {
    external_id: i.externalId,
    kind: i.kind,
    title: i.title,
    course: i.course ?? null,
    starts_at: i.startsAt?.toISOString() ?? null,
    ends_at: i.endsAt?.toISOString() ?? null,
    due_at: i.dueAt?.toISOString() ?? null,
    all_day: i.allDay ?? false,
    url: i.url ?? null,
    timing_key: i.timingKey ?? null,
    match_key: i.matchKey ?? null,
    raw: (i.raw ?? null) as Json,
  };
}

/**
 * Apply one diff atomically via `rpc('timeline_apply')` (rekeys → upserts → soft-removes).
 * @param userId owner
 * @param source the diff's source
 * @param d the diff
 * @returns externalId → row id for every touched row
 * @throws on an RPC error (nothing was written)
 */
export async function applyDiffRpc(userId: string, source: TimelineSource, d: SnapshotDiff): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (d.upserts.length === 0 && d.rekeys.length === 0 && d.removeIds.length === 0) return map;
  const { data, error } = await db().rpc("timeline_apply", {
    p_user_id: userId,
    p_source: source,
    p_rekeys: d.rekeys.map((r) => ({ id: r.id, new_external_id: r.newExternalId })),
    p_upserts: d.upserts.map(upsertRow),
    p_remove_ids: d.removeIds,
  });
  if (error) fail("applyDiffRpc", error.message);
  if (Array.isArray(data)) {
    for (const x of data) {
      if (isJsonObject(x) && typeof x.id === "string" && typeof x.external_id === "string") map.set(x.external_id, x.id);
    }
  }
  return map;
}

/**
 * One live item, owner-scoped.
 * @param userId owner
 * @param itemId row id (non-uuid → null)
 * @returns the item, or null
 */
export async function getItem(userId: string, itemId: string): Promise<TimelineItem | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) return null;
  const { data, error } = await db()
    .from("timeline_items")
    .select(COLUMNS)
    .eq("user_id", userId)
    .eq("id", itemId)
    .is("removed_at", null)
    .maybeSingle();
  if (error) fail("getItem", error.message);
  return data ? rowToItem(data) : null;
}

/**
 * Set an item's status (owner-scoped, live rows only). A no-op when unchanged.
 * @param userId owner
 * @param itemId row id
 * @param status new status
 * @returns before/after, or null when not found
 */
export async function updateStatus(
  userId: string,
  itemId: string,
  status: TimelineStatus,
): Promise<{ before: TimelineItem; after: TimelineItem } | null> {
  const before = await getItem(userId, itemId);
  if (!before) return null;
  if (before.status === status) return { before, after: before };
  const { data, error } = await db()
    .from("timeline_items")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", itemId)
    .is("removed_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) fail("updateStatus", error.message);
  return data ? { before, after: rowToItem(data) } : null;
}

/**
 * Live items whose id starts with `hex8` (index-backed uuid range scan). At most 2 rows.
 * @param userId owner
 * @param hex8 first 8 hex characters of the id
 * @returns `{id}` rows (2 ⇒ ambiguous)
 */
export async function findByRefPrefix(userId: string, hex8: string): Promise<{ id: string }[]> {
  const h = hex8.toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(h)) return [];
  const { data, error } = await db()
    .from("timeline_items")
    .select("id")
    .eq("user_id", userId)
    .is("removed_at", null)
    .gte("id", `${h}-0000-0000-0000-000000000000`)
    .lte("id", `${h}-ffff-ffff-ffff-ffffffffffff`)
    .limit(2);
  if (error) fail("findByRefPrefix", error.message);
  return data;
}

/**
 * Live date-only / floating items (the ones whose instants depend on the user's zone).
 * @param userId owner
 * @returns all-day items and items with an `F:` (floating) timing key
 */
export async function loadZoneDependent(userId: string): Promise<TimelineItem[]> {
  const out: TimelineItem[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db()
      .from("timeline_items")
      .select(COLUMNS)
      .eq("user_id", userId)
      .is("removed_at", null)
      .or("all_day.eq.true,timing_key.like.F:*")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) fail("loadZoneDependent", error.message);
    out.push(...data.map(rowToItem));
    if (data.length < PAGE) return out;
  }
}

/**
 * Overwrite an item's instants (rebase after a timezone change). Live rows only.
 * @param userId owner
 * @param itemId row id
 * @param t new instants
 */
export async function updateInstants(
  userId: string,
  itemId: string,
  t: { startsAt: Date | null; endsAt: Date | null; dueAt: Date | null },
): Promise<void> {
  const { error } = await db()
    .from("timeline_items")
    .update({
      starts_at: t.startsAt?.toISOString() ?? null,
      ends_at: t.endsAt?.toISOString() ?? null,
      due_at: t.dueAt?.toISOString() ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", itemId)
    .is("removed_at", null);
  if (error) fail("updateInstants", error.message);
}

/**
 * The user's IANA zone (validated; default America/New_York).
 * @param userId owner
 * @returns a zone safe for tz.ts
 */
export async function getUserTimezone(userId: string): Promise<string> {
  const { data, error } = await db().from("users").select("timezone").eq("id", userId).maybeSingle();
  if (error) fail("getUserTimezone", error.message);
  return safeTimeZone(data?.timezone);
}
