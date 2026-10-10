import "server-only";
/**
 * Page and action guards for the web app (web plan §2.3, §7.1; master plan §1.15). OWNER: 1.6.
 *
 * Pages read with any valid session. Every server action re-checks inside the action
 * (render-time gating is never trusted): Origin must equal `appOrigin()`, then the session
 * must meet the action's freshness level.
 */
import { headers } from "next/headers";
import { appOrigin } from "@/server/env";
import { RECENT_SESSION_MS, SETUP_FRESH_MS } from "@/server/security/link-policy";
import type { WebSession } from "@/server/security/sessions";
import { currentViewer, type Viewer } from "@/server/viewer";

/** Freshness an action needs: any session, a < 60 min one, or a < 15 min setup-scope one. */
export type Need = "any" | "recent" | "fresh_setup";

/** Why an action refused to run. */
export type GuardFailCode = "signed_out" | "needs_recent_link" | "needs_fresh_link" | "bad_origin";

/** Result of `requireActionViewer`. */
export type ActionViewerResult = { ok: true; viewer: Viewer } | { ok: false; code: GuardFailCode };

/**
 * The viewer for a page render (cached per request). Pages render `SignedOut` on null.
 * @returns viewer or null
 */
export async function requireViewer(): Promise<Viewer | null> {
  return currentViewer();
}

/**
 * Whether the session was created less than an hour ago (any scope).
 * @param session web session
 * @param now epoch ms
 * @returns true when recent
 */
export function isRecent(session: WebSession, now: number = Date.now()): boolean {
  return now - session.createdAt.getTime() < RECENT_SESSION_MS;
}

/**
 * When a setup-scope session stops being allowed to change integrations.
 * @param session web session
 * @param now epoch ms
 * @returns the deadline, or null for a view session or one that is already past it
 */
export function freshUntil(session: WebSession, now: number = Date.now()): Date | null {
  if (session.scope !== "setup") return null;
  const until = session.createdAt.getTime() + SETUP_FRESH_MS;
  return now < until ? new Date(until) : null;
}

/**
 * Exact Origin comparison (scheme, host, and port). Missing, `null`, or malformed → false.
 * @param origin the request's Origin header
 * @param expected `appOrigin()`
 * @returns true only on an exact origin match
 */
export function originMatches(origin: string | null | undefined, expected: string): boolean {
  if (!origin || origin === "null") return false;
  try {
    const parsed = new URL(origin).origin;
    // The header must already be a bare origin (no path, query, or trailing slash).
    return parsed === origin.toLowerCase() && parsed === new URL(expected).origin;
  } catch {
    return false;
  }
}

/**
 * Pure freshness check.
 * @param session the viewer's session
 * @param need required level
 * @param now epoch ms
 * @returns null when allowed, else the failure code
 */
export function sessionFailsNeed(
  session: WebSession,
  need: Need,
  now: number = Date.now(),
): "needs_recent_link" | "needs_fresh_link" | null {
  if (need === "recent" && !isRecent(session, now)) return "needs_recent_link";
  if (need === "fresh_setup" && !freshUntil(session, now)) return "needs_fresh_link";
  return null;
}

/**
 * Guard for server actions and mutating route handlers: Origin, then session, then freshness.
 * @param need freshness level for this mutation
 * @returns the viewer, or a code the form turns into copy (never throws for these cases)
 */
export async function requireActionViewer(need: Need): Promise<ActionViewerResult> {
  const origin = (await headers()).get("origin");
  if (!originMatches(origin, appOrigin())) return { ok: false, code: "bad_origin" };
  const viewer = await currentViewer();
  if (!viewer) return { ok: false, code: "signed_out" };
  const failed = sessionFailsNeed(viewer.session, need);
  return failed ? { ok: false, code: failed } : { ok: true, viewer };
}
