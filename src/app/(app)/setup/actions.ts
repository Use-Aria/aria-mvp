"use server";
/**
 * /setup server actions for the schedule, time zone, and tone sections (web plan §7.4).
 * OWNER: 4.4. (Canvas/Google actions live in `integration-actions.ts`, task 4.5.)
 *
 * Every action re-checks Origin + session inside the action (`requireActionViewer("any")`:
 * these are low-risk prefs, web plan §2.3), re-validates its input, and returns a small
 * `ActionResult`. Schedule and time-zone changes are persisted first, then
 * `onUserScheduleSettingsChanged` re-plans the briefing job, rebases the timeline, and
 * re-places nudges (master plan §1.14). A failed hook doesn't undo the save: the daily
 * reconcile re-derives the jobs.
 */
import { refresh } from "next/cache";
import { onUserScheduleSettingsChanged } from "@/server/briefing/scheduler";
import { db } from "@/server/db";
import type { Json } from "@/server/db/types";
import { refreshProfileBlock } from "@/server/memory/profile";
import { requireActionViewer } from "@/server/web/guard";
import { actionFail, actionOk, type ActionResult } from "@/shared/action-result";
import { isTone, withTone } from "@/shared/persona-prefs";
import {
  BRIEFING_OFF,
  BRIEFING_OPTIONS,
  DEFAULT_SCHEDULE,
  QUIET_END_OPTIONS,
  QUIET_START_OPTIONS,
  toHHMM,
  type ClockOption,
} from "@/shared/schedule-prefs";
import { isValidTimeZone } from "@/shared/time/tz";

function field(form: FormData, name: string, max = 64): string | null {
  const v = form.get(name);
  return typeof v === "string" && v.length > 0 && v.length <= max ? v.trim() : null;
}

function normalizeTime(value: string | null | undefined, fallback: string): string {
  try {
    return value ? toHHMM(value) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A clock value is accepted when it is one of the offered options, or equals the value already
 * stored (set in chat, e.g. a 6:30 briefing): the form shows that value as an extra option and
 * saving it unchanged must not fail.
 */
function acceptClock(value: string | null, options: readonly ClockOption[], current: string): string | null {
  if (value === null) return null;
  if (options.some((o) => o.value === value)) return value;
  return value === current ? current : null;
}

/**
 * Canonical IANA id for a browser-reported zone (`Intl` resolvedOptions), or null.
 * Region/City ids and UTC only; no "EST"-style abbreviations.
 */
function canonicalZone(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(v) && v.toUpperCase() !== "UTC") return null;
  if (!isValidTimeZone(v)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

async function reschedule(userId: string): Promise<void> {
  try {
    await onUserScheduleSettingsChanged(userId);
  } catch (err) {
    // Saved already; the daily reconcile re-derives the briefing job and nudges.
    console.warn("[setup] reschedule after save failed:", err instanceof Error ? err.message : "unknown");
  }
}

/**
 * Save the morning briefing time (or "off") and quiet hours. Freshness `any`.
 * A briefing inside quiet hours is allowed (the form warns; the scheduler sends it at quiet end).
 * Unchanged values are a no-op, so a double submit is harmless.
 * @param prev previous result (`useActionState`)
 * @param form fields `briefing` ("HH:MM" | "off"), `quietStart`, `quietEnd` ("HH:MM")
 * @returns ok, or signed_out / bad_origin / invalid / server
 */
export async function saveScheduleAction(prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  void prev;
  const gate = await requireActionViewer("any");
  if (!gate.ok) return actionFail(gate.code);
  const userId = gate.viewer.userId;

  try {
    const { data: row, error } = await db()
      .from("users")
      .select("briefing_time, briefing_enabled, quiet_start, quiet_end")
      .eq("id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return actionFail("signed_out");

    const curBriefing = normalizeTime(row.briefing_time, DEFAULT_SCHEDULE.briefing);
    const curStart = normalizeTime(row.quiet_start, DEFAULT_SCHEDULE.quietStart);
    const curEnd = normalizeTime(row.quiet_end, DEFAULT_SCHEDULE.quietEnd);

    const briefingRaw = field(form, "briefing", 8);
    const briefing =
      briefingRaw === BRIEFING_OFF
        ? BRIEFING_OFF
        : acceptClock(briefingRaw, BRIEFING_OPTIONS, curBriefing);
    const quietStart = acceptClock(field(form, "quietStart", 8), QUIET_START_OPTIONS, curStart);
    const quietEnd = acceptClock(field(form, "quietEnd", 8), QUIET_END_OPTIONS, curEnd);
    if (!briefing || !quietStart || !quietEnd || quietStart === quietEnd) return actionFail("invalid");

    const enabled = briefing !== BRIEFING_OFF;
    const nextBriefing = enabled ? briefing : curBriefing;
    const changed =
      enabled !== row.briefing_enabled ||
      nextBriefing !== curBriefing ||
      quietStart !== curStart ||
      quietEnd !== curEnd;
    if (changed) {
      const { error: upErr } = await db()
        .from("users")
        .update({
          briefing_enabled: enabled,
          briefing_time: nextBriefing,
          quiet_start: quietStart,
          quiet_end: quietEnd,
        })
        .eq("id", userId);
      if (upErr) throw new Error(upErr.message);
      await reschedule(userId);
    }
  } catch (err) {
    console.error("[setup] save schedule failed:", err instanceof Error ? err.message : "unknown");
    return actionFail("server");
  }
  refresh();
  return actionOk();
}

/**
 * Switch the account to the phone's time zone ("Use Pacific Time"). Freshness `any`.
 * Sets `timezone_source = 'user'`, then runs the schedule hook (which rebases date-only
 * timeline items) and refreshes the agent's profile block. Same zone → no-op.
 * @param prev previous result (`useActionState`)
 * @param form field `timezone` (IANA id from `Intl.DateTimeFormat().resolvedOptions()`)
 * @returns ok, or signed_out / bad_origin / invalid / server
 */
export async function saveTimezoneAction(prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  void prev;
  const gate = await requireActionViewer("any");
  if (!gate.ok) return actionFail(gate.code);
  const tz = canonicalZone(field(form, "timezone", 64));
  if (!tz) return actionFail("invalid");
  const userId = gate.viewer.userId;

  try {
    const { data: row, error } = await db().from("users").select("timezone").eq("id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return actionFail("signed_out");
    if (row.timezone !== tz) {
      const { error: upErr } = await db()
        .from("users")
        .update({ timezone: tz, timezone_source: "user" })
        .eq("id", userId);
      if (upErr) throw new Error(upErr.message);
      await reschedule(userId);
      await refreshProfileBlock(userId).catch((err: unknown) => {
        console.warn("[setup] profile refresh failed:", err instanceof Error ? err.message : "unknown");
      });
    }
  } catch (err) {
    console.error("[setup] save timezone failed:", err instanceof Error ? err.message : "unknown");
    return actionFail("server");
  }
  refresh();
  return actionOk();
}

/**
 * Save how Aria talks (`users.persona_prefs.tone`), keeping any other stored keys.
 * Freshness `any`.
 * @param prev previous result (`useActionState`)
 * @param form field `tone` ("mirror" | "casual" | "polished")
 * @returns ok, or signed_out / bad_origin / invalid / server
 */
export async function saveToneAction(prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  void prev;
  const gate = await requireActionViewer("any");
  if (!gate.ok) return actionFail(gate.code);
  const tone = field(form, "tone", 16);
  if (!isTone(tone)) return actionFail("invalid");
  const userId = gate.viewer.userId;

  try {
    const { data: row, error } = await db().from("users").select("persona_prefs").eq("id", userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return actionFail("signed_out");
    const next = withTone(row.persona_prefs, tone);
    const { error: upErr } = await db()
      .from("users")
      .update({ persona_prefs: next as Json })
      .eq("id", userId);
    if (upErr) throw new Error(upErr.message);
  } catch (err) {
    console.error("[setup] save tone failed:", err instanceof Error ? err.message : "unknown");
    return actionFail("server");
  }
  refresh();
  return actionOk();
}
