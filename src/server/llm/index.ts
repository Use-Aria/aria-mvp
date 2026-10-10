/**
 * Aria V2 — provider-agnostic LLM access layer.
 *
 * Every model call in Aria goes through `runModel`. Call sites name a ROUTE
 * (what the call is for), and the route maps to a model + settings here — so
 * model/cost decisions live in one place and any workload can be re-pointed
 * (e.g. to a free provider like Groq) later without touching call sites.
 *
 * Decisions — see docs/plans/2026-10-09-aria-v2-free-testing-plan.md:
 *   - main chat + anything reading email : Claude Haiku 5.5
 *   - hard scheduling / repeated failures: Claude Sonnet 5.5 (escalation)
 *   - classify / memory / briefing       : Claude Haiku 5.5
 *   - syllabus PDF parsing               : Claude Sonnet 5.5
 * Billing: Anthropic API, covered by the Max plan's monthly API credits.
 * Model ids verified available on this org via GET /v1/models (2026-10-09).
 */
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export type Route =
  | "chat" // main agent turn (voice + tools)
  | "escalate" // hard scheduling negotiation / repeated tool failures
  | "classify" // deadline / email classification (structured output)
  | "memory" // background fact extraction + consolidation
  | "briefing" // daily briefing synthesis
  | "syllabus"; // PDF parsing

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface RouteConfig {
  model: string;
  maxTokens: number;
  effort: Effort;
}

const ROUTES: Record<Route, RouteConfig> = {
  chat: { model: "claude-haiku-5-5", maxTokens: 1024, effort: "low" },
  escalate: { model: "claude-sonnet-5-5", maxTokens: 2048, effort: "low" },
  classify: { model: "claude-haiku-5-5", maxTokens: 512, effort: "low" },
  memory: { model: "claude-haiku-5-5", maxTokens: 1024, effort: "medium" },
  briefing: { model: "claude-haiku-5-5", maxTokens: 1024, effort: "medium" },
  syllabus: { model: "claude-sonnet-5-5", maxTokens: 4096, effort: "medium" },
};

// $/MTok (Anthropic API, 2026-10-09).
const PRICING: Record<
  string,
  { in: number; cacheRead: number; cacheWrite: number; out: number }
> = {
  "claude-haiku-5-5": { in: 0.1, cacheRead: 0.01, cacheWrite: 0.125, out: 0.5 },
  "claude-sonnet-5-5": { in: 2.0, cacheRead: 0.1, cacheWrite: 2.5, out: 10.0 },
};

export interface RunInput {
  route: Route;
  system: string; // stable prefix — cached across turns
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
}

export interface RunResult {
  text: string;
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
  raw: Anthropic.Message;
}

function costFor(model: string, u: Anthropic.Usage): number {
  const p = PRICING[model];
  if (!p) return 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  return (
    ((u.input_tokens ?? 0) * p.in +
      cr * p.cacheRead +
      cw * p.cacheWrite +
      (u.output_tokens ?? 0) * p.out) /
    1_000_000
  );
}

/**
 * Run one model call for a route. The system prompt is marked cacheable so
 * repeated turns in a reply burst hit the prompt cache (~2.5x cheaper).
 * Adaptive thinking is left on (correct for both Haiku 5.5 and Sonnet 5.5);
 * cost tuning (e.g. thinking off for `classify`) comes with the eval pass.
 */
export async function runModel(input: RunInput): Promise<RunResult> {
  const cfg = ROUTES[input.route];

  const res = await anthropic.messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: cfg.effort },
    system: [
      {
        type: "text",
        text: input.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    ...(input.tools?.length ? { tools: input.tools } : {}),
    messages: input.messages,
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const usage = {
    inputTokens: res.usage.input_tokens ?? 0,
    outputTokens: res.usage.output_tokens ?? 0,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    costUsd: costFor(cfg.model, res.usage),
  };

  // TODO: persist to the `llm_calls` table (route, model, tokens, cost, latency).
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[llm] ${input.route} ${cfg.model} in=${usage.inputTokens} cacheRead=${usage.cacheReadTokens} out=${usage.outputTokens} $${usage.costUsd.toFixed(5)}`,
    );
  }

  return { text, stopReason: res.stop_reason, usage, raw: res };
}
