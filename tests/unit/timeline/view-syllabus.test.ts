import { toView } from "@/server/timeline/view";
import { collapseSyllabusDuplicates } from "@/server/integrations/syllabus/dedupe";
import type { JsonValue } from "@/server/timeline/types";
import { NOW, row } from "./helpers";

const NY = "America/New_York";
type Raw = { [k: string]: JsonValue } | null;
const syl = (raw: Raw) => toView(row({ externalId: "syl:CPSC323:abc", source: "syllabus", raw }), NOW, NY);

describe("toView syllabus info", () => {
  it("fills weight_pct and topics from a timeline-map raw", () => {
    const v = syl({ syllabus_id: "s1", weight_pct: 20, topics: ["Paging", "TLBs"], date_text: "Oct 16", all_day: false });
    expect(v.syllabus).toEqual({ weight_pct: 20, topics: ["Paging", "TLBs"] });
  });

  it("keeps a null weight and an empty topic list (assignment shape)", () => {
    expect(syl({ syllabus_id: "s1", weight_pct: null, topics: [] }).syllabus).toEqual({ weight_pct: null, topics: [] });
  });

  it("parses defensively: bad weight → null, non-string topics dropped, non-array topics → []", () => {
    expect(syl({ weight_pct: "20", topics: ["a", 1, null, "b", { x: 1 }] }).syllabus).toEqual({ weight_pct: null, topics: ["a", "b"] });
    expect(syl({ weight_pct: 15, topics: "Paging" }).syllabus).toEqual({ weight_pct: 15, topics: [] });
    expect(syl({ weight_pct: [5] }).syllabus).toEqual({ weight_pct: null, topics: [] });
  });

  it("omits the field when raw is missing or carries neither field", () => {
    expect("syllabus" in syl(null)).toBe(false);
    expect("syllabus" in syl({ syllabus_id: "s1", date_text: "Oct 16" })).toBe(false);
  });

  it("leaves non-syllabus items unchanged even with a weight-shaped raw", () => {
    const v = toView(row({ externalId: "c1", source: "canvas", raw: { weight_pct: 20, topics: ["x"] } }), NOW, NY);
    expect("syllabus" in v).toBe(false);
  });

  it("lets collapseSyllabusDuplicates carry the weight onto the Canvas twin", () => {
    const due = new Date("2026-10-17T03:59:00Z");
    const canvas = toView(row({ externalId: "c1", source: "canvas", title: "Pset 4", dueAt: due }), NOW, NY);
    const s = toView(
      row({ externalId: "syl:CPSC323:x", source: "syllabus", title: "Problem Set 4", dueAt: due, raw: { weight_pct: 5, topics: [] } }),
      NOW,
      NY,
    );
    const out = collapseSyllabusDuplicates([canvas, s], NY);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("canvas");
    expect(out[0].syllabus).toEqual({ weight_pct: 5, topics: [] });
  });
});
