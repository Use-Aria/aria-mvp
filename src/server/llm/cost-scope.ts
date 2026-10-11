import "server-only";
// OWNER: 5.3 (Wave 5 follow-up: tool-internal LLM cost attribution)

/**
 * Per-scope LLM cost attribution. The agent loop runs every tool inside `withLlmCostScope`, and
 * `recordLlmCall` reports each logged call's cost to the innermost active scope. That is how a
 * tool's own model calls (e.g. `draft_email`'s Sonnet `draft` call) reach `agent_runs.cost_usd`.
 *
 * Why a scope and not `sum(llm_calls.cost_usd) where run_id = …` at run end: `recordLlmCall`
 * gives up waiting after `LLM_LOG_TIMEOUT_MS` while the insert may still land later (or fail), so
 * a DB sum taken at run end can miss rows. The scope is fed synchronously, before the insert
 * starts, so the total never races the log write and still counts calls whose log row was lost.
 * Calls a tool merely enqueues (jobs that run later, e.g. `syllabus_parse`) are not part of the
 * run and are not counted.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type CostSink = (usd: number) => void;

const storage = new AsyncLocalStorage<CostSink>();

/**
 * Run `fn` with a cost sink: every `reportLlmCost` made from `fn`'s async call tree (until it
 * settles, and also from work it leaves running) is passed to `onCost`.
 * @param onCost receives each reported cost in USD (> 0, finite)
 * @param fn the work to attribute
 * @returns whatever `fn` returns
 */
export function withLlmCostScope<T>(onCost: CostSink, fn: () => Promise<T>): Promise<T> {
  return storage.run(onCost, fn);
}

/**
 * Report one LLM call's cost to the active scope (no-op outside a scope). Never throws.
 * @param usd cost of the call in USD
 */
export function reportLlmCost(usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const sink = storage.getStore();
  if (!sink) return;
  try {
    sink(usd);
  } catch {
    // Attribution must never break a model call.
  }
}
