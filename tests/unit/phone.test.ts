import { maskHandle, normalizeHandle, toE164 } from "@/server/phone";
import { detectPlatform, formatNumber, smsLink } from "@/shared/sms-link";

describe("toE164", () => {
  it("normalizes US input", () => {
    expect(toE164("(203) 555-0142")).toBe("+12035550142");
    expect(toE164("203.555.0142")).toBe("+12035550142");
    expect(toE164("1 203 555 0142")).toBe("+12035550142");
    expect(toE164("+1 203 555 0142")).toBe("+12035550142");
  });

  it("keeps international numbers and rejects junk", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("+1 203 555 014")).toBeNull();
    expect(toE164("555-0142")).toBeNull();
    expect(toE164("call me maybe")).toBeNull();
    expect(toE164("")).toBeNull();
  });
});

describe("handles", () => {
  it("normalizeHandle handles phones and Apple ID emails", () => {
    expect(normalizeHandle("+12035550142")).toEqual({ handle: "+12035550142", kind: "phone" });
    expect(normalizeHandle(" Dan@iCloud.com ")).toEqual({ handle: "dan@icloud.com", kind: "email" });
    expect(normalizeHandle("not a handle")).toBeNull();
  });

  it("maskHandle hides all but the tail", () => {
    expect(maskHandle("+12035550142")).toBe("***0142");
    expect(maskHandle("dan@icloud.com")).toBe("***@icloud.com");
  });
});

describe("sms links", () => {
  it("uses & on Apple and ? on Android, with %20 encoding", () => {
    expect(smsLink("+12035550142", "Hey Aria!", "apple")).toBe("sms:+12035550142&body=Hey%20Aria!");
    expect(smsLink("+12035550142", "Hey Aria!", "android")).toBe("sms:+12035550142?body=Hey%20Aria!");
  });

  it("detectPlatform and formatNumber", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)")).toBe("apple");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9)")).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("desktop");
    expect(formatNumber("+12035550142")).toBe("(203) 555-0142");
    expect(formatNumber("+442079460958")).toBe("+442079460958");
  });
});
