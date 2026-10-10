import "server-only";
// OWNER: 3.1

/**
 * Credential-free agent (V2-03 §7 `stub-agent.ts`): used with `ARIA_AGENT=stub` (the default,
 * master plan §4), by the dev-chat REPL and by the pipeline tests. Deterministic, no I/O.
 *
 * - A batch whose last message is a short acknowledgement ("ok", "ty", "bet", …) gets a `like`
 *   tapback on that message and no bubble.
 * - Otherwise one echo bubble quoting the batch (bodies joined with " / ", attachments counted).
 * - A reaction-only turn (no new messages) gets one bubble naming the tapback.
 * - Nothing new at all → an empty plan (silence).
 */
import type { PlanBubble, ReplyPlan } from "@/server/channels/types";
import type { AgentTurnInput, AgentTurnResult, InboundMessage, RunAgentTurn } from "@/server/pipeline/types";

const ACK_RE = /^(?:ok(?:ay)?|k+|kk|ty|thx|thanks?(?: you)?|tysm|bet|cool|got it|sounds good|perfect)[\s!.👍🙏]*$/iu;
const MAX_ECHO_CHARS = 300;

/**
 * Whether a text is a bare acknowledgement the stub answers with a tapback.
 * @param text inbound body
 * @returns true for "ok", "ty", "bet", …
 */
export function isStubAck(text: string | null): boolean {
  return !!text && ACK_RE.test(text.trim());
}

function describe(m: InboundMessage): string {
  const body = m.body?.trim() ?? "";
  const files = m.media.length > 0 ? `[${m.media.length} attachment${m.media.length === 1 ? "" : "s"}]` : "";
  return [body, files].filter(Boolean).join(" ");
}

function result(plan: ReplyPlan): AgentTurnResult {
  return { plan, model: null, escalated: false, interimSent: false, costUsd: 0 };
}

/**
 * The stub `RunAgentTurn`: echo plus a `like` tapback on acknowledgements.
 * @param input turn input from the pipeline
 * @returns a reply plan with `model: null` and zero cost
 */
export const stubAgentTurn: RunAgentTurn = async (input: AgentTurnInput): Promise<AgentTurnResult> => {
  const msgs = input.newMessages;
  const last = msgs[msgs.length - 1];
  if (last && isStubAck(last.body) && last.media.length === 0) {
    return result({ bubbles: [], reactions: [{ targetMessageId: last.id, type: "like", fallbackText: "👍" }] });
  }
  if (msgs.length > 0) {
    const said = msgs.map(describe).filter(Boolean).join(" / ");
    const text = said.length > MAX_ECHO_CHARS ? `${said.slice(0, MAX_ECHO_CHARS - 1)}…` : said;
    const prefix = input.isFollowUpPass ? "(stub, follow-up)" : "(stub)";
    const n = msgs.length > 1 ? ` ${msgs.length} messages:` : "";
    const bubble: PlanBubble = { text: `${prefix}${n} ${text || "(empty)"}` };
    return result({ bubbles: [bubble] });
  }
  const live = input.inboundReactions.filter((r) => !r.removed);
  if (live.length > 0) {
    return result({ bubbles: [{ text: `(stub) saw your ${live.map((r) => r.type).join(", ")} tapback` }] });
  }
  return result({ bubbles: [] });
};
