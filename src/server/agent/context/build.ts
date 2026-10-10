import "server-only";
// OWNER: 2.2

/**
 * Assembles one agent turn's context (V2-04 §2.5, §7.2 `context/build.ts`).
 *
 *   tools[] + system          static, byte-identical for everyone        ← BP1 (1h, set by llm)
 *   user  <aria_profile> + <aria_summary>   per-user, stable between edits
 *   history (alternating)                    stable within a window chunk ← BP2 = historyBreakpointIndex
 *   user  <aria_now> + <new_messages>        changes every turn          ← BP3 (autoCacheTail)
 *
 * `loadTurnData` does the DB reads in parallel (agenda, pending actions and recent runs degrade
 * to "unavailable" instead of failing the turn); `assembleTurnContext` is pure.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { AliasTable } from "@/server/agent/context/aliases";
import {
  renderHistory,
  renderNewMessages,
  renderNowBlock,
  renderUserContextBlock,
  type HistoryReaction,
} from "@/server/agent/context/render";
import { buildStaticSystemPrompt } from "@/server/agent/context/static-prompt";
import { parseMedia, selectWindow, type MsgLite } from "@/server/agent/context/window";
import { WINDOW_HARD_MAX, WINDOW_MAX } from "@/server/agent/config";
import { listOpenActions } from "@/server/agent/pending/actions";
import type { OpenAction } from "@/server/agent/pending/types";
import { classifyAckOnly, endsWithQuestion } from "@/server/agent/persona/ack";
import { TOOLS } from "@/server/agent/tools";
import type { AgentTool } from "@/server/agent/tools/define";
import { toolSchemas } from "@/server/agent/tools/registry";
import type { ClassicTapback } from "@/server/channels/types";
import { db, type Tables } from "@/server/db";
import type { Json } from "@/server/db/types";
import { renderPreferences } from "@/server/memory/preference-policy";
import { getOpenQuestion, listActivePreferences, type OpenQuestionRow, type PreferenceRow } from "@/server/memory/preferences";
import { renderProfileBlock } from "@/server/memory/profile";
import type { AgentTurnInput } from "@/server/pipeline/types";
import { listTimeline } from "@/server/timeline";
import type { TimelineItemView } from "@/server/timeline/types";
import { parsePersonaPrefs, type Tone } from "@/shared/persona-prefs";
import { computeRegisterHint, type RegisterHint } from "@/shared/register";

/** Lookback for repetition signals (V2-04 §2.6). */
const REPEAT_WINDOW_MS = 15 * 60_000;
/** Lookback for the scheduling-negotiation counter and stickiness (V2-04 §2.6). */
const RUNS_WINDOW_MS = 30 * 60_000;
const AGENDA_HORIZON_MS = 48 * 3_600_000;
const AGENDA_LIMIT = 40;
const MESSAGE_LOOKBACK = WINDOW_HARD_MAX + WINDOW_MAX + 10;

/** One of this user's recent agent runs (escalation pre-run signals). */
export interface RecentRun {
  startedAt: Date;
  escalated: boolean;
  escalationReason: string | null;
  /** tool names called in that run, in order (from `agent_runs.tool_calls`) */
  toolNames: string[];
}

/** Inputs for pre-run escalation rules (consumed by `agent/escalation.ts`, task 3.2). */
export interface PreflightSignals {
  /** this run's new inbound texts, oldest first */
  newTexts: string[];
  /** the student's history texts from the last 15 minutes (repetition check), oldest first */
  recentUserTexts: { text: string; at: Date }[];
  /** this user's other runs from the last 30 minutes, newest first */
  recentRuns: RecentRun[];
}

/** Everything `assembleTurnContext` needs from the database. */
export interface TurnData {
  user: Tables<"users">;
  profile: Tables<"user_profile"> | null;
  preferences: PreferenceRow[];
  openQuestion: OpenQuestionRow | null;
  summary: { text: string | null; throughMessageId: string | null } | null;
  /** recent messages, oldest first (this run's batch may be included; it's filtered out) */
  messages: MsgLite[];
  /** live tapbacks on those messages */
  reactions: HistoryReaction[];
  pendingActions: OpenAction[];
  /** next-48h timeline (+ overdue); null when the timeline couldn't be read */
  agenda: TimelineItemView[] | null;
  recentRuns: RecentRun[];
}

/** A fully assembled turn (consumed by the agent loop, task 3.2). */
export interface BuiltContext {
  /** static system prompt (BP1) */
  system: string;
  /** tool schemas in registry order (part of the static prefix) */
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  /** last history message (BP2); 0 = the per-user block when there's no history */
  historyBreakpointIndex: number;
  aliases: AliasTable;
  /** m_/x_ aliases of this run's user-authored batch (empty on proactive runs) */
  evidence: Set<string>;
  /** m_ aliases of the student's messages shown (history + batch): reaction / reply_to targets */
  userMessageAliases: Set<string>;
  /** newest batch message alias (ack safety-net target), or null */
  lastInbound: string | null;
  /** batch texts joined with "\n" (ToolCtx.userText) */
  userText: string;
  register: RegisterHint;
  tone: Tone;
  signals: PreflightSignals;
  openQuestion: boolean;
  pendingCount: number;
  lastAriaAskedQuestion: boolean;
  /** ack-only fast path: the tapback to send without a model call, or null */
  ack: ClassicTapback | null;
  /** the window exceeds 30 messages: enqueue `conversation_summary` */
  needsSummary: boolean;
}

function toolNamesOf(json: Json): string[] {
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  for (const v of json) {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const name = v.name ?? v.tool;
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

function warn(event: string, runId: string, e: unknown): void {
  console.warn(`agent.context: ${event}`, { runId, error: e instanceof Error ? e.name : "error" });
}

/**
 * Read everything a turn needs, in parallel. Users, profile, preferences, summary and messages
 * are required (errors propagate); agenda, pending actions and recent runs degrade.
 * @param input the turn input
 * @returns the turn data
 * @throws Error when the user row is missing or a required read fails
 */
export async function loadTurnData(input: AgentTurnInput): Promise<TurnData> {
  const { userId, runId, now } = input;
  const [user, profile, preferences, openQuestion, summary, recent, pendingActions, agenda, recentRuns] = await Promise.all([
    db().from("users").select("*").eq("id", userId).maybeSingle(),
    db().from("user_profile").select("*").eq("user_id", userId).maybeSingle(),
    listActivePreferences(userId),
    getOpenQuestion(userId),
    db().from("conversation_summaries").select("summary, through_message_id").eq("user_id", userId).maybeSingle(),
    db()
      .from("messages")
      .select("id, direction, body, media, reply_to_message_id, created_at, reactions(message_id, actor, type, removed_at)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MESSAGE_LOOKBACK + input.newMessages.length),
    listOpenActions(userId).catch((e: unknown) => {
      warn("pending actions unavailable", runId, e);
      return [] as OpenAction[];
    }),
    listTimeline(userId, {
      from: now,
      to: new Date(now.getTime() + AGENDA_HORIZON_MS),
      includeOverdue: true,
      timezone: input.timezone,
      now,
      limit: AGENDA_LIMIT,
    }).catch((e: unknown) => {
      warn("agenda unavailable", runId, e);
      return null;
    }),
    db()
      .from("agent_runs")
      .select("id, started_at, escalated, escalation_reason, tool_calls")
      .eq("user_id", userId)
      .gte("started_at", new Date(now.getTime() - RUNS_WINDOW_MS).toISOString())
      .order("started_at", { ascending: false })
      .limit(10)
      .then((r) => {
        if (r.error) {
          warn("recent runs unavailable", runId, new Error(r.error.code));
          return [] as RecentRun[];
        }
        return r.data
          .filter((x) => x.id !== runId)
          .map((x) => ({
            startedAt: new Date(x.started_at),
            escalated: x.escalated,
            escalationReason: x.escalation_reason,
            toolNames: toolNamesOf(x.tool_calls),
          }));
      }),
  ]);
  for (const [label, r] of [
    ["users", user],
    ["user_profile", profile],
    ["conversation_summaries", summary],
    ["messages", recent],
  ] as const) {
    if (r.error) throw new Error(`agent.context: ${label} read failed: ${r.error.message}`);
  }
  if (!user.data) throw new Error("agent.context: user not found");

  const rows = [...(recent.data ?? [])].reverse();
  const messages: MsgLite[] = rows.map((m) => ({
    id: m.id,
    direction: m.direction === "out" ? "out" : "in",
    body: m.body,
    media: parseMedia(m.media),
    replyToMessageId: m.reply_to_message_id,
    createdAt: new Date(m.created_at),
  }));
  const reactions: HistoryReaction[] = rows.flatMap((m) =>
    (m.reactions ?? [])
      .filter((r) => r.removed_at === null && (r.actor === "user" || r.actor === "aria"))
      .map((r) => ({ messageId: r.message_id, actor: r.actor as "user" | "aria", type: r.type })),
  );

  return {
    user: user.data,
    profile: profile.data,
    preferences,
    openQuestion,
    summary: summary.data ? { text: summary.data.summary, throughMessageId: summary.data.through_message_id } : null,
    messages,
    reactions,
    pendingActions,
    agenda,
    recentRuns,
  };
}

/**
 * Assemble the turn context from loaded data. Pure (no clock reads: everything time-based uses
 * `input.now`), so the same inputs give the same bytes.
 * @param input the turn input
 * @param data rows from `loadTurnData`
 * @param tools registered tools (default: the global registry)
 * @returns the built context
 */
export function assembleTurnContext(input: AgentTurnInput, data: TurnData, tools: readonly AgentTool[] = TOOLS): BuiltContext {
  const tz = input.timezone;
  const aliases = new AliasTable();
  const batch = [...input.newMessages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const batchIds = new Set(batch.map((m) => m.id));
  const cutoff = batch.length > 0 ? batch[batch.length - 1].createdAt.getTime() : input.now.getTime();

  // History: everything before this batch (later arrivals belong to the follow-up pass).
  const prior = data.messages.filter((m) => !batchIds.has(m.id) && m.createdAt.getTime() <= cutoff);
  const { window, needsSummary } = selectWindow(prior, data.summary?.throughMessageId ?? null);

  const prefs = renderPreferences(data.preferences, { aliases });
  const userBlock = renderUserContextBlock(renderProfileBlock(data.user, data.profile), prefs, data.summary?.text ?? null);
  const history = renderHistory(window, data.reactions, aliases, tz);
  const newBlock = renderNewMessages(batch, input.inboundReactions, aliases, tz);

  const userTexts = [...window.filter((m) => m.direction === "in").map((m) => m.body ?? ""), ...batch.map((m) => m.body ?? "")].filter(
    (t) => t.trim().length > 0,
  );
  const register = computeRegisterHint(userTexts);
  const tone = parsePersonaPrefs(data.user.persona_prefs).tone;
  const nowBlock = renderNowBlock({
    now: input.now,
    timezone: tz,
    channel: input.channel,
    identity: input.identity,
    trigger: input.trigger,
    welcomeSent: input.welcomeSent,
    isFollowUpPass: input.isFollowUpPass,
    register,
    tone,
    openQuestion: data.openQuestion
      ? { id: data.openQuestion.id, statement: data.openQuestion.statement, askedAt: data.openQuestion.askedAt }
      : null,
    pendingActions: data.pendingActions,
    agenda: data.agenda,
    aliases,
  });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: userBlock }] },
    ...history,
    { role: "user", content: [{ type: "text", text: `${nowBlock}\n${newBlock}` }] },
  ];

  const inbound = input.trigger.kind === "inbound";
  const batchAliases = batch.map((m) => aliases.mint("m", m.id));
  const evidence = new Set<string>(
    inbound ? [...batchAliases, ...input.inboundReactions.filter((r) => !r.removed).map((r) => aliases.mint("x", r.id))] : [],
  );
  const userMessageAliases = new Set<string>([
    ...window.filter((m) => m.direction === "in").map((m) => aliases.mint("m", m.id)),
    ...batchAliases,
  ]);
  const lastAria = [...window].reverse().find((m) => m.direction === "out");
  const lastAriaAskedQuestion = endsWithQuestion(lastAria?.body);

  const ackEligible = inbound && batch.length > 0 && input.inboundReactions.length === 0 && batch.every((m) => m.media.length === 0);
  const ack = ackEligible
    ? classifyAckOnly(
        batch.map((m) => m.body ?? ""),
        { openQuestion: data.openQuestion !== null, pendingActions: data.pendingActions.length, lastAriaAskedQuestion },
      )
    : null;

  const repeatSince = input.now.getTime() - REPEAT_WINDOW_MS;
  return {
    system: buildStaticSystemPrompt(tools),
    tools: toolSchemas(tools),
    messages,
    historyBreakpointIndex: history.length,
    aliases,
    evidence,
    userMessageAliases,
    lastInbound: batchAliases.length > 0 ? batchAliases[batchAliases.length - 1] : null,
    userText: batch
      .map((m) => m.body ?? "")
      .filter((t) => t.length > 0)
      .join("\n"),
    register,
    tone,
    signals: {
      newTexts: batch.map((m) => m.body ?? "").filter((t) => t.trim().length > 0),
      recentUserTexts: window
        .filter((m) => m.direction === "in" && m.body && m.createdAt.getTime() >= repeatSince)
        .map((m) => ({ text: m.body ?? "", at: m.createdAt })),
      recentRuns: data.recentRuns,
    },
    openQuestion: data.openQuestion !== null,
    pendingCount: data.pendingActions.length,
    lastAriaAskedQuestion,
    ack,
    needsSummary,
  };
}

/**
 * Build the context for one agent turn (DB reads in parallel, then a pure assembly).
 * @param input the turn input from the pipeline
 * @returns system, tools, messages, breakpoint index, alias table, evidence and turn signals
 */
export async function buildTurnContext(input: AgentTurnInput): Promise<BuiltContext> {
  return assembleTurnContext(input, await loadTurnData(input));
}
