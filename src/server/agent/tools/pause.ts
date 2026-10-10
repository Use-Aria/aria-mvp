import "server-only";
// OWNER: 3.3

/**
 * Agent tool `pause` (master plan §1.4 #29 — the sole pause tool; V2-04 §9.2). Sets
 * `channels.paused_until` on the channel the student is texting from (time zone aware). Pauses
 * proactive messages only; replies to the student's own texts continue.
 */
import { z } from "zod";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { setPause } from "@/server/channels/repo";
import { addLocalDays, formatForChat, localDateOf, toLocal, zonedToUtc } from "@/shared/time/tz";

const input = z.strictObject({
  until: z.enum(["1h", "tonight", "tomorrow_morning", "1_week", "indefinitely", "resume"]),
  evidence: EV,
});

/** Pause choice. */
export type PauseUntil = z.output<typeof input>["until"];

/** "indefinitely" (V2-04 §9.2). */
export const PAUSE_FOREVER = new Date("9999-12-31T00:00:00Z");

/**
 * End of a pause (pure, DST-safe).
 * - 1h: now + 1h · tonight: 23:59 local today · tomorrow_morning: 08:00 local tomorrow
 * - 1_week: same wall-clock time 7 local days later · indefinitely: 9999-12-31 · resume: null
 * @param until choice
 * @param now clock
 * @param tz user zone
 * @returns pause end, or null to resume
 */
export function pauseEnd(until: PauseUntil, now: Date, tz: string): Date | null {
  const today = localDateOf(now, tz);
  switch (until) {
    case "1h":
      return new Date(now.getTime() + 3_600_000);
    case "tonight": {
      const end = zonedToUtc({ ...today, hour: 23, minute: 59 }, tz).instant;
      return end.getTime() > now.getTime() ? end : new Date(now.getTime() + 3_600_000);
    }
    case "tomorrow_morning":
      return zonedToUtc({ ...addLocalDays(today, 1), hour: 8, minute: 0 }, tz).instant;
    case "1_week": {
      const l = toLocal(now, tz);
      return zonedToUtc({ ...addLocalDays(today, 7), hour: l.hour, minute: l.minute }, tz).instant;
    }
    case "indefinitely":
      return PAUSE_FOREVER;
    case "resume":
      return null;
  }
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: paused until …" / "ok: resumed", or a model-readable error
 */
export async function runPause(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const end = pauseEnd(i.until, ctx.now, ctx.timezone);
  try {
    await setPause(ctx.channel.channelId, end);
  } catch (e) {
    ctx.log("pause_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't change that just now", retryable: true };
  }
  if (!end) return { ok: true, data: "ok: resumed" };
  if (end.getTime() === PAUSE_FOREVER.getTime()) return { ok: true, data: "ok: paused until they say resume" };
  return { ok: true, data: `ok: paused until ${formatForChat(end, ctx.timezone, ctx.now)}` };
}

/** `pause` tool. */
export const pauseTool = defineTool({
  name: "pause",
  description:
    "Pause Aria's proactive texts (briefings, nudges, alerts) for a while: 1h, tonight, until tomorrow morning, a week, indefinitely, or resume. Replies to the student's own messages continue.",
  input,
  mutates: true,
  run: runPause,
});
