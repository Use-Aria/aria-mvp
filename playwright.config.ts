/**
 * Playwright config (web plan §5, §10). Runs against installed Google Chrome
 * (`channel: "chrome"`), so no browser download is needed.
 *
 * - Device projects (`iphone-se`, `iphone-15`, `pro-max`, `desktop`) run `tests/e2e/**`
 *   against `E2E_BASE_URL` (default http://localhost:3000; start `npm run dev` first).
 * - `shots` writes review screenshots (`npm run qa:shots`).
 * - `assets` renders icons + OG cards (`npm run assets`, macOS only).
 */
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type Project = NonNullable<PlaywrightTestConfig["projects"]>[number];

/** Mobile emulation in Chromium (CDP): viewport + DPR + touch + iOS UA, no 500px window minimum. */
function phone(name: string, width: number, height: number, deviceScaleFactor: number): Project {
  return {
    name,
    testDir: "tests/e2e",
    testIgnore: /shots\.spec\.ts$/,
    use: {
      ...devices["iPhone 15"],
      browserName: "chromium",
      channel: "chrome",
      viewport: { width, height },
      deviceScaleFactor,
    },
  };
}

export default defineConfig({
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL, channel: "chrome", trace: "retain-on-failure" },
  projects: [
    phone("iphone-se", 375, 667, 2),
    phone("iphone-15", 393, 852, 3),
    phone("pro-max", 430, 932, 3),
    {
      name: "desktop",
      testDir: "tests/e2e",
      testIgnore: /shots\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1280, height: 800 } },
    },
    {
      name: "shots",
      testDir: "tests/e2e",
      testMatch: /shots\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "assets",
      testDir: "scripts/assets",
      testMatch: /render\.spec\.ts$/,
      timeout: 120_000,
      use: { ...devices["Desktop Chrome"], channel: "chrome", baseURL: undefined },
    },
  ],
});
