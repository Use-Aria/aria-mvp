/**
 * Wave 0 contract test (master plan §1.3 / §1.4 / §1.0.3): registry names + order, tool schema
 * invariants, and "no stub mutator silently succeeds".
 *
 * The stub checks are dynamic: a module is policed only while its source file still imports
 * `@/server/_stub` (orchestrator notes: implementers remove that import). Implemented modules are
 * skipped automatically, so this test stays green wave over wave while every remaining stub is
 * still checked. The few Wave 0 neutral-read stubs that never imported `_stub` (they just return
 * an empty value) are recognised by their "Wave 0 stub" doc marker instead.
 */
import fs from "node:fs";
import path from "node:path";
import { NotImplementedError } from "@/server/_stub";
import type { ToolCtx } from "@/server/agent/types";
import { TOOLS } from "@/server/agent/tools";
import { toolInputJsonSchema } from "@/server/agent/tools/define";
import { EXECUTORS, getExecutor } from "@/server/agent/pending/executors";
import * as pending from "@/server/agent/pending/actions";
import { runAgentTurn } from "@/server/agent";
import type { AgentTurnInput } from "@/server/pipeline/types";
import { JOB_KINDS, REGISTERED_KINDS, isJobKind } from "@/server/jobs/kinds";
import type { JobContext } from "@/server/jobs/types";
import { cancelJobs, enqueueJob } from "@/server/jobs/enqueue";
import { deliver, deliverReply, flushOutbox } from "@/server/channels/deliver";
import { redactInboundBodies } from "@/server/channels/repo";
import * as memory from "@/server/memory";
import * as timeline from "@/server/timeline";
import { notifyStatusSubscribers, TIMELINE_STATUS_SUBSCRIBERS } from "@/server/timeline/hooks";
import * as canvas from "@/server/integrations/canvas";
import * as google from "@/server/integrations/google";
import { googleFetch, googleFetchNoContent } from "@/server/integrations/google/http";
import { getGoogleIntegration, updateGoogleIntegration } from "@/server/integrations/google/store";
import { getGoogleAccess, markGoogleUnavailable } from "@/server/integrations/google/tokens";
import { GoogleApiError, GoogleAuthRevokedError, GoogleNotConnectedError } from "@/server/integrations/google/errors";
import { renewGmailWatch, startGmailWatch, stopGmailWatch } from "@/server/integrations/google/gmail/sync";
import { classifyIngested } from "@/server/integrations/google/gmail/classify";
import { alertHighImportance } from "@/server/integrations/google/gmail/alerts";
import { startTriage } from "@/server/integrations/google/gmail/triage";
import * as syllabus from "@/server/integrations/syllabus";
import * as reminders from "@/server/reminders/service";
import { onUserScheduleSettingsChanged, scheduleNextBriefing } from "@/server/briefing/scheduler";
import { addBriefingNote } from "@/server/briefing/notes";
import { getNotificationSettings, updateNotificationSettings } from "@/server/proactive/settings";
import { handleTimelineChanges } from "@/server/alerts/timeline-changes";
import { deleteAccount } from "@/server/account/delete";
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

function toolCtx(): ToolCtx {
  return {
    userId: U,
    runId: "r1",
    now: NOW,
    timezone: "America/New_York",
    channel: {
      channelId: "c1",
      provider: "dev",
      kind: "imessage",
      service: "imessage",
      handleKind: "phone",
      capabilities: { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 },
      windowOpen: true,
    },
    trigger: { kind: "inbound" },
    aliases: { mint: (k, id) => `${k}_${id.slice(0, 8)}`, resolve: () => null, shown: () => false },
    evidence: new Set(["m_1a2b3c4d"]),
    userText: "",
    taint: { tainted: false, mark: () => undefined },
    links: { add: () => "L1", resolve: () => null },
    interim: { sent: false, send: async () => false },
    signal: new AbortController().signal,
    log: () => undefined,
  };
}

const SERVER_SRC = path.resolve(__dirname, "../../../src/server");

/**
 * Read a server source file (path relative to `src/server`). Fails loudly if the file is missing,
 * so a wrong mapping can never silently skip a stub check.
 */
function readServerSource(rel: string): string {
  const file = path.join(SERVER_SRC, rel);
  if (!fs.existsSync(file)) throw new Error(`registry test: source file not found: src/server/${rel}`);
  return fs.readFileSync(file, "utf8");
}

/** True while the module still imports the Wave 0 stub helpers (i.e. is not implemented yet). */
function isStub(rel: string): boolean {
  return /from\s+["']@\/server\/_stub["']/.test(readServerSource(rel));
}

/** True while a neutral-read stub that never imported `_stub` still carries its Wave 0 marker. */
function isWave0Neutral(rel: string): boolean {
  return isStub(rel) || /Wave 0 stub/.test(readServerSource(rel));
}

/** `snake_case` registry name → `kebab-case` file stem. */
function kebab(name: string): string {
  return name.replace(/_/g, "-");
}

/** A mutator call paired with the source file that defines it (relative to `src/server`). */
type StubCall = [file: string, call: () => Promise<unknown>];

/** Every listed promise whose defining file is still a stub must reject with NotImplementedError. */
async function expectAllStubbed(calls: StubCall[]): Promise<void> {
  for (const [file, call] of calls) {
    if (!isStub(file)) continue;
    await expect(call()).rejects.toBeInstanceOf(NotImplementedError);
  }
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

  it("noop (and timeline_changes until 4.1) return done; every still-stubbed kind dead-letters via NotImplementedError", async () => {
    for (const kind of REGISTERED_KINDS) {
      const file = `jobs/kinds/${kebab(kind)}.ts`;
      const handler = JOB_KINDS[kind];
      const run = handler.run as (ctx: JobContext, payload: unknown) => Promise<unknown>;
      if (kind === "noop" || (kind === "timeline_changes" && isWave0Neutral(file))) {
        await expect(run(jobCtx(kind), {})).resolves.toEqual({ type: "done" });
      } else if (isStub(file)) {
        await expect(run(jobCtx(kind), {})).rejects.toBeInstanceOf(NotImplementedError);
      }
    }
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

  it("no tool stub reports success", async () => {
    for (const t of TOOLS) {
      if (!isStub(`agent/tools/${kebab(t.spec.name)}.ts`)) continue;
      const res = await t.spec.run(toolCtx(), {});
      expect(res.ok).toBe(false);
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
  it("registers delete_account and send_email; executors never silently succeed", async () => {
    expect(EXECUTORS.map((e) => e.kind)).toEqual(["delete_account", "send_email"]);
    expect(getExecutor("send_email")?.ttlMs).toBe(24 * 60 * 60_000);
    const ctx = { userId: U, actionId: "a1", via: "chat" as const, now: NOW };
    for (const e of EXECUTORS) {
      if (!isStub(`agent/pending/executors/${kebab(e.kind)}.ts`)) continue;
      await expect(e.execute(ctx, {})).rejects.toBeInstanceOf(NotImplementedError);
    }
  });

  it("read paths are neutral, mutators throw (while stubbed)", async () => {
    const ACTIONS = "agent/pending/actions.ts";
    if (isStub(ACTIONS)) {
      await expect(pending.listOpenActions(U)).resolves.toEqual([]);
      await expect(pending.getPendingAction(U, "a1")).resolves.toBeNull();
    }
    await expectAllStubbed([
      [ACTIONS, () => pending.createPendingAction(toolCtx(), { kind: "delete_account", payload: {}, summary: "x" })],
      [ACTIONS, () => pending.revisePendingAction(U, "a1", 1, {}, "web")],
      [ACTIONS, () => pending.confirmPendingAction(U, "a1", { via: "web" })],
      [ACTIONS, () => pending.cancelPendingAction(U, "a1", "web")],
    ]);
  });
});

describe("stub mutators never silently succeed (§1.0.3)", () => {
  it("jobs, channels, agent", async () => {
    await expectAllStubbed([
      ["jobs/enqueue.ts", () => enqueueJob({ kind: "noop", payload: {} })],
      ["jobs/enqueue.ts", () => cancelJobs({ userId: U })],
      ["channels/deliver.ts", () => deliver(U, { bubbles: [{ text: "x" }] }, { proactive: true, reason: "test", dedupeKey: "k" })],
      [
        "channels/deliver.ts",
        () =>
          deliverReply({
            userId: U,
            channelId: "c",
            runId: "r",
            plan: { bubbles: [] },
            elapsedMs: 0,
            trigger: "reply",
            keyPrefix: "r",
          }),
      ],
      ["channels/deliver.ts", () => flushOutbox(U, "j", [], NOW)],
      ["channels/repo.ts", () => redactInboundBodies(U, [], (b) => b)],
      ["agent/index.ts", () => runAgentTurn({} as AgentTurnInput)],
    ]);
  });

  it("memory", async () => {
    const MEMORY = "memory/index.ts";
    if (isStub(MEMORY)) {
      await expect(memory.loadProfileBlock(U)).resolves.toBe("");
      await expect(memory.listActivePreferences(U)).resolves.toEqual([]);
      await expect(memory.listMemory(U)).resolves.toEqual({ profile: { name: null, school: null, courses: [] }, preferences: [], facts: [] });
    }
    await expectAllStubbed([
      [MEMORY, () => memory.refreshProfileBlock(U)],
      [
        MEMORY,
        () =>
          memory.insertProposal({
            userId: U,
            key: "k",
            category: "other",
            statement: "s",
            status: "queued",
            runId: "r",
            evidenceMessageId: null,
          }),
      ],
      [MEMORY, () => memory.decidePreference(U, "p", "confirm")],
      [MEMORY, () => memory.editPreference(U, "p", "s")],
      [MEMORY, () => memory.removePreference(U, "p")],
      [MEMORY, () => memory.answerProposal(U, "p", true)],
      [MEMORY, () => memory.editFact(U, "f", "c")],
      [MEMORY, () => memory.deleteFact(U, "f")],
      [MEMORY, () => memory.setProfileSchool(U, null)],
    ]);
  });

  it("timeline", async () => {
    const TIMELINE = "timeline/index.ts";
    expect(timeline.listItems).toBe(timeline.listTimeline);
    if (isStub(TIMELINE)) {
      await expect(timeline.listTimeline(U, { from: NOW, to: NOW })).resolves.toEqual([]);
      await expect(timeline.resolveItemRef(U, "t_1a2b3c4d")).resolves.toEqual({ ok: false, error: "not_found" });
    }
    await expectAllStubbed([
      [TIMELINE, () => timeline.applySnapshot({ userId: U, source: "canvas", items: [] })],
      [TIMELINE, () => timeline.replaceSourceWindow({ userId: U, source: "gcal", from: NOW, to: NOW, items: [] })],
      [TIMELINE, () => timeline.upsertTimelineItem(U, "gcal", { externalId: "e", kind: "event", title: "t" })],
      [TIMELINE, () => timeline.deleteTimelineItems(U, "gcal")],
      [TIMELINE, () => timeline.upsertTimelineItems(U, [])],
      [TIMELINE, () => timeline.pruneTimelineItems({ userId: U, source: "syllabus", externalIdPrefix: "syl:", keep: [] })],
      [TIMELINE, () => timeline.setTimelineItemStatus(U, U, "done")],
      [TIMELINE, () => timeline.markItemDone(U, U)],
      [TIMELINE, () => timeline.rebaseTimeline(U, "UTC")],
    ]);
  });

  it("timeline status subscribers are lazily wired to handleTimelineChanges and never throw", async () => {
    expect(TIMELINE_STATUS_SUBSCRIBERS).toHaveLength(1);
    if (!isStub("alerts/timeline-changes.ts")) return;
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(notifyStatusSubscribers(U, { initial: false, changes: [] }, NOW)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("NotImplementedError"));
    spy.mockRestore();
  });

  it("canvas + google", async () => {
    const CONNECT = "integrations/canvas/connect.ts";
    const ALERTS = "integrations/google/gmail/alerts.ts";
    const STORE = "integrations/google/store.ts";
    const HTTP = "integrations/google/http.ts";
    const TOKENS = "integrations/google/tokens.ts";
    const GMAIL_SYNC = "integrations/google/gmail/sync.ts";
    if (isStub(CONNECT)) await expect(canvas.getCanvasStatus(U)).resolves.toEqual({ connected: false });
    if (isWave0Neutral("integrations/google/status.ts")) {
      await expect(google.getGoogleStatus(U)).resolves.toEqual({ connected: false, reason: "none" });
    }
    if (isStub(ALERTS)) {
      await expect(google.listEmailItemsForBriefing(U, NOW)).resolves.toEqual([]);
      await expect(google.markEmailItemsSurfaced([])).resolves.toBeUndefined();
      await expect(alertHighImportance(U, [])).resolves.toBe(0);
    }
    if (isWave0Neutral("integrations/google/calendar/busy.ts")) {
      await expect(google.readBusy(U, NOW, NOW)).resolves.toEqual({ busy: [], calendarsChecked: 0 });
    }
    if (isStub(STORE)) await expect(getGoogleIntegration(U)).resolves.toBeNull();
    if (isWave0Neutral("integrations/google/gmail/classify.ts")) await expect(classifyIngested(U, [])).resolves.toEqual([]);
    await expectAllStubbed([
      [CONNECT, () => canvas.connectCanvas({ userId: U, rawUrl: "https://x.instructure.com/feeds/calendars/user_x.ics" })],
      [CONNECT, () => canvas.disconnectCanvas(U)],
      [CONNECT, () => canvas.requestCanvasSync(U, "manual")],
      ["integrations/canvas/sync.ts", () => canvas.runCanvasSync(U, { reason: "manual" })],
      ["integrations/google/disconnect.ts", () => google.disconnectGoogle(U, { reason: "user" })],
      [ALERTS, () => google.markEmailItemsSurfaced(["e1"])],
      [
        ALERTS,
        () =>
          alertHighImportance(U, [
            { id: "e", importance: "high", kind: "fyi", course: null, oldDue: null, newDue: null, confidence: 1, summary: "" },
          ]),
      ],
      [HTTP, () => googleFetch(U, { url: "https://example.com" }, SendEmailPayload)],
      [HTTP, () => googleFetchNoContent(U, { url: "https://example.com" })],
      [STORE, () => updateGoogleIntegration("i", {})],
      [TOKENS, () => getGoogleAccess(U)],
      [TOKENS, () => markGoogleUnavailable(U, "invalid_grant")],
      [GMAIL_SYNC, () => startGmailWatch(U)],
      [GMAIL_SYNC, () => renewGmailWatch(U)],
      [GMAIL_SYNC, () => stopGmailWatch(U)],
      ["integrations/google/gmail/triage.ts", () => startTriage(U)],
    ]);
    expect(new GoogleApiError("x", { status: 503, retryable: true }).retryable).toBe(true);
    expect(new GoogleAuthRevokedError("invalid_grant").kind).toBe("invalid_grant");
    expect(new GoogleNotConnectedError("gmail_send").feature).toBe("gmail_send");
  });

  it("syllabus, reminders, briefing, settings, alerts, account", async () => {
    const SYLLABUS = "integrations/syllabus/index.ts";
    const REMINDERS = "reminders/service.ts";
    const SETTINGS = "proactive/settings.ts";
    const SCHEDULER = "briefing/scheduler.ts";
    if (isStub(SYLLABUS)) {
      const items = [{ source: "canvas" as const, kind: "exam" as const, title: "Midterm", course: null, dueAt: null, startsAt: null, allDay: false, allDayDate: null }];
      expect(syllabus.collapseSyllabusDuplicates(items, "UTC")).toEqual(items);
      await expect(syllabus.getSyllabusSignals(U)).resolves.toEqual([]);
      await expect(syllabus.listSyllabi(U)).resolves.toEqual([]);
    }
    if (isStub(REMINDERS)) await expect(reminders.listReminders(U, "UTC", { includeAuto: true, limit: 5 })).resolves.toEqual([]);
    if (isStub(SETTINGS)) await expect(getNotificationSettings(U)).resolves.toMatchObject({ briefingEnabled: true, nudgeMinutes: [180] });
    await expectAllStubbed([
      [SYLLABUS, () => syllabus.runSyllabusIntake({ userId: U, bytes: Buffer.from("%PDF-"), source: "dev" })],
      ["integrations/syllabus/client.ts", () => syllabus.callParseSyllabus({} as never)],
      [REMINDERS, () => reminders.createReminder(U, "UTC", { text: "x", when: { type: "in", minutes: 5 } }, NOW)],
      [REMINDERS, () => reminders.cancelReminder(U, "r")],
      [REMINDERS, () => reminders.ensureAutoNudges(U, NOW)],
      [REMINDERS, () => reminders.recomputeAnchored(U, "i", null, NOW)],
      [REMINDERS, () => reminders.cancelForItem(U, "i", "auto", "test")],
      [REMINDERS, () => reminders.recomputeRecurring(U, "UTC", NOW)],
      [REMINDERS, () => reminders.reconcileReminderJobs(U, NOW)],
      [SCHEDULER, () => scheduleNextBriefing(U)],
      [SCHEDULER, () => onUserScheduleSettingsChanged(U)],
      ["briefing/notes.ts", () => addBriefingNote(U, "other", {})],
      [SETTINGS, () => updateNotificationSettings(U, { briefingEnabled: false })],
      ["alerts/timeline-changes.ts", () => handleTimelineChanges(U, { initial: false, changes: [] }, NOW)],
      ["account/delete.ts", () => deleteAccount(U, { via: "web" })],
    ]);
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
