import "server-only";
// OWNER: 3.4
/* eslint-disable @typescript-eslint/no-unused-vars -- Wave 0 stub: params unused until 3.4 lands */

/**
 * Canvas connect / disconnect / status (master plan §1.11 = V2-05 §7.2 `connect.ts` verbatim).
 * Wave 0 stub: `getCanvasStatus` returns `{connected: false}`, everything else throws.
 */
import { notImplemented } from "@/server/_stub";
import type { ConnectSummaryShape } from "@/shared/canvas-guide";

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

/** Normalize → test-fetch (before saving, so a bad URL never replaces a good one) → save encrypted → initial sync → summary. Per-user rate limit 10/h. */
export async function connectCanvas(input: {
  userId: string;
  rawUrl: string;
  schoolName?: string | null;
  via?: "web" | "chat";
  now?: Date;
}): Promise<ConnectResult> {
  throw notImplemented("3.4");
}

/** Delete the integration row; soft-remove all canvas items (emits `removed` batch → V2-06 cancels nudges). */
export async function disconnectCanvas(userId: string): Promise<void> {
  throw notImplemented("3.4");
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
 * @returns status view (Wave 0: not connected)
 */
export async function getCanvasStatus(userId: string, now?: Date): Promise<CanvasStatusView> {
  return { connected: false };
}

/** Ask for an early sync (V2-07's Canvas due-change email hint, "refresh canvas"). Dedupe canvas_sync:<userId>. */
export async function requestCanvasSync(userId: string, reason: "email_hint" | "manual"): Promise<void> {
  throw notImplemented("3.4");
}
