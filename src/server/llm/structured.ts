import "server-only";
// OWNER: 1.3

/**
 * `runStructured`: one call constrained by `output_config.format`, built with the SDK's
 * `zodOutputFormat` (its `parse` validates the full zod schema client-side, including constraints
 * the grammar can't express). The format's JSON schema comes from `jsonSchemaFor` so `$schema`
 * isn't folded into the root description.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { callAnthropic, type AnthropicDeps } from "@/server/llm/anthropic";
import { LlmBadRequestError, LlmRefusalError } from "@/server/llm/errors";
import type { ModelId, Route } from "@/server/llm/routes";
import { jsonSchemaFor } from "@/server/llm/schema";
import type { LlmLogMeta, UsageSummary } from "@/server/llm/types";

/** Output format with a client-side parser. */
export type ParseableFormat<T> = Anthropic.JSONOutputFormat & { parse(content: string): T };

const FORMATS = new WeakMap<z.ZodType, ParseableFormat<unknown>>();

/**
 * Memoized output format for a zod schema (`zodOutputFormat` parser + `$schema`-free JSON schema).
 * @param schema zod schema (object root)
 * @returns the format (same object for the same schema)
 */
export function structuredFormat<T>(schema: z.ZodType<T>): ParseableFormat<T> {
  const hit = FORMATS.get(schema);
  if (hit) return hit as ParseableFormat<T>;
  const sdkFormat = zodOutputFormat(schema);
  const format: ParseableFormat<T> = {
    type: "json_schema",
    schema: jsonSchemaFor(schema),
    parse: (content: string) => sdkFormat.parse(content) as T,
  };
  FORMATS.set(schema, format as ParseableFormat<unknown>);
  return format;
}

/** Input of `runStructured`. */
export interface StructuredInput<T> {
  route: Route;
  system: string;
  user: string | Anthropic.MessageParam[];
  schema: z.ZodType<T>;
  log?: LlmLogMeta;
  signal?: AbortSignal;
  /** Override the route's `maxTokens`. */
  maxTokens?: number;
}

/** Result of `runStructured`. */
export interface StructuredResult<T> {
  data: T;
  usage: UsageSummary;
  model: ModelId;
  stopReason: string | null;
}

/**
 * Run one structured-output call and validate the result with zod.
 * @param i route, prompt, schema, attribution
 * @param deps injectable transport deps (tests)
 * @returns parsed data + usage
 * @throws LlmRefusalError on refusal; LlmBadRequestError on truncation (`max_tokens`) or invalid
 *   output; LlmUnavailableError when the provider is down
 */
export async function runStructured<T>(i: StructuredInput<T>, deps?: AnthropicDeps): Promise<StructuredResult<T>> {
  const format = structuredFormat(i.schema);
  const messages: Anthropic.MessageParam[] = typeof i.user === "string" ? [{ role: "user", content: i.user }] : i.user;
  const { response } = await callAnthropic(
    {
      route: i.route,
      system: i.system,
      messages,
      outputFormat: { type: format.type, schema: format.schema },
      log: i.log ?? {},
      ...(i.signal ? { signal: i.signal } : {}),
      ...(i.maxTokens !== undefined ? { maxTokens: i.maxTokens } : {}),
    },
    deps,
  );
  if (response.stopReason === "refusal") throw new LlmRefusalError(response.refusal?.category ?? null);
  if (response.stopReason === "max_tokens") throw new LlmBadRequestError("structured output truncated (max_tokens)");
  let data: T;
  try {
    data = format.parse(response.text);
  } catch (err) {
    throw new LlmBadRequestError("structured output failed validation", { cause: err });
  }
  return { data, usage: response.usage, model: response.model, stopReason: response.stopReason };
}
