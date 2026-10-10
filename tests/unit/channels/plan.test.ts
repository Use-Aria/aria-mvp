/**
 * channels/plan.ts — textPlan, validatePlan caps/allow-lists, reaction validation, outbox merge.
 */
import {
  isAllowedLink,
  isValidReactionType,
  mergeOutboxItems,
  OutboxItemSchema,
  textPlan,
  validatePlan,
  type OutboxItem,
} from "@/server/channels/plan";
import type { ReplyPlan } from "@/server/channels/types";

const APP = "https://aria.example.app";
const opts = { appOrigin: APP };

function item(over: Partial<OutboxItem> & { plan: ReplyPlan }): OutboxItem {
  return {
    reason: "briefing",
    priority: "routine",
    dedupeKey: "k",
    channelId: null,
    enqueuedAt: "2026-10-10T12:00:00.000Z",
    notBefore: null,
    expiresAt: null,
    ...over,
  };
}

describe("textPlan", () => {
  it("one bubble per non-empty text, trimmed", () => {
    expect(textPlan(["  hi ", "", "  ", "second"])).toEqual({ bubbles: [{ text: "hi" }, { text: "second" }] });
  });
  it("adds a link when given and skips null/blank links", () => {
    expect(textPlan(["see it"], `${APP}/week`)).toEqual({ bubbles: [{ text: "see it" }], link: { url: `${APP}/week` } });
    expect(textPlan(["x"], null)).toEqual({ bubbles: [{ text: "x" }] });
    expect(textPlan(["x"], "  ")).toEqual({ bubbles: [{ text: "x" }] });
  });
  it("empty input is an empty (silent) plan", () => {
    expect(textPlan([])).toEqual({ bubbles: [] });
  });
  it("output passes validatePlan unchanged", () => {
    const p = textPlan(["a", "b"], `${APP}/setup`);
    expect(validatePlan(p, opts)).toEqual({ plan: p, warnings: [] });
  });
});

describe("validatePlan: bubble cap", () => {
  it("merges the 4th bubble into the 3rd", () => {
    const { plan, warnings } = validatePlan(textPlan(["a", "b", "c", "d"]), opts);
    expect(plan.bubbles.map((b) => b.text)).toEqual(["a", "b", "c\n\nd"]);
    expect(warnings).toContain("bubbles_merged");
  });
  it("an interim already sent reduces the cap to 2", () => {
    const { plan } = validatePlan(textPlan(["a", "b", "c"]), { ...opts, interimSent: true });
    expect(plan.bubbles.map((b) => b.text)).toEqual(["a", "b\n\nc"]);
  });
  it("the link counts toward the cap", () => {
    const { plan } = validatePlan(textPlan(["a", "b", "c"], `${APP}/week`), opts);
    expect(plan.bubbles.map((b) => b.text)).toEqual(["a", "b\n\nc"]);
    expect(plan.link).toEqual({ url: `${APP}/week` });
  });
  it("interim + link leaves one bubble", () => {
    const { plan } = validatePlan(textPlan(["a", "b"], `${APP}/week`), { ...opts, interimSent: true });
    expect(plan.bubbles.map((b) => b.text)).toEqual(["a\n\nb"]);
  });
});

describe("validatePlan: text", () => {
  it("trims and drops empty bubbles", () => {
    const { plan, warnings } = validatePlan({ bubbles: [{ text: "  hi  " }, { text: "   " }] }, opts);
    expect(plan.bubbles).toEqual([{ text: "hi" }]);
    expect(warnings).toContain("bubble_empty");
  });
  it("truncates to 1200 chars with an ellipsis", () => {
    const { plan, warnings } = validatePlan({ bubbles: [{ text: "x".repeat(1500) }] }, opts);
    expect(plan.bubbles[0].text).toHaveLength(1200);
    expect(plan.bubbles[0].text.endsWith("…")).toBe(true);
    expect(warnings).toContain("bubble_truncated");
  });
  it("keeps exactly 1200 chars untouched", () => {
    const text = "y".repeat(1200);
    expect(validatePlan({ bubbles: [{ text }] }, opts).plan.bubbles[0].text).toBe(text);
  });
  it("never splits a surrogate pair when truncating", () => {
    const text = `${"x".repeat(1198)}😀😀`;
    const out = validatePlan({ bubbles: [{ text }] }, opts).plan.bubbles[0].text;
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(/[\uD800-\uDBFF]…$/.test(out)).toBe(false);
  });
  it("removes disallowed URLs inside bubble text but keeps allowed ones", () => {
    const { plan, warnings } = validatePlan(
      { bubbles: [{ text: `go to https://evil.example.com/x. or ${APP}/week!` }] },
      opts,
    );
    expect(plan.bubbles[0].text).toBe(`go to [link removed]. or ${APP}/week!`);
    expect(warnings).toContain("bubble_url_removed");
  });
  it("keeps replyToMessageId", () => {
    const { plan } = validatePlan({ bubbles: [{ text: "yes", replyToMessageId: "m1" }] }, opts);
    expect(plan.bubbles).toEqual([{ text: "yes", replyToMessageId: "m1" }]);
  });
});

describe("validatePlan: empty and reaction-only plans", () => {
  it("empty plan is allowed (silence)", () => {
    expect(validatePlan({ bubbles: [] }, opts)).toEqual({ plan: { bubbles: [] }, warnings: [] });
  });
  it("reaction-only plan is kept", () => {
    const p: ReplyPlan = { bubbles: [], reactions: [{ targetMessageId: "m1", type: "like" }] };
    expect(validatePlan(p, opts).plan).toEqual(p);
  });
  it("caps reactions at 2 and drops blank fallbackText", () => {
    const { plan, warnings } = validatePlan(
      {
        bubbles: [],
        reactions: [
          { targetMessageId: "a", type: "love", fallbackText: "  " },
          { targetMessageId: "b", type: "like", fallbackText: "👍" },
          { targetMessageId: "c", type: "laugh" },
        ],
      },
      opts,
    );
    expect(plan.reactions).toEqual([
      { targetMessageId: "a", type: "love" },
      { targetMessageId: "b", type: "like", fallbackText: "👍" },
    ]);
    expect(warnings).toContain("reactions_capped");
  });
  it("drops invalid reaction types", () => {
    const { plan, warnings } = validatePlan(
      { bubbles: [], reactions: [{ targetMessageId: "a", type: "heart" }] },
      opts,
    );
    expect(plan.reactions).toBeUndefined();
    expect(warnings).toEqual(["reaction_invalid"]);
  });
});

describe("isValidReactionType", () => {
  it.each(["love", "like", "dislike", "laugh", "emphasize", "question"])("classic %s", (t) => {
    expect(isValidReactionType(t)).toBe(true);
  });
  it.each(["😂", "👍🏽", "❤️", "🇺🇸", "👩‍💻", "1️⃣", "🔥"])("one emoji grapheme %s", (t) => {
    expect(isValidReactionType(t)).toBe(true);
  });
  it.each(["❤", "😂😂", "", "ok", "heart", "a", "#", "1", "👍 "])("rejects %p", (t) => {
    expect(isValidReactionType(t)).toBe(false);
  });
});

describe("isAllowedLink", () => {
  it.each([`${APP}/week`, `${APP}/m?t=abc`, "https://mail.google.com/mail/u/0/#inbox/FMfcgz", `${APP}`])(
    "allows %s",
    (u) => expect(isAllowedLink(u, APP)).toBe(true),
  );
  it.each([
    "javascript:alert(1)",
    "https://evil.example.com/",
    "https://aria.example.app.evil.com/week",
    "http://aria.example.app/week", // scheme differs from the https origin
    "https://user:pw@aria.example.app/",
    "https://mail.google.com.evil.com/",
    "http://mail.google.com/",
    "https://accounts.google.com/",
    "not a url",
    "data:text/html,hi",
  ])("rejects %s", (u) => expect(isAllowedLink(u, APP)).toBe(false));

  it("allows the localhost origin in dev", () => {
    expect(isAllowedLink("http://localhost:3000/week", "http://localhost:3000")).toBe(true);
    expect(isAllowedLink("http://localhost:3001/week", "http://localhost:3000")).toBe(false);
  });

  it("validatePlan drops a disallowed link and a link already in a bubble", () => {
    expect(validatePlan(textPlan(["a"], "https://evil.example.com"), opts)).toEqual({
      plan: { bubbles: [{ text: "a" }] },
      warnings: ["link_disallowed"],
    });
    const inBubble = validatePlan(textPlan([`here ${APP}/week`], `${APP}/week`), opts);
    expect(inBubble.plan.link).toBeUndefined();
    expect(inBubble.warnings).toContain("link_in_bubble");
  });

  it("validatePlan keeps media only from the app origin", () => {
    const { plan, warnings } = validatePlan(
      {
        bubbles: [],
        media: [
          { url: `${APP}/aria.vcf`, kind: "vcard" },
          { url: "https://cdn.evil.com/x.png", kind: "image" },
        ],
      },
      opts,
    );
    expect(plan.media).toEqual([{ url: `${APP}/aria.vcf`, kind: "vcard" }]);
    expect(warnings).toEqual(["media_disallowed"]);
  });
});

describe("mergeOutboxItems", () => {
  it("orders by enqueuedAt (stable) and concatenates bubbles", () => {
    const merged = mergeOutboxItems([
      item({ dedupeKey: "b", enqueuedAt: "2026-10-10T12:05:00.000Z", plan: textPlan(["second"]) }),
      item({ dedupeKey: "a", enqueuedAt: "2026-10-10T12:00:00.000Z", plan: textPlan(["first"]) }),
      item({ dedupeKey: "c", enqueuedAt: "2026-10-10T12:05:00.000Z", plan: textPlan(["third"]) }),
    ]);
    expect(merged.bubbles.map((b) => b.text)).toEqual(["first", "second", "third"]);
  });
  it("first link wins and counts toward the cap", () => {
    const merged = mergeOutboxItems([
      item({ dedupeKey: "a", enqueuedAt: "2026-10-10T12:00:00.000Z", plan: textPlan(["one"], `${APP}/week`) }),
      item({ dedupeKey: "b", enqueuedAt: "2026-10-10T12:01:00.000Z", plan: textPlan(["two", "three"], `${APP}/setup`) }),
    ]);
    expect(merged.link).toEqual({ url: `${APP}/week` });
    expect(merged.bubbles.map((b) => b.text)).toEqual(["one", "two\n\nthree"]);
  });
  it("drops a duplicate dedupeKey (first wins)", () => {
    const merged = mergeOutboxItems([
      item({ dedupeKey: "briefing:2026-10-10", enqueuedAt: "2026-10-10T12:00:00.000Z", plan: textPlan(["morning"]) }),
      item({ dedupeKey: "briefing:2026-10-10", enqueuedAt: "2026-10-10T12:01:00.000Z", plan: textPlan(["morning again"]) }),
    ]);
    expect(merged.bubbles).toEqual([{ text: "morning" }]);
  });
  it("dedupes media by URL and handles an empty outbox", () => {
    const vcard = { url: `${APP}/aria.vcf`, kind: "vcard" as const };
    const merged = mergeOutboxItems([
      item({ dedupeKey: "a", plan: { bubbles: [], media: [vcard] } }),
      item({ dedupeKey: "b", plan: { bubbles: [], media: [vcard] } }),
    ]);
    expect(merged.media).toEqual([vcard]);
    expect(mergeOutboxItems([])).toEqual({ bubbles: [] });
  });
  it("re-exports OutboxItemSchema (round-trips an item)", () => {
    const it1 = item({ dedupeKey: "x", plan: textPlan(["hi"]) });
    expect(OutboxItemSchema.parse(it1)).toEqual(it1);
  });
});
