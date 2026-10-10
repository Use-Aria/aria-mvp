/**
 * Reply plan parsing + resolution (V2-04 §10.1 plan; master plan C2).
 */
import { AliasTable } from "@/server/agent/context/aliases";
import { REPLY_FORMAT, parseModelPlan, resolvePlan, type ModelReplyPlan } from "@/server/agent/plan";
import type { LinkSlots } from "@/server/agent/types";
import type { ChannelContext } from "@/server/channels/types";
import { estimateTokens, clampLines } from "@/server/agent/context/budget";

const IN1 = "11111111-0000-4000-8000-000000000001";
const IN2 = "22222222-0000-4000-8000-000000000002";
const OUT1 = "33333333-0000-4000-8000-000000000003";

const IMESSAGE: ChannelContext = {
  channelId: "c1",
  provider: "dev",
  kind: "imessage",
  service: "imessage",
  handleKind: "phone",
  capabilities: { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 },
  windowOpen: true,
};
const SMS: ChannelContext = {
  ...IMESSAGE,
  kind: "sms",
  service: "sms",
  capabilities: { reactions: false, typing: false, inlineReplies: false, media: false, maxBubbleChars: 1200 },
};

function setup() {
  const aliases = new AliasTable();
  const m1 = aliases.mint("m", IN1);
  const m2 = aliases.mint("m", IN2);
  const mOut = aliases.mint("m", OUT1); // Aria's own message
  const urls = new Map([["L1", "https://aria.vercel.app/m/abc"]]);
  const links: LinkSlots = { add: () => "L2", resolve: (h) => urls.get(h) ?? null };
  const opts = { userMessageAliases: new Set([m1, m2]), lastInbound: m2 };
  return { aliases, links, opts, m1, m2, mOut };
}

const plan = (p: Partial<ModelReplyPlan>): ModelReplyPlan => ({ reactions: [], bubbles: [], reply_to: null, link: null, ...p });

describe("parseModelPlan", () => {
  it("parses valid JSON and rejects anything else", () => {
    expect(parseModelPlan('{"reactions":[],"bubbles":["hi"],"reply_to":null,"link":null}')).toEqual(plan({ bubbles: ["hi"] }));
    expect(parseModelPlan("hi")).toBeNull();
    expect(parseModelPlan('{"bubbles":["hi"]}')).toBeNull();
    expect(parseModelPlan('{"reactions":[{"target":"m_1","type":"wave"}],"bubbles":[],"reply_to":null,"link":null}')).toBeNull();
  });

  it("REPLY_FORMAT is a strict json_schema with no optional params and no $schema", () => {
    expect(REPLY_FORMAT.type).toBe("json_schema");
    expect(REPLY_FORMAT.schema.required).toEqual(["reactions", "bubbles", "reply_to", "link"]);
    expect(REPLY_FORMAT.schema.additionalProperties).toBe(false);
    expect(JSON.stringify(REPLY_FORMAT)).not.toContain("$schema");
  });
});

describe("resolvePlan", () => {
  it("merges bubbles beyond 3 into the third", () => {
    const { aliases, links, opts } = setup();
    const r = resolvePlan(plan({ bubbles: ["a", "b", "c", "d", "e"] }), aliases, links, IMESSAGE, opts);
    expect(r.plan.bubbles.map((b) => b.text)).toEqual(["a", "b", "c\n\nd\n\ne"]);
    expect(r.warnings).toContain("bubbles_merged:5");
  });

  it("a link counts toward the cap and its handle is substituted with the URL", () => {
    const { aliases, links, opts } = setup();
    const r = resolvePlan(plan({ bubbles: ["a", "b", "c"], link: "L1" }), aliases, links, IMESSAGE, opts);
    expect(r.plan.link).toEqual({ url: "https://aria.vercel.app/m/abc" });
    expect(r.plan.bubbles.map((b) => b.text)).toEqual(["a", "b\n\nc"]);
    const bad = resolvePlan(plan({ bubbles: ["a"], link: "https://evil.example" }), aliases, links, IMESSAGE, opts);
    expect(bad.plan.link).toBeUndefined();
    expect(bad.warnings.some((w) => w.startsWith("link_dropped"))).toBe(true);
    expect(resolvePlan(plan({ bubbles: ["a"], link: "L7" }), aliases, links, IMESSAGE, opts).plan.link).toBeUndefined();
  });

  it("drops unknown / non-user reaction targets with a warning and maps aliases to ids", () => {
    const { aliases, links, opts, m1, mOut } = setup();
    const r = resolvePlan(
      plan({
        bubbles: ["ok"],
        reactions: [
          { target: m1, type: "love" },
          { target: "m_deadbeef", type: "like" },
          { target: mOut, type: "laugh" },
          { target: m1, type: "like" }, // duplicate target
        ],
      }),
      aliases,
      links,
      IMESSAGE,
      opts,
    );
    expect(r.plan.reactions).toEqual([{ targetMessageId: IN1, type: "love" }]);
    expect(r.warnings.filter((w) => w.startsWith("reaction_dropped"))).toHaveLength(2);
  });

  it("reply_to must be a user message and threads the first bubble", () => {
    const { aliases, links, opts, m1, mOut } = setup();
    const ok = resolvePlan(plan({ bubbles: ["a", "b"], reply_to: m1 }), aliases, links, IMESSAGE, opts);
    expect(ok.plan.bubbles).toEqual([{ text: "a", replyToMessageId: IN1 }, { text: "b" }]);
    const own = resolvePlan(plan({ bubbles: ["a"], reply_to: mOut }), aliases, links, IMESSAGE, opts);
    expect(own.plan.bubbles).toEqual([{ text: "a" }]);
    expect(own.warnings.some((w) => w.startsWith("reply_to_dropped"))).toBe(true);
  });

  it("strips echoed [m_…] transcript prefixes", () => {
    const { aliases, links, opts } = setup();
    const r = resolvePlan(
      plan({ bubbles: ["[m_11111111] sure thing", "[m_22222222 Oct 14 2:14pm] got it", "  ", "[x_1a2b3c4d] ok"] }),
      aliases,
      links,
      IMESSAGE,
      opts,
    );
    expect(r.plan.bubbles.map((b) => b.text)).toEqual(["sure thing", "got it", "ok"]);
  });

  it("SMS drops reactions next to text and nulls reply_to", () => {
    const { aliases, links, opts, m1 } = setup();
    const r = resolvePlan(plan({ bubbles: ["done"], reactions: [{ target: m1, type: "like" }], reply_to: m1 }), aliases, links, SMS, opts);
    expect(r.plan.reactions).toBeUndefined();
    expect(r.plan.bubbles).toEqual([{ text: "done" }]);
    expect(r.warnings).toContain("reactions_unsupported");
  });

  it("SMS tapback-only keeps one reaction with a text fallback", () => {
    const { aliases, links, opts, m1, m2 } = setup();
    const r = resolvePlan(plan({ reactions: [{ target: m1, type: "love" }, { target: m2, type: "like" }] }), aliases, links, SMS, opts);
    expect(r.plan.reactions).toEqual([{ targetMessageId: IN1, type: "love", fallbackText: "❤️" }]);
    expect(r.plan.bubbles).toEqual([]);
  });

  it("empty plan with no reaction → like on the last inbound (ack safety net)", () => {
    const { aliases, links, opts } = setup();
    const r = resolvePlan(plan({ bubbles: ["   "] }), aliases, links, IMESSAGE, opts);
    expect(r.plan).toEqual({ bubbles: [], reactions: [{ targetMessageId: IN2, type: "like" }] });
    expect(r.warnings).toContain("empty_plan_ack");
    const proactive = resolvePlan(plan({}), aliases, links, IMESSAGE, { ...opts, lastInbound: null });
    expect(proactive.plan).toEqual({ bubbles: [] });
  });

  it("caps reactions at 2", () => {
    const aliases = new AliasTable();
    const ids = ["a", "b", "c"].map((c) => aliases.mint("m", `${c.repeat(8)}-0000-4000-8000-000000000000`));
    const r = resolvePlan(
      plan({ reactions: ids.map((target) => ({ target, type: "like" as const })) }),
      aliases,
      { add: () => "L1", resolve: () => null },
      IMESSAGE,
      { userMessageAliases: new Set(ids), lastInbound: ids[2] },
    );
    expect(r.plan.reactions).toHaveLength(2);
  });
});

describe("budget", () => {
  it("estimateTokens is ceil(chars/3)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("a".repeat(300))).toBe(100);
  });

  it("clampLines keeps the longest whole-line prefix within budget", () => {
    const lines = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
    expect(clampLines(lines, 10)).toEqual([lines[0]]);
    expect(clampLines(lines, 21)).toEqual([lines[0], lines[1]]); // 30 + 1 + 30 = 61 chars → 21 tokens
    expect(clampLines(lines, 1000)).toEqual(lines);
    expect(clampLines(lines, 5)).toEqual([]);
  });
});
