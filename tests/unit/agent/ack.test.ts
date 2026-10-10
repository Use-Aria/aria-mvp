/**
 * Ack-only fast path (V2-04 §2.9, §10.1).
 */
import { classifyAckOnly, endsWithQuestion } from "@/server/agent/persona/ack";

const FREE = { openQuestion: false, pendingActions: 0, lastAriaAskedQuestion: false };

describe("classifyAckOnly", () => {
  it.each([
    ["ok", "like"],
    ["k", "like"],
    ["kk", "like"],
    ["bet", "like"],
    ["Sounds good!!", "like"],
    ["got it.", "like"],
    ["cool", "like"],
    ["nice", "like"],
    ["ty", "love"],
    ["thx", "love"],
    ["thanks", "love"],
    ["Thank you!", "love"],
    ["👍", "like"],
    ["👍🏽", "like"],
    ["❤️", "love"],
    ["lol", "laugh"],
    ["hahaha", "laugh"],
    ["ok ty", "love"],
    ["cool thanks 🙏", "love"],
  ])("%s → %s", (text, kind) => {
    expect(classifyAckOnly([text], FREE)).toBe(kind);
  });

  it.each(["sure", "yes", "yeah", "ok but when is it due", "okay so", "thanks for nothing, it was due yesterday", "", "?", "ok?"])(
    "%j is not an ack",
    (text) => {
      expect(classifyAckOnly([text], FREE)).toBeNull();
    },
  );

  it("every message in the batch must be an ack; the newest decides the tapback", () => {
    expect(classifyAckOnly(["ok", "ty!!"], FREE)).toBe("love");
    expect(classifyAckOnly(["ok", "what about friday"], FREE)).toBeNull();
    expect(classifyAckOnly([], FREE)).toBeNull();
  });

  it("is blocked by an open question, pending actions, or a question from Aria", () => {
    expect(classifyAckOnly(["ok"], { ...FREE, openQuestion: true })).toBeNull();
    expect(classifyAckOnly(["ok"], { ...FREE, pendingActions: 1 })).toBeNull();
    expect(classifyAckOnly(["ok"], { ...FREE, lastAriaAskedQuestion: true })).toBeNull();
  });
});

describe("endsWithQuestion", () => {
  it.each([
    ["want me to set it?", true],
    ["want me to set it? 👀", true],
    ['you said "friday?"', true],
    ["done ✅", false],
    ["", false],
    [null, false],
  ])("%j → %s", (text, expected) => {
    expect(endsWithQuestion(text)).toBe(expected);
  });
});
