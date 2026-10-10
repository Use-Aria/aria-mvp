import "server-only";
// OWNER: 3.3

/**
 * Agent tool `forget` (master plan §1.4 #25, conflict C18; V2-04 §9.2). Facts are HARD-deleted
 * ("forget X" must really forget); preferences are retired (active → superseded, open → rejected).
 * Every id must be an `f_`/`p_` alias shown in this run (via recall / list_memory / context).
 */
import { z } from "zod";
import { EV, defineTool, requireEvidence, type ToolResult } from "@/server/agent/tools/define";
import type { ToolCtx } from "@/server/agent/types";
import { deleteFacts, retirePreferences } from "@/server/memory";

const input = z.strictObject({
  items: z
    .array(z.string().regex(/^[fp]_[0-9a-f]{8,10}$/))
    .min(1)
    .max(5),
  evidence: EV,
});

/**
 * Split aliases into fact / preference ids (pure).
 * @param ctx tool context (alias table)
 * @param items f_/p_ aliases
 * @returns resolved ids and the aliases that didn't resolve in this run
 */
export function resolveForgetItems(ctx: Pick<ToolCtx, "aliases">, items: readonly string[]): { facts: string[]; prefs: string[]; unknown: string[] } {
  const out = { facts: [] as string[], prefs: [] as string[], unknown: [] as string[] };
  for (const a of new Set(items)) {
    const kind = a.startsWith("f_") ? "f" : "p";
    const id = ctx.aliases.resolve(a, kind);
    if (!id) out.unknown.push(a);
    else if (kind === "f") out.facts.push(id);
    else out.prefs.push(id);
  }
  return out;
}

/**
 * Tool body (exported for tests).
 * @param ctx tool context
 * @param i parsed input
 * @returns "ok: forgot N", or a model-readable error (nothing is changed when any id is unknown)
 */
export async function runForget(ctx: ToolCtx, i: z.output<typeof input>): Promise<ToolResult> {
  const gate = requireEvidence(ctx, i.evidence);
  if (!gate.ok) return gate;
  const r = resolveForgetItems(ctx, i.items);
  if (r.unknown.length > 0) return { ok: false, error: `unknown ids ${r.unknown.join(", ")}: find them with recall or list_memory first` };
  try {
    const [facts, prefs] = await Promise.all([deleteFacts(ctx.userId, r.facts), retirePreferences(ctx.userId, r.prefs)]);
    return { ok: true, data: `ok: forgot ${facts + prefs}` };
  } catch (e) {
    ctx.log("forget_failed", { error: e instanceof Error ? e.name : "error" });
    return { ok: false, error: "couldn't forget that just now", retryable: true };
  }
}

/** `forget` tool. */
export const forgetTool = defineTool({
  name: "forget",
  description:
    "Forget remembered facts or preferences the student wants gone (f_/p_ ids shown in this run via recall or list_memory). Facts are permanently deleted; preferences are retired.",
  input,
  strict: true,
  mutates: true,
  run: runForget,
});
