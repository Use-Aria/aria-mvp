import "server-only";
// OWNER: 2.6

/**
 * Notification settings (master plan §1.14; V2-06 §7 `proactive/settings.ts`): briefing time and
 * on/off, default deadline-nudge offsets, quiet hours, template register. Writes go through
 * `updateNotificationSettings`, which always ends with `onUserScheduleSettingsChanged`.
 */
import { db } from "@/server/db";
import { effectiveQuietWindow } from "@/server/channels/guards";
import type { Service } from "@/server/channels/types";
import { onUserScheduleSettingsChanged } from "@/server/briefing/scheduler";
import { fromGuardWindow, type QuietWindow } from "@/server/proactive/schedule";
import type { Register } from "@/server/reminders/render";
import { parsePersonaPrefs, templateRegister } from "@/shared/persona-prefs";
import { isInDailyWindow, parseHHMM, safeTimeZone, type LocalTime } from "@/shared/time/tz";

export type { QuietWindow } from "@/server/proactive/schedule";
export type { Register } from "@/server/reminders/render";

export interface NotificationSettings {
  tz: string;
  briefingTime: LocalTime;
  briefingEnabled: boolean;
  /** minutes before each deadline; [] = auto nudges off */
  nudgeMinutes: number[];
  /** the user's own quiet hours (`users.quiet_start` / `quiet_end`) */
  quiet: QuietWindow;
  register: Register;
}

/** Everything schedulers need about a user in one read (internal to task 2.6 modules). */
export interface UserSchedule {
  userId: string;
  settings: NotificationSettings;
  /** quiet window actually enforced on the primary channel (SMS widened to 21:00–08:00) */
  effectiveQuiet: QuietWindow;
  service: Service;
  deleted: boolean;
  nextBriefingAt: Date | null;
}

/** A settings change the user asked for that can't be applied (message is user/model readable). */
export class NotificationSettingsError extends Error {
  readonly code: "briefing_in_quiet_hours" | "invalid_nudge_minutes" | "user_not_found";
  constructor(code: NotificationSettingsError["code"], message: string) {
    super(message);
    this.name = "NotificationSettingsError";
    this.code = code;
  }
}

const RECENT_TEXTS = 20;
const NUDGE_MIN = 15;
const NUDGE_MAX = 2_880;

function safeTime(t: string | null | undefined, fallback: string): LocalTime {
  try {
    return parseHHMM(t ?? fallback);
  } catch {
    return parseHHMM(fallback);
  }
}

function isService(s: string | null | undefined): s is Service {
  return s === "imessage" || s === "sms" || s === "rcs";
}

/** "10pm", "8:30am" for error texts. */
function clock(t: LocalTime): string {
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `${h12}${t.minute ? `:${String(t.minute).padStart(2, "0")}` : ""}${t.hour < 12 ? "am" : "pm"}`;
}

function hhmm(t: LocalTime): string {
  return `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/**
 * Load a user's schedule-relevant settings plus the primary channel's effective quiet window.
 * @param userId owner
 * @returns the schedule view, or null when the user doesn't exist
 * @throws on a DB error
 */
export async function loadUserSchedule(userId: string): Promise<UserSchedule | null> {
  const [userRes, chanRes, msgRes] = await Promise.all([
    db()
      .from("users")
      .select("id, timezone, briefing_time, briefing_enabled, deadline_nudge_minutes, quiet_start, quiet_end, persona_prefs, deleted_at, next_briefing_at")
      .eq("id", userId)
      .maybeSingle(),
    db()
      .from("channels")
      .select("kind, last_service, is_primary")
      .eq("user_id", userId)
      .order("is_primary", { ascending: false })
      .limit(1),
    db()
      .from("messages")
      .select("body")
      .eq("user_id", userId)
      .eq("direction", "in")
      .not("body", "is", null)
      .order("created_at", { ascending: false })
      .limit(RECENT_TEXTS),
  ]);
  if (userRes.error) throw new Error(`loadUserSchedule: ${userRes.error.message}`);
  if (chanRes.error) throw new Error(`loadUserSchedule(channels): ${chanRes.error.message}`);
  if (msgRes.error) throw new Error(`loadUserSchedule(messages): ${msgRes.error.message}`);
  const u = userRes.data;
  if (!u) return null;

  const chan = chanRes.data?.[0];
  const service: Service = isService(chan?.last_service) ? chan.last_service : chan?.kind === "sms" ? "sms" : "imessage";
  const quietStart = safeTime(u.quiet_start, "22:00");
  const quietEnd = safeTime(u.quiet_end, "08:00");
  const texts = (msgRes.data ?? []).map((m) => m.body ?? "").filter((b) => b.length > 0).reverse();
  const settings: NotificationSettings = {
    tz: safeTimeZone(u.timezone),
    briefingTime: safeTime(u.briefing_time, "08:00"),
    briefingEnabled: u.briefing_enabled,
    nudgeMinutes: [...(u.deadline_nudge_minutes ?? [])],
    quiet: { start: quietStart, end: quietEnd },
    register: templateRegister(parsePersonaPrefs(u.persona_prefs), texts),
  };
  const effective = effectiveQuietWindow({ quietStart: u.quiet_start, quietEnd: u.quiet_end }, service);
  return {
    userId,
    settings,
    effectiveQuiet: fromGuardWindow(effective),
    service,
    deleted: u.deleted_at !== null,
    nextBriefingAt: u.next_briefing_at ? new Date(u.next_briefing_at) : null,
  };
}

/**
 * Read a user's notification settings.
 * @param userId owner
 * @returns settings
 * @throws NotificationSettingsError("user_not_found") or a DB error
 */
export async function getNotificationSettings(userId: string): Promise<NotificationSettings> {
  const s = await loadUserSchedule(userId);
  if (!s) throw new NotificationSettingsError("user_not_found", "user not found");
  return s.settings;
}

/**
 * Normalize nudge offsets: unique, integer 15–2880, at most 3, largest first.
 * @param minutes requested offsets
 * @returns normalized offsets
 * @throws NotificationSettingsError("invalid_nudge_minutes")
 */
export function normalizeNudgeMinutes(minutes: readonly number[]): number[] {
  const uniq = [...new Set(minutes)];
  if (uniq.length > 3 || uniq.some((m) => !Number.isInteger(m) || m < NUDGE_MIN || m > NUDGE_MAX)) {
    throw new NotificationSettingsError(
      "invalid_nudge_minutes",
      "deadline heads-ups take up to 3 offsets between 15 minutes and 48 hours",
    );
  }
  return uniq.sort((a, b) => b - a);
}

/**
 * Update briefing time/on-off and nudge offsets, then call `onUserScheduleSettingsChanged`.
 * A briefing time inside the (effective) quiet window is rejected with a readable error.
 * @param userId owner
 * @param patch fields to change
 * @returns the new settings
 * @throws NotificationSettingsError for invalid input or a missing user; DB errors
 */
export async function updateNotificationSettings(
  userId: string,
  patch: Partial<Pick<NotificationSettings, "briefingTime" | "briefingEnabled" | "nudgeMinutes">>,
): Promise<NotificationSettings> {
  const current = await loadUserSchedule(userId);
  if (!current || current.deleted) throw new NotificationSettingsError("user_not_found", "user not found");

  const update: { briefing_time?: string; briefing_enabled?: boolean; deadline_nudge_minutes?: number[] } = {};
  if (patch.briefingTime) {
    const q = current.effectiveQuiet;
    if (isInDailyWindow(patch.briefingTime, q.start, q.end)) {
      throw new NotificationSettingsError(
        "briefing_in_quiet_hours",
        `${clock(patch.briefingTime)} is inside quiet hours (${clock(q.start)}–${clock(q.end)}); the earliest briefing time is ${clock(q.end)}`,
      );
    }
    update.briefing_time = hhmm(patch.briefingTime);
  }
  if (patch.briefingEnabled !== undefined) update.briefing_enabled = patch.briefingEnabled;
  if (patch.nudgeMinutes !== undefined) update.deadline_nudge_minutes = normalizeNudgeMinutes(patch.nudgeMinutes);

  if (Object.keys(update).length > 0) {
    const { error } = await db().from("users").update(update).eq("id", userId);
    if (error) throw new Error(`updateNotificationSettings: ${error.message}`);
  }
  try {
    await onUserScheduleSettingsChanged(userId);
  } catch (e) {
    // Settings are saved; the daily reconcile re-derives the briefing job and nudges.
    console.warn(`[settings] reschedule after update failed: ${e instanceof Error ? e.message : "unknown"}`);
  }
  return {
    ...current.settings,
    ...(patch.briefingTime ? { briefingTime: patch.briefingTime } : {}),
    ...(update.briefing_enabled !== undefined ? { briefingEnabled: update.briefing_enabled } : {}),
    ...(update.deadline_nudge_minutes ? { nudgeMinutes: update.deadline_nudge_minutes } : {}),
  };
}
