/**
 * Tool registry invariants (master plan §1.4 registry test; V2-04 §10.1).
 */
import { createHash } from "node:crypto";
import { TOOLS } from "@/server/agent/tools";
import { defineTool, toolInputJsonSchema } from "@/server/agent/tools/define";
import { STRICT_LIMITS, getTool, strictBudget, toolSchemas } from "@/server/agent/tools/registry";
import { REPLY_FORMAT } from "@/server/agent/plan";
import { z } from "zod";

/** §1.4 table, in order. */
const TOOL_NAMES = [
  "send_interim",
  "send_link",
  "get_agenda",
  "search_deadlines",
  "mark_done",
  "connect_canvas",
  "canvas_status",
  "create_reminder",
  "list_reminders",
  "cancel_reminder",
  "update_notification_settings",
  "find_free_slots",
  "create_block",
  "move_block",
  "delete_block",
  "search_email",
  "read_email",
  "draft_email",
  "read_syllabus",
  "syllabus_info",
  "recall",
  "list_memory",
  "propose_preference",
  "confirm_preference",
  "forget",
  "update_profile",
  "confirm_action",
  "cancel_action",
  "pause",
  "sign_out_everywhere",
  "request_account_deletion",
];

const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

describe("tool registry (§1.4)", () => {
  it("names and order equal the §1.4 table; names are unique", () => {
    expect(TOOLS).toHaveLength(31);
    expect(TOOLS.map((t) => t.spec.name)).toEqual(TOOL_NAMES);
    expect(toolSchemas().map((s) => s.name)).toEqual(TOOL_NAMES);
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
  });

  it("schemas are deterministic: rebuilding gives byte-identical JSON (same hash, same key order)", () => {
    const first = sha(toolSchemas());
    const rebuilt = TOOLS.map((t) => ({ ...t.schema, input_schema: { ...toolInputJsonSchema(t.spec.input), type: "object" } }));
    expect(sha(rebuilt)).toBe(first);
    expect(sha(toolSchemas())).toBe(first);
    expect(toolSchemas()).toBe(toolSchemas()); // memoized: identical objects every turn
    expect(sha(REPLY_FORMAT)).toBe(sha({ type: "json_schema", schema: REPLY_FORMAT.schema }));
    for (const t of TOOLS) {
      expect(t.schema.input_schema.type).toBe("object");
      expect(JSON.stringify(t.schema)).not.toContain("$schema");
    }
  });

  it("strict budget incl. the reply format: ≤16 strict tools, ≤20 optional params, ≤14 unions", () => {
    const b = strictBudget(TOOLS, [REPLY_FORMAT]);
    expect(b.strictTools).toBeLessThanOrEqual(STRICT_LIMITS.strictTools);
    expect(b.optionalParams).toBeLessThanOrEqual(STRICT_LIMITS.optionalParams);
    expect(b.unions).toBeLessThanOrEqual(STRICT_LIMITS.unions);
  });

  it("strictBudget counts optional and union-typed params (nested too)", () => {
    const tool = defineTool({
      name: "budget_probe",
      description: "Probe tool used only by this test to check strict budget counting; never registered.",
      input: z.strictObject({
        a: z.string().optional(),
        b: z.string().nullable(),
        c: z.strictObject({ d: z.number().optional(), e: z.union([z.string(), z.number()]) }),
      }),
      strict: true,
      run: async () => ({ ok: true, data: "" }),
    });
    expect(strictBudget([tool])).toEqual({ strictTools: 1, optionalParams: 2, unions: 2 });
    expect(strictBudget([{ ...tool, schema: { ...tool.schema, strict: false } }])).toEqual({ strictTools: 0, optionalParams: 0, unions: 0 });
    expect(strictBudget([], [REPLY_FORMAT])).toEqual({ strictTools: 0, optionalParams: 0, unions: 2 });
  });

  it("every mutating tool requires evidence", () => {
    const mutators = TOOLS.filter((t) => t.spec.mutates);
    expect(mutators.length).toBeGreaterThan(0);
    for (const t of mutators) {
      expect(Object.keys(t.spec.input.shape)).toContain("evidence");
      expect(t.schema.input_schema.required).toContain("evidence");
    }
  });

  it("descriptions are ≥ 60 chars", () => {
    for (const t of TOOLS) expect(t.spec.description.length).toBeGreaterThanOrEqual(60);
  });

  it("getTool looks up by name", () => {
    expect(getTool("mark_done")?.spec.name).toBe("mark_done");
    expect(getTool("react")).toBeUndefined();
    expect(getTool("toString")).toBeUndefined();
  });
});
