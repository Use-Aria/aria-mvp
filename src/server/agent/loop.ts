import "server-only";
// OWNER: 3.2

/**
 * The model ⇄ tool loop (V2-04 §2.1, §2.6, §2.10; master plan §1.2, §8 risks 11–12).
 * Framework-free over `callModel`, with every dependency injected so tests drive it with a fake
 * caller (no network).
 *
 * Invariants (tested in `tests/unit/agent/loop.test.ts`):
 *  - The message array is APPEND-ONLY within a run (preserved thinking: the API rejects a
 *    replayed thinking block after any edit to earlier messages). Each `response.content`
 *    (thinking blocks included) is appended verbatim; every request's `messages` extends the
 *    previous request's.
 *  - All `tool_result` blocks of one assistant turn go back in ONE user message, in `tool_use`
 *    order. `send_interim` runs before the other tools; mutators run one at a time.
 *  - ≤ `MAX_TOOL_ITERATIONS` tool iterations, then a forced final call (`tool_choice: none`).
 *  - Escalation switches Haiku → Sonnet at most once and never back.
 *  - Tool failures (throw, timeout, zod-invalid input, unknown alias, `{ok:false}`) become
 *    `is_error` results; they never throw out of the loop. `LlmUnavailableError` and aborts do.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { BuiltContext } from "@/server/agent/context/build";
import { MAX_TOOL_ITERATIONS, MAX_TOOL_RESULT_CHARS, TOOL_TIMEOUT_MS } from "@/server/agent/config";
import { midRunEscalation, type EscalationReason } from "@/server/agent/escalation";
import { REPLY_FORMAT, parseModelPlan, type ModelReplyPlan } from "@/server/agent/plan";
import type { ToolCallRecord } from "@/server/agent/runs";
import type { AgentTool, ToolResult } from "@/server/agent/tools/define";
import type { LinkSlots, ToolCtx, UntrustedSource } from "@/server/agent/types";
import { ROUTES, type LlmRequest, type LlmResponse, type ModelId, type Route } from "@/server/llm";
import { registerClass, type RegisterHint } from "@/shared/register";

/** Failed tool iterations after which a non-escalated run is forced to answer. */
export const FAILED_ITERATIONS_TO_FORCE = 3;

/** Injected dependencies of `runLoop`. */
export interface LoopDeps {
  /** one model call (`callModel` in production; a scripted fake in tests) */
  call: (req: LlmRequest) => Promise<LlmResponse>;
  /** executable tools, looked up by name (the schemas sent come from the context) */
  tools: readonly AgentTool[];
  /** claim an escalation for this run (cap-checked); true → later calls use the escalate route */
  claimEscalation: (reason: EscalationReason) => Promise<boolean>;
  /** ms clock for tool timings */
  now: () => number;
  /** per-tool timeout (default `TOOL_TIMEOUT_MS`) */
  toolTimeoutMs?: number;
}

/** The parts of a built turn context the loop reads. */
export type LoopContext = Pick<BuiltContext, "system" | "tools" | "messages" | "historyBreakpointIndex" | "register">;

/** Where the run starts (after pre-run escalation). */
export interface LoopStart {
  model: ModelId;
  escalated: boolean;
  escalationReason: EscalationReason | null;
}

/** Counters the loop updates as it goes (callers keep a reference to write partial stats on failure). */
export interface LoopStats {
  model: ModelId;
  escalated: boolean;
  escalationReason: EscalationReason | null;
  /** tool-executing iterations */
  iterations: number;
  llmCalls: number;
  costUsd: number;
  toolCalls: ToolCallRecord[];
}

/** How the loop ended. */
export type LoopEnd =
  | "final" // the model answered with a parseable plan
  | "forced_limit" // answered on the forced call after MAX_TOOL_ITERATIONS
  | "forced_failures" // answered on the forced call after repeated tool failures
  | "forced_max_tokens" // answered on the forced call after a max_tokens stop mid tool_use
  | "partial" // max_tokens on the final answer; bubbles salvaged from partial JSON
  | "refusal" // stop_reason "refusal" → canned bubble
  | "unparseable"; // no usable plan → canned bubble

/** Result of `runLoop`. */
export interface LoopOutcome extends LoopStats {
  plan: ModelReplyPlan;
  end: LoopEnd;
  /** `stop_details.category` on a refusal */
  refusalCategory: string | null;
  /** codes only (no text) */
  warnings: string[];
}

/** Canned persona lines (register-aware) for runs without a usable model answer. */
export const CANNED = Object.freeze({
  refusal: {
    casual: "can't help with that one, but i'm here for anything school or schedule",
    neutral: "I can't help with that one, but I'm here for anything school or schedule related.",
  },
  trouble: {
    casual: "i'm having trouble with that one, can you try rephrasing?",
    neutral: "I'm having trouble with that one. Can you try rephrasing?",
  },
});

/** Text appended (as our own note, after the tool results) before a forced final call. */
const FORCE_NOTE: Readonly<Record<"forced_limit" | "forced_failures", string>> = {
  forced_limit: "<aria_note>Tool limit reached for this turn. Reply to the student now with what you have.</aria_note>",
  forced_failures:
    "<aria_note>Tools keep failing this turn. Reply now: tell the student you're having trouble with that one and ask them to try rephrasing.</aria_note>",
};

/**
 * Fresh loop counters.
 * @param start starting model/escalation
 * @returns zeroed stats
 */
export function newLoopStats(start: LoopStart): LoopStats {
  return {
    model: start.model,
    escalated: start.escalated,
    escalationReason: start.escalationReason,
    iterations: 0,
    llmCalls: 0,
    costUsd: 0,
    toolCalls: [],
  };
}

/**
 * Plan with one canned bubble.
 * @param kind which canned line
 * @param register the student's register (casual → lowercase line)
 * @returns a model reply plan
 */
export function cannedPlan(kind: keyof typeof CANNED, register: RegisterHint): ModelReplyPlan {
  return { reactions: [], bubbles: [CANNED[kind][registerClass(register)]], reply_to: null, link: null };
}

/**
 * Parse the model's final text, leniently: strict JSON first, then the outermost `{…}` (code
 * fences, stray prose), then — for output cut off by `max_tokens` — the complete string literals of
 * the `bubbles` array.
 * @param text the response text
 * @returns a plan, or null when nothing usable is in the text
 */
export function lenientParsePlan(text: string): ModelReplyPlan | null {
  const strict = parseModelPlan(text.trim());
  if (strict) return strict;
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open >= 0 && close > open) {
    const inner = parseModelPlan(text.slice(open, close + 1));
    if (inner) return inner;
  }
  const at = text.indexOf('"bubbles"');
  if (at < 0) return null;
  const head = /^"bubbles"\s*:\s*\[/.exec(text.slice(at));
  if (!head) return null;
  let rest = text.slice(at + head[0].length);
  const bubbles: string[] = [];
  const STR = /^\s*,?\s*"((?:[^"\\]|\\.)*)"/;
  for (;;) {
    const m = STR.exec(rest);
    if (!m) break;
    try {
      bubbles.push(JSON.parse(`"${m[1]}"`) as string);
    } catch {
      break;
    }
    rest = rest.slice(m[0].length);
    if (/^\s*\]/.test(rest)) break;
  }
  return bubbles.length > 0 ? { reactions: [], bubbles, reply_to: null, link: null } : null;
}

/**
 * Deterministic JSON (object keys sorted at every level).
 * @param value any JSON-like value
 * @returns the JSON text
 */
export function stableStringify(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = norm(o[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value)) ?? "null";
}

const TRUNCATED = "…[truncated]";

/**
 * Serialize a successful tool result for the model (sorted keys, ≤ `MAX_TOOL_RESULT_CHARS`).
 * @param data the tool's `data`
 * @returns tool_result content text
 */
export function serializeToolData(data: string | Record<string, unknown>): string {
  const s = typeof data === "string" ? data : stableStringify(data);
  return s.length <= MAX_TOOL_RESULT_CHARS ? s : s.slice(0, MAX_TOOL_RESULT_CHARS - TRUNCATED.length) + TRUNCATED;
}

/** Model-facing alias shape (attachment suffix allowed); see `AliasTable`. */
const ALIAS_VALUE_RE = /^([mxtapfres])_([0-9a-f]{8,10})(?::\d{1,3})?$/;

/**
 * Alias-shaped strings in a tool input that weren't shown in this run.
 * @param value parsed tool input
 * @param shown `AliasTable.shown`
 * @returns the unknown aliases (deduped, input order)
 */
export function unknownAliases(value: unknown, shown: (alias: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const m = ALIAS_VALUE_RE.exec(v);
      if (m) {
        const base = `${m[1]}_${m[2]}`;
        if (!shown(base) && !out.includes(v)) out.push(v);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(value);
  return out;
}

/** Taint source per untrusted-output tool (informational; any mark taints the run). */
const TAINT_SOURCE: Readonly<Record<string, UntrustedSource>> = {
  search_email: "email",
  read_email: "email",
  draft_email: "email",
  find_free_slots: "calendar",
  read_syllabus: "syllabus",
  syllabus_info: "syllabus",
  get_agenda: "canvas",
  search_deadlines: "canvas",
  canvas_status: "canvas",
};

/**
 * Per-run link slots: `add(url)` → "L1", "L2", …; the model only ever sees the handle.
 * @returns a fresh `LinkSlots`
 */
export function createLinkSlots(): LinkSlots {
  const urls: string[] = [];
  return {
    add(url: string): string {
      const i = urls.indexOf(url);
      if (i >= 0) return `L${i + 1}`;
      urls.push(url);
      return `L${urls.length}`;
    },
    resolve(handle: string): string | null {
      const m = /^L(\d{1,2})$/.exec(handle.trim());
      if (!m) return null;
      return urls[Number(m[1]) - 1] ?? null;
    },
  };
}

/** Taint tracker with the sources that tainted the run. */
export interface TaintState {
  readonly tainted: boolean;
  readonly sources: ReadonlySet<UntrustedSource>;
  mark(source: UntrustedSource): void;
}

/**
 * Fresh taint tracker (`ToolCtx.taint`).
 * @returns an untainted state
 */
export function createTaint(): TaintState {
  const sources = new Set<UntrustedSource>();
  return {
    get tainted() {
      return sources.size > 0;
    },
    sources,
    mark(source: UntrustedSource) {
      sources.add(source);
    },
  };
}

/**
 * `ToolCtx.interim`: at most one interim per run through this context. The pipeline's watchdog
 * calls the same `send` function directly; it returns false when one already went out.
 * @param send the pipeline's `AgentTurnInput.interim`
 * @returns the interim handle
 */
export function createInterim(send: (text: string) => Promise<boolean>): ToolCtx["interim"] {
  let sent = false;
  return {
    get sent() {
      return sent;
    },
    async send(text: string): Promise<boolean> {
      if (sent) return false;
      const ok = await send(text);
      if (ok) sent = true;
      return ok;
    },
  };
}

class ToolTimeoutError extends Error {
  constructor() {
    super("tool timed out");
    this.name = "ToolTimeoutError";
  }
}

/** One prepared tool call. */
type Prepared =
  | { kind: "error"; use: Anthropic.ToolUseBlock; content: string; counts: boolean }
  | { kind: "run"; use: Anthropic.ToolUseBlock; tool: AgentTool; input: unknown };

interface Executed {
  block: Anthropic.ToolResultBlockParam;
  /** counts toward the failed-iteration rule */
  failed: boolean;
}

function errorText(error: string, retryable: boolean | undefined): string {
  return retryable === undefined ? error : `${error}; retryable=${retryable}`;
}

function prepare(use: Anthropic.ToolUseBlock, byName: ReadonlyMap<string, AgentTool>, ctx: ToolCtx): Prepared {
  const tool = byName.get(use.name);
  if (!tool) return { kind: "error", use, content: `unknown tool "${use.name.slice(0, 64)}"`, counts: true };
  const parsed = tool.spec.input.safeParse(use.input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(input)"}: ${i.message}`)
      .join("; ");
    return { kind: "error", use, content: `invalid input: ${issues}`, counts: true };
  }
  const unknown = unknownAliases(parsed.data, (a) => ctx.aliases.shown(a));
  if (unknown.length > 0) {
    return {
      kind: "error",
      use,
      content: `unknown id ${unknown[0]}; use an id from context or a tool result`,
      counts: true,
    };
  }
  return { kind: "run", use, tool, input: parsed.data };
}

async function runWithTimeout(tool: AgentTool, ctx: ToolCtx, input: unknown, timeoutMs: number): Promise<ToolResult> {
  const timer = new AbortController();
  const signal = AbortSignal.any([ctx.signal, timer.signal]);
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      timer.abort();
      reject(new ToolTimeoutError());
    }, timeoutMs);
  });
  try {
    // `input` is the zod output of this tool's own schema.
    return await Promise.race([tool.spec.run({ ...ctx, signal }, input as Record<string, unknown>), timeout]);
  } finally {
    clearTimeout(handle);
  }
}

async function execute(p: Prepared, ctx: ToolCtx, deps: LoopDeps, iteration: number, stats: LoopStats): Promise<Executed> {
  if (p.kind === "error") {
    stats.toolCalls.push({ name: p.use.name.slice(0, 64), iteration, ok: false, ms: 0 });
    return { block: { type: "tool_result", tool_use_id: p.use.id, content: p.content, is_error: true }, failed: p.counts };
  }
  const name = p.tool.spec.name;
  const started = deps.now();
  let result: ToolResult;
  try {
    result = await runWithTimeout(p.tool, ctx, p.input, deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof ToolTimeoutError) result = { ok: false, error: "tool timed out", retryable: true };
    else {
      const retryable = typeof e === "object" && e !== null && "retryable" in e && e.retryable === true;
      result = { ok: false, error: `tool failed (${e instanceof Error ? e.name : "error"})`, retryable };
      ctx.log("tool_threw", { tool: name, error: e instanceof Error ? e.name : "error" });
    }
  }
  stats.toolCalls.push({ name, iteration, ok: result.ok, ms: deps.now() - started });
  if (!result.ok) {
    // Stubs (not implemented yet) and a second interim are not the model's fault: no escalation.
    const failed = result.error !== "not_implemented" && name !== "send_interim";
    return {
      block: { type: "tool_result", tool_use_id: p.use.id, content: errorText(result.error, result.retryable), is_error: true },
      failed,
    };
  }
  if (p.tool.spec.untrustedOutput) ctx.taint.mark(TAINT_SOURCE[name] ?? "canvas");
  return { block: { type: "tool_result", tool_use_id: p.use.id, content: serializeToolData(result.data) }, failed: false };
}

/**
 * Execute one assistant turn's tool calls: `send_interim` first, then the rest — read tools
 * concurrently, mutators one at a time in call order. Results come back in `tool_use` order.
 */
async function executeAll(
  uses: readonly Anthropic.ToolUseBlock[],
  byName: ReadonlyMap<string, AgentTool>,
  ctx: ToolCtx,
  deps: LoopDeps,
  iteration: number,
  stats: LoopStats,
): Promise<Executed[]> {
  const prepared = uses.map((u) => prepare(u, byName, ctx));
  const results: Executed[] = new Array<Executed>(prepared.length);
  const isInterim = (p: Prepared) => p.kind === "run" && p.tool.spec.name === "send_interim";

  for (let i = 0; i < prepared.length; i++) {
    if (isInterim(prepared[i])) results[i] = await execute(prepared[i], ctx, deps, iteration, stats);
  }
  const reads: Promise<void>[] = [];
  const mutators: number[] = [];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    if (isInterim(p)) continue;
    if (p.kind === "run" && p.tool.spec.mutates) mutators.push(i);
    else reads.push(execute(p, ctx, deps, iteration, stats).then((r) => void (results[i] = r)));
  }
  const chain = (async () => {
    for (const i of mutators) results[i] = await execute(prepared[i], ctx, deps, iteration, stats);
  })();
  await Promise.all([...reads, chain]);
  return results;
}

function routeFor(stats: LoopStats): Route {
  return stats.escalated ? "escalate" : "chat";
}

/**
 * Run the model ⇄ tool loop for one turn.
 * @param ctx tool context for this run (aliases, evidence, taint, links, interim, signal)
 * @param built the assembled context (system, tool schemas, messages, BP2 index, register)
 * @param deps model caller, executable tools, escalation claim, clock
 * @param start starting model / pre-run escalation
 * @param stats counters to update (pass your own to read partial stats after a throw)
 * @returns the model's reply plan (or a canned one) and the run stats
 * @throws LlmUnavailableError (retryable) | LlmBadRequestError | the abort reason of `ctx.signal`
 */
export async function runLoop(
  ctx: ToolCtx,
  built: LoopContext,
  deps: LoopDeps,
  start: LoopStart,
  stats: LoopStats = newLoopStats(start),
): Promise<LoopOutcome> {
  const byName = new Map(deps.tools.map((t) => [t.spec.name, t]));
  const messages: Anthropic.MessageParam[] = [...built.messages];
  const warnings: string[] = [];
  const seenCalls = new Set<string>();
  let failedIterations = 0;
  let repeatedCall = false;
  let escalationTried = start.escalated;
  let forced: "forced_limit" | "forced_failures" | "forced_max_tokens" | null = null;

  const done = (plan: ModelReplyPlan, end: LoopEnd, refusalCategory: string | null = null): LoopOutcome => ({
    ...stats,
    toolCalls: [...stats.toolCalls],
    plan,
    end,
    refusalCategory,
    warnings,
  });

  for (;;) {
    ctx.signal.throwIfAborted();
    const req: LlmRequest = {
      route: routeFor(stats),
      model: stats.model,
      system: built.system,
      tools: built.tools,
      messages: messages.slice(),
      outputFormat: REPLY_FORMAT,
      historyBreakpointIndex: built.historyBreakpointIndex,
      autoCacheTail: true,
      ...(forced ? { toolChoice: { type: "none" } as const } : {}),
      log: { userId: ctx.userId, runId: ctx.runId, iteration: stats.llmCalls },
      signal: ctx.signal,
    };
    const res = await deps.call(req);
    stats.llmCalls++;
    stats.costUsd += res.usage.costUsd;

    if (res.stopReason === "refusal") {
      const category = res.refusal?.category ?? null;
      ctx.log("refusal", { category: category ?? "none" });
      return done(cannedPlan("refusal", built.register), "refusal", category);
    }

    const truncated = res.stopReason === "max_tokens" || res.stopReason === "model_context_window_exceeded";
    const uses = forced ? [] : res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (truncated && !forced && (uses.length > 0 || res.text.trim().length === 0)) {
      // Cut off mid tool_use: drop that response (never appended) and force a final answer on
      // the unchanged history — still append-only.
      warnings.push(`max_tokens:${stats.llmCalls}`);
      forced = "forced_max_tokens";
      continue;
    }

    if (uses.length === 0) {
      const text = res.text;
      const strict = truncated ? null : parseModelPlan(text.trim());
      if (strict) return done(strict, forced ?? "final");
      const lenient = lenientParsePlan(text);
      if (lenient) {
        warnings.push(truncated ? "partial_plan" : "lenient_plan");
        return done(lenient, truncated ? "partial" : (forced ?? "final"));
      }
      warnings.push(text.trim().length === 0 ? "empty_text" : "unparseable_plan");
      return done(cannedPlan("trouble", built.register), "unparseable");
    }

    // Tool turn: append the response verbatim (thinking blocks included), then run the tools.
    messages.push({ role: "assistant", content: res.content });
    const iteration = stats.iterations + 1;
    let repeatedNow = false;
    for (const u of uses) {
      const key = `${u.name}\u0000${stableStringify(u.input)}`;
      if (seenCalls.has(key)) repeatedNow = true;
      seenCalls.add(key);
    }
    const executed = await executeAll(uses, byName, ctx, deps, iteration, stats);
    stats.iterations = iteration;
    if (repeatedNow) repeatedCall = true;
    if (repeatedNow || executed.some((e) => e.failed)) failedIterations++;

    if (!escalationTried) {
      const reason = midRunEscalation({ failedIterations, repeatedCall });
      if (reason) {
        escalationTried = true;
        if (await deps.claimEscalation(reason)) {
          stats.escalated = true;
          stats.escalationReason = reason;
          stats.model = ROUTES.escalate.model;
          ctx.log("escalated", { reason, iteration });
        }
      }
    }

    if (stats.iterations >= MAX_TOOL_ITERATIONS) forced = "forced_limit";
    else if (!stats.escalated && failedIterations >= FAILED_ITERATIONS_TO_FORCE) forced = "forced_failures";

    const content: Anthropic.ContentBlockParam[] = executed.map((e) => e.block);
    if (forced === "forced_limit" || forced === "forced_failures") {
      warnings.push(forced);
      content.push({ type: "text", text: FORCE_NOTE[forced] });
    }
    messages.push({ role: "user", content });
  }
}
