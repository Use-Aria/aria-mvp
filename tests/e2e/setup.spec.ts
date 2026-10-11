/**
 * /setup e2e (web plan §10 flows, §2.3 freshness, §9.2 copy; orchestrator notes W3 3.5/3.6, W4 4.4/4.5):
 * schedule + quiet hours (overlap warning, unchanged re-save), time-zone mismatch, tone, Canvas
 * (guide host, client + server URL errors, fresh-link notice, connected/failing/disconnect),
 * Google (GET `<a>` connect, `Sec-Fetch-Site` → 403, every `?google=` banner + strip, capabilities,
 * disconnect), and the syllabus upload (PDF, not-a-PDF, replace=1) against the local parser.
 */
import { createHash } from "node:crypto";
import { makePdf, SYNTHETIC_SYLLABUS } from "../unit/syllabus/fixtures";
import { GOOGLE_STATUS_COPY, SETUP_COPY, SHARED_COPY, CANVAS_ERROR_COPY } from "@/shared/copy";
import { ALL_GOOGLE_SCOPES, must, sb, seedCanvas, seedGoogle } from "./support/db";
import { expect, expectNoHorizontalScroll, hydrated, test } from "./support/fixtures";

test.describe.configure({ timeout: 180_000 });

test.describe("schedule + tone", () => {
  test.use({ timezoneId: "America/New_York" });

  test("briefing inside quiet hours warns; save persists; unchanged re-save is a no-op", async ({ page, world }) => {
    const u = await world.user({ briefingTime: "09:00", quietStart: "22:00", quietEnd: "08:00" });
    await world.signIn(u, { scope: "view", ageMinutes: 120 }); // schedule needs only `any`
    await page.goto("/setup");
    await hydrated(page);
    await expect(page.getByText(SETUP_COPY.briefing.timeZone("Eastern Time"))).toBeVisible();
    await expect(page.getByText(SETUP_COPY.briefing.timeZoneMismatch("Eastern Time"))).toHaveCount(0);

    const briefing = page.getByLabel(SETUP_COPY.briefing.label);
    await expect(briefing).toHaveValue("09:00");
    await expect(page.getByText(/inside quiet hours/)).toHaveCount(0);
    await briefing.selectOption("07:00");
    await expect(page.getByText(SETUP_COPY.quiet.overlap("8:00 AM"))).toBeVisible();
    // Moving quiet hours to end at 6 AM clears the warning; back to 8 AM shows it again.
    await page.getByLabel(SETUP_COPY.quiet.until).selectOption("06:00");
    await expect(page.getByText(/inside quiet hours/)).toHaveCount(0);
    await page.getByLabel(SETUP_COPY.quiet.until).selectOption("08:00");

    const quiet = page.locator("#quiet");
    await quiet.getByRole("button", { name: SETUP_COPY.save.idle }).click();
    await expect(quiet.getByRole("status").filter({ hasText: SETUP_COPY.save.done })).toBeVisible();
    await expect
      .poll(async () => must(await sb().from("users").select("briefing_time, briefing_enabled, quiet_end").eq("id", u).single(), "u"))
      .toEqual({ briefing_time: "07:00:00", briefing_enabled: true, quiet_end: "08:00:00" });

    // Unchanged re-save: still "Saved.", no new jobs (the schedule hook is skipped).
    const jobsBefore = (await sb().from("jobs").select("id", { count: "exact", head: true }).eq("user_id", u)).count ?? 0;
    await page.reload();
    await hydrated(page);
    await expect(page.getByLabel(SETUP_COPY.briefing.label)).toHaveValue("07:00");
    await page.locator("#quiet").getByRole("button", { name: SETUP_COPY.save.idle }).click();
    await expect(page.locator("#quiet").getByRole("status").filter({ hasText: SETUP_COPY.save.done })).toBeVisible();
    const jobsAfter = (await sb().from("jobs").select("id", { count: "exact", head: true }).eq("user_id", u)).count ?? 0;
    expect(jobsAfter).toBe(jobsBefore);

    // Briefing off.
    await page.getByLabel(SETUP_COPY.briefing.label).selectOption("off");
    await page.locator("#quiet").getByRole("button", { name: SETUP_COPY.save.idle }).click();
    await expect
      .poll(async () => must(await sb().from("users").select("briefing_enabled").eq("id", u).single(), "u").briefing_enabled)
      .toBe(false);
    await expectNoHorizontalScroll(page);
  });

  test("tone saves and keeps other persona keys", async ({ page, world }) => {
    const u = await world.user({ tone: "mirror" });
    await world.signIn(u);
    await page.goto("/setup#tone");
    await hydrated(page);
    const tone = page.locator("#tone");
    await expect(tone.getByRole("radio", { name: /Match me/ })).toBeChecked();
    await tone.getByRole("radio", { name: /Polished/ }).check();
    await tone.getByRole("button", { name: SETUP_COPY.save.idle }).click();
    await expect(tone.getByRole("status").filter({ hasText: SETUP_COPY.save.done })).toBeVisible();
    const row = must(await sb().from("users").select("persona_prefs").eq("id", u).single(), "u");
    expect(row.persona_prefs).toMatchObject({ tone: "polished", e2e: true });
  });
});

test.describe("time-zone mismatch", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("browser zone differs → 'Use Pacific Time' switches users.timezone", async ({ page, world }) => {
    const u = await world.user({ timezone: "America/New_York" });
    await world.signIn(u);
    await page.goto("/setup");
    await hydrated(page);
    await expect(page.getByText(SETUP_COPY.briefing.timeZoneMismatch("Pacific Time"))).toBeVisible();
    await page.getByRole("button", { name: SETUP_COPY.briefing.useTimeZone("Pacific Time") }).click();
    await expect
      .poll(async () => must(await sb().from("users").select("timezone, timezone_source").eq("id", u).single(), "u"))
      .toEqual({ timezone: "America/Los_Angeles", timezone_source: "user" });
    await expect(page.getByText(SETUP_COPY.briefing.timeZone("Pacific Time"))).toBeVisible();
    await expect(page.getByText(SETUP_COPY.briefing.timeZoneMismatch("Pacific Time"))).toHaveCount(0);
  });
});

test.describe("canvas", () => {
  test("view session: guide + fresh-link notice, no connect form", async ({ page, world }) => {
    const u = await world.user({ school: "Yale University" });
    await world.signIn(u, { scope: "view" });
    await page.goto("/setup");
    const canvas = page.locator("#canvas");
    await expect(canvas.getByText(SHARED_COPY.freshLinkNeeded)).toBeVisible();
    await expect(canvas.getByRole("button", { name: SETUP_COPY.canvas.connect })).toHaveCount(0);
    await expect(canvas.getByRole("link", { name: SETUP_COPY.canvas.step1Link("yale.instructure.com") })).toHaveAttribute(
      "href",
      "https://yale.instructure.com/calendar",
    );
    // Google: no connect link either.
    await expect(page.locator(`#google a[href="/api/google/oauth"]`)).toHaveCount(0);
  });

  test("fresh session: school picker, client + server URL errors keep the pasted value", async ({ page, world }) => {
    const u = await world.user({ school: null });
    await world.signIn(u, { scope: "setup" });
    await page.goto("/setup");
    await hydrated(page);
    const canvas = page.locator("#canvas");
    await expect(page.getByText(/You can connect accounts until/)).toBeVisible();

    const school = canvas.getByLabel(SETUP_COPY.canvas.schoolLabel);
    await school.selectOption("Yale University");
    await expect(canvas.getByRole("link", { name: SETUP_COPY.canvas.step1Link("yale.instructure.com") })).toBeVisible();
    await school.selectOption({ label: SETUP_COPY.canvas.schoolUnlisted });
    await canvas.getByLabel(SETUP_COPY.canvas.customHostLabel).fill("canvas.example.edu");
    await expect(canvas.getByRole("link", { name: SETUP_COPY.canvas.step1Link("canvas.example.edu") })).toHaveAttribute(
      "href",
      "https://canvas.example.edu/calendar",
    );

    const url = canvas.getByLabel(SETUP_COPY.canvas.pasteLabel);
    const connect = canvas.getByRole("button", { name: SETUP_COPY.canvas.connect });

    // Empty submit → client pre-check.
    await connect.click();
    await expect(canvas.getByRole("alert")).toHaveText(CANVAS_ERROR_COPY.empty);
    await expect(url).toBeFocused();

    // Not a URL (on blur).
    await url.fill("hello there");
    await url.blur();
    await expect(canvas.getByRole("alert")).toHaveText(CANVAS_ERROR_COPY.not_a_url);
    await expect(url).toHaveAttribute("aria-invalid", "true");
    const describedBy = (await url.getAttribute("aria-describedby")) ?? "";
    expect(describedBy).toContain("-error");

    // A Canvas page, not the feed.
    await url.fill("https://yale.instructure.com/calendar");
    await connect.click();
    await expect(canvas.getByRole("alert")).toHaveText(CANVAS_ERROR_COPY.not_ical);

    // An IP literal is refused by the client pre-check with the server's copy for it.
    await url.fill("https://127.0.0.1/feeds/calendars/user_1.ics");
    await connect.click();
    await expect(canvas.getByRole("alert")).toHaveText(CANVAS_ERROR_COPY.private_address);

    // A one-course feed gets the specific course_feed copy (on blur, before submit).
    await url.fill("https://yale.instructure.com/feeds/calendars/course_abc.ics");
    await url.blur();
    await expect(canvas.getByRole("alert")).toHaveText(CANVAS_ERROR_COPY.course_feed);

    // Server-side refusal without contacting any Canvas: a name that doesn't resolve.
    const secretish = "https://e2e.localhost/feeds/calendars/user_e2eAbc123e2eAbc123e2eAbc123e2eAbc123.ics";
    await url.fill(secretish);
    await expect(canvas.getByRole("alert")).toHaveCount(0); // typing clears the old error
    await connect.click();
    const alert = canvas.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 30_000 });
    const text = (await alert.textContent()) ?? "";
    expect([CANVAS_ERROR_COPY.unreachable, CANVAS_ERROR_COPY.private_address, CANVAS_ERROR_COPY.not_canvas]).toContain(text);
    await expect(url).toHaveValue(secretish);
    // Nothing saved; the URL is never echoed into the page by the server.
    const integ = await sb().from("integrations").select("id").eq("user_id", u);
    expect(integ.data ?? []).toHaveLength(0);
    // The value lives only in the input's client state; no rendered text echoes it.
    expect(await page.locator("body").innerText()).not.toContain("e2eAbc123e2eAbc123");
  });

  test("connected + healthy: status, use a different link, disconnect via dialog", async ({ page, world }) => {
    const u = await world.user({ school: "Yale University" });
    await seedCanvas(u);
    await world.signIn(u, { scope: "setup" });
    await page.goto("/setup");
    await hydrated(page);
    const canvas = page.locator("#canvas");
    await expect(canvas.getByText(SETUP_COPY.canvas.connected, { exact: true })).toBeVisible();
    await expect(canvas.getByText(/Connected to yale\.instructure\.com · Last checked/)).toBeVisible();
    await expect(canvas.getByLabel(SETUP_COPY.canvas.pasteLabel)).toHaveCount(0);
    await canvas.getByRole("button", { name: SETUP_COPY.canvas.useDifferent }).click();
    await expect(canvas.getByLabel(SETUP_COPY.canvas.pasteLabel)).toBeVisible();
    await canvas.getByRole("button", { name: "Keep the current link" }).click();

    await canvas.getByRole("button", { name: SETUP_COPY.canvas.disconnect }).click();
    const dialog = page.getByRole("dialog", { name: SETUP_COPY.canvas.disconnectConfirm.title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: SETUP_COPY.canvas.disconnectConfirm.cancel }).click();
    await expect(dialog).toBeHidden();
    await canvas.getByRole("button", { name: SETUP_COPY.canvas.disconnect }).click();
    await dialog.getByRole("button", { name: SETUP_COPY.canvas.disconnectConfirm.confirm }).click();
    await expect(canvas.getByText(/Canvas disconnected/)).toBeVisible();
    await expect.poll(async () => (await sb().from("integrations").select("id").eq("user_id", u)).data?.length ?? -1).toBe(0);
    await expect(canvas.getByText(SETUP_COPY.canvas.notConnected, { exact: true })).toBeVisible();
  });

  test("connected + failing: warning copy and the paste form", async ({ page, world }) => {
    const u = await world.user({ school: "Yale University" });
    await seedCanvas(u, { failing: true });
    await world.signIn(u, { scope: "setup" });
    await page.goto("/setup");
    const canvas = page.locator("#canvas");
    await expect(canvas.getByText(/Aria couldn't read your Canvas feed since/)).toBeVisible();
    await expect(canvas.getByText(CANVAS_ERROR_COPY.feed_not_found)).toBeVisible();
    await expect(canvas.getByLabel(SETUP_COPY.canvas.pasteLabel)).toBeVisible();
  });
});

test.describe("google", () => {
  test("connect is a plain GET <a>; fresh session redirects to Google (intercepted)", async ({ page, world }) => {
    const u = await world.user();
    await world.signIn(u, { scope: "setup" });
    await page.goto("/setup");
    await hydrated(page);
    const google = page.locator("#google");
    const link = google.getByRole("link", { name: SETUP_COPY.google.connect });
    await expect(link).toHaveAttribute("href", "/api/google/oauth");
    // Disclosure + warning render before the button.
    const order = await google.evaluate((el) => {
      const t = el.textContent ?? "";
      return [t.indexOf("What Aria reads"), t.indexOf("Google will show a warning"), t.indexOf("Connect Google")];
    });
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[2]);
    expect(order[1]).toBeLessThan(order[2]);
    await expect(google.getByText(/Safari 16\.4 or newer/)).toBeVisible();

    let googleUrl: URL | null = null;
    await page.route("https://accounts.google.com/**", async (route) => {
      googleUrl = new URL(route.request().url());
      await route.abort();
    });
    await link.click();
    await expect.poll(() => googleUrl?.hostname ?? page.url(), { timeout: 20_000 }).toMatch(/accounts\.google\.com|google=/);
    if (googleUrl) {
      const g = googleUrl as URL;
      expect(g.pathname).toBe("/o/oauth2/v2/auth");
      expect(g.searchParams.get("scope") ?? "").toContain("gmail.send");
      expect(g.searchParams.get("state")).toBeTruthy();
    } else {
      // GOOGLE_CLIENT_ID unset on this dev server: the start route falls back to ?google=error.
      expect(page.url()).toContain("/setup");
    }
  });

  test("start route: missing / cross-site Sec-Fetch-Site → 403; stale session → ?google=stale", async ({ page, world, request }) => {
    expect((await request.get("/api/google/oauth", { maxRedirects: 0 })).status()).toBe(403);
    for (const site of ["cross-site", "same-site"]) {
      const r = await request.get("/api/google/oauth", { maxRedirects: 0, headers: { "sec-fetch-site": site } });
      expect(r.status(), site).toBe(403);
    }
    const u = await world.user();
    await world.signIn(u, { scope: "view" });
    await page.goto("/api/google/oauth"); // typed navigation: Sec-Fetch-Site: none
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.locator("#google").getByText(GOOGLE_STATUS_COPY.stale.text)).toBeVisible();
  });

  test("every ?google= code shows its banner once and is stripped from the URL", async ({ page, world }) => {
    test.setTimeout(240_000);
    const u = await world.user();
    await world.signIn(u, { scope: "setup" });
    const notConnected: Array<[string, string]> = [
      ["denied", GOOGLE_STATUS_COPY.denied.text],
      ["admin_blocked", GOOGLE_STATUS_COPY.admin_blocked.text],
      ["stale", GOOGLE_STATUS_COPY.stale.text],
      ["expired", GOOGLE_STATUS_COPY.expired.text],
      ["account_in_use", GOOGLE_STATUS_COPY.account_in_use.text],
      ["error", GOOGLE_STATUS_COPY.error.text],
      // `connected` with no row is treated as an error; `missing_scopes` with no row = nothing granted.
      ["connected", GOOGLE_STATUS_COPY.error.text],
      ["missing_scopes", "Google didn't give Aria access to anything"],
    ];
    for (const [code, text] of notConnected) {
      await page.goto(`/setup?google=${code}`);
      await hydrated(page);
      const banner = page.locator("#google").getByText(text);
      await expect(banner, code).toBeVisible();
      await expect(page, code).toHaveURL(/\/setup$/);
      await page.reload();
      await expect(page.locator("#google").getByText(text), `${code} after reload`).toHaveCount(0);
    }
    // Unknown / hostile codes render nothing (never echoed).
    await page.goto("/setup?google=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    await expect(page.locator("#google [role=status], #google [role=alert]")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("<script>");
  });

  test("connected with missing scopes: precise banner, capability list, reconnect + disconnect", async ({ page, world }) => {
    const u = await world.user();
    const partial = ALL_GOOGLE_SCOPES.filter((s) => !s.endsWith("gmail.send") && !s.endsWith("calendar.app.created"));
    await seedGoogle(u, { email: "dana.e2e@example.com", scopes: partial });
    await world.signIn(u, { scope: "setup" });
    await page.goto("/setup?google=missing_scopes");
    await hydrated(page);
    const google = page.locator("#google");
    await expect(
      google.getByText(GOOGLE_STATUS_COPY.missing_scopes.text.replace("{missing}", "send email for you or add study blocks")),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/setup$/);
    await expect(google.getByText(SETUP_COPY.google.connectedAs("dana.e2e@example.com"))).toBeVisible();
    await expect(google.getByRole("listitem").filter({ hasText: "send emails you approve" })).toContainText("(not allowed)");
    await expect(google.getByRole("listitem").filter({ hasText: "read your inbox" })).toContainText("(allowed)");
    await expect(google.getByRole("link", { name: SETUP_COPY.google.connect })).toBeVisible();

    await google.getByRole("button", { name: SETUP_COPY.google.disconnect }).click();
    const dialog = page.getByRole("dialog", { name: SETUP_COPY.google.disconnectConfirm.title });
    await dialog.getByRole("button", { name: SETUP_COPY.google.disconnectConfirm.confirm }).click();
    await expect(google.getByText(SETUP_COPY.google.notConnected, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await sb().from("integrations").select("id").eq("user_id", u)).data?.length ?? -1).toBe(0);
  });

  test("connected with every scope: ?google=connected and ?google=missing_scopes both say connected", async ({ page, world }) => {
    const u = await world.user();
    await seedGoogle(u, { email: "dana.all@example.com" });
    await world.signIn(u, { scope: "setup" });
    for (const code of ["connected", "missing_scopes"]) {
      await page.goto(`/setup?google=${code}`);
      await expect(page.locator("#google").getByText("Google connected as dana.all@example.com.")).toBeVisible();
    }
    await expect(page.locator("#google").getByRole("link", { name: SETUP_COPY.google.connect })).toHaveCount(0);
  });
});

test.describe("syllabus upload", () => {
  test("PDF parses via the local parser; same course again offers Replace (replace=1); not-a-PDF refused", async ({ page, world }) => {
    test.setTimeout(240_000);
    const u = await world.user();
    await world.signIn(u);
    await page.goto("/setup#syllabus");
    await hydrated(page);
    const syl = page.locator("#syllabus");
    const upload = syl.getByRole("button", { name: "Upload syllabus" });

    await upload.click();
    await expect(syl.getByRole("alert")).toHaveText("Pick a PDF file first.");

    await syl.getByLabel("Syllabus PDF").setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("hello, not a pdf") });
    await upload.click();
    await expect(syl.getByText("That isn't a PDF. Export the syllabus as a PDF and try again.")).toBeVisible();

    await syl.getByLabel("Syllabus PDF").setInputFiles({ name: "hist101.pdf", mimeType: "application/pdf", buffer: makePdf(SYNTHETIC_SYLLABUS) });
    await syl.getByLabel("Which class? (optional)").fill("HIST 101");
    await upload.click();
    await expect(syl.getByText(/Aria is reading your syllabus/)).toBeVisible();
    const first = syl.locator("[role=status], [role=alert]").filter({ hasNotText: /Aria is reading/ }).last();
    await expect(first).toBeVisible({ timeout: 180_000 });
    await expect.poll(async () => (await sb().from("syllabi").select("id").eq("user_id", u)).data?.length ?? 0, { timeout: 30_000 }).toBe(1);

    // Same course, different bytes → "exists" with Replace.
    const v2 = makePdf([...SYNTHETIC_SYLLABUS, ["Revised Oct 1."]]);
    await syl.getByLabel("Syllabus PDF").setInputFiles({ name: "hist101-v2.pdf", mimeType: "application/pdf", buffer: v2 });
    await syl.getByLabel("Which class? (optional)").fill("HIST 101");
    await upload.click();
    const replace = syl.getByRole("button", { name: "Replace it" });
    await expect(replace).toBeVisible({ timeout: 180_000 });
    await replace.click();
    await expect(replace).toBeHidden({ timeout: 180_000 });
    // replace=1 swapped the saved syllabus for the v2 bytes (still one row for the course).
    const v2sha = createHash("sha256").update(v2).digest("hex");
    await expect
      .poll(async () => (await sb().from("syllabi").select("pdf_sha256").eq("user_id", u)).data ?? [], { timeout: 30_000 })
      .toEqual([{ pdf_sha256: v2sha }]);
  });
});
