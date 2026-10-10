import "server-only";
// OWNER: 4.1

/**
 * Load everything a briefing needs (V2-06 §7 `briefing/load.ts`). Reads only cached data:
 * timeline (Canvas, Google Calendar mirror, syllabus, Aria blocks), unconsumed briefing notes,
 * unsurfaced important emails (4.3's accessor, via the Google barrel), busy intervals (4.2's readBusy),
 * integration state and one queued preference proposal. Optional sources fail soft (logged, empty).
 */
import { db } from "@/server/db";
import type { BriefingInputs, BriefingMode, BriefingNoteInput } from "@/server/briefing/snapshot";
import { listEmailItemsForBriefing, readBusy } from "@/server/integrations/google";
import type { BriefingEmailItem } from "@/server/integrations/google/gmail/types";
import { listQueuedProposals } from "@/server/memory";
import { loadUserSchedule } from "@/server/proactive/settings";
import { listTimeline } from "@/server/timeline";
import type { JsonValue } from "@/server/timeline/types";
import { addLocalDays, localDateOf, zonedToUtc, type LocalDate } from "@/shared/time/tz";

/** Extra facts `run.ts` needs alongside the snapshot inputs. */
export interface BriefingContext {
  inputs: BriefingInputs;
  createdAt: Date;
  lastBriefingSentAt: Date | null;
}

const DAY_MS = 86_400_000;
const NOTES_MAX = 20;
/** Items are loaded for [today, today + 9 local days): Monday week view + exam T-7 + margin. */
const ITEM_WINDOW_DAYS = 9;
const BUSY_TIMEOUT_MS = 5_000;

function errName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown";
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    t = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

function isRecord(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Load briefing inputs for the local date of `now` in the user's zone.
 * @param userId owner
 * @param now reference instant (the scheduled delivery time, or the deferred send time)
 * @param kind daily | monday | catchup (monday is derived from the date; catchup = compact mode)
 * @returns inputs plus signup / last-briefing timestamps
 * @throws when the user doesn't exist, or on a DB error in a required read
 */
export async function loadBriefingInputs(
  userId: string,
  now: Date,
  kind: "daily" | "monday" | "catchup",
): Promise<BriefingContext> {
  const schedule = await loadUserSchedule(userId);
  if (!schedule) throw new Error("loadBriefingInputs: user not found");
  const tz = schedule.settings.tz;
  const localDate: LocalDate = localDateOf(now, tz);
  const mode: BriefingMode = kind === "catchup" ? "catchup" : "daily";
  const from = zonedToUtc({ ...localDate, hour: 0, minute: 0 }, tz).instant;
  const to = zonedToUtc({ ...addLocalDays(localDate, ITEM_WINDOW_DAYS), hour: 0, minute: 0 }, tz).instant;
  const dayEnd = zonedToUtc({ ...addLocalDays(localDate, 1), hour: 0, minute: 0 }, tz).instant;

  const [userRes, notesRes, integRes, items] = await Promise.all([
    db().from("users").select("name, created_at, last_briefing_sent_at").eq("id", userId).maybeSingle(),
    db()
      .from("briefing_notes")
      .select("id, kind, payload")
      .eq("user_id", userId)
      .is("consumed_at", null)
      .order("created_at", { ascending: true })
      .limit(NOTES_MAX),
    db().from("integrations").select("provider, status").eq("user_id", userId),
    listTimeline(userId, { from, to }, { statuses: ["upcoming"], timezone: tz, now }),
  ]);
  if (userRes.error) throw new Error(`loadBriefingInputs(users): ${userRes.error.message}`);
  if (!userRes.data) throw new Error("loadBriefingInputs: user not found");
  if (notesRes.error) throw new Error(`loadBriefingInputs(notes): ${notesRes.error.message}`);
  if (integRes.error) throw new Error(`loadBriefingInputs(integrations): ${integRes.error.message}`);

  const integrations = {
    canvas: (integRes.data ?? []).some((r) => r.provider === "canvas_ical" && (r.status === "active" || r.status === "error")),
    google: (integRes.data ?? []).some((r) => r.provider === "google" && r.status === "active"),
  };
  const lastBriefingSentAt = userRes.data.last_briefing_sent_at ? new Date(userRes.data.last_briefing_sent_at) : null;

  let emails: BriefingEmailItem[] = [];
  let busy: { start: Date; end: Date }[] = [];
  if (integrations.google) {
    const since = lastBriefingSentAt ?? new Date(now.getTime() - DAY_MS);
    try {
      emails = await listEmailItemsForBriefing(userId, since);
    } catch (e) {
      console.warn(`[briefing] email items unavailable: ${errName(e)}`);
    }
  }
  // readBusy (4.2) unions Google, timeline and class times; it skips Google when not connected
  // but THROWS on other Google errors: degrade to no extra busy data, never lose the briefing.
  try {
    const r = await withTimeout(readBusy(userId, from, dayEnd), BUSY_TIMEOUT_MS, { busy: [], calendarsChecked: 0 });
    busy = r.busy.map((b) => ({ start: b.start, end: b.end }));
  } catch (e) {
    console.warn(`[briefing] busy intervals unavailable: ${errName(e)}`);
  }

  let proposal: BriefingInputs["proposal"] = null;
  if (mode === "daily") {
    try {
      const [p] = await listQueuedProposals(userId, 1);
      if (p) proposal = { id: p.id, statement: p.statement };
    } catch (e) {
      console.warn(`[briefing] queued proposals unavailable: ${errName(e)}`);
    }
  }

  const notes: BriefingNoteInput[] = (notesRes.data ?? []).map((n) => ({
    id: n.id,
    kind: n.kind,
    payload: isRecord(n.payload) ? n.payload : {},
  }));

  return {
    inputs: {
      user: { name: userRes.data.name, tz, briefingTime: schedule.settings.briefingTime, register: schedule.settings.register },
      now,
      localDate,
      mode,
      items,
      notes,
      emails,
      busy,
      integrations,
      proposal,
    },
    createdAt: new Date(userRes.data.created_at),
    lastBriefingSentAt,
  };
}
