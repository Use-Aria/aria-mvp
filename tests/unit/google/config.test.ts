/**
 * Google scopes → features, and env-derived config (V2-07 §10 `config.test.ts`).
 */
import {
  featureList,
  featuresFor,
  gmailPushConfig,
  googleRedirectUri,
  missingRequiredScopes,
  normalizeScopes,
  pkceEnabled,
  REQUESTED_SCOPES,
  REQUIRED_SCOPES,
  SCOPES,
} from "@/server/integrations/google/config";

const ENV_KEYS = [
  "APP_BASE_URL",
  "GOOGLE_REDIRECT_URI",
  "GMAIL_PUBSUB_TOPIC",
  "GMAIL_PUSH_SERVICE_ACCOUNT",
  "GMAIL_PUSH_AUDIENCE",
  "GMAIL_PUSH_SUBSCRIPTION",
  "GOOGLE_PKCE",
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// What Google echoes back in the token response `scope` (long-form email scope, any order).
const GRANTED_ALL =
  "https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email " +
  "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly " +
  "https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/gmail.readonly";

describe("scope lists", () => {
  it("requests exactly the V2-07 §2.1 set (minimal; no calendar.readonly / compose / modify)", () => {
    expect(REQUESTED_SCOPES).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.app.created",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(REQUIRED_SCOPES).toEqual(["openid", "email", SCOPES.calEventsRead]);
  });

  it("normalizes the long-form email scope, blanks and duplicates", () => {
    expect(normalizeScopes("  openid  https://www.googleapis.com/auth/userinfo.email openid ")).toEqual(["openid", "email"]);
    expect(normalizeScopes(null)).toEqual([]);
    expect(normalizeScopes(["email", "email"])).toEqual(["email"]);
  });
});

describe("featuresFor", () => {
  it("all scopes → all features", () => {
    expect([...featuresFor(normalizeScopes(GRANTED_ALL))].sort()).toEqual(["calendar_read", "calendar_write", "gmail_read", "gmail_send"]);
    expect(featureList(GRANTED_ALL.split(" "))).toEqual(["calendar_read", "calendar_write", "gmail_read", "gmail_send"]);
    expect(missingRequiredScopes(GRANTED_ALL)).toEqual([]);
  });

  it("Gmail unticked → calendar only", () => {
    const granted = ["openid", "email", SCOPES.calEventsRead, SCOPES.calList, SCOPES.calAppCreated];
    expect(featureList(granted)).toEqual(["calendar_read", "calendar_write"]);
    expect(missingRequiredScopes(granted)).toEqual([]);
  });

  it("app.created unticked → no calendar_write", () => {
    const granted = ["openid", "email", SCOPES.calEventsRead, SCOPES.gmailRead, SCOPES.gmailSend];
    expect(featureList(granted)).toEqual(["calendar_read", "gmail_read", "gmail_send"]);
  });

  it("only gmail.send → send only; required scopes missing", () => {
    expect(featureList([SCOPES.gmailSend])).toEqual(["gmail_send"]);
    expect(missingRequiredScopes([SCOPES.gmailSend])).toEqual(["openid", "email", SCOPES.calEventsRead]);
  });

  it("missing calendar read is reported even with everything else", () => {
    const granted = GRANTED_ALL.split(" ").filter((s) => s !== SCOPES.calEventsRead);
    expect(missingRequiredScopes(granted)).toEqual([SCOPES.calEventsRead]);
    expect(featuresFor(granted).has("calendar_read")).toBe(false);
  });

  it("empty → nothing", () => {
    expect(featuresFor([]).size).toBe(0);
  });
});

describe("env config", () => {
  it("redirect URI defaults to the app base URL and honours an override", () => {
    process.env.APP_BASE_URL = "https://aria-test.vercel.app/";
    expect(googleRedirectUri()).toBe("https://aria-test.vercel.app/api/google/callback");
    process.env.GOOGLE_REDIRECT_URI = "https://aria.example.com/api/google/callback";
    expect(googleRedirectUri()).toBe("https://aria.example.com/api/google/callback");
  });

  it("gmail push config is null without a topic, defaults the audience, and requires the SA", () => {
    expect(gmailPushConfig()).toBeNull();
    process.env.APP_BASE_URL = "https://aria-test.vercel.app";
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/gmail-push";
    expect(() => gmailPushConfig()).toThrow(/GMAIL_PUSH_SERVICE_ACCOUNT/);
    process.env.GMAIL_PUSH_SERVICE_ACCOUNT = "gmail-push-invoker@p.iam.gserviceaccount.com";
    expect(gmailPushConfig()).toEqual({
      topic: "projects/p/topics/gmail-push",
      serviceAccount: "gmail-push-invoker@p.iam.gserviceaccount.com",
      audience: "https://aria-test.vercel.app/api/google/gmail-push",
    });
    process.env.GMAIL_PUSH_AUDIENCE = "aud-x";
    process.env.GMAIL_PUSH_SUBSCRIPTION = "projects/p/subscriptions/s";
    expect(gmailPushConfig()).toMatchObject({ audience: "aud-x", subscription: "projects/p/subscriptions/s" });
  });

  it("PKCE is on unless GOOGLE_PKCE=off", () => {
    expect(pkceEnabled()).toBe(true);
    process.env.GOOGLE_PKCE = "on";
    expect(pkceEnabled()).toBe(true);
    process.env.GOOGLE_PKCE = " OFF ";
    expect(pkceEnabled()).toBe(false);
  });
});
