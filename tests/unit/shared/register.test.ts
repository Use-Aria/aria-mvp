import { computeRegisterHint, registerClass } from "@/shared/register";

describe("computeRegisterHint", () => {
  it("captures lowercase, slang, emoji and length", () => {
    const h = computeRegisterHint(["bet", "ok ts is due tmrw fr 😭", "lmk when u get a sec", "ty 🙏🙏"]);
    expect(h.lowercaseShare).toBe(1);
    expect(h.slang).toEqual(expect.arrayContaining(["bet", "ts", "tmrw", "fr", "lmk"]));
    expect(h.slang.length).toBeLessThanOrEqual(5);
    expect(h.emojiRate).toBe(0.75);
    expect(h.avgWords).toBe(4);
    expect(h.formal).toBe(false);
    expect(registerClass(h)).toBe("casual");
  });

  it("orders slang by frequency, then first appearance", () => {
    const h = computeRegisterHint(["idk lol", "lol fr", "lol"]);
    expect(h.slang).toEqual(["lol", "idk", "fr"]);
  });

  it("formal input → no slang, formal, neutral", () => {
    const h = computeRegisterHint([
      "Could you tell me when my Organic Chemistry midterm is?",
      "Thank you. Please remind me the day before.",
    ]);
    expect(h.slang).toEqual([]);
    expect(h.emojiRate).toBe(0);
    expect(h.lowercaseShare).toBe(0);
    expect(h.formal).toBe(true);
    expect(registerClass(h)).toBe("neutral");
  });

  it("auto-capitalized plain texts read as neutral, not formal", () => {
    const h = computeRegisterHint(["What's due this week", "Ok sounds good"]);
    expect(h.formal).toBe(false);
    expect(registerClass(h)).toBe("neutral");
  });

  it("counts compound emoji once and ignores URLs", () => {
    const h = computeRegisterHint(["👍🏽", "👨\u200D👩\u200D👧 HTTPS://EXAMPLE.COM/ABC"]);
    expect(h.emojiRate).toBe(1);
    expect(h.lowercaseShare).toBe(0);
  });

  it("empty input → zero hint, casual default", () => {
    const h = computeRegisterHint([]);
    expect(h).toEqual({ avgWords: 0, lowercaseShare: 0, emojiRate: 0, slang: [], formal: false });
    expect(registerClass(h)).toBe("casual");
    expect(registerClass(computeRegisterHint(["   ", ""]))).toBe("casual");
  });

  it("only the last 30 texts count", () => {
    const old = Array.from({ length: 40 }, () => "lol bet");
    const recent = Array.from({ length: 30 }, () => "Sounds good, thank you.");
    const h = computeRegisterHint([...old, ...recent]);
    expect(h.slang).toEqual([]);
    expect(registerClass(h)).toBe("neutral");
  });

  it("is deterministic", () => {
    const texts = ["yo whats up", "Nah I'm good 😂", "omw"];
    expect(computeRegisterHint(texts)).toEqual(computeRegisterHint([...texts]));
  });
});
