import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

// WCAG 2.2 contrast (1.4.3) computed from the oklch tokens in styles.css, so a
// palette change can't drop below AA unnoticed. axe checks rendered stories
// too, but only the pairs they show.

type Rgb = [number, number, number];

// oklch -> linear sRGB (Björn Ottosson's Oklab matrices), clamped to gamut.
function oklchToLinear(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function block(selector: string): Record<string, Rgb> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    Array.from(body.matchAll(/--([a-z-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\);/g), (m) => [
      m[1],
      oklchToLinear(Number(m[2]), Number(m[3]), Number(m[4])),
    ]),
  );
}

const light = block(`[data-theme="light"]`);
const dark = block(`[data-theme="dark"]`);
const systemDark = block(`:root:not([data-theme="light"]):not(.light)`);

// [text, ground]: every pairing a component renders.
const pairs: [string, string][] = [
  ["foreground", "background"],
  ["muted-foreground", "background"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["card-foreground", "card"],
  ["muted-foreground", "card"],
  ["accent-foreground", "accent"],
  ["recorded", "background"],
  ["pending", "background"],
];

describe("palette", () => {
  it("uses the same dark palette for the system preference and the explicit theme", () => {
    expect(systemDark).toEqual(dark);
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("every text colour reaches 4.5:1 on its ground in the %s theme", (_, theme) => {
    for (const [text, ground] of pairs) {
      const t = theme[text];
      const g = theme[ground];
      expect(t, text).toBeDefined();
      expect(g, ground).toBeDefined();
      expect(contrast(t as Rgb, g as Rgb), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("computes contrast as WCAG defines it", () => {
    expect(contrast(oklchToLinear(0, 0, 0), oklchToLinear(1, 0, 0))).toBeCloseTo(21, 2);
  });
});
