import "server-only";
// OWNER: 1.3

/**
 * Registry helpers (V2-04 §7.2 `tools/registry.ts`): deterministic schema list for the request,
 * lookup by name, and the strict-schema budget the API enforces per request.
 *
 * API limits (structured outputs, combined across strict tools + the output format): 20 strict
 * tools, 24 optional params, 16 union-typed params. Aria keeps headroom (`STRICT_LIMITS`), checked
 * by `tests/unit/agent/registry.test.ts`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { TOOLS } from "@/server/agent/tools";
import type { AgentTool } from "@/server/agent/tools/define";

/** Aria's strict budget (below the API's 20 / 24 / 16). */
export const STRICT_LIMITS = Object.freeze({ strictTools: 16, optionalParams: 20, unions: 14 });

/** Strict-schema usage of a request. */
export interface StrictBudget {
  strictTools: number;
  optionalParams: number;
  unions: number;
}

const SCHEMA_CACHE = new WeakMap<readonly AgentTool[], Anthropic.Tool[]>();

/**
 * The `tools` request param, in registry order. Memoized per array, so every turn sends the
 * identical objects (byte-stable cached prefix).
 * @param tools tool list (default: the global registry)
 * @returns Anthropic tool definitions
 */
export function toolSchemas(tools: readonly AgentTool[] = TOOLS): Anthropic.Tool[] {
  const hit = SCHEMA_CACHE.get(tools);
  if (hit) return hit;
  const schemas = tools.map((t) => t.schema);
  SCHEMA_CACHE.set(tools, schemas);
  return schemas;
}

let byName: Map<string, AgentTool> | null = null;

/**
 * Registered tool by name.
 * @param name tool name from a `tool_use` block
 * @returns the tool, or undefined for an unknown name
 */
export function getTool(name: string): AgentTool | undefined {
  if (!byName) byName = new Map(TOOLS.map((t) => [t.spec.name, t]));
  return byName.get(name);
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Walk a JSON schema, counting optional properties and union-typed properties. */
function countSchema(node: unknown, acc: { optional: number; unions: number }): void {
  if (Array.isArray(node)) {
    for (const n of node) countSchema(n, acc);
    return;
  }
  if (!isObj(node)) return;
  const props = isObj(node.properties) ? node.properties : null;
  if (props) {
    const required = new Set(Array.isArray(node.required) ? node.required.filter((r): r is string => typeof r === "string") : []);
    for (const [key, prop] of Object.entries(props)) {
      if (!required.has(key)) acc.optional++;
      if (isObj(prop)) {
        const anyOf = Array.isArray(prop.anyOf) ? prop.anyOf.length : 0;
        const types = Array.isArray(prop.type) ? prop.type.length : 0;
        if (anyOf > 1 || types > 1) acc.unions++;
      }
    }
  }
  for (const [key, v] of Object.entries(node)) {
    if (key === "properties" && props) {
      for (const p of Object.values(props)) countSchema(p, acc);
    } else if (key === "items" || key === "anyOf" || key === "allOf" || key === "$defs" || key === "additionalProperties") {
      countSchema(key === "$defs" && isObj(v) ? Object.values(v) : v, acc);
    }
  }
}

/**
 * Strict-schema usage: strict tools, plus optional and union-typed params across strict tool
 * inputs and any structured output formats sent with them.
 * @param tools tool list
 * @param formats output formats sent in the same request (e.g. `REPLY_FORMAT`)
 * @returns counts to compare with `STRICT_LIMITS`
 */
export function strictBudget(tools: readonly AgentTool[], formats: readonly Anthropic.JSONOutputFormat[] = []): StrictBudget {
  const acc = { optional: 0, unions: 0 };
  let strictTools = 0;
  for (const t of tools) {
    if (!t.schema.strict) continue;
    strictTools++;
    countSchema(t.schema.input_schema, acc);
  }
  for (const f of formats) countSchema(f.schema, acc);
  return { strictTools, optionalParams: acc.optional, unions: acc.unions };
}
