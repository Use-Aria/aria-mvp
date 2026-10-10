/**
 * Google JWT verification with a locally generated RSA key served as a JWKS through a stub
 * `fetch` (V2-07 §10 `oidc.test.ts`).
 */
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from "jose";
import { checkIdTokenClaims, checkPushClaims, verifyGoogleJwt, type GoogleIdClaims } from "@/server/integrations/google/oidc";

const AUD = "https://aria-test.vercel.app/api/google/gmail-push";
const SA = "gmail-push-invoker@proj.iam.gserviceaccount.com";
const NOW = new Date("2026-10-10T12:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

let privateKey: CryptoKey;
let jwks: { keys: JWK[] };
let otherPrivate: CryptoKey;
let jwksHits = 0;

const jwksFetch: typeof fetch = async (input) => {
  expect(String(input)).toBe("https://www.googleapis.com/oauth2/v3/certs");
  jwksHits++;
  return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
};

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  jwks = { keys: [{ ...pub, kid: "k1", alg: "RS256", use: "sig" }] };
  otherPrivate = (await generateKeyPair("RS256")).privateKey;
});

interface Claims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
  iat?: number;
}

async function sign(over: Claims = {}, key: CryptoKey = privateKey, kid = "k1"): Promise<string> {
  const c: Claims = {
    iss: "https://accounts.google.com",
    aud: AUD,
    sub: "1234567890",
    email: SA,
    email_verified: true,
    iat: nowSec - 60,
    exp: nowSec + 3600,
    ...over,
  };
  return new SignJWT({ email: c.email, email_verified: c.email_verified })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(c.iss as string)
    .setAudience(c.aud as string)
    .setSubject(c.sub as string)
    .setIssuedAt(c.iat)
    .setExpirationTime(c.exp as number)
    .sign(key);
}

const verify = (token: string) => verifyGoogleJwt(token, { audience: AUD, fetch: jwksFetch, currentDate: NOW });

describe("verifyGoogleJwt", () => {
  it("accepts a valid token and returns the claims", async () => {
    const claims = await verify(await sign());
    expect(claims).toEqual({ iss: "https://accounts.google.com", aud: AUD, sub: "1234567890", email: SA, email_verified: true, exp: nowSec + 3600 });
    expect(jwksHits).toBeGreaterThan(0);
  });

  it("accepts the bare accounts.google.com issuer", async () => {
    await expect(verify(await sign({ iss: "accounts.google.com" }))).resolves.toMatchObject({ iss: "accounts.google.com" });
  });

  it("rejects the wrong audience", async () => {
    await expect(verify(await sign({ aud: "https://evil.example/push" }))).rejects.toThrow();
  });

  it("rejects the wrong issuer", async () => {
    await expect(verify(await sign({ iss: "https://evil.example" }))).rejects.toThrow();
  });

  it("allows 5 min skew but rejects a token expired beyond it", async () => {
    await expect(verify(await sign({ exp: nowSec - 200 }))).resolves.toBeDefined();
    await expect(verify(await sign({ exp: nowSec - 400 }))).rejects.toThrow();
  });

  it("rejects a token signed by a key not in the JWKS", async () => {
    await expect(verify(await sign({}, otherPrivate))).rejects.toThrow();
    await expect(verify(await sign({}, otherPrivate, "unknown-kid"))).rejects.toThrow();
  });

  it("rejects alg none", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${enc({ alg: "none", typ: "JWT" })}.${enc({ iss: "https://accounts.google.com", aud: AUD, sub: "1", exp: nowSec + 60 })}.`;
    await expect(verify(unsigned)).rejects.toThrow();
  });

  it("rejects HS256 (alg confusion)", async () => {
    const secret = new TextEncoder().encode("a-shared-secret-of-at-least-32-bytes!!");
    const hs = await new SignJWT({ email: SA, email_verified: true })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(AUD)
      .setSubject("1")
      .setExpirationTime(nowSec + 60)
      .sign(secret);
    await expect(verify(hs)).rejects.toThrow();
  });

  it("rejects garbage", async () => {
    await expect(verify("not.a.jwt")).rejects.toThrow();
  });
});

describe("checkPushClaims / checkIdTokenClaims", () => {
  const base: GoogleIdClaims = { iss: "https://accounts.google.com", aud: AUD, sub: "1", email: SA, email_verified: true, exp: nowSec };

  it("accepts the configured service account (case-insensitive)", () => {
    expect(checkPushClaims(base, { serviceAccount: SA })).toBe(true);
    expect(checkPushClaims({ ...base, email: SA.toUpperCase() }, { serviceAccount: SA })).toBe(true);
  });

  it("rejects the wrong email, unverified email, missing email, or empty config", () => {
    expect(checkPushClaims({ ...base, email: "attacker@proj.iam.gserviceaccount.com" }, { serviceAccount: SA })).toBe(false);
    expect(checkPushClaims({ ...base, email_verified: false }, { serviceAccount: SA })).toBe(false);
    expect(checkPushClaims({ ...base, email: undefined }, { serviceAccount: SA })).toBe(false);
    expect(checkPushClaims(base, { serviceAccount: "" })).toBe(false);
  });

  it("id_token: returns the lower-cased verified email, else null", async () => {
    const verified = await verify(await sign({ email: "Student@Example.EDU" }));
    expect(checkIdTokenClaims(verified)).toBe("student@example.edu");
    const unverified = await verify(await sign({ email_verified: false }));
    expect(unverified.email_verified).toBe(false);
    expect(checkIdTokenClaims(unverified)).toBeNull();
    expect(checkIdTokenClaims({ ...base, email: undefined })).toBeNull();
  });
});
