/**
 * OAuth state, PKCE and cookie binding (V2-07 §10 `state.test.ts`).
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  buildAuthUrl,
  createPkcePair,
  deriveStateKey,
  openOAuthCookie,
  pkceChallenge,
  sealOAuthCookie,
  sessionBinding,
  signState,
  verifyCallbackBinding,
  verifyState,
  type OAuthStatePayload,
} from "@/server/integrations/google/oauth/state";
import { REQUESTED_SCOPES } from "@/server/integrations/google/config";

const appKey = randomBytes(32);
const key = deriveStateKey(appKey);
const NOW = 1_800_000_000_000;
const USER = "8a1c0e4e-2b1f-4f5e-9a59-3f0f1b2c3d4e";
const RAW_SESSION = "raw-session-cookie-value";

function payload(over: Partial<OAuthStatePayload> = {}): OAuthStatePayload {
  return { u: USER, s: sessionBinding(RAW_SESSION), n: "nonce-abcdefgh", e: NOW + 600_000, r: "/setup", ...over };
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

describe("signState / verifyState", () => {
  it("round-trips", () => {
    const st = signState(payload(), key);
    expect(st.split(".")).toHaveLength(2);
    expect(verifyState(st, key, NOW)).toEqual({ ok: true, payload: payload() });
  });

  it("rejects a tampered payload as bad_sig", () => {
    const [, sig] = signState(payload(), key).split(".");
    const forged = `${b64(JSON.stringify(payload({ u: "someone-else" })))}.${sig}`;
    expect(verifyState(forged, key, NOW)).toEqual({ ok: false, reason: "bad_sig" });
  });

  it("rejects a tampered signature", () => {
    const [body, sig] = signState(payload(), key).split(".") as [string, string];
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyState(`${body}.${flipped}`, key, NOW)).toEqual({ ok: false, reason: "bad_sig" });
    expect(verifyState(`${body}.${sig.slice(0, -2)}`, key, NOW)).toEqual({ ok: false, reason: "bad_sig" });
  });

  it("rejects a state signed with another key", () => {
    const st = signState(payload(), deriveStateKey(randomBytes(32)));
    expect(verifyState(st, key, NOW)).toEqual({ ok: false, reason: "bad_sig" });
  });

  it("expires strictly after e", () => {
    const st = signState(payload(), key);
    expect(verifyState(st, key, NOW + 600_000).ok).toBe(true);
    expect(verifyState(st, key, NOW + 600_001)).toEqual({ ok: false, reason: "expired" });
  });

  it.each([
    ["no dot", "abcdef"],
    ["extra dots", "a.b.c"],
    ["empty parts", "."],
    ["bad base64 chars", "ab+c.de/f"],
    ["empty", ""],
  ])("rejects malformed: %s", (_name, st) => {
    expect(verifyState(st, key, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a correctly signed but invalid payload as malformed", () => {
    // Sign arbitrary bytes with the real key to reach the payload checks behind the HMAC.
    const signRaw = (body: string) => `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
    const signJson = (obj: unknown) => signRaw(b64(JSON.stringify(obj)));
    expect(verifyState(signJson({ ...payload(), r: "//evil.example" }), key, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyState(signJson({ ...payload(), r: "https://evil.example" }), key, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyState(signJson({ ...payload(), extra: 1 }), key, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyState(signJson("not an object"), key, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyState(signRaw(b64("{not json")), key, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("derives an HKDF key that differs from the raw key and is deterministic", () => {
    expect(key.equals(appKey)).toBe(false);
    expect(key).toHaveLength(32);
    expect(deriveStateKey(appKey).equals(key)).toBe(true);
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 Appendix B vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates a 43-char verifier with its S256 challenge", () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("sessionBinding", () => {
  it("is a stable 16-hex prefix", () => {
    expect(sessionBinding("abc")).toBe(sessionBinding("abc"));
    expect(sessionBinding("abc")).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionBinding("abc")).not.toBe(sessionBinding("abd"));
  });
});

describe("buildAuthUrl", () => {
  it("has every required parameter and encodes scopes with %20", () => {
    const url = buildAuthUrl({
      clientId: "cid.apps.googleusercontent.com",
      redirectUri: "https://aria.example.app/api/google/callback",
      scopes: REQUESTED_SCOPES,
      state: "st.sig",
      codeChallenge: "chal",
    });
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(url).not.toContain("+");
    const q = new URL(url).searchParams;
    expect(q.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(q.get("redirect_uri")).toBe("https://aria.example.app/api/google/callback");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe(REQUESTED_SCOPES.join(" "));
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent select_account");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("state")).toBe("st.sig");
    expect(q.get("code_challenge")).toBe("chal");
    expect(q.get("code_challenge_method")).toBe("S256");
  });

  it("omits PKCE params without a challenge", () => {
    const q = new URL(buildAuthUrl({ clientId: "c", redirectUri: "https://x.app/cb", scopes: ["openid"], state: "s" })).searchParams;
    expect(q.has("code_challenge")).toBe(false);
    expect(q.has("code_challenge_method")).toBe(false);
  });
});

describe("OAuth cookie + callback binding", () => {
  const verifier = createPkcePair().verifier;
  const nonce = "nonce-abcdefgh";
  const goodState = () => signState(payload({ n: nonce }), key);
  const goodCookie = () => sealOAuthCookie({ v: verifier, n: nonce, u: USER }, appKey);
  const session = { userId: USER, rawSessionId: RAW_SESSION };
  const base = () => ({ state: goodState(), cookieValue: goodCookie(), session, stateKey: key, appKey, now: NOW });

  it("seals and opens; tampering or a wrong key yields null", () => {
    const c = goodCookie();
    expect(openOAuthCookie(c, appKey)).toEqual({ v: verifier, n: nonce, u: USER });
    expect(openOAuthCookie(c, randomBytes(32))).toBeNull();
    expect(openOAuthCookie(`${c.slice(0, -3)}AAA`, appKey)).toBeNull();
    expect(openOAuthCookie(undefined, appKey)).toBeNull();
    expect(openOAuthCookie("garbage", appKey)).toBeNull();
  });

  it("accepts a matching state, cookie and session", () => {
    const r = verifyCallbackBinding(base());
    expect(r).toEqual({ ok: true, payload: payload({ n: nonce }), verifier });
  });

  it("passes a null verifier through when PKCE is off", () => {
    const r = verifyCallbackBinding({ ...base(), cookieValue: sealOAuthCookie({ v: null, n: nonce, u: USER }, appKey) });
    expect(r.ok && r.verifier).toBeNull();
  });

  it.each([
    ["missing state", { state: null }, "malformed"],
    ["expired state", { now: NOW + 600_001 }, "expired"],
    ["missing cookie", { cookieValue: undefined }, "missing_cookie"],
    ["no session", { session: null }, "no_session"],
    ["different session user", { session: { userId: "other-user", rawSessionId: RAW_SESSION } }, "session_mismatch"],
    ["different session cookie", { session: { userId: USER, rawSessionId: "another-session" } }, "session_mismatch"],
  ] as const)("rejects %s", (_name, over, reason) => {
    expect(verifyCallbackBinding({ ...base(), ...over })).toEqual({ ok: false, reason });
  });

  it("rejects a cookie from another flow (nonce or user mismatch)", () => {
    const otherNonce = sealOAuthCookie({ v: verifier, n: "nonce-zzzzzzzz", u: USER }, appKey);
    const otherUser = sealOAuthCookie({ v: verifier, n: nonce, u: "other-user" }, appKey);
    expect(verifyCallbackBinding({ ...base(), cookieValue: otherNonce })).toEqual({ ok: false, reason: "cookie_mismatch" });
    expect(verifyCallbackBinding({ ...base(), cookieValue: otherUser })).toEqual({ ok: false, reason: "cookie_mismatch" });
  });
});
