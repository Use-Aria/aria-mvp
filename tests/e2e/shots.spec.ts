/**
 * Review screenshots (web plan §10 "Screenshots"; master plan Wave 5 row 5.4): every page at
 * 375 / 393 / 430 / 1280 px in light, dark, and reduced motion, full page. Not pixel-diffed (font
 * rendering flakes); a human reads them. Phone widths use device emulation (CDP viewport + touch +
 * mobile UA), never a narrow window (headless Chrome's 500px window minimum would clip it).
 * Also asserts no horizontal scroll on every page × width × mode.
 *
 * Output: `test-results/shots/<width>-<mode>/<page>.png` (override with `E2E_SHOTS_DIR`). Playwright
 * empties `test-results/` at the start of every run, so run `npm run qa:shots` last.
 * Run: `npm run qa:shots` (project `shots`).
 */
import path from "node:path";
import { devices } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { PAGE_CASES, PAGE_TZ, openCase } from "./support/pages";

const OUT = process.env.E2E_SHOTS_DIR ?? path.join("test-results", "shots");
const WIDTHS = [375, 393, 430, 1280] as const;
const MODES = [
  { name: "light", colorScheme: "light", reducedMotion: "no-preference" },
  { name: "dark", colorScheme: "dark", reducedMotion: "no-preference" },
  { name: "reduced", colorScheme: "light", reducedMotion: "reduce" },
] as const;

test.describe.configure({ timeout: 600_000 });

for (const pc of PAGE_CASES) {
  test(`shots: ${pc.name}`, async ({ browser, world, baseURL }) => {
    const seeded: { value?: { userId: string; path: string } } = {};
    const overflow: string[] = [];
    for (const width of WIDTHS) {
      const phone = width < 1000;
      for (const mode of MODES) {
        const context = await browser.newContext({
          ...(phone ? devices["iPhone 15"] : devices["Desktop Chrome"]),
          baseURL,
          viewport: { width, height: phone ? 800 : 900 },
          deviceScaleFactor: phone ? 2 : 1,
          colorScheme: mode.colorScheme,
          reducedMotion: mode.reducedMotion,
          timezoneId: PAGE_TZ,
        });
        try {
          const page = await context.newPage();
          const target = await openCase(pc, world, context, PAGE_TZ, seeded);
          await page.goto(target, { waitUntil: "load" });
          await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 15_000 }).catch(() => undefined);
          // Next's dev-only overlay button isn't part of the product.
          await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
          // Let the landing hero finish playing (≈2s) and color transitions settle.
          await page.waitForTimeout(pc.name === "landing" && mode.reducedMotion !== "reduce" ? 2_600 : 400);
          const m = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
          }));
          if (m.scroll > m.client) overflow.push(`${width}-${mode.name}: scrollWidth ${m.scroll} > ${m.client}`);
          await page.screenshot({ path: path.join(OUT, `${width}-${mode.name}`, `${pc.name}.png`), fullPage: true });
        } finally {
          await context.close();
        }
      }
    }
    expect(overflow, overflow.join("\n")).toEqual([]);
  });
}
