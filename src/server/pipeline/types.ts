import "server-only";
// OWNER: 0.2 (frozen contract; only the orchestrator edits this file — master plan §1.0.2)

/**
 * Pipeline ↔ agent boundary (master plan §1.2; merges V2-03 §7 and V2-04 §8.1, conflict C4).
 * The pipeline (3.1) creates the `agent_runs` row; the agent (3.2) writes run stats.
 */
import type { ChannelContext, InboundMedia, ReactionType, ReplyPlan } from "@/server/channels/types";
import type { ModelId } from "@/server/llm";

export interface InboundMessage {
  id: string;
  body: string | null;
  media: InboundMedia[];
  replyToMessageId: string | null;
  createdAt: Date;
}
export interface InboundReaction {
  id: string;
  targetMessageId: string;
  type: ReactionType;
  removed: boolean;
  createdAt: Date;
}
export interface IdentityState {
  isNewUser: boolean;
  name: string | null;
  timezone: string;
  timezoneSource: "default" | "signup" | "user" | "inferred";
}
export type AgentTrigger =
  | { kind: "inbound" }
  | {
      kind: "proactive";
      reason: "email_alert" | "deadline_change" | "reminder" | "followup";
      /** pre-wrapped with wrapUntrusted where it holds third-party text */
      event: string;
    };
export interface AgentTurnInput {
  userId: string;
  runId: string;
  now: Date;
  timezone: string;
  channel: ChannelContext;
  identity: IdentityState;
  trigger: AgentTrigger;
  /** this run's consumed inbound, oldest first ([] for proactive) */
  newMessages: InboundMessage[];
  /** user tapbacks on Aria messages since the last run (x_ evidence) */
  inboundReactions: InboundReaction[];
  isFollowUpPass: boolean;
  welcomeSent: boolean;
  isEval: boolean;
  /** aborts at run deadline − 30s or on lease loss */
  signal: AbortSignal;
  /** false if the watchdog/tool already sent one */
  interim: (text: string) => Promise<boolean>;
}
export interface AgentTurnResult {
  plan: ReplyPlan;
  /** null = ack fast path */
  model: ModelId | null;
  escalated: boolean;
  interimSent: boolean;
  costUsd: number;
}
/** The agent entry point (`runAgentTurn` in `@/server/agent`). Throw = turn failed (pipeline retries). */
export type RunAgentTurn = (input: AgentTurnInput) => Promise<AgentTurnResult>;

/** The model provider is unavailable; the pipeline retries the turn with backoff. */
export class AgentUnavailableError extends Error {
  readonly retryable = true;

  constructor(message = "agent unavailable") {
    super(message);
    this.name = "AgentUnavailableError";
  }
}
