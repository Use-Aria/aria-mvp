/**
 * /week e2e (web plan §2.5, §10 "/week groups and toggles done", §12 /week checks): local-day
 * grouping around midnight in non-UTC zones, all-day items on their floating date (even with a
 * misleading stored anchor), exams before assignments, hostile titles escaped, unsafe URLs not
 * linked, "Still open", optimistic mark done + Undo (persists across reload), week navigation
 * (`?w=1`, invalid `w`), empty-day copy, and the empty / Canvas-failing / signed-out states.
 */
import { WEEK_COPY, SHARED_COPY } from "@/shared/copy";
import { localAt, localDay, must, sb, seedCanvas, seedTimeline, ymd } from "./support/db";
import { expect, expectNoHorizontalScroll, hydrated, test } from "./support/fixtures";

test.describe.configure({ timeout: 180_000 });

const HOSTILE = `<img src=x onerror="window.__xss=1">`;

for (const tz of ["Pacific/Honolulu", "Asia/Tokyo"]) {
  test.describe(`grouping in ${tz}`, () => {
    test.use({ timezoneId: tz });

    test("items land on the right local day; ordering, escaping, links, still open", async ({ page, world }) => {
      const u = await world.user({ name: "Dana", timezone: tz });
      await seedCanvas(u);
      const d2 = localDay(tz, 2);
      await seedTimeline(
        u,
        [
          { title: "Problem Set 4", dueAt: localAt(tz, 0, 23, 30), course: "CPSC 323" },
          { title: "Reading response", dueAt: localAt(tz, 1, 0, 15) },
          // All-day on day+2, stored with a UTC-midnight anchor that falls on another local day.
          { title: "Lab report", allDayDate: d2, dueAt: new Date(Date.UTC(d2.year, d2.month - 1, d2.day, 0, 0)) },
          { title: "Essay draft", dueAt: localAt(tz, 3, 9, 0) },
          { title: "Midterm", kind: "exam", dueAt: localAt(tz, 3, 9, 0) },
          { title: HOSTILE, dueAt: localAt(tz, 4, 17, 0), url: "javascript:alert(1)" },
          { title: "Quiz 3", dueAt: localAt(tz, 4, 18, 0), url: "https://yale.instructure.com/courses/1/assignments/2" },
          { title: "Late pset", dueAt: localAt(tz, -1, 17, 0) },
          { title: "Finished thing", dueAt: localAt(tz, 0, 12, 0), status: "done" },
          {
            title: "CPSC 323 lecture",
            kind: "class",
            source: "gcal",
            startsAt: localAt(tz, 1, 10, 30),
            endsAt: localAt(tz, 1, 11, 45),
          },
          { title: "Next week thing", dueAt: localAt(tz, 9, 12, 0) },
        ],
        tz,
      );
      await world.signIn(u);
      await page.goto("/week");
      await hydrated(page);

      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dana's week");
      const day = (n: number) => page.locator(`section[data-day="${ymd(localDay(tz, n))}"]`);
      await expect(day(0).getByRole("heading")).toHaveText("Today");
      await expect(day(1).getByRole("heading")).toHaveText("Tomorrow");
      await expect(day(0)).toContainText("Problem Set 4");
      await expect(day(0)).toContainText("Due 11:30 PM · CPSC 323");
      await expect(day(1)).toContainText("Reading response");
      await expect(day(1)).toContainText("Due 12:15 AM");
      await expect(day(0)).not.toContainText("Reading response");
      await expect(day(2)).toContainText("Lab report");
      await expect(day(2)).toContainText("Due (all day)");
      await expect(page.locator("section[data-day]").filter({ hasText: "Lab report" })).toHaveCount(1);
      await expect(day(1)).toContainText("10:30–11:45 AM · CPSC 323 lecture");

      // Exams before assignments at the same time.
      const titles = await day(3).locator("li[data-kind] p.font-semibold").allTextContents();
      expect(titles).toEqual(["Midterm", "Essay draft"]);
      await expect(day(3).getByRole("img")).toHaveAttribute("aria-label", "Heavy day: 2 things due");

      // Hostile title is text; no injected element; the javascript: URL isn't linked.
      await expect(day(4).getByText(HOSTILE, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.querySelectorAll('img[src="x"]').length)).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
      const openLinks = day(4).getByRole("link", { name: /Open in Canvas/ });
      await expect(openLinks).toHaveCount(1);
      await expect(openLinks).toHaveAttribute("href", "https://yale.instructure.com/courses/1/assignments/2");
      await expect(openLinks).toHaveAttribute("rel", "noopener noreferrer");
      await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);

      // Still open (yesterday, not done) sits on top with its day label.
      const stillOpen = page.locator("section", { has: page.getByRole("heading", { name: WEEK_COPY.stillOpen.title }) });
      await expect(stillOpen).toContainText("Late pset");
      await expect(stillOpen).toContainText(/Due 5:00 PM/);

      // Done items: struck through, with Undo.
      const finished = day(0).locator("li", { hasText: "Finished thing" });
      await expect(finished.getByRole("button", { name: WEEK_COPY.markNotDone("Finished thing"), exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(finished.getByRole("button", { name: `${WEEK_COPY.undo}: ${WEEK_COPY.markNotDone("Finished thing")}` })).toHaveText(WEEK_COPY.undo);

      // Days 5 and 6 are empty.
      await expect(day(5)).toContainText(WEEK_COPY.emptyDay);
      await expect(page.getByText("Next week thing")).toHaveCount(0);
      await expect(page.getByText(WEEK_COPY.noGoogle.text)).toBeVisible();
      await expectNoHorizontalScroll(page);

      // Next week → following 7 days.
      await page.getByRole("link", { name: WEEK_COPY.nextWeek }).click();
      await expect(page).toHaveURL(/\/week\?w=1$/);
      await expect(page.getByText(/^Following 7 days · /)).toBeVisible();
      await expect(page.getByText("Next week thing")).toBeVisible();
      await expect(page.getByText(WEEK_COPY.stillOpen.title)).toHaveCount(0);
      await page.getByRole("link", { name: WEEK_COPY.thisWeek }).click();
      await expect(page).toHaveURL(/\/week$/);
      await expect(page.getByText(/^Next 7 days · /)).toBeVisible();
    });
  });
}

test.describe("mark done", () => {
  test.use({ timezoneId: "America/New_York" });

  test("optimistic toggle persists across reload; Undo restores", async ({ page, world }) => {
    const tz = "America/New_York";
    const u = await world.user({ timezone: tz });
    await seedCanvas(u);
    const [id] = await seedTimeline(u, [{ title: "Econ pset", dueAt: localAt(tz, 1, 23, 59) }], tz);
    await world.signIn(u);
    await page.goto("/week");
    await hydrated(page);

    // Slow the action down so the optimistic state is observable before the server answers.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/week", async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.continue();
    });
    const toggle = page.getByRole("button", { name: WEEK_COPY.markDone("Econ pset") });
    await toggle.click();
    const undone = page.getByRole("button", { name: WEEK_COPY.markNotDone("Econ pset"), exact: true });
    await expect(undone).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
    await expect(page.getByText(`${WEEK_COPY.done} ·`)).toBeVisible();
    release();
    await expect
      .poll(async () => must(await sb().from("timeline_items").select("status").eq("id", id).single(), "item").status)
      .toBe("done");
    await page.unroute("**/week");

    await page.reload();
    await hydrated(page);
    await expect(page.getByRole("button", { name: WEEK_COPY.markNotDone("Econ pset"), exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /^Undo/ }).click();
    await expect(page.getByRole("button", { name: WEEK_COPY.markDone("Econ pset") })).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(async () => must(await sb().from("timeline_items").select("status").eq("id", id).single(), "item").status)
      .toBe("upcoming");
  });
});

test.describe("states", () => {
  test("no Canvas: invite to connect; invalid ?w falls back to this week", async ({ page, world }) => {
    const u = await world.user({ name: null });
    await world.signIn(u);
    await page.goto("/week?w=banana");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your week");
    await expect(page.getByText(/^Next 7 days · /)).toBeVisible();
    await expect(page.getByText(WEEK_COPY.emptyNoCanvas.title)).toBeVisible();
    await expect(page.getByRole("link", { name: WEEK_COPY.emptyNoCanvas.button })).toHaveAttribute("href", "/setup#canvas");
  });

  test("Canvas connected, nothing due: says so", async ({ page, world }) => {
    const u = await world.user();
    await seedCanvas(u);
    await world.signIn(u);
    await page.goto("/week");
    await expect(page.getByText(WEEK_COPY.emptyConnected.title)).toBeVisible();
    await expect(page.getByRole("img", { name: /Light week · 0 things due/ })).toBeVisible();
    await expect(page.locator("section[data-day]")).toHaveCount(7);
  });

  test("Canvas failing: banner with the fix link", async ({ page, world }) => {
    const u = await world.user();
    await seedCanvas(u, { failing: true });
    await world.signIn(u);
    await page.goto("/week");
    await expect(page.getByText(/^Aria couldn't read your Canvas feed since /)).toBeVisible();
    await expect(page.getByRole("link", { name: WEEK_COPY.syncFailingButton })).toHaveAttribute("href", "/setup#canvas");
  });

  test("signed out (and the PWA variant)", async ({ page }) => {
    await page.goto("/week");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(SHARED_COPY.signedOut["new link"].title);
    await page.goto("/week?src=pwa");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(SHARED_COPY.signedOut.pwa.title);
  });
});
