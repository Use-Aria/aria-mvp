/**
 * Contract test (master plan §1.3 / §1.4 / §1.5 / §1.0.3): job-kind and tool registry names +
 * order, tool schema invariants, pending-action executors, and the shared contract schemas.
 *
 * The Wave 0 stub helpers (`src/server/_stub.ts`) were deleted by task 5.2 once every stub was
 * implemented; the last block asserts they stay gone, so a reintroduced stub fails here.
 */
import fs from "node:fs";
import path from "node:path";
import { TOOLS } from "@/server/agent/tools";
import { toolInputJsonSchema } from "@/server/agent/tools/define";
import { EXECUTORS, getExecutor } from "@/server/agent/pending/executors";
import { JOB_KINDS, REGISTERED_KINDS, isJobKind } from "@/server/jobs/kinds";
import type { JobContext } from "@/server/jobs/types";
import * as timeline from "@/server/timeline";
import { TIMELINE_STATUS_SUBSCRIBERS } from "@/server/timeline/hooks";
import { GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { DEFAULT_TARGET, LINK_TTL_MS, RECENT_SESSION_MS, SCOPE_FOR_PURPOSE, isLinkPurpose } from "@/server/security/link-policy";
import { ConstraintPrefSchema } from "@/shared/scheduling-constraints";
import { SendEmailPayload } from "@/shared/email-draft";

const U = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-10T15:00:00Z");

/** §1.3 table, in order: [kind, maxAttempts]. */
const KIND_TABLE: [string, number][] = [
  ["conversation_turn", 3],
  ["proactive_flush", 5],
  ["retention_purge", 3],
  ["noop", 1],
  ["memory_extract", 3],
  ["conversation_summary", 3],
  ["account_purge", 3],
  ["canvas_sync", 5],
  ["reminder_fire", 5],
  ["briefing_prepare", 5],
  ["briefing_send", 5],
  ["timeline_changes", 5],
  ["google_post_connect", 3],
  ["gcal_sync", 5],
  ["gcal_watch_renew", 5],
  ["gmail_watch_renew", 5],
  ["gmail_history_sync", 5],
  ["gmail_triage_chunk", 3],
  ["syllabus_parse", 2],
];

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

function jobCtx(kind: string): JobContext {
  return {
    jobId: "j1",
    kind,
    userId: U,
    attempt: 1,
    maxAttempts: 3,
    token: "t",
    now: NOW,
    deadline: NOW.getTime() + 60_000,
    signal: new AbortController().signal,
  };
}

const SRC = path.resolve(__dirname, "../../../src");

/** Every `.ts`/`.tsx` file under `dir`, as absolute paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("job kind registry (§1.3)", () => {
  it("has exactly the §1.3 kinds, in order, with the §1.3 maxAttempts", () => {
    expect(REGISTERED_KINDS).toEqual(KIND_TABLE.map(([k]) => k));
    for (const [kind, max] of KIND_TABLE) {
      expect(isJobKind(kind)).toBe(true);
      expect(JOB_KINDS[kind as keyof typeof JOB_KINDS].maxAttempts).toBe(max);
    }
    expect(isJobKind("toString")).toBe(false);
  });

  it("payload schemas accept the documented shapes", () => {
    expect(JOB_KINDS.canvas_sync.payload.parse({})).toEqual({ reason: "scheduled" });
    expect(() => JOB_KINDS.canvas_sync.payload.parse({ reason: "x" })).toThrow();
    expect(JOB_KINDS.syllabus_parse.payload.parse({ messageId: U })).toEqual({ messageId: U, mediaIndex: 0, replace: false });
    expect(JOB_KINDS.account_purge.payload.parse({ userId: U })).toEqual({ userId: U });
    expect(JOB_KINDS.reminder_fire.payload.parse({ reminderId: U, dueAt: NOW.toISOString() })).toBeTruthy();
    expect(JOB_KINDS.gmail_triage_chunk.payload.parse({ runId: "r", phase: "meta", ids: ["abcdef12"], offset: 0 })).toBeTruthy();
    expect(() => JOB_KINDS.gmail_triage_chunk.payload.parse({ runId: "r", phase: "meta", ids: ["XYZ"], offset: 0 })).toThrow();
    expect(
      JOB_KINDS.proactive_flush.payload.parse({
        items: [
          {
            plan: { bubbles: [{ text: "hi" }] },
            reason: "briefing",
            priority: "routine",
            dedupeKey: "briefing:2026-10-10",
            channelId: null,
            enqueuedAt: NOW.toISOString(),
            notBefore: null,
            expiresAt: null,
          },
        ],
      }).items,
    ).toHaveLength(1);
  });

  it("noop returns done", async () => {
    const run = JOB_KINDS.noop.run as (ctx: JobContext, payload: unknown) => Promise<unknown>;
    await expect(run(jobCtx("noop"), {})).resolves.toEqual({ type: "done" });
  });
});

describe("agent tool registry (§1.4)", () => {
  it("has exactly the §1.4 tools, in order", () => {
    expect(TOOLS.map((t) => t.spec.name)).toEqual(TOOL_NAMES);
    expect(TOOLS.map((t) => t.schema.name)).toEqual(TOOL_NAMES);
  });

  it("descriptions are ≥ 60 chars", () => {
    for (const t of TOOLS) expect(t.spec.description.length).toBeGreaterThanOrEqual(60);
  });

  it("every mutating tool takes evidence; strict tools ≤ 16", () => {
    for (const t of TOOLS) {
      if (t.spec.mutates) expect(Object.keys(t.spec.input.shape)).toContain("evidence");
    }
    expect(TOOLS.filter((t) => t.spec.strict).length).toBeLessThanOrEqual(16);
  });

  it("schemas are deterministic object schemas", () => {
    for (const t of TOOLS) {
      const again = toolInputJsonSchema(t.spec.input);
      expect(JSON.stringify({ ...again, type: "object" })).toBe(JSON.stringify(t.schema.input_schema));
      expect(t.schema.input_schema.type).toBe("object");
      expect(JSON.stringify(t.schema)).not.toContain("$schema");
    }
  });

  it("model-facing ids are 8-hex aliases", () => {
    const markDone = TOOLS.find((t) => t.spec.name === "mark_done");
    expect(markDone?.spec.input.safeParse({ item: "t_1a2b3c4d", status: "done", evidence: "m_1a2b3c4d" }).success).toBe(true);
    expect(markDone?.spec.input.safeParse({ item: U, status: "done", evidence: "m_1a2b3c4d" }).success).toBe(false);
    const propose = TOOLS.find((t) => t.spec.name === "propose_preference");
    expect(
      propose?.spec.input.safeParse({
        key: "gym.latest_time",
        category: "schedule",
        statement: "no gym after 8pm",
        explicit: false,
        constraint: { applies_to: ["gym"], constraint: { type: "not_after", time: "20:00" }, waking: null, signoff: null },
        evidence: "m_1a2b3c4d",
      }).success,
    ).toBe(true);
  });
});

describe("pending actions (§1.5)", () => {
  it("registers delete_account and send_email", () => {
    expect(EXECUTORS.map((e) => e.kind)).toEqual(["delete_account", "send_email"]);
    expect(getExecutor("send_email")?.ttlMs).toBe(24 * 60 * 60_000);
  });
});

describe("Wave 0 stubs are gone (§1.0.3)", () => {
  it("src/server/_stub.ts was deleted and nothing under src/ imports it or calls a stub helper", () => {
    expect(fs.existsSync(path.join(SRC, "server/_stub.ts"))).toBe(false);
    const offenders = sourceFiles(SRC).filter((file) => {
      const text = fs.readFileSync(file, "utf8");
      return /["']@\/server\/_stub["']/.test(text) || /\b(notImplemented|stubToolResult)\(/.test(text);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("timeline barrel aliases and status subscribers are wired", () => {
    expect(timeline.listItems).toBe(timeline.listTimeline);
    expect(TIMELINE_STATUS_SUBSCRIBERS).toHaveLength(1);
  });

  it("google error classes carry their discriminators", () => {
    expect(new GoogleApiError("x", { status: 503, retryable: true }).retryable).toBe(true);
    expect(new GoogleAuthRevokedError("invalid_grant").kind).toBe("invalid_grant");
    expect(new GoogleNotConnectedError("gmail_send").feature).toBe("gmail_send");
  });
});

describe("shared contracts", () => {
  it("link policy has the digest purpose (§1.15)", () => {
    expect(isLinkPurpose("digest")).toBe(true);
    expect(LINK_TTL_MS.digest).toBe(12 * 60 * 60_000);
    expect(SCOPE_FOR_PURPOSE.digest).toBe("view");
    expect(DEFAULT_TARGET.digest).toBe("/week");
    expect(RECENT_SESSION_MS).toBe(60 * 60_000);
  });

  it("constraint pref + email draft schemas parse their examples", () => {
    expect(
      ConstraintPrefSchema.safeParse({ applies_to: ["*"], constraint: null, waking: { start: "09:00", end: "01:00" }, signoff: null })
        .success,
    ).toBe(true);
    expect(
      SendEmailPayload.safeParse({
        v: 1,
        from: "me@example.com",
        to: ["prof@example.edu"],
        cc: [],
        subject: "Re: essay",
        body_text: "hi",
        original_rfc822_id: "<abc@mail>",
      }).success,
    ).toBe(true);
  });
});
