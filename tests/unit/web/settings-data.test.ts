/**
 * /settings view model (task 4.6): memory rows are split, cleaned, and dated in the viewer's zone;
 * the `?export=` code is allow-listed.
 */
import { parseExportRefusal, toSettingsMemory } from "@/server/web/settings-data";
import type { MemoryView } from "@/server/memory";

describe("toSettingsMemory", () => {
  const view: MemoryView = {
    profile: { name: "Dan‮", school: "Yale University", courses: ["CPSC 323", "​", "ECON 115"] },
    preferences: [
      { id: "p1", key: "gym", statement: "No gym after 8pm", status: "active", validFrom: new Date() },
      { id: "p2", key: "signoff", statement: "Sign emails ⁦Best, Dan", status: "proposed", validFrom: new Date() },
    ],
    facts: [{ id: "f1", content: "Has a Stripe interview Oct 23", createdAt: new Date("2026-10-10T02:30:00Z"), expiresAt: null }],
  };

  it("splits active preferences from suggestions and strips bidi / zero-width controls", () => {
    const m = toSettingsMemory(view, "America/New_York");
    expect(m.profile).toEqual({ name: "Dan", school: "Yale University", courses: ["CPSC 323", "ECON 115"] });
    expect(m.preferences).toEqual([{ id: "p1", text: "No gym after 8pm" }]);
    expect(m.proposed).toEqual([{ id: "p2", text: "Sign emails Best, Dan" }]);
    expect(m.empty).toBe(false);
  });

  it("dates facts in the viewer's zone (02:30Z is still Oct 9 in New York)", () => {
    expect(toSettingsMemory(view, "America/New_York").facts[0].savedLabel).toBe("Oct 9");
    expect(toSettingsMemory(view, "Asia/Tokyo").facts[0].savedLabel).toBe("Oct 10");
  });

  it("is empty when nothing is known", () => {
    const m = toSettingsMemory({ profile: { name: null, school: null, courses: [] }, preferences: [], facts: [] }, "UTC");
    expect(m.empty).toBe(true);
  });
});

describe("parseExportRefusal", () => {
  it("accepts only the fixed codes", () => {
    expect(parseExportRefusal("needs_fresh_link")).toBe("needs_fresh_link");
    expect(parseExportRefusal(["rate_limited", "x"])).toBe("rate_limited");
    expect(parseExportRefusal("<script>")).toBeNull();
    expect(parseExportRefusal(undefined)).toBeNull();
  });
});
