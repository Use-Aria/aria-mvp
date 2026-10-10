import "server-only";
// OWNER: 4.6

/**
 * /settings data access (web plan §7.6, §9.4). Returns a view model only: plain strings and
 * booleans, dates preformatted in the user's zone, display text passed through `cleanText`
 * (bidi/zero-width controls stripped), never `enc_*` columns or raw rows.
 */
import { getCanvasStatus, type CanvasStatusView } from "@/server/integrations/canvas";
import { getGoogleStatus, type GoogleStatusView } from "@/server/integrations/google";
import { listMemory, type MemoryView } from "@/server/memory";
import { canChangeIntegrations } from "@/server/security/sessions";
import { freshUntil, isRecent } from "@/server/web/guard";
import type { Viewer } from "@/server/viewer";
import { cleanText } from "@/shared/safe-url";

/** Refusal codes `/api/me/export` sends back as `/settings?export=<code>`. */
export const EXPORT_REFUSAL_CODES = ["signed_out", "needs_fresh_link", "rate_limited", "server"] as const;
/** One of `EXPORT_REFUSAL_CODES`. */
export type ExportRefusal = (typeof EXPORT_REFUSAL_CODES)[number];

/**
 * Allow-list a `?export=` query value (never echo query text).
 * @param value raw query param
 * @returns the code, or null
 */
export function parseExportRefusal(value: unknown): ExportRefusal | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && (EXPORT_REFUSAL_CODES as readonly string[]).includes(v) ? (v as ExportRefusal) : null;
}

/** One editable memory row. */
export interface SettingsMemoryRow {
  id: string;
  text: string;
}

/** A remembered fact with its "Saved Oct 9" label. */
export interface SettingsFactRow extends SettingsMemoryRow {
  savedLabel: string;
}

/** "What Aria knows about you", ready to render. */
export interface SettingsMemory {
  profile: { name: string | null; school: string | null; courses: string[] };
  /** Active preferences ("How you like things"). */
  preferences: SettingsMemoryRow[];
  /** Proposed or queued preferences ("Aria's suggestions"). */
  proposed: SettingsMemoryRow[];
  facts: SettingsFactRow[];
  /** Nothing at all is known (no profile values, preferences, or facts). */
  empty: boolean;
}

/** Everything /settings renders. */
export interface SettingsView {
  canvas: CanvasStatusView;
  google: GoogleStatusView;
  memory: SettingsMemory;
  /** Setup-scope session < 15 min old: may export or delete the account. */
  canChange: boolean;
  /** Session < 60 min old: may edit memories and keep suggestions. */
  isRecent: boolean;
  /** "3:42 PM" in the user's zone while `canChange`, else null. */
  freshUntilLabel: string | null;
}

function clockIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(date);
}

/**
 * Turn the memory API's view into display rows (pure).
 * @param view `listMemory` result
 * @param timeZone the viewer's IANA zone (for "Saved Oct 9")
 * @returns cleaned, preformatted rows
 */
export function toSettingsMemory(view: MemoryView, timeZone: string): SettingsMemory {
  const name = view.profile.name ? cleanText(view.profile.name, 120) || null : null;
  const school = view.profile.school ? cleanText(view.profile.school, 120) || null : null;
  const courses = view.profile.courses.map((c) => cleanText(c, 80)).filter(Boolean);
  const row = (p: MemoryView["preferences"][number]): SettingsMemoryRow => ({ id: p.id, text: cleanText(p.statement, 280) });
  const preferences = view.preferences.filter((p) => p.status === "active").map(row);
  const proposed = view.preferences.filter((p) => p.status === "proposed").map(row);
  const facts = view.facts.map((f) => ({ id: f.id, text: cleanText(f.content, 500), savedLabel: dayIn(f.createdAt, timeZone) }));
  const empty = !name && !school && courses.length === 0 && preferences.length === 0 && proposed.length === 0 && facts.length === 0;
  return { profile: { name, school, courses }, preferences, proposed, facts, empty };
}

/**
 * Loads the /settings view for the signed-in viewer. Integration status failures degrade to
 * "not connected" (logged) so one broken integration never blanks the page; a memory read
 * failure throws (the error boundary offers a retry).
 * @param viewer the signed-in viewer
 * @param now clock (tests)
 * @returns the view model
 */
export async function getSettingsView(viewer: Viewer, now: Date = new Date()): Promise<SettingsView> {
  const [canvas, google, memory] = await Promise.all([
    getCanvasStatus(viewer.userId, now).catch((err: unknown): CanvasStatusView => {
      console.error("[settings] canvas status failed:", err instanceof Error ? err.message : "unknown");
      return { connected: false };
    }),
    getGoogleStatus(viewer.userId).catch((err: unknown): GoogleStatusView => {
      console.error("[settings] google status failed:", err instanceof Error ? err.message : "unknown");
      return { connected: false, reason: "error" };
    }),
    listMemory(viewer.userId),
  ]);
  const until = freshUntil(viewer.session, now.getTime());
  return {
    canvas,
    google,
    memory: toSettingsMemory(memory, viewer.timezone),
    canChange: canChangeIntegrations(viewer.session) && until !== null,
    isRecent: isRecent(viewer.session, now.getTime()),
    freshUntilLabel: until ? clockIn(until, viewer.timezone) : null,
  };
}
