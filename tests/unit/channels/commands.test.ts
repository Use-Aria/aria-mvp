/**
 * channels/commands.ts — whole-message keyword commands, opt-out "by any reasonable means",
 * negatives that must reach the agent, pause durations in the user's zone.
 */
import { commandReply, detectCommand, normalizeCommandText } from "@/server/channels/commands";

const NY = "America/New_York";
const NOW = new Date("2026-10-10T16:00:00Z"); // Sat 12:00 EDT
const H = 3_600_000;
const kind = (text: string) => detectCommand(text, NOW, NY)?.kind ?? null;

describe("opt-out", () => {
  it.each([
    "stop",
    "STOP",
    "Stop",
    "STOP!!",
    "Stop 🛑",
    "stop.",
    "  stop  ",
    "unsubscribe",
    "Unsubscribe.",
    "cancel",
    "opt out",
    "opt-out",
    "Opt Out!",
    "optout",
    "revoke",
    "end",
    "END",
    "quit",
    "stop all",
    "STOPALL",
    "leave me alone",
    "leave me alone pls",
    "Leave me alone!!! 😡",
    "please leave me alone",
    "stop texting me",
    "Stop texting me.",
    "stop messaging me",
    "dont text me",
    "don't text me",
    "Don’t text me",
    "no more texts",
    "please stop texting me",
    "stop texting me please",
    "quit messaging me",
    "stop contacting me",
    "stop texting me anymore",
    "ok stop",
    "unsub",
  ])("%p → opt_out", (t) => expect(kind(t)).toBe("opt_out"));
});

describe("not commands (reach the agent)", () => {
  it.each([
    "stop reminding me about cpsc",
    "end of the week?",
    "end of week?",
    "can you pause my gym block",
    "quit my job lol",
    "cancel my 3pm reminder",
    "stop the reminder",
    "when does it end",
    "help me with my essay",
    "can you help",
    "start my study session",
    "pause the music",
    "quiet hours?",
    "i want to stop procrastinating",
    "",
    "👍",
    "?",
  ])("%p → null", (t) => expect(kind(t)).toBeNull());
});

describe("opt-in and help", () => {
  it.each(["start", "START", "Start!", "unstop", "UNSTOP", "resume", "unpause", "opt in"])("%p → opt_in", (t) =>
    expect(kind(t)).toBe("opt_in"),
  );
  it.each(["help", "HELP", "Help?", "info", "INFO"])("%p → help", (t) => expect(kind(t)).toBe("help"));
});

describe("pause durations", () => {
  const until = (t: string) => {
    const c = detectCommand(t, NOW, NY);
    if (c?.kind !== "pause") throw new Error(`not a pause: ${t}`);
    return c.until;
  };

  it("bare pause/mute/snooze/quiet → 24h", () => {
    for (const t of ["pause", "PAUSE", "mute", "snooze", "quiet", "pause messages", "mute pls"]) {
      expect(until(t)).toEqual(new Date(NOW.getTime() + 24 * H));
    }
  });
  it("for N hours", () => {
    expect(until("pause for 3 hours")).toEqual(new Date(NOW.getTime() + 3 * H));
    expect(until("mute for an hour")).toEqual(new Date(NOW.getTime() + H));
    expect(until("snooze for 2hrs")).toEqual(new Date(NOW.getTime() + 2 * H));
  });
  it("for N days keeps the local wall time", () => {
    expect(until("pause for 2 days")).toEqual(new Date("2026-10-12T16:00:00Z"));
    expect(until("pause for a day")).toEqual(new Date("2026-10-11T16:00:00Z"));
    expect(until("mute for a week")).toEqual(new Date("2026-10-17T16:00:00Z"));
  });
  it("for N days across fall-back keeps 12:00 local (25h day)", () => {
    const now = new Date("2026-10-31T16:00:00Z"); // Sat 12:00 EDT
    const c = detectCommand("pause for 2 days", now, NY);
    expect(c).toEqual({ kind: "pause", until: new Date("2026-11-02T17:00:00Z") }); // Mon 12:00 EST
  });
  it("till tomorrow / for today → next local midnight", () => {
    const midnight = new Date("2026-10-11T04:00:00Z");
    expect(until("mute till tomorrow")).toEqual(midnight);
    expect(until("pause until tomorrow")).toEqual(midnight);
    expect(until("pause for today")).toEqual(midnight);
    expect(until("snooze til tmrw")).toEqual(midnight);
  });
  it("till tomorrow in another zone", () => {
    const c = detectCommand("mute till tomorrow", NOW, "Asia/Kolkata"); // 21:30 IST
    expect(c).toEqual({ kind: "pause", until: new Date("2026-10-10T18:30:00Z") }); // 00:00 IST Oct 11
  });
  it("caps long pauses at 30 days", () => {
    expect(until("pause for 400 days")).toEqual(new Date("2026-11-09T17:00:00Z")); // 30 local days, EST
  });
});

describe("normalizeCommandText", () => {
  it("lowercases, strips emoji and edge punctuation, removes apostrophes, collapses spaces", () => {
    expect(normalizeCommandText("  Don’t   TEXT me!!! 🛑 ")).toBe("dont text me");
    expect(normalizeCommandText("ＳＴＯＰ")).toBe("stop"); // NFKC full-width
    expect(normalizeCommandText("🛑🛑")).toBe("");
  });
});

describe("commandReply", () => {
  it("fixed texts", () => {
    expect(commandReply({ kind: "opt_out" })).toMatch(/START/);
    expect(commandReply({ kind: "opt_in" })).toMatch(/STOP/);
    expect(commandReply({ kind: "help" })).toMatch(/AI assistant/);
  });
  it("pause names the local end time when given a zone", () => {
    const text = commandReply({ kind: "pause", until: new Date("2026-10-11T16:00:00Z") }, { tz: NY, now: NOW });
    expect(text).toContain("tmrw 12pm");
    expect(commandReply({ kind: "pause", until: NOW })).toMatch(/check-ins/);
  });
});
