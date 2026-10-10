/**
 * Committed brand assets (web plan §10 assets.test): OG JPEGs are 1200×630 and < 300 KB,
 * icons are their exact sizes, and the manifest has the fields installs need.
 * Header parsing only (no image deps).
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import manifest from "@/app/manifest";
import { ogImageFor } from "@/server/security/link-policy";

const ROOT = path.resolve(__dirname, "..", "..");

/** Width/height from a JPEG's SOF0/SOF1/SOF2 marker. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  expect(buf.readUInt16BE(0)).toBe(0xffd8);
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error("bad JPEG marker");
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error("no SOF marker");
}

/** Width/height from a PNG's IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("OG images", () => {
  for (const kind of ["landing", "week", "setup", "email", "settings", "default"]) {
    it(`${kind} is a 1200×630 JPEG under 300 KB`, () => {
      const file = path.join(ROOT, "public", ogImageFor(kind));
      expect(statSync(file).size).toBeLessThan(300 * 1024);
      expect(jpegSize(readFileSync(file))).toEqual({ width: 1200, height: 630 });
    });
  }
});

describe("icons", () => {
  const cases: [string, number][] = [
    ["src/app/icon.png", 32],
    ["src/app/apple-icon.png", 180],
    ["public/icons/icon-192.png", 192],
    ["public/icons/icon-512.png", 512],
    ["public/icons/icon-maskable-512.png", 512],
  ];
  for (const [rel, size] of cases) {
    it(`${rel} is ${size}×${size}`, () => {
      expect(pngSize(readFileSync(path.join(ROOT, rel)))).toEqual({ width: size, height: size });
    });
  }
});

describe("manifest", () => {
  it("has the install fields and existing icons", () => {
    const m = manifest();
    expect(m).toMatchObject({
      id: "aria",
      name: "Aria",
      short_name: "Aria",
      start_url: "/week?src=pwa",
      scope: "/",
      display: "standalone",
      background_color: "#f2f4ef",
      theme_color: "#f2f4ef",
    });
    const icons = m.icons ?? [];
    expect(icons.map((i) => `${i.sizes}:${i.purpose}`)).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
    for (const icon of icons) {
      const [w] = (icon.sizes ?? "").split("x").map(Number);
      expect(pngSize(readFileSync(path.join(ROOT, "public", icon.src))).width).toBe(w);
    }
  });
});
