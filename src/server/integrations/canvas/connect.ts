import "server-only";
// OWNER: 3.4

/**
 * Canvas connect / disconnect / status (master plan §1.11 = V2-05 §7.2 `connect.ts`; §2.9).
 *
 * - `connectCanvas` re-checks everything security-relevant itself (URL policy, SSRF-safe fetch,
 *   Canvas proof for unlisted hosts, its own per-user rate limit), so it is safe for both callers:
 *   the web server action (4.5) and the `connect_canvas` tool (which first proves the URL is
 *   user-authored). It test-fetches BEFORE saving, so a bad URL never replaces a good one.
 * - Web connects get a chat confirmation via `deliver(…, {proactive: false, reason:
 *   "canvas_connected"})`; chat connects return the text for the agent's own reply.
 * - There is no `/api/canvas/connect` route (master plan §1.11).
 * - The feed URL is never logged (host + fp8 only).
 */
import { deliver } from "@/server/channels/deliver";
import { textPlan } from "@/server/channels/plan";
import { enqueueJob, cancelJobs } from "@/server/jobs/enqueue";
import { fetchCanvasFeed, type FeedFetchErrorCode } from "@/server/integrations/canvas/fetch-feed";
import {
  claimSyncLease,
  deleteCanvasIntegration,
  feedUrlFingerprint,
  getCanvasIntegration,
  readFeedUrl,
  readUserTimezone,
  releaseSyncLease,
  saveCanvasIntegration,
} from "@/server/integrations/canvas/store";
import { commitPreparedFeed, prepareFeed, withEnvLimits, type CanvasSyncDeps } from "@/server/integrations/canvas/sync";
import { getProfile, refreshProfileBlock } from "@/server/memory";
import { setProfileSchool } from "@/server/memory/web";
import { rateLimit } from "@/server/ratelimit";
import { deleteTimelineItems, summarizeUpcoming } from "@/server/timeline";
import { CANVAS_ERROR_COPY, formatConnectSummary, type ConnectSummaryShape } from "@/shared/canvas-guide";
import { feedUrlHint, normalizeCanvasFeedUrl, type FeedUrlError } from "@/shared/canvas-url";
import { OTHER_UNIVERSITY } from "@/shared/universities";

export type CanvasConnectError =
  | "not_a_url"
  | "not_ical"
  | "course_feed"
  | "not_canvas"
  | "private_address"
  | "feed_not_found"
  | "unreachable"
  | "timeout"
  | "too_large"
  | "forbidden"
  | "rate_limited"
  | "already_connected_elsewhere"
  | "not_user_authored"
  | "no_url_found"
  | "multiple_urls"
  | "internal";
export type ConnectResult =
  | { ok: true; host: string; itemCount: number; upcomingCount: number; summary: ConnectSummaryShape; text: string }
  | { ok: false; code: CanvasConnectError; text: string };

/** Per-user connect attempts per hour (shared by the web and chat paths). */
export const CONNECT_LIMIT_PER_HOUR = 10;
const LEASE_WAIT_MS = 5_000;
const LEASE_POLL_MS = 500;

/** Seams for {@link connectCanvasWith} (tests and smoke inject a fixture transport). */
export interface CanvasConnectDeps extends CanvasSyncDeps {
  /** rate limiter (default Upstash `rateLimit`; allows everything in dev without Upstash) */
  rateLimit?: (key: string, limit: number, windowSec: number) => Promise<boolean>;
}

// ── pure mappings (unit-tested) ─────────────────────────────────────────────

/**
 * Maps a URL-normalization failure to a connect error.
 * @param e `normalizeCanvasFeedUrl` error
 * @returns the user-facing error code
 */
export function connectErrorForUrl(e: FeedUrlError): CanvasConnectError {
  switch (e) {
    case "empty":
    case "not_a_url":
    case "bad_scheme":
      return "not_a_url";
    case "ip_literal":
      return "private_address";
    case "course_feed":
      return "course_feed";
    default:
      return "not_ical";
  }
}

/**
 * Maps a fetch / sync error code to a connect error (also used for the status view's `lastError`).
 * @param code fetch error code, `parse_error`, `not_canvas`, or another stored `last_error`
 * @returns the user-facing error code, or null for non-errors (`removal_deferred`, null)
 */
export function connectErrorForSync(code: FeedFetchErrorCode | string | null): CanvasConnectError | null {
  switch (code) {
    case null:
    case "removal_deferred":
      return null;
    case "feed_not_found":
      return "feed_not_found";
    case "forbidden":
      return "forbidden";
    case "timeout":
      return "timeout";
    case "too_large":
      return "too_large";
    case "not_calendar":
    case "parse_error":
      return "not_ical";
    case "not_canvas":
    case "redirect_rejected":
      return "not_canvas";
    case "non_public_address":
      return "private_address";
    case "rate_limited":
    case "server_error":
    case "dns_failed":
    case "tls_error":
    case "network":
    case "too_many_redirects":
      return "unreachable";
    default:
      return "internal";
  }
}

/**
 * Chat confirmation bubbles for a web connect.
 * @param summaryText `formatConnectSummary` output
 * @param deadlines upcoming deadline count
 * @returns one bubble, e.g. "canvas connected: found 14 deadlines across 4 courses — next up: …"
 */
export function connectedConfirmation(summaryText: string, deadlines: number): string {
  return deadlines > 0 ? `canvas connected: ${summaryText}` : `canvas ${summaryText}`;
}

function failed(code: CanvasConnectError): ConnectResult {
  return { ok: false, code, text: CANVAS_ERROR_COPY[code] };
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

async function claimLeaseWithWait(userId: string): Promise<boolean> {
  const until = Date.now() + LEASE_WAIT_MS;
  for (;;) {
    if (await claimSyncLease(userId)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, LEASE_POLL_MS));
  }
}

// ── connect ─────────────────────────────────────────────────────────────────

/**
 * Normalize → test-fetch (before saving, so a bad URL never replaces a good one) → save encrypted →
 * initial sync → summary. Per-user rate limit 10/h.
 * @param input owner, pasted URL, optional school (fills an empty profile school), caller, clock
 * @returns summary + copy, or an error code + copy
 */
export async function connectCanvas(input: {
  userId: string;
  rawUrl: string;
  schoolName?: string | null;
  via?: "web" | "chat";
  now?: Date;
}): Promise<ConnectResult> {
  return connectCanvasWith(input, {});
}

/**
 * {@link connectCanvas} with injectable fetch / rate limiter / jitter (tests, smoke).
 * @param input as for `connectCanvas`
 * @param deps seams
 * @returns as for `connectCanvas`
 */
export async function connectCanvasWith(
  input: { userId: string; rawUrl: string; schoolName?: string | null; via?: "web" | "chat"; now?: Date },
  deps: CanvasConnectDeps,
): Promise<ConnectResult> {
  const { userId } = input;
  const now = input.now ?? new Date();
  const via = input.via ?? "web";

  const normalized = normalizeCanvasFeedUrl(input.rawUrl);
  if (!normalized.ok) return failed(connectErrorForUrl(normalized.error));

  try {
    const limiter = deps.rateLimit ?? rateLimit;
    if (!(await limiter(`canvas_connect:${userId}`, CONNECT_LIMIT_PER_HOUR, 3600))) return failed("rate_limited");

    const fetched = await fetchCanvasFeed(normalized.url, withEnvLimits(deps.fetchOptions));
    if (!fetched.ok) {
      console.warn(`[canvas] connect fetch failed host=${normalized.url.host} code=${fetched.code} via=${via}`);
      return failed(connectErrorForSync(fetched.code) ?? "internal");
    }

    const tz = await readUserTimezone(userId);
    const prepared = prepareFeed(fetched, tz);
    if (!prepared.ok) {
      console.warn(`[canvas] connect rejected host=${fetched.finalUrl.host} code=${prepared.code} via=${via}`);
      return failed(prepared.code === "parse_error" ? "not_ical" : "not_canvas");
    }

    const saved = await saveCanvasIntegration(userId, prepared.feed.url, now);
    if (!saved.ok) return failed(saved.code);
    const fp = feedUrlFingerprint(prepared.feed.url.href).slice(0, 8);

    const integ = await getCanvasIntegration(userId);
    const initial = saved.urlChanged || integ?.syncedAt === null;
    if (await claimLeaseWithWait(userId)) {
      try {
        await commitPreparedFeed(userId, prepared.feed, {
          now,
          initial,
          deferredLastTime: !initial && integ?.lastError === "removal_deferred",
          rand: deps.rand,
        });
      } finally {
        await releaseSyncLease(userId).catch(() => undefined);
      }
    } else {
      // A scheduled sync holds the lease; the next one picks up the new URL (synced_at is null → initial).
      await requestCanvasSync(userId, "manual");
    }

    await fillSchool(userId, input.schoolName);
    const summary = await summarizeUpcoming(userId, "canvas", { timezone: tz, now });
    const text = formatConnectSummary(summary);
    console.info(
      `[canvas] connected host=${prepared.feed.url.host} fp=${fp} via=${via} initial=${initial} ` +
        `items=${prepared.feed.parsed.items.length} upcoming=${summary.deadlines}`,
    );

    if (via === "web") {
      try {
        await deliver(userId, textPlan([connectedConfirmation(text, summary.deadlines)]), {
          proactive: false,
          reason: "canvas_connected",
          dedupeKey: `canvas_connected:${fp}:${now.getTime()}`,
        });
      } catch (e) {
        console.error(`[canvas] connect confirmation failed: ${errName(e)}`);
      }
    }

    return {
      ok: true,
      host: prepared.feed.url.host,
      itemCount: prepared.feed.parsed.items.length,
      upcomingCount: summary.deadlines,
      summary,
      text,
    };
  } catch (e) {
    console.error(`[canvas] connect failed host=${normalized.url.host} via=${via}: ${errName(e)}`);
    return failed("internal");
  }
}

/** Sets the profile school from the connect form when the profile has none yet (best-effort). */
async function fillSchool(userId: string, schoolName: string | null | undefined): Promise<void> {
  const school = schoolName?.replace(/\s+/g, " ").trim();
  if (!school || school === OTHER_UNIVERSITY) return;
  try {
    const profile = await getProfile(userId);
    if (!profile.school) await setProfileSchool(userId, school);
  } catch (e) {
    console.warn(`[canvas] school fill failed: ${errName(e)}`);
  }
}

// ── disconnect / status / manual sync ───────────────────────────────────────

/**
 * Delete the integration row; soft-remove all canvas items (emits `removed` batch → V2-06 cancels
 * nudges); cancel pending syncs; refresh the profile block. Idempotent.
 * @param userId owner
 */
export async function disconnectCanvas(userId: string): Promise<void> {
  await deleteCanvasIntegration(userId);
  await cancelJobs({ dedupeKey: `canvas_sync:${userId}` });
  await deleteTimelineItems(userId, "canvas");
  await refreshProfileBlock(userId).catch((e: unknown) => console.warn(`[canvas] profile refresh failed: ${errName(e)}`));
  console.info("[canvas] disconnected");
}

export type CanvasStatusView =
  | { connected: false }
  | {
      connected: true;
      host: string;
      urlHint: string;
      syncedAt: Date | null;
      nextSyncAt: Date | null;
      health: "ok" | "failing" | "revoked";
      lastError: CanvasConnectError | null;
      upcomingCount: number;
    };

/**
 * Canvas connection status for /setup, /settings, `canvas_status`.
 * @param userId owner
 * @param now clock
 * @returns `{connected: false}` without a live row; otherwise host, a non-secret URL hint, sync
 *   times, health (`revoked` → reconnect; `failing` = error status or a failure streak), the last
 *   error as a connect error code, and the upcoming deadline count
 */
export async function getCanvasStatus(userId: string, now?: Date): Promise<CanvasStatusView> {
  const integ = await getCanvasIntegration(userId);
  if (!integ || integ.status === "disconnected") return { connected: false };
  const url = await readFeedUrl(userId);
  const summary = await summarizeUpcoming(userId, "canvas", { now: now ?? new Date() });
  const health = integ.status === "revoked" ? "revoked" : integ.status === "error" || integ.consecutiveFailures > 0 ? "failing" : "ok";
  return {
    connected: true,
    host: integ.host ?? url?.host ?? "canvas",
    urlHint: url ? feedUrlHint(url) : `${integ.host ?? "canvas"}/feeds/…`,
    syncedAt: integ.syncedAt,
    nextSyncAt: integ.nextSyncAt,
    health,
    lastError: health === "ok" ? null : connectErrorForSync(integ.lastError),
    upcomingCount: summary.deadlines,
  };
}

/**
 * Ask for an early sync (V2-07's Canvas due-change email hint, "refresh canvas"). Dedupe
 * `canvas_sync:<userId>` (a pending scheduled sync is pulled forward). No-op without a live
 * (active / error) integration.
 * @param userId owner
 * @param reason why
 */
export async function requestCanvasSync(userId: string, reason: "email_hint" | "manual"): Promise<void> {
  const integ = await getCanvasIntegration(userId);
  if (!integ || (integ.status !== "active" && integ.status !== "error")) return;
  await enqueueJob({ kind: "canvas_sync", userId, payload: { reason }, dedupeKey: `canvas_sync:${userId}`, mode: "replace" });
}
