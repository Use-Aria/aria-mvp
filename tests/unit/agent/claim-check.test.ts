/**
 * Claim check detectors (5.F1, CR-2/CR-3): phrases the model used when it claimed an action
 * without calling the tool (eval/probe transcripts), and replies that must NOT count.
 */
import { claimCheck, claimsAction, looksLikeAnswer, type ClaimCheckState } from "@/server/agent/claim-check";

describe("claimsAction: claims seen without a tool call", () => {
  it.each([
    ["pause till tomorrow", "got it, quiet till tmrw morning"],
    ["pause till tomorrow", "paused till tmrw morning"],
    ["pause till tomorrow", "got it, quiet till morning"],
    ["can you stop texting me for the rest of the night", "got it, quiet for the rest of tonight"],
    ["just finished the econ pset", "nice, that's one off the list"],
    ["just finished the econ pset", "nice, one less thing 🎉"],
    ["just finished the econ pset", "nice, econ pset marked done"],
    ["sure", "done, it's a standing rule now"],
    ["remind me in 10 min to drink water", "on it, water reminder in 10 min 💧"],
    ["remind me in 10 min to drink water", "on it, I'll ping you in 10 min"],
    ["make the gym cutoff 9pm", "done, locked in"],
    ["draft an email to prof lee", "on it, drafting that now"],
    ["sign my emails Best, Dan", "saved 👍"],
    ["move my study block to 4", "I moved it to 4pm"],
    ["book the 6:30 slot", "ok you're all set for 6:30"],
    ["make it 9pm instead", "updated ✅"],
    ["remember i hate early classes", "got it"],
    ["don't text me till tomorrow", "got it, will do"],
  ])("%s → %s", (userText, bubble) => {
    expect(claimsAction([bubble], userText)).toBe(true);
  });
});

describe("claimsAction: replies that are not claims", () => {
  it.each([
    ["what's due tmr", ["econ problem set 6", "due tmr 5pm"]],
    ["what's due tmr", ["you've got the econ problem set"]],
    ["fyi i have a midterm thursday, kinda stressed", ["that's a lot to carry, sorry it's stressing you out", "i don't see a midterm in your calendar yet. want to add it?"]],
    ["fyi i have a midterm thursday", ["what class is it? if you tell me i'll add it and we can plan study time"]],
    ["fyi i have a midterm thursday", ["got it, good luck!"]], // weak ack, no action asked
    ["wait did you set that reminder?", ["nope, my bad. I said I set it but I didn't", "want me to set it for 9pm tonight?"]],
    ["wait did you set that reminder?", ["honestly no, it's not set"]],
    ["find me time for gym tmr", ["4–5:30 or 6:30–8?"]],
    ["remind me 2h before the pset", ["it's due tmr 11:59pm, so 9:59pm. you sure you can finish it in 2 hrs?"]],
    ["draft an email to prof lee", ["want me to draft it now?"]],
    ["thanks!!", []],
    ["are you a real person", ["nope, I'm an AI 🤖 but I got you"]],
  ])("%s → %j", (userText, bubbles) => {
    expect(claimsAction(bubbles, userText)).toBe(false);
  });
});

describe("looksLikeAnswer", () => {
  it.each(["sure", "yes", "yep do it", "ok", "Sure!", "nah nvm", "no thanks", "sounds good", "yeah go for it"])("%s → answer", (t) => {
    expect(looksLikeAnswer(t)).toBe(true);
  });
  it.each(["", "what's due tmr", "sure but can you also check my email and tell me if prof lee wrote back about the essay", "maybe later idk"])("%j → not an answer", (t) => {
    expect(looksLikeAnswer(t)).toBe(false);
  });
});

describe("claimCheck gating", () => {
  const base: ClaimCheckState = {
    trigger: "inbound",
    evidenceCount: 1,
    locked: false,
    alreadyChecked: false,
    forced: false,
    toolCalls: 0,
    mutatingCalls: 0,
    openQuestion: false,
    userText: "pause till tomorrow",
    bubbles: ["paused till tmrw"],
  };

  it("fires on a tool-less claim", () => {
    expect(claimCheck(base)).toBe("claimed_action");
  });

  it.each([
    ["proactive", { trigger: "proactive" as const }],
    ["no evidence", { evidenceCount: 0 }],
    ["action-locked", { locked: true }],
    ["already fired", { alreadyChecked: true }],
    ["forced answer", { forced: true }],
    ["a mutating tool ran", { mutatingCalls: 1, toolCalls: 1 }],
  ])("never fires: %s", (_label, over) => {
    expect(claimCheck({ ...base, ...over })).toBeNull();
    expect(claimCheck({ ...base, ...over, openQuestion: true, userText: "sure", bubbles: [] })).toBeNull();
  });

  it("a bare tapback (no bubbles, no tool) on an action request counts as a claim; on chit-chat it doesn't", () => {
    const tap = { ...base, userText: "can you draft an email to prof lee saying i'll miss section", bubbles: [] };
    expect(claimCheck(tap)).toBe("claimed_action");
    expect(claimCheck({ ...tap, toolCalls: 1 })).toBeNull(); // a read ran: the tapback isn't the whole answer
    expect(claimCheck({ ...tap, userText: "thanks!! you're the best" })).toBeNull();
    expect(claimCheck({ ...tap, userText: "lol" })).toBeNull();
  });

  it("unrecorded answer: open question + bare yes/no + no tool at all", () => {
    const s = { ...base, openQuestion: true, userText: "sure", bubbles: [] };
    expect(claimCheck(s)).toBe("unrecorded_answer");
    expect(claimCheck({ ...s, openQuestion: false })).toBeNull();
    expect(claimCheck({ ...s, toolCalls: 1 })).toBeNull(); // a read tool ran: it answered something else
    expect(claimCheck({ ...s, userText: "what's due tmr" })).toBeNull();
  });
});
