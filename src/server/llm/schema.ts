import "server-only";
// OWNER: 1.3

/**
 * zod → JSON schema for tool inputs and `output_config.format`: the same transform the SDK's
 * `zodOutputFormat` applies (`z.toJSONSchema` + `transformJSONSchema`, which moves unsupported
 * constraints into descriptions), but with `$schema` dropped first — otherwise the transform folds
 * it into the root description. Deterministic: key order follows zod declaration order.
 */
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import { z } from "zod";

/**
 * Strict-mode-compatible JSON schema for a zod type.
 * @param schema zod schema (root should be an object for tools / output formats)
 * @returns JSON schema object (no `$schema` key)
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...z.toJSONSchema(schema, { reused: "ref" }) };
  delete raw.$schema;
  return transformJSONSchema(raw);
}
