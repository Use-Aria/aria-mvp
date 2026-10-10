/**
 * channels/render.ts — step order, pacing, first-bubble credit, SMS degradation, media.
 */
import { bubblePauseMs, quotePrefix, renderPlan, type RenderStep } from "@/server/channels/render";
import type { ChannelCapabilities, ReplyPlan } from "@/server/channels/types";

const IMESSAGE: ChannelCapabilities = { reactions: true, typing: true, inlineReplies: true, media: true, maxBubbleChars: 1200 };
const SMS: ChannelCapabilities = { reactions: false, typing: false, inlineReplies: false, media: true, maxBubbleChars: 1200 };
const noCredit = { elapsedMs: 0, snippets: {} };

const kinds = (steps: RenderStep[]) => steps.map((s) => s.t);

describe("bubblePauseMs", () => {
  it("clamps to [800, 4000] at 35 chars/s", () => {
    expect(bubblePauseMs("x")).toBe(800);
    expect(bubblePauseMs("x".repeat(35))).toBe(1000);
    expect(bubblePauseMs("x".repeat(70))).toBe(2000);
    expect(bubblePauseMs("x".repeat(500))).toBe(4000);
    expect(bubblePauseMs("")).toBe(800);
  });
  it("counts code points, not UTF-16 units", () => {
    expect(bubblePauseMs("😀".repeat(35))).toBe(1000);
  });
});

describe("renderPlan order", () => {
  it("reactions first, then (typing, pause, send) per bubble, then link, then media", () => {
    const plan: ReplyPlan = {
      reactions: [{ targetMessageId: "in1", type: "love" }],
      bubbles: [{ text: "nice" }, { text: "see you then" }],
      link: { url: "https://aria.example.app/week" },
      media: [{ url: "https://aria.example.app/aria.vcf", kind: "vcard" }],
    };
    const steps = renderPlan(plan, IMESSAGE, noCredit);
    expect(kinds(steps)).toEqual([
      "react",
      "typing", "pause", "send",
      "typing", "pause", "send",
      "typing", "pause", "send",
      "send",
    ]);
    const sends = steps.filter((s): s is Extract<RenderStep, { t: "send" }> => s.t === "send");
    expect(sends.map((s) => s.kind)).toEqual(["bubble", "bubble", "link", "media"]);
    expect(sends[2].text).toBe("https://aria.example.app/week");
    expect(sends[3].mediaUrl).toBe("https://aria.example.app/aria.vcf");
  });

  it("assigns unique, increasing bubbleIndex values across react and send steps", () => {
    const steps = renderPlan(
      { reactions: [{ targetMessageId: "a", type: "like" }], bubbles: [{ text: "x" }, { text: "y" }] },
      IMESSAGE,
      noCredit,
    );
    const idx = steps.flatMap((s) => ("bubbleIndex" in s ? [s.bubbleIndex] : []));
    expect(idx).toEqual([0, 1, 2]);
  });

  it("skips the link bubble when a bubble already contains the URL", () => {
    const url = "https://aria.example.app/week";
    const steps = renderPlan({ bubbles: [{ text: `here: ${url}` }], link: { url } }, IMESSAGE, noCredit);
    expect(steps.filter((s) => s.t === "send")).toHaveLength(1);
  });

  it("no typing steps when the channel can't show typing", () => {
    const steps = renderPlan({ bubbles: [{ text: "hi" }] }, SMS, noCredit);
    expect(kinds(steps)).toEqual(["pause", "send"]);
  });
});

describe("first-bubble credit", () => {
  const plan: ReplyPlan = { bubbles: [{ text: "x".repeat(140) }, { text: "x".repeat(140) }] }; // 4000ms each
  const pauses = (elapsedMs: number) =>
    renderPlan(plan, IMESSAGE, { elapsedMs, snippets: {} }).flatMap((s) => (s.t === "pause" ? [s.ms] : []));

  it("subtracts elapsed time from the first pause only", () => {
    expect(pauses(0)).toEqual([4000, 4000]);
    expect(pauses(1500)).toEqual([2500, 4000]);
  });
  it("never goes below 800ms", () => {
    expect(pauses(9000)).toEqual([800, 4000]);
  });
});

describe("SMS degradation", () => {
  it("drops reactions without fallbackText; fallbackText becomes a bubble", () => {
    const steps = renderPlan(
      {
        reactions: [
          { targetMessageId: "a", type: "love" },
          { targetMessageId: "b", type: "like", fallbackText: "👍" },
        ],
        bubbles: [{ text: "done" }],
      },
      SMS,
      noCredit,
    );
    expect(steps.some((s) => s.t === "react")).toBe(false);
    const sends = steps.filter((s): s is Extract<RenderStep, { t: "send" }> => s.t === "send");
    expect(sends.map((s) => [s.kind, s.text])).toEqual([
      ["fallback", "👍"],
      ["bubble", "done"],
    ]);
  });

  it("drops replyTo without a prefix when the plan answers one target", () => {
    const steps = renderPlan(
      { bubbles: [{ text: "yes", replyToMessageId: "m1" }, { text: "also this" }] },
      SMS,
      { elapsedMs: 0, snippets: { m1: "can you move my gym block" } },
    );
    const sends = steps.filter((s): s is Extract<RenderStep, { t: "send" }> => s.t === "send");
    expect(sends.map((s) => s.text)).toEqual(["yes", "also this"]);
    expect(sends.every((s) => s.replyToMessageId === undefined)).toBe(true);
  });

  it("prefixes a quote when the plan answers more than one target", () => {
    const steps = renderPlan(
      {
        bubbles: [
          { text: "yep, moved", replyToMessageId: "m1" },
          { text: "friday 5pm", replyToMessageId: "m2" },
        ],
      },
      SMS,
      { elapsedMs: 0, snippets: { m1: "can you move my gym block to thursday", m2: "when is the econ pset due" } },
    );
    const sends = steps.filter((s): s is Extract<RenderStep, { t: "send" }> => s.t === "send");
    expect(sends.map((s) => s.text)).toEqual([
      "“can you move my gym bloc…” → yep, moved",
      "“when is the econ pset du…” → friday 5pm",
    ]);
  });

  it("keeps replyTo on iMessage", () => {
    const steps = renderPlan({ bubbles: [{ text: "yes", replyToMessageId: "m1" }] }, IMESSAGE, noCredit);
    const send = steps.find((s): s is Extract<RenderStep, { t: "send" }> => s.t === "send");
    expect(send?.replyToMessageId).toBe("m1");
  });

  it("quotePrefix: short snippet has no ellipsis; missing snippet gives no prefix", () => {
    expect(quotePrefix("ok cool")).toBe("“ok cool” → ");
    expect(quotePrefix(undefined)).toBe("");
  });
});

describe("empty and reaction-only plans", () => {
  it("empty plan sends typing stop only", () => {
    expect(renderPlan({ bubbles: [] }, IMESSAGE, noCredit)).toEqual([{ t: "typing", state: "stop" }]);
  });
  it("reaction-only plan: react then typing stop", () => {
    const steps = renderPlan({ bubbles: [], reactions: [{ targetMessageId: "a", type: "like" }] }, IMESSAGE, noCredit);
    expect(kinds(steps)).toEqual(["react", "typing"]);
    expect(steps[1]).toEqual({ t: "typing", state: "stop" });
  });
  it("empty plan on SMS renders nothing", () => {
    expect(renderPlan({ bubbles: [] }, SMS, noCredit)).toEqual([]);
  });
});

describe("media", () => {
  it("media sends are outside the bubble cap and skip typing/pause", () => {
    const steps = renderPlan(
      {
        bubbles: [{ text: "a" }, { text: "b" }, { text: "c" }],
        media: [
          { url: "https://aria.example.app/aria.vcf", kind: "vcard" },
          { url: "https://aria.example.app/f/x.png", kind: "image" },
        ],
      },
      IMESSAGE,
      noCredit,
    );
    const sends = steps.filter((s): s is Extract<RenderStep, { t: "send" }> => s.t === "send");
    expect(sends).toHaveLength(5);
    expect(kinds(steps).slice(-2)).toEqual(["send", "send"]);
  });
  it("media dropped when the channel has no media capability", () => {
    const steps = renderPlan(
      { bubbles: [], media: [{ url: "https://aria.example.app/aria.vcf", kind: "vcard" }] },
      { ...IMESSAGE, media: false },
      noCredit,
    );
    expect(steps).toEqual([{ t: "typing", state: "stop" }]);
  });
});
