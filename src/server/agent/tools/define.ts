import "server-only";
// OWNER: 1.3 (master plan §1.4 = V2-04 §8.3)

/**
 * Tool framework: `defineTool`, `ToolResult`, `requireEvidence`, plus the shared zod helpers every
 * tool file uses for model-facing ids (`aliasRef`, `EV`). Ids are always `AliasTable` aliases
 * (prefix + 8 hex, +2 on collision; master plan §1.0.4) — never raw UUIDs.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AliasKind, ToolCtx } from "@/server/agent/types";
import { jsonSchemaFor } from "@/server/llm/schema";

export type ToolResult =
  /** serialized deterministically (sorted keys) ≤ 6000 chars */
  | { ok: true; data: string | Record<string, unknown> }
  | { ok: false; error: string; retryable?: boolean };

export interface ToolSpec<S extends z.ZodObject> {
  /** snake_case, unique; ≤ 64 chars */
  name: string;
  /** prescriptive: WHEN to call, not just what it does (≥ 60 chars, registry-tested) */
  description: string;
  /** z.object({...}).strict() */
  input: S;
  /** default false; strict budget enforced by test */
  strict?: boolean;
  /** true → takes `evidence` (EV), evidence gate, serialized execution */
  mutates?: boolean;
  /** true → ctx.taint.mark() after run; output must be wrapUntrusted'd */
  untrustedOutput?: boolean;
  /** hint in description to pair with send_interim */
  slow?: boolean;
  run(ctx: ToolCtx, input: z.output<S>): Promise<ToolResult>;
}
export interface AgentTool {
  spec: ToolSpec<z.ZodObject>;
  schema: Anthropic.Tool;
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SLOW_HINT = " This tool is slow: call send_interim in the same response.";

/**
 * Model-facing id of one alias kind, e.g. `aliasRef("t")` accepts `t_1a2b3c4d`.
 * @param kind alias prefix
 * @param description optional schema description shown to the model
 * @returns zod string schema matching `<kind>_` + 8–10 hex
 */
export function aliasRef(kind: AliasKind, description?: string): z.ZodString {
  const s = z.string().regex(new RegExp(`^${kind}_[0-9a-f]{8,10}$`));
  return description ? s.describe(description) : s;
}

/** `evidence` input every mutating tool takes (V2-04 §9.2 `EV`, 8-hex aliases). */
export const EV = z
  .string()
  .regex(/^[mx]_[0-9a-f]{8,10}$/)
  .describe("id of the user's message in <new_messages> that asked for this");

/**
 * JSON schema for a tool input: `z.toJSONSchema` (refs reused) → the SDK's strict-schema transform,
 * with `$schema` dropped first so it isn't folded into the description. Deterministic.
 * @param input the tool's zod input object
 * @returns JSON schema object (root `type: "object"`)
 */
export function toolInputJsonSchema(input: z.ZodType): Record<string, unknown> {
  return jsonSchemaFor(input);
}

/**
 * Declare an agent tool: keeps the spec and builds its Anthropic tool schema once
 * (the SDK's `zodOutputFormat` transform minus `$schema`; zod still validates at run time).
 * @param spec tool spec
 * @returns the registered tool (spec + JSON schema)
 * @throws Error if the name is not snake_case ≤ 64 chars
 */
export function defineTool<S extends z.ZodObject>(spec: ToolSpec<S>): AgentTool {
  if (!NAME_RE.test(spec.name)) throw new Error(`defineTool: invalid tool name "${spec.name}"`);
  const json: Record<string, unknown> = toolInputJsonSchema(spec.input);
  const schema: Anthropic.Tool = {
    name: spec.name,
    description: spec.slow ? spec.description + SLOW_HINT : spec.description,
    input_schema: { ...json, type: "object" },
    ...(spec.strict ? { strict: true } : {}),
  };
  return { spec, schema };
}

/**
 * Evidence gate for mutators: `alias` must be a user-authored inbound `m_`/`x_` alias of this
 * run's batch. Proactive runs have no batch, so they fail closed.
 * @param ctx tool context
 * @param alias the tool input's `evidence`
 * @returns `{ok: true}` or a `ToolResult` error to return to the model
 */
export function requireEvidence(ctx: ToolCtx, alias: string): { ok: true } | ToolResult {
  if (ctx.trigger.kind !== "inbound" || !ctx.evidence.has(alias)) {
    return {
      ok: false,
      error: "evidence must be the id of the user's own message in <new_messages> that asked for this",
    };
  }
  return { ok: true };
}
