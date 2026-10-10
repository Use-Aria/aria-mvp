import "server-only";
// OWNER: 3.3

/**
 * Agent tool `propose_preference` (master plan §1.4 #23; input per V2-04 §9.2 (+ nullable constraint, §1.17)).
 * Wave 0 stub: final name, description, input and flags; `run` returns not_implemented.
 */
import { z } from "zod";
import { stubToolResult } from "@/server/_stub";
import { EV, defineTool } from "@/server/agent/tools/define";
import { ConstraintPrefSchema } from "@/shared/scheduling-constraints";

/** `propose_preference` tool. */
export const proposePreferenceTool = defineTool({
  name: "propose_preference",
  description:
    "Save a lasting preference or rule the student expressed (e.g. 'no gym after 8pm'). explicit=true only when they directly asked you to remember it; otherwise it becomes a question to confirm. Fill constraint when it's a scheduling rule find_free_slots should enforce, else null.",
  input: z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/),
    category: z.enum(["schedule", "reminders", "email", "briefing", "persona", "study", "other"]),
    statement: z.string().min(3).max(160),
    explicit: z.boolean(),
    constraint: ConstraintPrefSchema.nullable(),
    evidence: EV,
  }),
  strict: true,
  mutates: true,
  run: async () => stubToolResult("3.3"),
});
