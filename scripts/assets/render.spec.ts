/**
 * Renders the committed brand assets (web plan §2.4, §7.2). Not part of CI or the build:
 * run `npm run assets` on macOS after changing icon.html or og.html, then commit the output.
 * Uses installed Google Chrome (`channel: "chrome"`), Google Fonts (network), and `sips`
 * (macOS) for PNG → JPEG.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const ROOT = path.resolve(__dirname, "..", "..");
const ICON_HTML = pathToFileURL(path.join(__dirname, "icon.html")).href;
const OG_HTML = pathToFileURL(path.join(__dirname, "og.html")).href;

type IconVariant = "rounded" | "full" | "maskable" | "favicon";

const ICONS: { out: string; size: number; variant: IconVariant }[] = [
  { out: "src/app/icon.png", size: 32, variant: "favicon" },
  { out: "src/app/apple-icon.png", size: 180, variant: "full" },
  { out: "public/icons/icon-192.png", size: 192, variant: "rounded" },
  { out: "public/icons/icon-512.png", size: 512, variant: "rounded" },
  { out: "public/icons/icon-maskable-512.png", size: 512, variant: "maskable" },
];

const OG_KINDS = ["landing", "week", "setup", "email", "settings", "default"] as const;

test.describe.configure({ mode: "serial" });

test("app icons", async ({ page }) => {
  await page.goto(ICON_HTML);
  for (const icon of ICONS) {
    const dataUrl = await page.evaluate(
      ({ size, variant }) =>
        (window as unknown as { renderIcon: (o: { size: number; variant: string }) => Promise<string> }).renderIcon({
          size,
          variant,
        }),
      icon,
    );
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    const file = path.join(ROOT, icon.out);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
  }
});

test("open graph cards", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 630 });
  const tmp = path.join(ROOT, "test-results", "og-png");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(path.join(ROOT, "public", "og"), { recursive: true });
  for (const kind of OG_KINDS) {
    await page.goto(`${OG_HTML}?k=${kind}`);
    await page.evaluate(() => (window as unknown as { cardReady: Promise<boolean> }).cardReady);
    const png = path.join(tmp, `${kind}.png`);
    await page.screenshot({ path: png, clip: { x: 0, y: 0, width: 1200, height: 630 } });
    const jpg = path.join(ROOT, "public", "og", `${kind}.jpg`);
    rmSync(jpg, { force: true });
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "82", png, "--out", jpg], {
      stdio: "ignore",
    });
  }
});
