/**
 * Unit tests for src/shared/canvas-url.ts (V2-05 §2.6 step 1, §10.2). Run: npm test
 */
import { connectErrorForUrl } from "@/server/integrations/canvas/connect";
import { CANVAS_ERROR_COPY } from "@/shared/copy";
import {
  CANVAS_FEED_PATH_RE,
  classifyCanvasHost,
  feedUrlHint,
  findCanvasFeedUrls,
  normalizeCanvasFeedUrl,
  precheckErrorFor,
  precheckIcalUrl,
  redactCanvasFeedUrls,
  type FeedUrlError,
} from "@/shared/canvas-url";

const ID = "Ab3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k"; // 40 alphanumerics, like SecureRandom.alphanumeric(40)
const PATH = `/feeds/calendars/user_${ID}.ics`;
const YALE = `https://yale.instructure.com${PATH}`;

function ok(input: string) {
  const r = normalizeCanvasFeedUrl(input);
  if (!r.ok) throw new Error(`expected ok for ${input}, got ${r.error}`);
  return r.url;
}

function rejects(input: string): FeedUrlError {
  const r = normalizeCanvasFeedUrl(input);
  if (r.ok) throw new Error(`expected rejection for ${input}, got ${r.url.href}`);
  return r.error;
}

describe("normalizeCanvasFeedUrl — accepts", () => {
  it("upgrades webcal:// and http:// to https", () => {
    expect(ok(`webcal://yale.instructure.com${PATH}`)).toEqual({ href: YALE, host: "yale.instructure.com", hostClass: "instructure" });
    expect(ok(`webcals://yale.instructure.com${PATH}`).href).toBe(YALE);
    expect(ok(`http://yale.instructure.com${PATH}`).href).toBe(YALE);
    expect(ok(YALE).href).toBe(YALE);
  });

  it("lower-cases the host and strips a trailing dot", () => {
    expect(ok(`https://YALE.Instructure.COM${PATH}`).href).toBe(YALE);
    expect(ok(`https://yale.instructure.com.${PATH}`).href).toBe(YALE);
  });

  it("unwraps <…>, quotes, smart quotes, and trailing punctuation; drops the fragment", () => {
    expect(ok(`<${YALE}>`).href).toBe(YALE);
    expect(ok(`"${YALE}"`).href).toBe(YALE);
    expect(ok(`“${YALE}”`).href).toBe(YALE);
    expect(ok(`  ${YALE}.  `).href).toBe(YALE);
    expect(ok(`(${YALE}),`).href).toBe(YALE);
    expect(ok(`${YALE}#frag`).href).toBe(YALE);
  });

  it("accepts a scheme-less paste and the explicit default port", () => {
    expect(ok(`yale.instructure.com${PATH}`).href).toBe(YALE);
    expect(ok(`https://yale.instructure.com:443${PATH}`).href).toBe(YALE);
  });

  it("classifies listed vanity hosts and unlisted hosts", () => {
    expect(ok(`https://canvas.harvard.edu${PATH}`).hostClass).toBe("listed");
    expect(ok(`https://courseworks2.columbia.edu${PATH}`).hostClass).toBe("listed");
    expect(ok(`https://canvas.someschool.edu${PATH}`)).toEqual({
      href: `https://canvas.someschool.edu${PATH}`,
      host: "canvas.someschool.edu",
      hostClass: "unlisted",
    });
  });

  it("accepts legacy id lengths 20–64 only", () => {
    expect(ok(`https://yale.instructure.com/feeds/calendars/user_${"a".repeat(20)}.ics`).host).toBe("yale.instructure.com");
    expect(ok(`https://yale.instructure.com/feeds/calendars/user_${"a".repeat(64)}.ics`).host).toBe("yale.instructure.com");
    expect(rejects(`https://yale.instructure.com/feeds/calendars/user_${"a".repeat(19)}.ics`)).toBe("not_feed_path");
    expect(rejects(`https://yale.instructure.com/feeds/calendars/user_${"a".repeat(65)}.ics`)).toBe("not_feed_path");
  });
});

describe("normalizeCanvasFeedUrl — rejects", () => {
  it.each<[string, FeedUrlError]>([
    ["", "empty"],
    ["   ", "empty"],
    ["hello there", "not_a_url"],
    [`ftp://yale.instructure.com${PATH}`, "bad_scheme"],
    [`javascript:alert(1)`, "bad_scheme"],
    [`http://u:p@yale.instructure.com${PATH}`, "has_credentials"],
    [`https://yale.instructure.com@evil.com${PATH}`, "has_credentials"],
    [`https://yale.instructure.com:8443${PATH}`, "bad_port"],
    [`yale.instructure.com:8443${PATH}`, "bad_port"],
    [`https://127.0.0.1${PATH}`, "ip_literal"],
    [`https://2130706433${PATH}`, "ip_literal"],
    [`https://0x7f.1${PATH}`, "ip_literal"],
    [`https://017700000001${PATH}`, "ip_literal"],
    [`https://[::1]${PATH}`, "ip_literal"],
    [`https://localhost${PATH}`, "bad_host"],
    [`https://evil_host.edu${PATH}`, "bad_host"],
    [`https://evil.com/yale.instructure.com${PATH}`, "not_feed_path"],
    [`https://evil.com\\@yale.instructure.com${PATH}`, "not_feed_path"],
    [`https://yale.instructure.com/feeds/calendars/../../api/v1`, "not_feed_path"],
    [`https://yale.instructure.com/feeds/calendars/%2e%2e/%2e%2e/api/v1/users_${ID}.ics`, "not_feed_path"],
    [`https://yale.instructure.com/feeds/calendars/user_${ID}%2f.ics`, "not_feed_path"],
    [`https://yale.instructure.com/api/v1/users/self`, "not_feed_path"],
    [`${YALE}?x=1`, "has_query"],
    [`https://yale.instructure.com/feeds/calendars/course_${ID}.ics`, "course_feed"],
    [`https://yale.instructure.com/feeds/calendars/enrollment_${ID}.ics`, "course_feed"],
  ])("%s → %s", (input, error) => {
    expect(rejects(input)).toBe(error);
  });

  it("treats look-alike hosts as unlisted (they must still prove they're Canvas at fetch)", () => {
    expect(ok(`https://yale.instructure.com.evil.com${PATH}`).hostClass).toBe("unlisted");
    // Cyrillic "е" in "instructurе" → punycode, which no longer matches *.instructure.com
    const idn = ok(`https://yale.instructurе.com${PATH}`);
    expect(idn.host.startsWith("yale.xn--")).toBe(true);
    expect(idn.hostClass).toBe("unlisted");
    // Cyrillic "а" in a listed vanity host
    expect(ok(`https://canvas.hаrvard.edu${PATH}`).hostClass).toBe("unlisted");
  });

  it("CANVAS_FEED_PATH_RE is anchored", () => {
    expect(CANVAS_FEED_PATH_RE.test(PATH)).toBe(true);
    expect(CANVAS_FEED_PATH_RE.test(`/x${PATH}`)).toBe(false);
    expect(CANVAS_FEED_PATH_RE.test(`${PATH}/x`)).toBe(false);
  });
});

describe("classifyCanvasHost", () => {
  it.each([
    ["yale.instructure.com", "instructure"],
    ["columbiasce.instructure.com", "instructure"],
    ["canvas.its.virginia.edu", "listed"],
    ["instructure.com", "unlisted"],
    ["evilinstructure.com", "unlisted"],
    ["canvas.example.edu", "unlisted"],
  ])("%s → %s", (host, cls) => {
    expect(classifyCanvasHost(host)).toBe(cls);
  });
});

describe("precheckIcalUrl", () => {
  it("maps to the web form's codes", () => {
    expect(precheckIcalUrl(` ${YALE} `)).toEqual({ ok: true, normalized: YALE });
    expect(precheckIcalUrl("")).toEqual({ ok: false, code: "empty" });
    expect(precheckIcalUrl("not a link")).toEqual({ ok: false, code: "not_a_url" });
    expect(precheckIcalUrl(`ftp://yale.instructure.com${PATH}`)).toEqual({ ok: false, code: "not_a_url" });
    expect(precheckIcalUrl("https://yale.instructure.com/calendar")).toEqual({ ok: false, code: "not_ical" });
    expect(precheckIcalUrl(`${YALE}?x=1`)).toEqual({ ok: false, code: "not_ical" });
  });

  it("keeps the specific reasons the server has distinct copy for", () => {
    expect(precheckIcalUrl("https://yale.instructure.com/feeds/calendars/course_abc.ics")).toEqual({
      ok: false,
      code: "course_feed",
    });
    expect(precheckIcalUrl(`https://127.0.0.1${PATH}`)).toEqual({ ok: false, code: "private_address" });
    expect(precheckIcalUrl(`https://[::1]${PATH}`)).toEqual({ ok: false, code: "private_address" });
  });

  it("agrees with the server's connectErrorForUrl for every code (except client-only empty)", () => {
    const all: Record<FeedUrlError, true> = {
      empty: true,
      not_a_url: true,
      bad_scheme: true,
      has_credentials: true,
      bad_port: true,
      ip_literal: true,
      bad_host: true,
      has_query: true,
      course_feed: true,
      not_feed_path: true,
      parser_mismatch: true,
    };
    for (const e of Object.keys(all) as FeedUrlError[]) {
      const code = precheckErrorFor(e);
      expect(CANVAS_ERROR_COPY[code]).toBeTruthy();
      if (e === "empty") expect(code).toBe("empty");
      else expect(code).toBe(connectErrorForUrl(e));
    }
  });
});

describe("findCanvasFeedUrls", () => {
  const HARVARD = `https://canvas.harvard.edu/feeds/calendars/user_${"z".repeat(40)}.ics`;

  it("finds URLs among punctuation, dedupes, keeps order", () => {
    const text = `here it is: <${YALE}>. also (webcal://canvas.harvard.edu/feeds/calendars/user_${"z".repeat(40)}.ics), and again ${YALE}!`;
    expect(findCanvasFeedUrls(text).map((u) => u.href)).toEqual([YALE, HARVARD]);
  });

  it("handles a scheme glued to a label and scheme-less pastes", () => {
    expect(findCanvasFeedUrls(`link:${YALE}`).map((u) => u.href)).toEqual([YALE]);
    expect(findCanvasFeedUrls(`yale.instructure.com${PATH}`).map((u) => u.href)).toEqual([YALE]);
  });

  it("returns [] for no URL, rejected URLs, and empty text", () => {
    expect(findCanvasFeedUrls("what's due tomorrow?")).toEqual([]);
    expect(findCanvasFeedUrls(`https://127.0.0.1${PATH}`)).toEqual([]);
    expect(findCanvasFeedUrls("https://yale.instructure.com/calendar")).toEqual([]);
    expect(findCanvasFeedUrls("")).toEqual([]);
  });

  it("is linear-time on adversarial input", () => {
    const evil = `${".".repeat(200_000)}x /feeds/calendars/${"(".repeat(200_000)}`;
    const t0 = Date.now();
    expect(findCanvasFeedUrls(evil)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("redactCanvasFeedUrls", () => {
  it("replaces each feed URL and keeps surrounding text", () => {
    expect(redactCanvasFeedUrls(`here: <${YALE}>. thanks`)).toBe("here: <[Canvas feed link]>. thanks");
    expect(redactCanvasFeedUrls(`a ${YALE} b webcal://yale.instructure.com${PATH}`, "[saved]")).toBe("a [saved] b [saved]");
  });

  it("errs toward secrecy for rejected spellings, leaves other links alone", () => {
    expect(redactCanvasFeedUrls(`https://127.0.0.1${PATH}`)).toBe("[Canvas feed link]");
    expect(redactCanvasFeedUrls("see https://yale.instructure.com/calendar")).toBe("see https://yale.instructure.com/calendar");
    expect(redactCanvasFeedUrls("")).toBe("");
  });
});

describe("feedUrlHint", () => {
  it("shows host and the last 4 of the id only", () => {
    const hint = feedUrlHint(ok(YALE));
    expect(hint).toBe("yale.instructure.com/feeds/…fG5hJ7k".replace("fG5hJ7k", ID.slice(-4)));
    expect(hint).not.toContain(ID.slice(0, 10));
  });
});
