/**
 * Dependency-free accessibility checks run in the page (no axe; web plan §2.8, §10 manual pass):
 * `lang`, one h1 + no skipped heading levels, names on every form control / button / link /
 * role=img, tap targets ≥ 44×44 (inline text links exempt, WCAG 2.5.8 inline exception), and text
 * contrast (4.5:1, 3:1 for large text) against the effective background. Returns problems as
 * strings so a failing test prints all of them at once.
 */
import type { Page } from "@playwright/test";

export interface AuditOptions {
  /** Skip the tap-target check (e.g. desktop, where 44px is advisory). */
  targets?: boolean;
  /** Skip the contrast check. */
  contrast?: boolean;
}

/**
 * Runs the audit on the current page.
 * @param page the page
 * @param opts which checks to run
 * @returns problems (empty when clean)
 */
export async function audit(page: Page, opts: AuditOptions = {}): Promise<string[]> {
  return page.evaluate(
    ({ targets, contrast }) => {
      const problems: string[] = [];
      const visible = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        // sr-only (clipped 1px boxes) still count as "present" for names, not for targets/contrast.
        return !el.closest("dialog:not([open])") && !el.closest("[hidden]");
      };
      const srOnly = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width <= 1 && r.height <= 1;
      };
      const short = (el: Element): string => {
        const id = el.id ? `#${el.id}` : "";
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `<${el.tagName.toLowerCase()}${id}> "${text}"`;
      };
      const nameOf = (el: Element): string => {
        const label = el.getAttribute("aria-label");
        if (label?.trim()) return label.trim();
        const by = el.getAttribute("aria-labelledby");
        if (by) {
          const t = by
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();
          if (t) return t;
        }
        const labels = (el as HTMLInputElement).labels;
        if (labels && labels.length > 0) {
          const t = Array.from(labels)
            .map((l) => l.textContent ?? "")
            .join(" ")
            .trim();
          if (t) return t;
        }
        if (el instanceof HTMLImageElement) return el.alt;
        return (el.textContent ?? "").trim() || el.getAttribute("title") || "";
      };

      // 1. lang
      if (document.documentElement.lang !== "en") problems.push(`html lang="${document.documentElement.lang}"`);

      // 2. headings
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(
        (h) => visible(h) || h.closest("dialog"),
      );
      const h1s = headings.filter((h) => h.tagName === "H1" && !h.closest("dialog"));
      if (h1s.length !== 1) problems.push(`expected 1 h1, found ${h1s.length}`);
      let prev = 0;
      for (const h of headings) {
        if (h.closest("dialog")) continue;
        const level = Number(h.tagName[1]);
        if (prev && level > prev + 1) problems.push(`heading jumps h${prev} → h${level}: ${short(h)}`);
        prev = level;
      }

      // 3. form controls, buttons, links, images
      for (const el of Array.from(document.querySelectorAll("input:not([type=hidden]),select,textarea"))) {
        if (!visible(el) && !el.closest("dialog")) continue;
        if (!nameOf(el)) problems.push(`unlabeled control ${short(el)}`);
      }
      for (const el of Array.from(document.querySelectorAll("button,a[href],summary,[role=button]"))) {
        if (!visible(el)) continue;
        if (!nameOf(el)) problems.push(`no accessible name ${short(el)}`);
      }
      for (const el of Array.from(document.querySelectorAll("img"))) {
        if (!el.hasAttribute("alt")) problems.push(`img without alt ${el.src}`);
      }
      for (const el of Array.from(document.querySelectorAll("[role=img]"))) {
        if (!nameOf(el)) problems.push(`role=img without a name ${short(el)}`);
      }

      // 4. tap targets
      if (targets) {
        for (const el of Array.from(document.querySelectorAll("button,a[href],select,input:not([type=hidden]),textarea,summary"))) {
          if (!visible(el) || srOnly(el)) continue;
          const cs = getComputedStyle(el);
          if (el.tagName === "A" && cs.display === "inline") continue; // inline text link
          let box = (el as HTMLElement).getBoundingClientRect();
          const input = el as HTMLInputElement;
          if (el.tagName === "INPUT" && (input.type === "radio" || input.type === "checkbox")) {
            const label = input.labels?.[0];
            if (label) box = label.getBoundingClientRect();
          }
          if (box.height < 43.5 || box.width < 43.5) {
            problems.push(`tap target ${Math.round(box.width)}×${Math.round(box.height)} ${short(el)}`);
          }
        }
      }

      // 5. contrast
      if (contrast) {
        const parse = (c: string): [number, number, number, number] | null => {
          const m = /rgba?\(([^)]+)\)/.exec(c);
          if (!m) return null;
          const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
          return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
        };
        const lum = ([r, g, b]: number[]): number => {
          const f = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const bgOf = (el: Element | null): [number, number, number] => {
          let layers: Array<[number, number, number, number]> = [];
          for (let e = el; e; e = e.parentElement) {
            const c = parse(getComputedStyle(e).backgroundColor);
            if (c && c[3] > 0) {
              layers.push(c);
              if (c[3] >= 1) break;
            }
          }
          if (layers.length === 0 || layers[layers.length - 1][3] < 1) {
            layers = [...layers, parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1]];
          }
          // Composite from the bottom layer up.
          let out: [number, number, number] = [layers[layers.length - 1][0], layers[layers.length - 1][1], layers[layers.length - 1][2]];
          for (let i = layers.length - 2; i >= 0; i--) {
            const [r, g, b, a] = layers[i];
            out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
          }
          return out;
        };
        const seen = new Set<Element>();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const txt = (n.textContent ?? "").trim();
          if (!txt) continue;
          // Emoji / pictographs render in their own colors; CSS color doesn't apply.
          if (/^[\p{Extended_Pictographic}\u200d\ufe0f\s]+$/u.test(txt)) continue;
          const el = n.parentElement;
          if (!el || seen.has(el)) continue;
          seen.add(el);
          if (!visible(el) || srOnly(el)) continue;
          if (el.closest("option,script,style,noscript")) continue;
          let faded = false;
          for (let e: Element | null = el; e; e = e.parentElement) {
            if (Number(getComputedStyle(e).opacity) < 1) faded = true;
          }
          if (faded || (el.closest("button") as HTMLButtonElement | null)?.disabled) continue;
          const cs = getComputedStyle(el);
          const fg = parse(cs.color);
          if (!fg) continue;
          const bg = bgOf(el);
          const fgc: [number, number, number] = [
            fg[0] * fg[3] + bg[0] * (1 - fg[3]),
            fg[1] * fg[3] + bg[1] * (1 - fg[3]),
            fg[2] * fg[3] + bg[2] * (1 - fg[3]),
          ];
          const l1 = lum(fgc);
          const l2 = lum(bg);
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          const size = parseFloat(cs.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
          const need = large ? 3 : 4.5;
          if (ratio < need) problems.push(`contrast ${ratio.toFixed(2)} < ${need} ${short(el)} (${cs.color} on rgb(${bg.map(Math.round).join(",")}))`);
        }
      }
      return problems;
    },
    { targets: opts.targets !== false, contrast: opts.contrast !== false },
  );
}

/**
 * Tabs through the first `n` focusable elements and reports any whose focus isn't visible
 * (no outline and no box-shadow), plus whether the first stop is the skip link.
 * @param page the page
 * @param n how many tab stops to check
 * @returns problems plus the first stop's text
 */
export async function focusAudit(page: Page, n = 8): Promise<{ problems: string[]; first: string }> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.click(1, 1).catch(() => undefined);
  const problems: string[] = [];
  let first = "";
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      // Next's dev-only overlay portal takes a tab stop in `next dev`; production has none.
      if (el.tagName.toLowerCase() === "nextjs-portal") return { skip: true } as const;
      const cs = getComputedStyle(el);
      const visibleRing = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
      return {
        text: (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().replace(/\s+/g, " ").slice(0, 40),
        tag: el.tagName.toLowerCase(),
        visibleRing,
        tabIndex: el.tabIndex,
      };
    });
    if (!info) break;
    if ("skip" in info) continue;
    if (!first) first = info.text;
    seen.push(info.text);
    if (!info.visibleRing) problems.push(`focus not visible on <${info.tag}> "${info.text}"`);
    if (info.tabIndex > 0) problems.push(`positive tabindex on <${info.tag}> "${info.text}"`);
  }
  return { problems, first };
}
