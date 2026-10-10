import "server-only";
// OWNER: 1.3

/**
 * Model reply plan (V2-04 §2.3, §7.2 `plan.ts`; master plan C2): the model's final answer is JSON
 * constrained by `output_config.format` (`REPLY_FORMAT`), using aliases and link handles. Pure.
 *
 * `resolvePlan` maps it to the channel `ReplyPlan` (ids, URLs) and never throws: unknown targets
 * are dropped with a warning, bubbles beyond the cap merge into the last allowed bubble, echoed
 * `[m_…]` transcript prefixes are stripped, `reply_to` threads the first bubble, and channels
 * without tapbacks / inline replies degrade.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MAX_BUBBLES, MAX_REACTIONS } from "@/server/agent/config";
import type { AliasTable, LinkSlots } from "@/server/agent/types";
import type { ChannelContext, ClassicTapback, PlanReaction, ReplyPlan } from "@/server/channels/types";
import { jsonSchemaFor } from "@/server/llm/schema";

const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const satisfies readonly ClassicTapback[];

/** Model-facing reply plan (aliases, not UUIDs). No optional params; 2 nullable unions. */
export const ModelReplyPlanSchema = z.strictObject({
  reactions: z
    .array(
      z.strictObject({
        target: z.string().describe("m_ id of the user's message to react to"),
        type: z.enum(TAPBACKS),
      }),
    )
    .describe("tapbacks on the user's messages; usually empty"),
  bubbles: z.array(z.string()).describe("0–3 short text bubbles, in order"),
  reply_to: z.string().nullable().describe("m_ id of a user message to reply to inline, or null"),
  link: z.string().nullable().describe("link handle like L1 returned by send_link, or null"),
});
/** Parsed model reply plan. */
export type ModelReplyPlan = z.output<typeof ModelReplyPlanSchema>;

/** `output_config.format` for the agent's final answer (built once; byte-stable). */
export const REPLY_FORMAT: Anthropic.JSONOutputFormat = Object.freeze({
  type: "json_schema" as const,
  schema: jsonSchemaFor(ModelReplyPlanSchema),
});

/** Text fallback per tapback when the channel can't react. */
const TAPBACK_TEXT: Readonly<Record<ClassicTapback, string>> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  question: "❓",
};

/** Leading transcript-style id prefixes the model sometimes echoes, e.g. "[m_1a2b3c4d 2:14pm] ". */
const ECHO_PREFIX_RE = /^\s*\[(?:aria|you|me|user)?\s*[:·-]?\s*[mx]_[0-9a-f]{8,10}(?::\d+)?[^\]\n]{0,48}\]\s*/i;
const LINK_HANDLE_RE = /^L\d{1,2}$/;

/**
 * Parse the model's final JSON text.
 * @param text the response text
 * @returns the plan, or null if it isn't valid JSON matching the schema
 */
export function parseModelPlan(text: string): ModelReplyPlan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = ModelReplyPlanSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Context `resolvePlan` needs beyond the alias table. */
export interface ResolveOptions {
  /** m_ aliases of user-authored (inbound) messages shown in this run: history + new batch. */
  userMessageAliases: ReadonlySet<string>;
  /** m_ alias of the newest inbound message (ack safety-net target), or null (proactive runs). */
  lastInbound: string | null;
}

function stripEchoes(text: string): string {
  let t = text;
  for (let i = 0; i < 3; i++) {
    const next = t.replace(ECHO_PREFIX_RE, "");
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

/**
 * Map a model plan to the channel `ReplyPlan`. Never throws.
 * @param p parsed model plan
 * @param aliases this run's alias table
 * @param links this run's link slots
 * @param channel channel capabilities
 * @param opts user-message aliases and the ack target
 * @returns the resolved plan plus warnings (codes and aliases only, no text)
 */
export function resolvePlan(
  p: ModelReplyPlan,
  aliases: AliasTable,
  links: LinkSlots,
  channel: ChannelContext,
  opts: ResolveOptions,
): { plan: ReplyPlan; warnings: string[] } {
  const warnings: string[] = [];
  const caps = channel.capabilities;

  const userTarget = (alias: string, what: string): string | null => {
    const a = alias.trim().toLowerCase();
    const id = opts.userMessageAliases.has(a) ? aliases.resolve(a, "m") : null;
    if (!id) warnings.push(`${what}_dropped:${a.slice(0, 16)}`);
    return id;
  };

  // Link (counts toward the bubble cap).
  let link: ReplyPlan["link"];
  if (p.link !== null) {
    const handle = p.link.trim();
    const url = LINK_HANDLE_RE.test(handle) ? links.resolve(handle) : null;
    if (url) link = { url };
    else warnings.push(`link_dropped:${handle.slice(0, 8)}`);
  }

  // Bubbles: strip echoes, drop empties, merge overflow into the last allowed bubble.
  let texts = p.bubbles.map(stripEchoes).filter((t) => t.length > 0);
  const maxText = link ? MAX_BUBBLES - 1 : MAX_BUBBLES;
  if (texts.length > maxText) {
    warnings.push(`bubbles_merged:${texts.length}`);
    texts = maxText === 0 ? [] : [...texts.slice(0, maxText - 1), texts.slice(maxText - 1).join("\n\n")];
  }

  // Reactions: user-message targets only, one per target, capped.
  let reactions: PlanReaction[] = [];
  const seen = new Set<string>();
  for (const r of p.reactions) {
    const id = userTarget(r.target, "reaction");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    reactions.push({ targetMessageId: id, type: r.type });
  }
  if (reactions.length > MAX_REACTIONS) {
    warnings.push(`reactions_capped:${reactions.length}`);
    reactions = reactions.slice(0, MAX_REACTIONS);
  }

  // Ack safety net: nothing to send → like the newest inbound message.
  if (texts.length === 0 && !link && reactions.length === 0 && opts.lastInbound) {
    const id = aliases.resolve(opts.lastInbound, "m");
    if (id) {
      reactions.push({ targetMessageId: id, type: "like" });
      warnings.push("empty_plan_ack");
    }
  }

  // Channels without tapbacks: drop reactions when there's text; otherwise keep one with a text fallback.
  if (!caps.reactions && reactions.length > 0) {
    if (texts.length > 0 || link) {
      warnings.push("reactions_unsupported");
      reactions = [];
    } else {
      const first = reactions[0];
      reactions = [{ ...first, fallbackText: TAPBACK_TEXT[first.type as ClassicTapback] }];
    }
  }

  // reply_to threads the first bubble (plain text where inline replies aren't supported).
  let replyTo: string | null = null;
  if (p.reply_to !== null) {
    replyTo = userTarget(p.reply_to, "reply_to");
    if (replyTo && !caps.inlineReplies) replyTo = null;
  }

  const plan: ReplyPlan = {
    bubbles: texts.map((text, i) => (i === 0 && replyTo ? { text, replyToMessageId: replyTo } : { text })),
  };
  if (reactions.length > 0) plan.reactions = reactions;
  if (link) plan.link = link;
  return { plan, warnings };
}
