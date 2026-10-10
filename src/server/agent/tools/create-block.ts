import "server-only";
// OWNER: 4.2

/**
 * Agent tool `create_block` (master plan §1.4 #13; V2-07 §2.8, §9.2). Evidence-gated mutator.
 *
 * - Times: `slot` (an `s_` alias minted by `find_free_slots` in this run, decoded with
 *   `parseSlotId`) or explicit `start`/`end` (RFC 3339 with offset). Raw slot ids are never
 *   accepted: an alias that wasn't shown in this run resolves to null.
 * - Writes only to the dedicated Aria calendar (`createBlock`), never the user's own calendars.
 * - Google disconnected / no `calendar_write` → `is_error` telling the model to offer
 *   `send_link` connect_google.
 * - Retry-safe: `aria_key = sha256(runId|title|start|end)[0..32]`.
 * - A conflict is a normal outcome (ok result, "not booked: …") so the model renegotiates.
 *
 * Also exports the gate/error helpers `move_block` and `delete_block` share.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { EV, aliasRef, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { getGoogleStatus } from "@/server/integrations/google/status";
import { GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { createBlock } from "@/server/integrations/google/calendar/aria-calendar";
import { parseSlotId, type Interval } from "@/server/integrations/google/calendar/slots";
import { formatTimeRange } from "@/shared/time/tz";

const input = z
  .strictObject({
    title: z.string().min(1).max(100),
    slot: aliasRef("s", "s_ id from find_free_slots").optional(),
    start: z.iso.datetime({ offset: true }).optional(),
    end: z.iso.datetime({ offset: true }).optional(),
    description: z.string().max(500).optional(),
    allow_overlap: z
      .boolean()
      .default(false)
      .describe("true only if the user explicitly wants it despite a conflict"),
    evidence: EV,
  })
  .superRefine((v, c) => {
    const explicit = v.start !== undefined && v.end !== undefined;
    if ((v.slot === undefined) === !explicit) {
      c.addIssue({ code: "custom", message: "pass either slot or both start and end" });
    }
  });

/** Longest block, minutes (matches `find_free_slots`' max duration). */
export const MAX_BLOCK_MIN = 480;
/** A block may start at most this far in the past (clock skew / "now"). */
const PAST_GRACE_MS = 5 * 60_000;

/** The `is_error` text for "Google can't take calendar writes" (offer the connect link). */
export const CONNECT_GOOGLE_ERROR =
  "Google Calendar isn't connected with permission to add events to their Aria calendar. Offer to send a connect link: send_link kind connect_google.";

/**
 * Gate shared by the block tools: an active Google connection with `calendar_write`.
 * @param ctx tool context
 * @returns null when writes are possible, else the `is_error` result to return
 */
export async function calendarWriteGate(ctx: ToolCtx): Promise<ToolResult | null> {
  try {
    const s = await getGoogleStatus(ctx.userId);
    return s.connected && s.canWriteAriaCalendar ? null : { ok: false, error: CONNECT_GOOGLE_ERROR };
  } catch (e) {
    ctx.log("calendar_gate_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't check their Google connection just now", retryable: true };
  }
}

/**
 * Map a Google failure from a block tool to a model-readable result.
 * @param ctx tool context
 * @param tool tool name (log event prefix)
 * @param e the thrown error
 * @returns connect hint (not connected / revoked / permission denied) or a retryable error
 */
export function blockToolError(ctx: ToolCtx, tool: string, e: unknown): ToolResult {
  ctx.log(`${tool}_failed`, { error: e instanceof Error ? e.name : "error", status: e instanceof GoogleApiError ? e.status : 0 });
  if (e instanceof GoogleNotConnectedError || e instanceof GoogleAuthRevokedError) return { ok: false, error: CONNECT_GOOGLE_ERROR };
  if (e instanceof GoogleApiError && e.status === 403 && e.reason !== "rateLimitExceeded" && e.reason !== "userRateLimitExceeded") {
    return { ok: false, error: CONNECT_GOOGLE_ERROR };
  }
  return { ok: false, error: "couldn't reach Google Calendar just now", retryable: true };
}

/**
 * Validate explicit block times (pure).
 * @param start RFC 3339 start
 * @param end RFC 3339 end
 * @param now logical now
 * @returns the interval or a model-readable error
 */
export function checkBlockTimes(start: string, end: string, now: Date): { ok: true; interval: Interval } | { ok: false; error: string } {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return { ok: false, error: "start/end must be RFC 3339 times with an offset" };
  if (e <= s) return { ok: false, error: "end must be after start" };
  if (e.getTime() - s.getTime() > MAX_BLOCK_MIN * 60_000) return { ok: false, error: `a block can be at most ${MAX_BLOCK_MIN / 60} hours` };
  if (s.getTime() < now.getTime() - PAST_GRACE_MS) return { ok: false, error: "that time has already passed" };
  return { ok: true, interval: { start: s, end: e } };
}

/**
 * Idempotency key for a block (retries of the same call in the same run reuse the event).
 * @param runId agent run id
 * @param title block title
 * @param iv block times
 * @returns 32 hex chars
 */
export function ariaKeyFor(runId: string, title: string, iv: Interval): string {
  return createHash("sha256").update(`${runId}|${title}|${iv.start.toISOString()}|${iv.end.toISOString()}`, "utf8").digest("hex").slice(0, 32);
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: on your Aria calendar, <label> [t_…]", "not booked: …" on a conflict, or an error
 */
export async function runCreateBlock(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;

  let iv: Interval;
  if (i.slot !== undefined) {
    const id = ctx.aliases.resolve(i.slot, "s");
    const slot = id ? parseSlotId(id) : null;
    if (!slot) {
      return { ok: false, error: `unknown slot ${i.slot}: slot ids only work in the run that found them; pass start and end instead` };
    }
    const checked = checkBlockTimes(slot.start.toISOString(), slot.end.toISOString(), ctx.now);
    if (!checked.ok) return checked;
    iv = checked.interval;
  } else {
    const checked = checkBlockTimes(i.start ?? "", i.end ?? "", ctx.now);
    if (!checked.ok) return checked;
    iv = checked.interval;
  }

  const blocked = await calendarWriteGate(ctx);
  if (blocked) return blocked;

  const title = i.title.replace(/\s+/g, " ").trim() || "Block";
  try {
    const r = await createBlock(ctx.userId, {
      title,
      start: iv.start,
      end: iv.end,
      description: i.description,
      ariaKey: ariaKeyFor(ctx.runId, title, iv),
      allowOverlap: i.allow_overlap,
    });
    if (!r.ok && r.reason === "no_permission") return { ok: false, error: CONNECT_GOOGLE_ERROR };
    if (!r.ok) {
      const labels = r.conflicts.map((c) => formatTimeRange(c.start, c.end, ctx.timezone, ctx.now));
      return {
        ok: true,
        data: `not booked: it overlaps busy time (${labels.join(", ")}). Offer another time, or retry with allow_overlap true only if the student explicitly wants it anyway.`,
      };
    }
    const label = formatTimeRange(iv.start, iv.end, ctx.timezone, ctx.now);
    const ref = ctx.aliases.mint("t", r.blockId);
    return { ok: true, data: `ok: on your Aria calendar, ${label} [${ref}]${r.note ? `\nnote: ${r.note}` : ""}` };
  } catch (e) {
    return blockToolError(ctx, "create_block", e);
  }
}

/** `create_block` tool. */
export const createBlockTool = defineTool({
  name: "create_block",
  description:
    "Put a block on the student's dedicated Aria Google calendar (never their other calendars). Only after the student picked or accepted a specific time: pass slot (an s_ id from find_free_slots) or an explicit start and end.",
  input,
  mutates: true,
  run: runCreateBlock,
});
