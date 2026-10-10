import "server-only";
/**
 * /setup data access (web plan §7.4). OWNER: 1.6. Returns a view model only: plain values,
 * dates preformatted where the UI shows them, never `enc_*` columns or raw rows.
 */
import { db } from "@/server/db";
import { getCanvasStatus, type CanvasStatusView } from "@/server/integrations/canvas";
import { getGoogleStatus, type GoogleStatusView } from "@/server/integrations/google";
import { canChangeIntegrations } from "@/server/security/sessions";
import { freshUntil } from "@/server/web/guard";
import type { Viewer } from "@/server/viewer";
import { parsePersonaPrefs, type Tone } from "@/shared/persona-prefs";
import { BRIEFING_OFF, DEFAULT_SCHEDULE, timeZoneLabel, toHHMM } from "@/shared/schedule-prefs";

/** Briefing and quiet-hours settings, as the Schedule form needs them. */
export interface SetupSchedule {
  /** "HH:MM" (the stored time even when the briefing is off). */
  briefingTime: string;
  briefingEnabled: boolean;
  /** Value for the briefing `<select>`: "HH:MM", or "off" when disabled. */
  briefingValue: string;
  quietStart: string;
  quietEnd: string;
  /** IANA zone. */
  timezone: string;
  /** e.g. "Eastern Time". */
  tzLabel: string;
}

/** Everything /setup renders. */
export interface SetupView {
  canvas: CanvasStatusView;
  google: GoogleStatusView;
  schedule: SetupSchedule;
  tone: Tone;
  /** Setup-scope session < 15 min old: may connect or disconnect accounts. */
  canChange: boolean;
  /** "3:42 PM" in the user's zone while `canChange`, else null. */
  freshUntilLabel: string | null;
  school: string | null;
}

function safeHHMM(value: string | null | undefined, fallback: string): string {
  try {
    return value ? toHHMM(value) : fallback;
  } catch {
    return fallback;
  }
}

function clockIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

/**
 * Loads the /setup view for the signed-in viewer. Integration status failures degrade to
 * "not connected" (logged) so one broken integration never blanks the page.
 * @param viewer the signed-in viewer
 * @param now clock (tests)
 * @returns the view model
 */
export async function getSetupView(viewer: Viewer, now: Date = new Date()): Promise<SetupView> {
  const [user, canvas, google] = await Promise.all([
    db()
      .from("users")
      .select("briefing_time, briefing_enabled, quiet_start, quiet_end, timezone, persona_prefs")
      .eq("id", viewer.userId)
      .maybeSingle(),
    getCanvasStatus(viewer.userId, now).catch((err: unknown): CanvasStatusView => {
      console.error("[setup] canvas status failed:", err instanceof Error ? err.message : "unknown");
      return { connected: false };
    }),
    getGoogleStatus(viewer.userId).catch((err: unknown): GoogleStatusView => {
      console.error("[setup] google status failed:", err instanceof Error ? err.message : "unknown");
      return { connected: false, reason: "error" };
    }),
  ]);
  if (user.error) throw new Error(`getSetupView failed: ${user.error.message}`);

  const row = user.data;
  const timezone = viewer.timezone;
  const briefingTime = safeHHMM(row?.briefing_time, DEFAULT_SCHEDULE.briefing);
  const briefingEnabled = row?.briefing_enabled ?? true;
  const until = freshUntil(viewer.session, now.getTime());

  return {
    canvas,
    google,
    schedule: {
      briefingTime,
      briefingEnabled,
      briefingValue: briefingEnabled ? briefingTime : BRIEFING_OFF,
      quietStart: safeHHMM(row?.quiet_start, DEFAULT_SCHEDULE.quietStart),
      quietEnd: safeHHMM(row?.quiet_end, DEFAULT_SCHEDULE.quietEnd),
      timezone,
      tzLabel: timeZoneLabel(timezone, now),
    },
    tone: parsePersonaPrefs(row?.persona_prefs).tone,
    canChange: canChangeIntegrations(viewer.session) && until !== null,
    freshUntilLabel: until ? clockIn(until, timezone) : null,
    school: viewer.school,
  };
}
