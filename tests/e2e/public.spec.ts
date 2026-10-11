/**
 * Public pages + security edges (web plan §10 flows, §2.6; CLAUDE.md "magic-link redeem" gotcha):
 * landing + signup form, `/m` magic-link redeem (fragment scrubbed, single use, re-open with a
 * session still routes, without one → /link-expired), redeem Origin check, response headers
 * (CSP, Referrer-Policy same-origin, X-Frame-Options), /link-expired, /privacy, /terms,
 * /signed-out, /account-deleted (+ `?g=0`), 404, and a server action replayed without Origin →
 * `bad_origin`.
 */
import { SETTINGS_COPY, SHARED_COPY } from "@/shared/copy";
import { E2E_SIGNUP_PREFIX, createMagicLink, must, sb } from "./support/db";
import { expect, expectNoHorizontalScroll, hydrated, test } from "./support/fixtures";

test.describe.configure({ timeout: 180_000 });

/** A per-test documentation-range IP so the in-memory per-IP limits never bite across reruns. */
function testIp(): string {
  return `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
}

test("landing renders; signup saves a row and shows the next step; bad phone explains", async ({ page }) => {
  const ip = testIp();
  await page.setExtraHTTPHeaders({ "x-real-ip": ip });
  await page.goto("/");
  await hydrated(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Texts you what's due, before it's due.");
  await expect(page.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  const name = `${E2E_SIGNUP_PREFIX}Pat ${Math.floor(Math.random() * 1e6)}`;
  try {
    await page.getByLabel("First name").fill(name);
    await page.getByLabel("Phone number").fill("1234567");
    await page.getByRole("button", { name: "Continue to Messages" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText(
      "Enter a US number like (203) 555-0142, or include your country code.",
    );

    const phone = `(203) 555-${String(1000 + Math.floor(Math.random() * 8999))}`;
    await page.getByLabel("Phone number").fill(phone);
    await page.getByRole("button", { name: "Continue to Messages" }).click();
    await expect(page.locator("main").getByRole("status")).toBeVisible();
    const rows = must(await sb().from("signups").select("name, timezone, ip").eq("name", name), "signup");
    expect(rows).toHaveLength(1);
    expect(rows[0].timezone).toBeTruthy();
  } finally {
    await sb().from("signups").delete().eq("name", name);
  }
  expect((await sb().from("signups").select("id").eq("name", name)).data ?? []).toHaveLength(0);
  await expectNoHorizontalScroll(page);
});

test("/m redeems once, scrubs the fragment, and re-opening routes only with a session", async ({ page, world, browser, baseURL }) => {
  await page.setExtraHTTPHeaders({ "x-real-ip": testIp() });
  const u = await world.user({ name: "Dana" });
  const link = await createMagicLink(u, { purpose: "view", target: "/week" });
  await page.goto(link.path);
  await expect(page).toHaveURL(/\/week$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dana's week");
  // Token never left in history.
  const history = await page.evaluate(() => window.location.href);
  expect(history).not.toContain("#t=");
  const used = must(await sb().from("magic_links").select("used_at").eq("user_id", u).single(), "link");
  expect(used.used_at).not.toBeNull();
  const sessions = must(await sb().from("web_sessions").select("scope").eq("user_id", u), "sessions");
  expect(sessions).toEqual([{ scope: "view" }]);

  // Re-open the used link with the session: still routes.
  await page.goto("about:blank");
  await page.goto(link.path);
  await expect(page).toHaveURL(/\/week$/, { timeout: 30_000 });

  // Without a session: /link-expired.
  const fresh = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-real-ip": testIp() } });
  try {
    const p2 = await fresh.newPage();
    await p2.goto(link.path);
    await expect(p2).toHaveURL(/\/link-expired$/, { timeout: 30_000 });
    await expect(p2.getByRole("heading", { level: 1 })).toHaveText("That link expired.");
  } finally {
    await fresh.close();
  }
});

test("/m without a token, and a setup link lands on /setup with a setup session", async ({ page, world }) => {
  await page.setExtraHTTPHeaders({ "x-real-ip": testIp() });
  await page.goto("/m");
  await expect(page.getByText(/This link is missing its code/)).toBeVisible();
  const u = await world.user();
  const link = await createMagicLink(u, { purpose: "setup", target: "/setup" });
  await page.goto(link.path);
  await expect(page).toHaveURL(/\/setup$/, { timeout: 30_000 });
  await expect(page.getByText(/You can connect accounts until/)).toBeVisible();
});

test("redeem refuses a missing or foreign Origin; headers are set", async ({ request }) => {
  const ip = testIp();
  const none = await request.post("/api/session/redeem", { form: { t: "x".repeat(32) }, headers: { "x-real-ip": ip }, maxRedirects: 0 });
  expect(none.status()).toBe(403);
  const nul = await request.post("/api/session/redeem", { form: { t: "x".repeat(32) }, headers: { origin: "null", "x-real-ip": ip }, maxRedirects: 0 });
  expect(nul.status()).toBe(403);
  const get = await request.get("/api/session/redeem", { maxRedirects: 0 });
  expect(get.status()).toBe(405);

  for (const path of ["/", "/week", "/setup", "/m"]) {
    const res = await request.get(path);
    const h = res.headers();
    expect(h["referrer-policy"], path).toBe("same-origin");
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["content-security-policy"], path).toContain("form-action 'self'");
    expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
  }
});

test("static pages render with one h1", async ({ page }) => {
  const pages: Array<[string, string]> = [
    ["/privacy", "Privacy"],
    ["/terms", "Terms"],
    ["/link-expired", "That link expired."],
    ["/signed-out", SHARED_COPY.signedOutPage.title],
    ["/account-deleted", SETTINGS_COPY.deletedPage.title],
  ];
  for (const [path, h1] of pages) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }), path).toHaveText(h1);
    await expect(page.locator("h1"), path).toHaveCount(1);
    await expectNoHorizontalScroll(page);
  }
  await page.goto("/account-deleted?g=0");
  await expect(page.getByText(SETTINGS_COPY.deletedPage.revokeFailed)).toBeVisible();
  await expect(page.getByRole("link", { name: SETTINGS_COPY.deletedPage.revokeButton })).toHaveAttribute(
    "href",
    "https://myaccount.google.com/permissions",
  );
  const res = await page.goto("/definitely-not-a-page");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(SHARED_COPY.notFound.title);
});

test("a server action replayed without Origin returns bad_origin and changes nothing", async ({ page, world, request }) => {
  const u = await world.user({ tone: "mirror" });
  const raw = await world.signIn(u);
  await page.goto("/setup#tone");
  await hydrated(page);
  // Capture the real tone-save action request, then let it through.
  const captured = page.waitForRequest((r) => r.method() === "POST" && Boolean(r.headers()["next-action"]));
  await page.locator("#tone").getByRole("radio", { name: /Casual/ }).check();
  await page.locator("#tone").getByRole("button", { name: "Save" }).click();
  const req = await captured;
  await expect.poll(async () => must(await sb().from("users").select("persona_prefs").eq("id", u).single(), "u").persona_prefs).toMatchObject({ tone: "casual" });

  // Replay with tone=polished but no Origin header.
  const headers: Record<string, string> = {
    "next-action": req.headers()["next-action"],
    "content-type": req.headers()["content-type"],
    accept: "text/x-component",
    cookie: `aria=${raw}`,
  };
  const body = (req.postDataBuffer() ?? Buffer.alloc(0)).toString("latin1").replace(/casual/g, "polished");
  const replay = await request.post("/setup", { headers, data: Buffer.from(body, "latin1"), maxRedirects: 0 });
  const text = await replay.text();
  expect(text).toContain("bad_origin");
  const after = must(await sb().from("users").select("persona_prefs").eq("id", u).single(), "u");
  expect(after.persona_prefs).toMatchObject({ tone: "casual" });
});
