/**
 * Task 4.3 email tools — gates that run before any DB/Gmail access (evidence rule, alias
 * resolution) and the frozen schema flags (draft_email mutates + takes evidence, is not strict;
 * the model has no send tool).
 * Run: npm test -- tests/unit/agent/tools-email.test.ts
 */
import { AliasTable } from "@/server/agent/context/aliases";
import { TOOLS } from "@/server/agent/tools";
import { draftEmailTool } from "@/server/agent/tools/draft-email";
import { readEmailTool, runReadEmail } from "@/server/agent/tools/read-email";
import { searchEmailTool } from "@/server/agent/tools/search-email";
import { draftEmail } from "@/server/integrations/google/gmail/draft";
import type { ToolCtx } from "@/server/agent/types";

const USER = "00000000-0000-4000-8000-000000000001";
const MSG = "11111111-1111-4111-8111-111111111111";

function ctx(over: Partial<ToolCtx> = {}): ToolCtx & { aliases: AliasTable } {
  const aliases = new AliasTable();
  const ev = aliases.mint("m", MSG);
  return {
    userId: USER,
    runId: "22222222-2222-4222-8222-222222222222",
    now: new Date("2026-10-12T16:00:00Z"),
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
    aliases,
    evidence: new Set([ev]),
    userText: "",
    taint: { tainted: false, mark: () => undefined },
    links: { add: () => "L1", resolve: () => null },
    interim: { sent: false, send: async () => true },
    signal: new AbortController().signal,
    log: () => undefined,
    ...over,
  } as ToolCtx & { aliases: AliasTable };
}

const BASE = { mode: "new" as const, reply_all: false, to: ["lee@example.edu"], intent: "ask for an extension" };

describe("draft_email gates", () => {
  it("refuses without user evidence of this run, and on proactive runs", async () => {
    const c = ctx();
    expect((await draftEmail(c, { ...BASE, evidence: "m_99999999" })).ok).toBe(false);
    const p = ctx({ trigger: { kind: "proactive", reason: "email_alert", event: "" } });
    const ev = [...p.evidence][0];
    const r = await draftEmail(p, { ...BASE, evidence: ev });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/evidence/);
  });

  it("rejects an e_ / a_ alias not shown in this run", async () => {
    const c = ctx();
    const ev = [...c.evidence][0];
    const a = await draftEmail(c, { ...BASE, mode: "reply", email: "e_12345678", evidence: ev });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toMatch(/search_email again/);
    const b = await draftEmail(c, { ...BASE, revise: "a_12345678", evidence: ev });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toMatch(/unknown draft/);
  });

  it("schema: reply needs email unless revising; new needs to", () => {
    const parse = (v: Record<string, unknown>) => draftEmailTool.spec.input.safeParse({ intent: "x", evidence: "m_11111111", ...v }).success;
    expect(parse({ mode: "reply" })).toBe(false);
    expect(parse({ mode: "reply", email: "e_1234abcd" })).toBe(true);
    expect(parse({ mode: "reply", revise: "a_1234abcd" })).toBe(true);
    expect(parse({ mode: "new" })).toBe(false);
    expect(parse({ mode: "new", to: ["a@b.co"] })).toBe(true);
  });
});

describe("read_email gates", () => {
  it("rejects an unshown e_ alias before touching Gmail", async () => {
    const r = await runReadEmail(ctx(), { email: "e_deadbeef" });
    expect(r.ok).toBe(false);
  });
});

describe("email tool flags", () => {
  it("draft_email mutates with evidence, is non-strict, marks untrusted output, and says it never sends", () => {
    expect(draftEmailTool.spec.mutates).toBe(true);
    expect(draftEmailTool.spec.strict).toBeFalsy();
    expect(draftEmailTool.schema.strict).toBeUndefined();
    expect(draftEmailTool.spec.untrustedOutput).toBe(true);
    expect(draftEmailTool.schema.description).toMatch(/NEVER sends/);
    expect(JSON.stringify(draftEmailTool.schema.input_schema)).toContain("evidence");
  });

  it("search/read are read-only untrusted-output tools", () => {
    for (const t of [searchEmailTool, readEmailTool]) {
      expect(t.spec.mutates).toBeFalsy();
      expect(t.spec.untrustedOutput).toBe(true);
      expect(t.schema.strict).toBeUndefined();
    }
  });

  it("no tool can send email", () => {
    expect(TOOLS.map((t) => t.spec.name).filter((n) => /send_email|send_mail/.test(n))).toEqual([]);
  });
});
