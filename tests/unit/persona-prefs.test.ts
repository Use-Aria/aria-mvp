/** Persona tone parsing and template register (web plan §10 persona-prefs.test; master plan §1.17). */
import {
  PersonaPrefsSchema,
  TONE_OPTIONS,
  parsePersonaPrefs,
  templateRegister,
  withTone,
} from "@/shared/persona-prefs";

describe("parsePersonaPrefs", () => {
  it("defaults to mirror on empty, garbage, or unknown tone", () => {
    for (const v of [{}, null, undefined, "casual", 42, [], { tone: "loud" }, { tone: 1 }]) {
      expect(parsePersonaPrefs(v)).toEqual({ tone: "mirror" });
    }
  });

  it("reads valid tones and round-trips through withTone", () => {
    expect(parsePersonaPrefs({ tone: "polished" })).toEqual({ tone: "polished" });
    const stored = withTone({ tone: "casual", other: 1 }, "polished");
    expect(stored).toEqual({ tone: "polished", other: 1 });
    expect(parsePersonaPrefs(stored).tone).toBe("polished");
    expect(withTone("garbage", "casual")).toEqual({ tone: "casual" });
  });

  it("schema defaults tone", () => {
    expect(PersonaPrefsSchema.parse({})).toEqual({ tone: "mirror" });
  });

  it("offers three options with samples", () => {
    expect(TONE_OPTIONS.map((o) => o.value)).toEqual(["mirror", "casual", "polished"]);
    for (const o of TONE_OPTIONS) expect(o.sample.length).toBeGreaterThan(10);
  });
});

describe("templateRegister", () => {
  const casualTexts = ["ok bet", "lol what's due tmr", "ty"];
  const formalTexts = ["Hello Aria, what is due this week?", "Thank you. Please remind me tomorrow."];

  it("polished → neutral and casual → casual regardless of texts", () => {
    expect(templateRegister({ tone: "polished" }, casualTexts)).toBe("neutral");
    expect(templateRegister({ tone: "casual" }, formalTexts)).toBe("casual");
  });

  it("mirror follows the user's register", () => {
    expect(templateRegister({ tone: "mirror" }, casualTexts)).toBe("casual");
    expect(templateRegister({ tone: "mirror" }, formalTexts)).toBe("neutral");
    expect(templateRegister({ tone: "mirror" }, [])).toBe("casual");
  });
});
