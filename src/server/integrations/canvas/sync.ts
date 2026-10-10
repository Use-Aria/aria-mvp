import "server-only";
// OWNER: 3.4

/**
 * Canvas sync (master plan §1.11 = V2-05 §7.2 `sync.ts`; §2.4, §2.5, §2.7).
 *
 * Lease → decrypt → SSRF-safe fetch → feed-hash skip → lex → parse → Canvas proof (unlisted
 * hosts) → `applySnapshot` (which enqueues the `timeline_changes` batch after commit) → schedule
 * the next hourly slot. Failures are recorded on the integration row (backoff, revoke after 3
 * definitive failures over ≥ 2h, a one-time notice after 48h of outage) and never thrown: the job
 * handler returns normally so there is no double backoff with the dispatcher.
 *
 * The feed URL is never logged; logs carry the host and `fp8` only. Canvas titles stay in the
 * timeline (third-party text; model-facing reads wrap them with `wrapUntrusted`).
 */
import { createHash } from "node:crypto";
import { deliver } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import { optionalEnv } from "@/server/env";
import {
  fetchCanvasFeed,
  isAcceptableFeedSource,
  MAX_FEED_BYTES,
  type FeedFetchClass,
  type FeedFetchErrorCode,
  type FeedFetchOk,
  type FetchFeedOptions,
} from "@/server/integrations/canvas/fetch-feed";
import { IcsParseError, lexIcs } from "@/server/integrations/canvas/ics";
import { parseCanvasFeed, type ParsedCanvasFeed } from "@/server/integrations/canvas/parse";
import { decideAfterFailure, nextHourlySync } from "@/server/integrations/canvas/schedule";
import {
  claimSyncLease,
  getCanvasIntegration,
  markStatusNotified,
  readFeedUrl,
  readUserTimezone,
  recordSyncFailure,
  recordSyncSuccess,
  releaseSyncLease,
  setNextSyncAt,
  type CanvasIntegration,
} from "@/server/integrations/canvas/store";
import { refreshProfileBlock } from "@/server/memory";
import { mintMagicLink } from "@/server/security/magic-links";
import { applySnapshot, listCourses } from "@/server/timeline";
import type { ApplyResult, TimelineKind } from "@/server/timeline/types";
import type { CanvasFeedUrl } from "@/shared/canvas-url";
import { courseKey } from "@/shared/course-key";

export type CanvasSyncReason = "scheduled" | "connect" | "manual" | "email_hint";
export type CanvasSyncOutcome =
  | {
      ok: true;
      skipped: "unchanged" | "lease_held" | "disabled" | null;
      initial: boolean;
      result: ApplyResult;
      warnings: ParsedCanvasFeed["warnings"];
    }
  | {
      ok: false;
      code: FeedFetchErrorCode | "parse_error" | "not_canvas" | "no_integration" | "internal";
      cls: FeedFetchClass;
    };

/** Injectable seams (tests and the smoke run serve fixture ICS through a fake transport). */
export interface CanvasSyncDeps {
  /** resolver / transport / limits for `fetchCanvasFeed` */
  fetchOptions?: FetchFeedOptions;
  /** jitter source for scheduling and backoff (default `Math.random`) */
  rand?: () => number;
  /** kill-switch override (default: `CANVAS_SYNC_DISABLED === "1"`) */
  disabled?: boolean;
}

/** A fetched body that lexed, parsed and passed the Canvas-source check. */
export interface PreparedFeed {
  url: CanvasFeedUrl;
  parsed: ParsedCanvasFeed;
  feedHash: string;
  timezone: string;
}

const NO_WARNINGS: ParsedCanvasFeed["warnings"] = Object.freeze({
  duplicateUids: 0,
  skippedNoStart: 0,
  skippedNoUid: 0,
  capSaturated: Object.freeze({ assignments: false, events: false }),
}) as ParsedCanvasFeed["warnings"];

/** Link validity window for the revoke notice (magic `setup` links live 30 min). */
const NOTICE_LINK_WINDOW_MS = 25 * 60_000;

// ── pure helpers (unit-tested in tests/unit/canvas/schedule-io.test.ts) ─────

/**
 * Feed fingerprint for the "unchanged" skip: sha256(body ‖ tz), so a timezone change re-parses.
 * @param body raw feed bytes
 * @param timezone the user's zone at sync time
 * @returns 64 hex chars
 */
export function feedHashOf(body: Uint8Array, timezone: string): string {
  return createHash("sha256").update(body).update("\u0000").update(timezone, "utf8").digest("hex");
}

/**
 * Timeline kinds whose removals must be skipped because Canvas truncated the feed (≥ 1,000 items).
 * @param w parse warnings
 * @returns kinds for `applySnapshot({capSaturatedKinds})`
 */
export function capSaturatedKindsOf(w: ParsedCanvasFeed["warnings"]): TimelineKind[] {
  const out: TimelineKind[] = [];
  if (w.capSaturated.assignments) out.push("assignment", "exam");
  if (w.capSaturated.events) out.push("event");
  return out;
}

/**
 * Whether a sync may skip parse + diff: same body and zone as last time, not the initial sync,
 * and no deferred removals waiting to be re-checked.
 * @param i.initial initial sync after connect / URL change
 * @param i.feedHash this body's hash
 * @param i.previousHash `integrations.feed_hash`
 * @param i.lastError `integrations.last_error`
 * @returns true to skip
 */
export function shouldSkipUnchanged(i: {
  initial: boolean;
  feedHash: string;
  previousHash: string | null;
  lastError: string | null;
}): boolean {
  return !i.initial && i.previousHash !== null && i.previousHash === i.feedHash && i.lastError !== "removal_deferred";
}

/**
 * Whether two course lists differ as sets of `courseKey`s (profile refresh trigger, V2-05 §2.9).
 * @param before course labels before the sync
 * @param after course labels after the sync
 * @returns true when a course appeared or disappeared
 */
export function courseSetChanged(before: readonly string[], after: readonly string[]): boolean {
  const keys = (list: readonly string[]) => new Set(list.map((c) => courseKey(c) ?? c.trim().toLowerCase()));
  const a = keys(before);
  const b = keys(after);
  if (a.size !== b.size) return true;
  for (const k of a) if (!b.has(k)) return true;
  return false;
}

/**
 * Lexes, parses and checks a fetched body (no DB).
 * @param fetched successful fetch
 * @param timezone the user's zone (date-only due dates are 23:59 local)
 * @returns the prepared feed, or `parse_error` (not an iCalendar body) / `not_canvas` (unlisted host
 *   without Canvas proof)
 */
export function prepareFeed(
  fetched: FeedFetchOk,
  timezone: string,
): { ok: true; feed: PreparedFeed } | { ok: false; code: "parse_error" | "not_canvas" } {
  let parsed: ParsedCanvasFeed;
  try {
    parsed = parseCanvasFeed(lexIcs(fetched.body), { timezone, host: fetched.finalUrl.host });
  } catch (e) {
    if (e instanceof IcsParseError) return { ok: false, code: "parse_error" };
    throw e;
  }
  if (!isAcceptableFeedSource(fetched, parsed.looksLikeCanvas)) return { ok: false, code: "not_canvas" };
  return { ok: true, feed: { url: fetched.finalUrl, parsed, feedHash: feedHashOf(fetched.body, timezone), timezone } };
}

/**
 * An `ApplyResult` with nothing applied (skipped syncs).
 * @returns zero counts and an empty, non-initial batch
 */
export function emptyApplyResult(): ApplyResult {
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
 * Fetch options with the env body cap applied (`CANVAS_FEED_MAX_BYTES`, default 10 MiB).
 * @param o caller overrides
 * @returns options for `fetchCanvasFeed`
 */
export function withEnvLimits(o: FetchFeedOptions = {}): FetchFeedOptions {
  if (o.maxBytes !== undefined) return o;
  const raw = Number(optionalEnv("CANVAS_FEED_MAX_BYTES"));
  return Number.isFinite(raw) && raw > 0 ? { ...o, maxBytes: Math.min(raw, MAX_FEED_BYTES) } : o;
}

/** First 8 hex of the URL fingerprint: the only feed identifier that may appear in logs. */
function fp8(i: Pick<CanvasIntegration, "urlFp"> | null): string {
  return i?.urlFp?.slice(0, 8) ?? "none";
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

// ── commit (shared with connect) ────────────────────────────────────────────

/**
 * Applies a prepared feed: `applySnapshot` (change batch enqueued after commit), success
 * bookkeeping + next hourly slot, and a profile refresh when the course set changed.
 * The caller holds the sync lease.
 * @param userId owner
 * @param feed prepared feed
 * @param o.now clock
 * @param o.initial initial sync (all hints "none"; guard off)
 * @param o.deferredLastTime removals were deferred by the guard on the previous sync
 * @param o.rand jitter source
 * @returns the apply result
 * @throws on DB errors (nothing recorded as success)
 */
export async function commitPreparedFeed(
  userId: string,
  feed: PreparedFeed,
  o: { now: Date; initial: boolean; deferredLastTime: boolean; rand?: () => number },
): Promise<ApplyResult> {
  const coursesBefore = await listCourses(userId, o.now).catch(() => null);
  const result = await applySnapshot({
    userId,
    source: "canvas",
    items: feed.parsed.items,
    now: o.now,
    initial: o.initial,
    removalGuard: { enabled: !o.initial, deferredLastTime: o.deferredLastTime },
    capSaturatedKinds: capSaturatedKindsOf(feed.parsed.warnings),
  });
  await recordSyncSuccess(userId, {
    feedHash: feed.feedHash,
    nextSyncAt: nextHourlySync(userId, o.now, o.rand),
    lastError: result.removalsDeferred > 0 ? "removal_deferred" : null,
    now: o.now,
  });
  if (result.batch.changes.length > 0 || o.initial) {
    try {
      const after = await listCourses(userId, o.now);
      if (coursesBefore === null || courseSetChanged(coursesBefore, after)) await refreshProfileBlock(userId);
    } catch (e) {
      console.warn(`[canvas] profile refresh failed: ${errName(e)}`);
    }
  }
  return result;
}

// ── sync ────────────────────────────────────────────────────────────────────

/**
 * Lease → decrypt → fetch → lex → parse → applySnapshot (enqueues the change batch) → schedule next;
 * failure bookkeeping; one-time notices. Never throws.
 * @param userId owner
 * @param opts reason, clock, a URL override (connect), and a forced initial flag
 * @returns outcome (skips are `ok: true` with `skipped` set)
 */
export async function runCanvasSync(
  userId: string,
  opts: { reason: CanvasSyncReason; now?: Date; urlOverride?: CanvasFeedUrl; initial?: boolean },
): Promise<CanvasSyncOutcome> {
  return runCanvasSyncWith(userId, opts, {});
}

/**
 * {@link runCanvasSync} with injectable fetch / jitter / kill-switch (tests, smoke).
 * @param userId owner
 * @param opts as for `runCanvasSync`
 * @param deps seams
 * @returns outcome
 */
export async function runCanvasSyncWith(
  userId: string,
  opts: { reason: CanvasSyncReason; now?: Date; urlOverride?: CanvasFeedUrl; initial?: boolean },
  deps: CanvasSyncDeps,
): Promise<CanvasSyncOutcome> {
  const now = opts.now ?? new Date();
  let integ: CanvasIntegration | null;
  try {
    integ = await getCanvasIntegration(userId);
  } catch (e) {
    console.error(`[canvas] sync: integration read failed: ${errName(e)}`);
    return { ok: false, code: "internal", cls: "transient" };
  }
  if (!integ || integ.status === "revoked" || integ.status === "disconnected") {
    return { ok: false, code: "no_integration", cls: "rejected" };
  }

  const disabled = deps.disabled ?? optionalEnv("CANVAS_SYNC_DISABLED") === "1";
  if (disabled) {
    try {
      await setNextSyncAt(userId, nextHourlySync(userId, now, deps.rand));
    } catch (e) {
      console.error(`[canvas] sync: reschedule (disabled) failed: ${errName(e)}`);
    }
    return { ok: true, skipped: "disabled", initial: false, result: emptyApplyResult(), warnings: NO_WARNINGS };
  }

  let leased = false;
  try {
    leased = await claimSyncLease(userId);
  } catch (e) {
    console.error(`[canvas] sync: lease claim failed: ${errName(e)}`);
    return { ok: false, code: "internal", cls: "transient" };
  }
  if (!leased) return { ok: true, skipped: "lease_held", initial: false, result: emptyApplyResult(), warnings: NO_WARNINGS };

  const initial = opts.initial ?? integ.syncedAt === null;
  try {
    const url = opts.urlOverride ?? (await readFeedUrl(userId));
    if (!url) return await failSync(userId, integ, "no_integration", "rejected", now, deps);

    const fetched = await fetchCanvasFeed(url, withEnvLimits(deps.fetchOptions));
    if (!fetched.ok) return await failSync(userId, integ, fetched.code, fetched.cls, now, deps);

    const tz = await readUserTimezone(userId);
    const hash = feedHashOf(fetched.body, tz);
    if (shouldSkipUnchanged({ initial, feedHash: hash, previousHash: integ.feedHash, lastError: integ.lastError })) {
      await recordSyncSuccess(userId, { feedHash: hash, nextSyncAt: nextHourlySync(userId, now, deps.rand), lastError: null, now });
      return { ok: true, skipped: "unchanged", initial: false, result: emptyApplyResult(), warnings: NO_WARNINGS };
    }

    const prepared = prepareFeed(fetched, tz);
    if (!prepared.ok) return await failSync(userId, integ, prepared.code, "definitive", now, deps);

    const result = await commitPreparedFeed(userId, prepared.feed, {
      now,
      initial,
      deferredLastTime: integ.lastError === "removal_deferred",
      rand: deps.rand,
    });
    console.info(
      `[canvas] sync ok host=${prepared.feed.url.host} fp=${fp8(integ)} reason=${opts.reason} initial=${initial} ` +
        `items=${prepared.feed.parsed.items.length} created=${result.created} due=${result.dueChanged} ` +
        `removed=${result.removed} deferred=${result.removalsDeferred}`,
    );
    return { ok: true, skipped: null, initial, result, warnings: prepared.feed.parsed.warnings };
  } catch (e) {
    console.error(`[canvas] sync failed host=${integ.host ?? "?"} fp=${fp8(integ)}: ${errName(e)}`);
    try {
      return await failSync(userId, integ, "internal", "transient", now, deps);
    } catch {
      return { ok: false, code: "internal", cls: "transient" };
    }
  } finally {
    await releaseSyncLease(userId).catch((e: unknown) => console.error(`[canvas] lease release failed: ${errName(e)}`));
  }
}

/** Records the failure, applies the decision, sends the one-time notice, and returns the outcome. */
async function failSync(
  userId: string,
  integ: CanvasIntegration,
  code: FeedFetchErrorCode | "parse_error" | "not_canvas" | "no_integration" | "internal",
  cls: FeedFetchClass,
  now: Date,
  deps: CanvasSyncDeps,
): Promise<CanvasSyncOutcome> {
  const decision = decideAfterFailure({
    cls,
    consecutiveFailures: integ.consecutiveFailures + 1,
    firstFailureAt: integ.firstFailureAt,
    now,
    alreadyNotified: integ.statusNotifiedAt !== null,
    rand: deps.rand,
  });
  await recordSyncFailure(userId, { code, decision, now, prev: integ });
  console.warn(
    `[canvas] sync failed host=${integ.host ?? "?"} fp=${fp8(integ)} code=${code} cls=${cls} ` +
      `n=${integ.consecutiveFailures + 1} action=${decision.action}`,
  );
  if (decision.action === "revoke") await notifyOnce(userId, "revoked", fp8(integ), integ);
  else if (decision.action === "error_notify") await notifyOnce(userId, "error", fp8(integ), integ);
  return { ok: false, code, cls };
}

// ── one-time notices ─────────────────────────────────────────────────────────

/** Copy for the one-time "Canvas broke" notices (plain text, iMessage). */
export const CANVAS_NOTICE_COPY = Object.freeze({
  revoked:
    "heads up: Canvas stopped sharing your calendar with me (the feed link was probably reset), so I can't see new deadlines.",
  revokedLink: "grab a fresh Calendar Feed link from Canvas and paste it here, or use this:",
  revokedNoLink: 'paste a fresh Calendar Feed link from Canvas here, or text me "canvas" for a setup link.',
  error:
    "heads up: I haven't been able to reach your Canvas calendar for a couple of days, so deadlines might be out of date. I'll keep trying.",
});

/**
 * Sends the revoke / long-outage notice at most once (`status_notified_at` claim + proactive dedupe).
 * The revoke notice carries a `setup` magic link when it can go out before the link expires;
 * otherwise (deferred by quiet hours / pause, or no link) a link-free version is queued.
 */
async function notifyOnce(userId: string, kind: "revoked" | "error", fp: string, integ: CanvasIntegration): Promise<void> {
  try {
    if (!(await markStatusNotified(userId))) return;
    if (kind === "error") {
      const key = `canvas_error:${userId}:${(integ.firstFailureAt ?? new Date()).getTime()}`;
      await deliver(userId, textPlan([CANVAS_NOTICE_COPY.error]), { proactive: true, reason: "canvas_feed_error", dedupeKey: key });
      return;
    }
    const key = `canvas_revoked:${userId}:${fp}`;
    const link = await mintMagicLink({ userId, purpose: "setup", preview: { kind: "setup" } }).catch(() => null);
    if (link) {
      const r = await deliver(userId, textPlan([CANVAS_NOTICE_COPY.revoked, CANVAS_NOTICE_COPY.revokedLink], link), {
        proactive: true,
        reason: "canvas_feed_revoked",
        dedupeKey: key,
        expiresAt: new Date(Date.now() + NOTICE_LINK_WINDOW_MS),
        deferMode: "return",
      });
      const fallback = r.status === "deferred" || (r.status === "suppressed" && r.reason === "expired");
      if (!fallback) return;
    }
    await deliver(userId, textPlan([CANVAS_NOTICE_COPY.revoked, CANVAS_NOTICE_COPY.revokedNoLink]), {
      proactive: true,
      reason: "canvas_feed_revoked",
      dedupeKey: `${key}:nolink`,
    });
  } catch (e) {
    console.error(`[canvas] ${kind} notice failed fp=${fp}: ${errName(e)}`);
  }
}
