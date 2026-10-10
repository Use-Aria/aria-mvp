/**
 * Unit tests for pure security logic. Run: npm test
 */
import { randomBytes } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  parseKey,
  randomToken,
  safeEqual,
  sha256Hex,
} from "@/server/security/crypto";
import {
  DEFAULT_TARGET,
  isLinkPurpose,
  previewTitle,
  safeTarget,
} from "@/server/security/link-policy";

const key = randomBytes(32);

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and is versioned", () => {
    const enc = encryptSecret("ya29.refresh-token", key);
    expect(enc).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(decryptSecret(enc, key)).toBe("ya29.refresh-token");
  });

  it("uses a fresh IV every time", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects tampering, wrong key, and unknown versions", () => {
    const enc = encryptSecret("secret", key);
    const body = Buffer.from(enc.slice(3), "base64url");
    body[body.length - 1] ^= 1;
    expect(() => decryptSecret(`v1:${body.toString("base64url")}`, key)).toThrow();
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
    expect(() => decryptSecret(enc.replace("v1:", "v9:"), key)).toThrow();
    expect(() => decryptSecret("garbage", key)).toThrow();
  });
});

describe("crypto helpers", () => {
  it("parseKey requires exactly 32 bytes", () => {
    expect(parseKey(randomBytes(32).toString("base64"))).toHaveLength(32);
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow();
  });

  it("randomToken is base64url with the requested entropy", () => {
    const t = randomToken(24);
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(t).not.toBe(randomToken(24));
  });

  it("sha256Hex and safeEqual", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "b")).toBe(false);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});

describe("link policy", () => {
  it("safeTarget allows only in-app paths", () => {
    expect(safeTarget("/week", "/setup")).toBe("/week");
    const email = "/email/0b8e2c1a-1111-4222-8333-944455556666";
    expect(safeTarget(email, "/week")).toBe(email);
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/week/../admin",
      "/week?x=1",
      "/settings/",
      "",
      null,
      undefined,
    ]) {
      expect(safeTarget(bad, "/week")).toBe("/week");
    }
  });

  it("isLinkPurpose and defaults", () => {
    expect(isLinkPurpose("connect_google")).toBe(true);
    expect(isLinkPurpose("admin")).toBe(false);
    expect(isLinkPurpose("toString")).toBe(false);
    expect(DEFAULT_TARGET.setup).toBe("/setup");
  });

  it("previewTitle never echoes arbitrary input", () => {
    expect(previewTitle("week", "3")).toBe("Your week: 3 deadlines");
    expect(previewTitle("week", "1")).toBe("Your week: 1 deadline");
    expect(previewTitle("week", "<script>")).toBe("Your week");
    expect(previewTitle("week", "999")).toBe("Your week");
    expect(previewTitle("CPSC 323 midterm", "1")).toBe("Open Aria");
  });
});
