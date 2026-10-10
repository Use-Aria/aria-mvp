import "server-only";
// OWNER: 4.1

/**
 * Briefing text generation (V2-06 §2.5, §7 `briefing/generate.ts`): one `runStructured` call on
 * the `briefing` route (Haiku, medium effort; master plan §1.6) returning `{bubbles}`. Up to two
 * attempts, then the deterministic `templateBriefing`. Output is post-processed: every URL removed
 * (the link is code's job), whitespace tidied, bubbles clipped to 320 chars, at most 2 bubbles
 * (the link bubble is the third).
 */
import { z } from "zod";
import { BRIEFING_BUBBLE_MAX, BRIEFING_SYSTEM_PROMPT, renderSnapshotForModel } from "@/server/briefing/prompt";
import type { BriefingSnapshot } from "@/server/briefing/snapshot";
import { templateBriefing } from "@/server/briefing/template";
import { runStructured, type LlmLogMeta } from "@/server/llm";
import { stripUrls, type Register } from "@/server/reminders/render";

/** Structured output of the briefing call (lenient: extra bubbles are merged in post). */
export const BriefingOutputSchema = z.object({ bubbles: z.array(z.string()).min(1) });

/** A generated briefing. */
export interface BriefingPlan {
  bubbles: string[];
  costUsd: number;
  source: "llm" | "template";
}

/** Injectable model call (tests use a fake; production uses `runStructured` route "briefing"). */
export type BriefingModel = (i: { system: string; user: string; log: LlmLogMeta; signal?: AbortSignal }) => Promise<{ bubbles: string[]; costUsd: number }>;

const defaultModel: BriefingModel = async (i) => {
  const r = await runStructured({
    route: "briefing",
    system: i.system,
    user: i.user,
    schema: BriefingOutputSchema,
    log: i.log,
    ...(i.signal ? { signal: i.signal } : {}),
  });
  return { bubbles: r.data.bubbles, costUsd: r.usage.costUsd };
};

/** Max model attempts before the template fallback. */
export const BRIEFING_ATTEMPTS = 2;
const MAX_TEXT_BUBBLES = 2;

function clipBubble(text: string): string {
  if (text.length <= BRIEFING_BUBBLE_MAX) return text;
  const cut = text.slice(0, BRIEFING_BUBBLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > BRIEFING_BUBBLE_MAX * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Normalize model bubbles: strip every URL, tidy whitespace, drop empties, merge overflow into the
 * second bubble, clip each to 320 chars.
 * @param raw model output bubbles
 * @returns 0–2 clean bubbles (0 = unusable output)
 */
export function sanitizeBubbles(raw: readonly string[]): string[] {
  const clean = raw
    .map((b) => stripUrls(String(b), "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim())
    .filter((b) => b.length > 0);
  if (clean.length > MAX_TEXT_BUBBLES) {
    clean.splice(MAX_TEXT_BUBBLES - 1, clean.length, clean.slice(MAX_TEXT_BUBBLES - 1).join("\n"));
  }
  return clean.map(clipBubble);
}

/**
 * Generate the briefing bubbles for a snapshot: LLM (≤2 attempts) → template fallback.
 * @param s snapshot
 * @param register casual | neutral
 * @param userId owner (llm_calls attribution)
 * @param o optional model override (tests), Canvas hint, link-follows flag, abort signal, job id
 * @returns bubbles, LLM cost (USD, summed over successful attempts) and which path produced them
 */
export async function generateBriefingPlan(
  s: BriefingSnapshot,
  register: Register,
  userId: string,
  o: { model?: BriefingModel; canvasHint?: boolean; linkFollows?: boolean; signal?: AbortSignal; jobId?: string } = {},
): Promise<BriefingPlan> {
  const model = o.model ?? defaultModel;
  const user = renderSnapshotForModel(s, register, { canvasHint: o.canvasHint, linkFollows: o.linkFollows });
  const log: LlmLogMeta = {
    userId,
    ...(o.jobId ? { jobId: o.jobId } : {}),
    meta: { purpose: "briefing", kind: s.kind, localDate: s.localDate },
  };
  let costUsd = 0;
  for (let attempt = 1; attempt <= BRIEFING_ATTEMPTS; attempt += 1) {
    if (o.signal?.aborted) break;
    try {
      const r = await model({ system: BRIEFING_SYSTEM_PROMPT, user, log: { ...log, iteration: attempt }, ...(o.signal ? { signal: o.signal } : {}) });
      costUsd += Number.isFinite(r.costUsd) ? r.costUsd : 0;
      const bubbles = sanitizeBubbles(r.bubbles);
      if (bubbles.length > 0) return { bubbles, costUsd, source: "llm" };
      console.warn(`[briefing] attempt ${attempt}: empty output`);
    } catch (e) {
      // Error class only: messages can echo prompt content.
      console.warn(`[briefing] attempt ${attempt} failed: ${e instanceof Error ? e.name : "unknown"}`);
    }
  }
  return { bubbles: templateBriefing(s, register, { canvasHint: o.canvasHint }), costUsd, source: "template" };
}
