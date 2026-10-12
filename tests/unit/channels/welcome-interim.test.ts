/**
 * pipeline/welcome.ts + channels/interim.ts — greeting detection, welcome templates (AI
 * disclosure), contact card plan, register detection, seeded interim picks.
 */
import { validatePlan } from "@/server/channels/plan";
import { detectRegister, INTERIM_POOLS, pickInterim } from "@/server/channels/interim";
import { contactCardPlan, greetingName, isGreetingOnly, welcomePlan } from "@/server/pipeline/welcome";

describe("isGreetingOnly", () => {
  it.each(["hey", "Hey!", "hi", "hii", "hiii aria", "hello", "Hello 👋", "yo", "sup", "heyy", "hey aria!", "hey there", "good morning", "gm", "hi :)", "what's up"])(
    "%p → true",
    (t) => expect(isGreetingOnly(t)).toBe(true),
  );
  it.each([
    "hey what's due tmrw",
    "hi what's due",
    "hey?",
    "hi can you help",
    "hey aria can you remind me at 5",
    "hello is this aria?",
    "help",
    "ok",
    "",
    "this is a long message that starts with nothing",
    "history homework",
    "hide my calendar",
  ])("%p → false", (t) => expect(isGreetingOnly(t)).toBe(false));
});

describe("welcomePlan", () => {
  it("unknown name: intro with AI disclosure + name question", () => {
    const p = welcomePlan({ name: null });
    expect(p.bubbles).toHaveLength(2);
    expect(p.bubbles[0].text).toMatch(/I'm Aria/);
    expect(p.bubbles[0].text).toMatch(/AI assistant/);
    expect(p.bubbles[1].text).toBe("what should I call you?");
  });
  it("known name (signup match): intro + asks them to confirm the first name, never assumes it", () => {
    const p = welcomePlan({ name: "Dan Lee" });
    expect(p.bubbles).toHaveLength(2);
    expect(p.bubbles[0].text).toMatch(/^hey! I'm Aria/);
    expect(p.bubbles[0].text).toMatch(/AI assistant/);
    expect(p.bubbles[0].text).not.toMatch(/Dan/);
    expect(p.bubbles[1].text).toBe("you're Dan, right?");
  });
  it("known name, neutral register: capitalized confirmation, no emoji", () => {
    const p = welcomePlan({ name: "Sam", register: "neutral" });
    expect(p.bubbles.map((b) => b.text)).toEqual([
      "Hi! I'm Aria, an AI assistant for your classes — deadlines, your calendar, and reminders, all over text.",
      "Just to check: you're Sam, right?",
    ]);
    expect(p.bubbles.some((b) => /👋/.test(b.text))).toBe(false);
  });
  it("neutral register is capitalized and emoji-free", () => {
    const p = welcomePlan({ name: null, register: "neutral" });
    expect(p.bubbles[0].text).toMatch(/^Hi! I'm Aria, an AI assistant/);
    expect(p.bubbles[1].text).toBe("What should I call you?");
    expect(p.bubbles.some((b) => /👋/.test(b.text))).toBe(false);
  });
  it("unusable stored names fall back to the name question", () => {
    expect(greetingName("   ")).toBeNull();
    expect(greetingName("123")).toBeNull();
    expect(greetingName("Zoë Ann")).toBe("Zoë");
    expect(welcomePlan({ name: "  " }).bubbles).toHaveLength(2);
    expect(welcomePlan({ name: "  " }).bubbles[1].text).toBe("what should I call you?");
  });
  it("greetingName echoes only a plain word (signup names are typed by anyone)", () => {
    expect(greetingName("Sam!")).toBe("Sam");
    expect(greetingName("O'Brien")).toBe("O'Brien");
    expect(greetingName("Mary-Kate Olsen")).toBe("Mary-Kate");
    expect(greetingName("José")).toBe("José");
    expect(greetingName("Jose\u0301")).toBe("José");
    for (const bad of ["evil.com", "https://evil.example", "<b>Sam</b>", "sam@x.edu", "J.R.", "S4m", "a".repeat(41)]) {
      expect(greetingName(bad)).toBeNull();
    }
    expect(welcomePlan({ name: "evil.com" }).bubbles[1].text).toBe("what should I call you?");
  });
  it("passes validatePlan unchanged", () => {
    for (const p of [welcomePlan({ name: null }), welcomePlan({ name: "Sam" }), welcomePlan({ name: "Sam", register: "neutral" })]) {
      expect(validatePlan(p, { appOrigin: "https://aria.test" })).toEqual({ plan: p, warnings: [] });
    }
  });
});

describe("contactCardPlan", () => {
  it("media-only plan to /aria.vcf that survives validation", () => {
    const p = contactCardPlan("https://aria.test/");
    expect(p).toEqual({ bubbles: [], media: [{ url: "https://aria.test/aria.vcf", kind: "vcard" }] });
    expect(validatePlan(p, { appOrigin: "https://aria.test" }).plan).toEqual(p);
  });
});

describe("interim", () => {
  it("detectRegister: casual for lowercase/slang/emoji, neutral for formal, casual with no signal", () => {
    expect(detectRegister(["ok ts is due tmrw fr 😭", "lmk"])).toBe("casual");
    expect(detectRegister(["Could you tell me when the essay is due?", "Thank you."])).toBe("neutral");
    expect(detectRegister([])).toBe("casual");
  });
  it("pickInterim is deterministic with a seeded rng and stays in the pool", () => {
    expect(pickInterim("casual", () => 0)).toBe(INTERIM_POOLS.casual[0]);
    expect(pickInterim("neutral", () => 0.999)).toBe(INTERIM_POOLS.neutral[INTERIM_POOLS.neutral.length - 1]);
    let seed = 42;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const a = Array.from({ length: 5 }, () => pickInterim("casual", rng));
    seed = 42;
    const b = Array.from({ length: 5 }, () => pickInterim("casual", rng));
    expect(a).toEqual(b);
    for (const line of a) expect(INTERIM_POOLS.casual).toContain(line);
  });
  it("pickInterim tolerates an out-of-range rng", () => {
    expect(INTERIM_POOLS.casual).toContain(pickInterim("casual", () => 1));
    expect(INTERIM_POOLS.casual).toContain(pickInterim("casual", () => Number.NaN));
  });
});
