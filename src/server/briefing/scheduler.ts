import "server-only";
// OWNER: 2.6

/**
 * Briefing scheduling (master plan §1.14; V2-06 §2.7, §7 `scheduler.ts`, moved to task 2.6 by C30).
 *
 * `users.next_briefing_at` is the source of truth; the pending `briefing_prepare` job
 * (dedupe `briefing_prep:<userId>`, mode replace) is a cache of it. Both are recomputed from the
 * user's local briefing time on every settings change, DST-safe (`nextBriefingAt`).
 */
import { db } from "@/server/db";
import { cancelJobs, enqueueJob } from "@/server/jobs/enqueue";
import { loadUserSchedule } from "@/server/proactive/settings";
import { nextBriefingAt, prepRunAt } from "@/server/proactive/schedule";
import { ensureAutoNudges, recomputeRecurring } from "@/server/reminders/service";
import { rebaseTimeline } from "@/server/timeline";
import { addLocalDays, formatLocalDate, zonedToUtc, type LocalDate } from "@/shared/time/tz";

/** Dedupe key of a user's pending prepare job. */
export function briefingPrepKey(userId: string): string {
  return `briefing_prep:${userId}`;
}

/** Local dates (YYYY-MM-DD) among `dates` that already have a sent/skipped briefing. */
async function finishedDates(userId: string, dates: string[]): Promise<Set<string>> {
  const { data, error } = await db()
    .from("briefings")
    .select("local_date, status")
    .eq("user_id", userId)
    .in("local_date", dates)
    .in("status", ["sent", "skipped"]);
  if (error) throw new Error(`scheduleNextBriefing(briefings): ${error.message}`);
  return new Set((data ?? []).map((r) => r.local_date));
}

/**
 * Recompute `users.next_briefing_at` (DST-safe) and replace the `briefing_prepare` job.
 * A local date that was already briefed (sent/skipped, e.g. after a timezone change) is skipped.
 * Disabled or deleted users get `next_briefing_at = null` and no pending prepare job.
 * @param userId owner
 * @param now clock (default: now)
 * @returns next briefing instant + local date ("YYYY-MM-DD"), or null if disabled/deleted
 */
export async function scheduleNextBriefing(userId: string, now: Date = new Date()): Promise<{ at: Date; localDate: string } | null> {
  const s = await loadUserSchedule(userId);
  if (!s || s.deleted || !s.settings.briefingEnabled) {
    await cancelJobs({ dedupeKey: briefingPrepKey(userId) });
    if (s && !s.deleted) {
      const { error } = await db().from("users").update({ next_briefing_at: null }).eq("id", userId);
      if (error) throw new Error(`scheduleNextBriefing: ${error.message}`);
    }
    return null;
  }

  const { tz, briefingTime } = s.settings;
  let next = nextBriefingAt({ tz, briefingTime, quiet: s.effectiveQuiet, now });
  const candidates: LocalDate[] = [next.localDate, addLocalDays(next.localDate, 1), addLocalDays(next.localDate, 2)];
  const done = await finishedDates(userId, candidates.map(formatLocalDate));
  for (let i = 0; i < candidates.length && done.has(formatLocalDate(next.localDate)); i += 1) {
    // Already briefed that local date: solve again from the end of that day (→ the next date).
    const endOfDay = zonedToUtc({ ...next.localDate, hour: 23, minute: 59 }, tz).instant;
    next = nextBriefingAt({ tz, briefingTime, quiet: s.effectiveQuiet, now: endOfDay });
  }

  const localDate = formatLocalDate(next.localDate);
  const { error } = await db().from("users").update({ next_briefing_at: next.at.toISOString() }).eq("id", userId);
  if (error) throw new Error(`scheduleNextBriefing: ${error.message}`);
  await enqueueJob({
    kind: "briefing_prepare",
    userId,
    runAt: prepRunAt(next.at, userId, now),
    payload: { targetAt: next.at.toISOString(), localDate },
    dedupeKey: briefingPrepKey(userId),
    mode: "replace",
  });
  return { at: next.at, localDate };
}

/**
 * THE hook after any change to timezone, briefing time/on-off, nudge offsets or quiet hours:
 * recomputes `next_briefing_at` + prepare job, `rebaseTimeline` (idempotent: date-only items are
 * re-solved in the current zone, so calling it without a zone change is a no-op),
 * `recomputeRecurring`, and re-places auto-nudges. Absolute and user-anchored reminders keep their
 * instants. Every step runs even if an earlier one fails; failures are rethrown together.
 * Callers: `update_profile`, `update_notification_settings`, the `/setup` schedule actions, first contact.
 * @param userId owner
 * @param now clock (default: now)
 * @throws Error listing the steps that failed
 */
export async function onUserScheduleSettingsChanged(userId: string, now: Date = new Date()): Promise<void> {
  const s = await loadUserSchedule(userId);
  if (!s || s.deleted) {
    await cancelJobs({ dedupeKey: briefingPrepKey(userId) });
    return;
  }
  const tz = s.settings.tz;
  const failures: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(`${name}: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  };
  await step("briefing", () => scheduleNextBriefing(userId, now));
  await step("rebase_timeline", () => rebaseTimeline(userId, tz));
  await step("recurring", () => recomputeRecurring(userId, tz, now));
  await step("auto_nudges", () => ensureAutoNudges(userId, now));
  if (failures.length > 0) {
    console.warn(`[briefing] schedule settings hook: ${failures.length} step(s) failed`);
    throw new Error(`onUserScheduleSettingsChanged: ${failures.join("; ")}`);
  }
}
