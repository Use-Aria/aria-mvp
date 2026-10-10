/**
 * src/server/proactive/schedule.ts — V2-06 §10 schedule cases: next briefing (DST, quiet clamp,
 * invalid tz), prep jitter, quiet-aware nudge placement, due-change routing, deferral matrix,
 * late-fire policy.
 */
import {
  anchoredFireAt,
  briefingDeferral,
  classifyDueChange,
  fromGuardWindow,
  lateFirePolicy,
  nextBriefingAt,
  placeNudge,
  prepRunAt,
  toGuardWindow,
  type QuietWindow,
} from "@/server/proactive/schedule";

const NY = "America/New_York";
const QUIET: QuietWindow = { start: { hour: 22, minute: 0 }, end: { hour: 8, minute: 0 } };
const NONE: QuietWindow = { start: { hour: 0, minute: 0 }, end: { hour: 0, minute: 0 } };
const EIGHT = { hour: 8, minute: 0 };
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const at = (iso: string) => new Date(iso);

describe("nextBriefingAt", () => {
  const next = (now: string, briefingTime = EIGHT, quiet = QUIET, tz = NY) => {
    const r = nextBriefingAt({ tz, briefingTime, quiet, now: at(now) });
    return { at: r.at.toISOString(), localDate: r.localDate };
  };

  it("07:55 → today 08:00; 08:01 → tomorrow", () => {
    expect(next("2026-10-12T11:55:00Z")).toEqual({ at: "2026-10-12T12:00:00.000Z", localDate: { year: 2026, month: 10, day: 12 } });
    expect(next("2026-10-12T12:01:00Z").at).toBe("2026-10-13T12:00:00.000Z");
  });

  it("needs more than 2 minutes of lead", () => {
    expect(next("2026-10-12T11:59:00Z").at).toBe("2026-10-13T12:00:00.000Z");
  });

  it("solves the local date across fall-back (25h apart) and spring-forward", () => {
    expect(next("2026-10-31T12:30:00Z").at).toBe("2026-11-01T13:00:00.000Z"); // 08:00 EST
    expect(next("2026-03-07T13:30:00Z").at).toBe("2026-03-08T12:00:00.000Z"); // 08:00 EDT
  });

  it("a briefing time in the spring-forward gap shifts forward (02:30 → 03:30 EDT)", () => {
    expect(next("2026-03-07T08:00:00Z", { hour: 2, minute: 30 }, NONE).at).toBe("2026-03-08T07:30:00.000Z");
  });

  it("clamps a briefing time inside quiet hours to quiet end", () => {
    expect(next("2026-10-12T04:00:00Z", { hour: 7, minute: 0 }).at).toBe("2026-10-12T12:00:00.000Z");
  });

  it("falls back to New York for an invalid zone", () => {
    expect(next("2026-10-12T11:55:00Z", EIGHT, QUIET, "Mars/Base").at).toBe("2026-10-12T12:00:00.000Z");
  });

  it("works in a non-DST half-hour zone", () => {
    expect(next("2026-10-12T00:00:00Z", EIGHT, QUIET, "Asia/Kolkata").at).toBe("2026-10-12T02:30:00.000Z");
  });
});

describe("prepRunAt", () => {
  const target = at("2026-10-12T12:00:00Z");
  const now = at("2026-10-11T12:00:00Z");
  it("runs 10–20 min before, deterministic per user", () => {
    for (const u of ["a", "b", "00000000-0000-4000-8000-000000000001", "zzz"]) {
      const lead = target.getTime() - prepRunAt(target, u, now).getTime();
      expect(lead).toBeGreaterThanOrEqual(10 * MIN);
      expect(lead).toBeLessThanOrEqual(20 * MIN);
      expect(prepRunAt(target, u, now).getTime()).toBe(prepRunAt(target, u, now).getTime());
    }
  });
  it("is never before now", () => {
    const late = at("2026-10-12T11:55:00Z");
    expect(prepRunAt(target, "a", late).getTime()).toBe(late.getTime());
  });
});

describe("anchoredFireAt", () => {
  it("is anchor − offset", () => {
    expect(anchoredFireAt(at("2026-10-12T20:00:00Z"), 120).toISOString()).toBe("2026-10-12T18:00:00.000Z");
  });
});

describe("placeNudge (quiet 22:00–08:00, NY)", () => {
  const NOON = at("2026-10-12T16:00:00Z"); // 12:00 EDT Oct 12
  const place = (due: string, now = NOON, offsetMinutes = 180) =>
    placeNudge({ dueAt: at(due), offsetMinutes, tz: NY, quiet: QUIET, now })?.toISOString() ?? null;

  it("due 01:00 → T-3h 22:00 is quiet → pulled to 21:45 the evening before", () => {
    expect(place("2026-10-13T05:00:00Z")).toBe("2026-10-13T01:45:00.000Z");
  });
  it("due 09:00 → T-3h 06:00 is quiet, pull would be 8h early → pushed to 08:00", () => {
    expect(place("2026-10-13T13:00:00Z")).toBe("2026-10-13T12:00:00.000Z");
  });
  it("due 08:20 → no slot (pull too early, push too late) → null", () => {
    expect(place("2026-10-13T12:20:00Z")).toBeNull();
  });
  it("normal afternoon → unchanged", () => {
    expect(place("2026-10-12T21:00:00Z")).toBe("2026-10-12T18:00:00.000Z");
  });
  it("intended time already passed, or deadline passed → null", () => {
    expect(place("2026-10-12T17:00:00Z")).toBeNull();
    expect(place("2026-10-12T15:00:00Z")).toBeNull();
  });
  it("can't pull into the past: due 01:00 seen at 21:50 → null", () => {
    expect(place("2026-10-13T05:00:00Z", at("2026-10-13T01:50:00Z"))).toBeNull();
  });
  it("no quiet window → exact", () => {
    expect(placeNudge({ dueAt: at("2026-10-13T05:00:00Z"), offsetMinutes: 180, tz: NY, quiet: NONE, now: NOON })?.toISOString()).toBe(
      "2026-10-13T02:00:00.000Z",
    );
  });
  it("guard window conversion round-trips", () => {
    expect(toGuardWindow(QUIET)).toEqual({ startMin: 1320, endMin: 480 });
    expect(fromGuardWindow(toGuardWindow(QUIET))).toEqual(QUIET);
  });
});

describe("classifyDueChange", () => {
  const N = at("2026-10-12T16:00:00Z");
  const plus = (ms: number) => new Date(N.getTime() + ms);
  const c = (old: number | null, next: number | null, status = "upcoming") =>
    classifyDueChange({ oldDueAt: old === null ? null : plus(old), newDueAt: next === null ? null : plus(next), status }, N);

  it("≤7 days → alert; later move non-urgent", () => expect(c(3 * D, 4 * D)).toEqual({ route: "alert", urgent: false }));
  it("moved earlier → urgent", () => expect(c(3 * D, 2.5 * D)).toEqual({ route: "alert", urgent: true }));
  it("new due ≤48h → urgent", () => expect(c(5 * D, 1 * D)).toEqual({ route: "alert", urgent: true }));
  it("new item (no old due) soon → urgent alert", () => expect(c(null, 1 * D)).toEqual({ route: "alert", urgent: true }));
  it(">7 days both ends → briefing", () => expect(c(10 * D, 12 * D)).toEqual({ route: "briefing" }));
  it("moved from >7d into the window → alert", () => expect(c(10 * D, 6 * D)).toEqual({ route: "alert", urgent: true }));
  it("Δ < 5 min → ignore", () => expect(c(3 * D, 3 * D + 4 * MIN)).toEqual({ route: "ignore" }));
  it("new due in the past → ignore", () => expect(c(1 * D, -H)).toEqual({ route: "ignore" }));
  it("done item → ignore", () => expect(c(1 * D, 2 * D, "done")).toEqual({ route: "ignore" }));
  it("no new due → ignore", () => expect(c(1 * D, null)).toEqual({ route: "ignore" }));
});

describe("briefingDeferral (local date Mon 2026-10-12, NY)", () => {
  const day = { year: 2026, month: 10, day: 12 };
  it("before noon → regenerate as usual", () => {
    expect(briefingDeferral(at("2026-10-12T15:59:00Z"), day, NY, "daily")).toEqual({ action: "regenerate", kind: "daily" });
    expect(briefingDeferral(at("2026-10-12T15:59:00Z"), day, NY, "monday")).toEqual({ action: "regenerate", kind: "monday" });
  });
  it("12:00–17:59 → catch-up", () => {
    expect(briefingDeferral(at("2026-10-12T16:00:00Z"), day, NY, "daily")).toEqual({ action: "regenerate", kind: "catchup" });
    expect(briefingDeferral(at("2026-10-12T21:59:00Z"), day, NY, "daily")).toEqual({ action: "regenerate", kind: "catchup" });
  });
  it("≥18:00 or the next day → skip", () => {
    expect(briefingDeferral(at("2026-10-12T22:00:00Z"), day, NY, "daily")).toEqual({ action: "skip" });
    expect(briefingDeferral(at("2026-10-13T13:00:00Z"), day, NY, "daily")).toEqual({ action: "skip" });
  });
});

describe("lateFirePolicy", () => {
  const due = at("2026-10-12T16:00:00Z");
  const p = (lateMs: number, kind: "absolute" | "anchored" | "recurring", origin: "user" | "auto") =>
    lateFirePolicy(due, new Date(due.getTime() + lateMs), kind, origin);

  it.each<[number, "absolute" | "anchored" | "recurring", "user" | "auto", string]>([
    [-10_000, "absolute", "user", "fire"],
    [10 * MIN, "absolute", "user", "fire"],
    [31 * MIN, "absolute", "user", "fire_late_prefix"],
    [11 * H, "anchored", "user", "fire_late_prefix"],
    [13 * H, "absolute", "user", "expire"],
    [20 * MIN, "recurring", "user", "fire"],
    [45 * MIN, "recurring", "user", "skip_to_next"],
    [50 * MIN, "anchored", "auto", "fire"],
    [61 * MIN, "anchored", "auto", "expire"],
  ])("late %d ms, %s/%s → %s", (late, kind, origin, want) => {
    expect(p(late, kind, origin)).toBe(want);
  });
});
