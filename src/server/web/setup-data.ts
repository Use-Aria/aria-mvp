import "server-only";
/**
 * /setup data access (web plan §7.4). OWNER: 1.6. Returns a view model only: plain values,
 * dates preformatted where the UI shows them, never `enc_*` columns or raw rows.
 */
import { db } from "@/server/db";
import { getCanvasStatus, type CanvasStatusView } from "@/server/integrations/canvas";
import { getGoogleStatus, type GoogleStatusView } from "@/server/integrations/google";
import { maskHandle } from "@/server/phone";
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

/**
 * Whose Aria this session belongs to, masked (5.5 #13): a forwarded setup link signs the reader
 * in as the sender, so /setup shows the sender's masked handle next to "Connect Google".
 * Copy (masked + screen-reader text) is in `SETUP_COPY.google.textingAs`.
 */
export type TextingAsView = { kind: "phone"; last4: string } | { kind: "email"; domain: string };

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
  /** The account's primary messaging handle, masked; null when unknown. */
  textingAs: TextingAsView | null;
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
 * Masks a messaging handle for display through the log masker (`maskHandle`), so the page never
 * shows more of a handle than the logs do.
 * @param handle E.164 phone or Apple ID email, or null
 * @returns last 4 digits (phone) or the email domain, or null when nothing safe is left
 */
export function textingAsView(handle: string | null | undefined): TextingAsView | null {
  if (!handle) return null;
  const masked = maskHandle(handle);
  const email = /^\*{3}@([^\s@]+)$/.exec(masked);
  if (email) return { kind: "email", domain: email[1] };
  const phone = /^\*{3}(\d{4})$/.exec(masked);
  return phone ? { kind: "phone", last4: phone[1] } : null;
}

/**
 * The account's primary channel handle (primary first, then oldest). Failures degrade to null.
 * @param userId owner
 * @returns the handle, or null
 */
async function primaryHandle(userId: string): Promise<string | null> {
  try {
    const { data, error } = await db()
      .from("channels")
      .select("handle")
      .eq("user_id", userId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    return data?.[0]?.handle ?? null;
  } catch (err) {
    console.error("[setup] channel lookup failed:", err instanceof Error ? err.message : "unknown");
    return null;
  }
}

/**
 * Loads the /setup view for the signed-in viewer. Integration status failures degrade to
 * "not connected" (logged) so one broken integration never blanks the page.
 * @param viewer the signed-in viewer
 * @param now clock (tests)
 * @returns the view model
 */
export async function getSetupView(viewer: Viewer, now: Date = new Date()): Promise<SetupView> {
  const [user, canvas, google, handle] = await Promise.all([
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
    primaryHandle(viewer.userId),
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
    textingAs: textingAsView(handle),
  };
}
