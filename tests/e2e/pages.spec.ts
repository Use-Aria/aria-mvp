/**
 * Layout + accessibility sweep over every page (web plan §10 "No horizontal scroll … on every page
 * and viewport", §2.8): runs in whichever device project is selected (iphone-se / iphone-15 /
 * pro-max / desktop). Per page: no horizontal scroll, the in-page audit (`support/audit.ts`) in
 * light and dark, keyboard focus visible on the first tab stops (skip link first on app pages),
 * and reduced motion honoured on the landing hero.
 */
import { audit, focusAudit } from "./support/audit";
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalScroll, test } from "./support/fixtures";
import { PAGE_CASES, PAGE_TZ, openCase } from "./support/pages";

test.describe.configure({ timeout: 180_000 });
test.use({ timezoneId: PAGE_TZ });

const APP_PAGES = /^(week|setup|settings|email)(?!-signed-out)/;

/**
 * Waits until the streamed page content has replaced the `(app)/loading.tsx` skeleton: every
 * audited page renders exactly one visible h1 inside `<main>`. Under `next dev` the "load" event
 * can fire before the RSC stream swaps the content in, so auditing straight away races it.
 * @param page the page
 * @returns once the content is in
 */
async function contentReady(page: Page): Promise<void> {
  await expect(page.locator("main h1")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status", { name: "Loading" })).toHaveCount(0, { timeout: 30_000 });
}

for (const pc of PAGE_CASES) {
  test(`${pc.name}: no horizontal scroll, a11y audit (light + dark), focus`, async ({ page, world, context }) => {
    const path = await openCase(pc, world, context, PAGE_TZ);
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(path, { waitUntil: "load" });
    await contentReady(page);
    await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 15_000 }).catch(() => undefined);
    await expectNoHorizontalScroll(page);
    const light = await audit(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(400); // let color transitions (≤150ms) settle
    const dark = (await audit(page, { targets: false })).map((p) => `[dark] ${p}`);
    await page.emulateMedia({ colorScheme: "light" });
    const focus = await focusAudit(page);
    const problems = [...light, ...dark, ...focus.problems];
    if (APP_PAGES.test(pc.name)) {
      expect(focus.first, "first tab stop").toBe("Skip to content");
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}

test("reduced motion: the hero thread renders statically", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const anims = await page.locator(".bubble-in").evaluateAll((els) =>
    els.map((e) => ({ name: getComputedStyle(e).animationName, opacity: getComputedStyle(e).opacity })),
  );
  expect(anims.length).toBeGreaterThan(0);
  for (const a of anims) expect(a).toEqual({ name: "none", opacity: "1" });
  const typing = await page.locator(".typing-flash").evaluateAll((els) => els.map((e) => getComputedStyle(e).display));
  for (const d of typing) expect(d).toBe("none");
});
