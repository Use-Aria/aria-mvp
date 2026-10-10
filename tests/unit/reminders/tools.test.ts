/**
 * Reminder agent tools — the pure gates that run before any DB access: evidence rule (§1.0.5),
 * alias resolution (`t_` / `r_` only when shown this run), schema shapes and flags.
 */
import { AliasTable } from "@/server/agent/context/aliases";
import { cancelReminderTool, runCancelReminder } from "@/server/agent/tools/cancel-reminder";
import { createReminderTool, runCreateReminder } from "@/server/agent/tools/create-reminder";
import { listRemindersTool } from "@/server/agent/tools/list-reminders";
import { runUpdateNotificationSettings, updateNotificationSettingsTool } from "@/server/agent/tools/update-notification-settings";
import type { ToolCtx } from "@/server/agent/types";

const NOW = new Date("2026-10-12T16:00:00Z");
const EVIDENCE = "m_1a2b3c4d";

function ctx(over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    runId: "run1",
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
    aliases: new AliasTable(),
    evidence: new Set([EVIDENCE]),
    userText: "",
    taint: { tainted: false, mark: () => undefined },
    links: { add: () => "L1", resolve: () => null },
    interim: { sent: false, send: async () => false },
    signal: new AbortController().signal,
    log: () => undefined,
    ...over,
  };
}

describe("evidence gate", () => {
  it("create_reminder refuses without a user message from this batch", async () => {
    const r = await runCreateReminder(ctx(), { text: "x", when: { type: "in", minutes: 5 }, evidence: "m_ffffffff" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/evidence/) });
  });

  it("proactive runs fail closed", async () => {
    const c = ctx({ trigger: { kind: "proactive", reason: "reminder", event: "" } });
    const r = await runCancelReminder(c, { reminder: "r_12345678", evidence: EVIDENCE });
    expect(r.ok).toBe(false);
  });

  it("update_notification_settings checks evidence too", async () => {
    const r = await runUpdateNotificationSettings(ctx(), { briefingEnabled: false, evidence: "x_00000000" });
    expect(r.ok).toBe(false);
  });
});

describe("alias resolution", () => {
  it("create_reminder rejects a t_ alias not shown in this run", async () => {
    const r = await runCreateReminder(ctx(), {
      text: "pset in 2h",
      when: { type: "before_item", item: "t_deadbeef", minutesBefore: 120 },
      evidence: EVIDENCE,
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/unknown item t_deadbeef/) });
  });

  it("cancel_reminder rejects an r_ alias not shown in this run, and a t_ alias of the right hex", async () => {
    const c = ctx();
    const tAlias = c.aliases.mint("t", "12345678-1111-4111-8111-111111111111");
    expect((await runCancelReminder(c, { reminder: "r_12345678", evidence: EVIDENCE })).ok).toBe(false);
    expect(tAlias).toBe("t_12345678");
  });
});

describe("schemas and flags (frozen §1.4 shapes)", () => {
  it("mutating tools take evidence; list is read-only", () => {
    expect(createReminderTool.spec.mutates).toBe(true);
    expect(cancelReminderTool.spec.mutates).toBe(true);
    expect(updateNotificationSettingsTool.spec.mutates).toBe(true);
    expect(listRemindersTool.spec.mutates).toBeFalsy();
  });

  it("create_reminder rejects raw UUIDs and offset times; fills recurring defaults", () => {
    const s = createReminderTool.spec.input;
    expect(
      s.safeParse({ text: "x", when: { type: "before_item", item: "12345678-1111-4111-8111-111111111111", minutesBefore: 5 }, evidence: EVIDENCE })
        .success,
    ).toBe(false);
    expect(s.safeParse({ text: "x", when: { type: "at", local: "2026-10-13T21:00Z" }, evidence: EVIDENCE }).success).toBe(false);
    const ok = s.safeParse({ text: " x ", when: { type: "recurring", firstLocal: "2026-10-13T09:00", freq: "daily" }, evidence: EVIDENCE });
    expect(ok.success && ok.data).toMatchObject({ text: "x", when: { interval: 1 } });
  });

  it("update_notification_settings needs at least one field and a valid HH:MM", () => {
    const s = updateNotificationSettingsTool.spec.input;
    expect(s.safeParse({ evidence: EVIDENCE }).success).toBe(false);
    expect(s.safeParse({ briefingTime: "7:30", evidence: EVIDENCE }).success).toBe(false);
    expect(s.safeParse({ briefingTime: "07:30", evidence: EVIDENCE }).success).toBe(true);
    expect(s.safeParse({ deadlineNudgeMinutesBefore: [], evidence: EVIDENCE }).success).toBe(true);
    expect(s.safeParse({ deadlineNudgeMinutesBefore: [10], evidence: EVIDENCE }).success).toBe(false);
  });
});
