/**
 * Scheduling constraints (task 4.2; V2-07 §2.7, §10 `constraints.test.ts`; master plan §1.17):
 * the frozen zod schemas accept/reject, and `constraintsFromPreferences` filters by `applies_to`,
 * ignores malformed JSON and applies the waking override.
 */
import {
  appliesToActivity,
  constraintsFromPreferences,
  dedupeConstraints,
  describeConstraint,
} from "@/server/integrations/google/calendar/slots";
import { ConstraintPrefSchema, ConstraintSchema, type Constraint } from "@/shared/scheduling-constraints";

const pref = (applies_to: string[], constraint: Constraint | null, waking: { start: string; end: string } | null = null) => ({
  constraintJson: { applies_to, constraint, waking, signoff: null },
});

describe("ConstraintSchema", () => {
  it.each([
    { type: "not_after", time: "20:00" },
    { type: "not_before", time: "07:30", days: ["MO", "FR"] },
    { type: "avoid_range", start: "12:00", end: "13:00" },
    { type: "avoid_days", days: ["SA", "SU"] },
    { type: "only_days", days: ["TU"] },
    { type: "buffer_minutes", minutes: 0 },
    { type: "buffer_minutes", minutes: 60 },
  ])("accepts %j", (c) => {
    expect(ConstraintSchema.safeParse(c).success).toBe(true);
  });

  it.each([
    { type: "not_after", time: "24:00" },
    { type: "not_after", time: "8pm" },
    { type: "not_before", time: "7:30" },
    { type: "avoid_days", days: [] },
    { type: "only_days", days: ["Monday"] },
    { type: "buffer_minutes", minutes: 61 },
    { type: "buffer_minutes", minutes: 5.5 },
    { type: "waking_hours", start: "09:00", end: "01:00" },
    { time: "20:00" },
  ])("rejects %j", (c) => {
    expect(ConstraintSchema.safeParse(c).success).toBe(false);
  });
});

describe("ConstraintPrefSchema", () => {
  it("accepts the stored shape and rejects an empty applies_to", () => {
    expect(ConstraintPrefSchema.safeParse({ applies_to: ["gym"], constraint: { type: "not_after", time: "20:00" }, waking: null, signoff: null }).success).toBe(true);
    expect(ConstraintPrefSchema.safeParse({ applies_to: ["*"], constraint: null, waking: { start: "09:00", end: "01:00" }, signoff: null }).success).toBe(true);
    expect(ConstraintPrefSchema.safeParse({ applies_to: [], constraint: null, waking: null, signoff: null }).success).toBe(false);
    expect(ConstraintPrefSchema.safeParse({ applies_to: ["gym"], constraint: { type: "not_after", time: "20:00" } }).success).toBe(false);
  });
});

describe("appliesToActivity", () => {
  it.each([
    ["*", "anything", true],
    ["gym", "gym", true],
    ["Gym", "  GYM ", true],
    ["study", "study CPSC 323", true],
    ["cpsc 323", "study CPSC 323", true],
    ["gym", "gymnastics practice", false],
    ["study", "studio art", false],
    ["email", "gym", false],
    ["", "gym", false],
  ] as const)("%s covers %s → %s", (a, act, want) => {
    expect(appliesToActivity(a, act)).toBe(want);
  });
});

describe("constraintsFromPreferences", () => {
  it("keeps only preferences whose applies_to covers the activity (incl. '*')", () => {
    const prefs = [
      pref(["gym"], { type: "not_after", time: "20:00" }),
      pref(["study"], { type: "not_before", time: "10:00" }),
      pref(["*"], { type: "avoid_days", days: ["SU"] }),
      pref(["email"], null),
    ];
    expect(constraintsFromPreferences(prefs, "gym")).toEqual({
      constraints: [
        { type: "not_after", time: "20:00" },
        { type: "avoid_days", days: ["SU"] },
      ],
    });
    expect(constraintsFromPreferences(prefs, "study CPSC 323").constraints).toEqual([
      { type: "not_before", time: "10:00" },
      { type: "avoid_days", days: ["SU"] },
    ]);
  });

  it("ignores malformed constraint_json", () => {
    const prefs = [
      { constraintJson: null },
      { constraintJson: undefined },
      { constraintJson: "not_after 20:00" },
      { constraintJson: { applies_to: ["gym"], constraint: { type: "not_after", time: "8pm" }, waking: null, signoff: null } },
      { constraintJson: { applies_to: "gym", constraint: null, waking: null, signoff: null } },
      { constraintJson: [1, 2, 3] },
      pref(["gym"], { type: "buffer_minutes", minutes: 15 }),
    ];
    expect(constraintsFromPreferences(prefs, "gym")).toEqual({ constraints: [{ type: "buffer_minutes", minutes: 15 }] });
  });

  it("applies the waking override (last matching one wins; other activities' waking ignored)", () => {
    const prefs = [
      pref(["*"], null, { start: "08:30", end: "23:30" }),
      pref(["gym"], null, { start: "09:00", end: "01:00" }),
      pref(["study"], null, { start: "06:00", end: "22:00" }),
    ];
    expect(constraintsFromPreferences(prefs, "gym")).toEqual({ constraints: [], waking: { start: "09:00", end: "01:00" } });
    expect(constraintsFromPreferences(prefs, "laundry")).toEqual({ constraints: [], waking: { start: "08:30", end: "23:30" } });
    expect(constraintsFromPreferences([], "gym")).toEqual({ constraints: [] });
  });

  it("dedupes a constraint the model also copied into the tool input", () => {
    const fromPrefs = constraintsFromPreferences([pref(["gym"], { type: "not_after", time: "20:00" })], "gym").constraints;
    const merged = dedupeConstraints([{ time: "20:00", type: "not_after" } as Constraint, ...fromPrefs]);
    expect(merged).toEqual([{ time: "20:00", type: "not_after" }]);
  });
});

describe("describeConstraint", () => {
  it("is short and human", () => {
    expect(describeConstraint({ type: "not_after", time: "20:00" })).toBe("not after 8pm");
    expect(describeConstraint({ type: "not_before", time: "09:30", days: ["MO", "WE"] })).toBe("not before 9:30am on Mon/Wed");
    expect(describeConstraint({ type: "avoid_range", start: "12:00", end: "13:00" })).toBe("not 12pm–1pm");
    expect(describeConstraint({ type: "avoid_days", days: ["SA", "SU"] })).toBe("not on Sat/Sun");
    expect(describeConstraint({ type: "only_days", days: ["TU"] })).toBe("only on Tue");
  });
});
