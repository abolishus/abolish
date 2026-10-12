import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

// WCAG 2.2 relative luminance and contrast ratio (1.4.3, 1.4.11), computed
// from the hex values in styles.css so a palette change can't drop below AA
// unnoticed. axe checks rendered stories too, but only the pairs they show.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    Array.from(body.matchAll(/--abolish-([a-z]+):\s*(#[0-9a-f]{6});/g), (m) => [m[1], m[2]]),
  );
}

const light = block(`[data-theme="light"]`);
const dark = block(`[data-theme="dark"]`);
const systemDark = block(`:root:not([data-theme="light"])`);
const names = ["paper", "ink", "pencil", "accent", "recorded", "pending"];

describe("palette", () => {
  it("defines every token in both themes", () => {
    expect(Object.keys(light).sort()).toEqual([...names].sort());
    expect(Object.keys(dark).sort()).toEqual([...names].sort());
  });

  it("uses the same dark palette for the system preference and the explicit theme", () => {
    expect(systemDark).toEqual(dark);
  });

  it("keeps the brief's starting palette in the light theme", () => {
    expect(light).toEqual({
      paper: "#f6f3ec",
      ink: "#1b1a17",
      pencil: "#5a5650",
      accent: "#5b4b8a",
      recorded: "#2f6b5e",
      pending: "#8a5a12",
    });
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("every text colour reaches 4.5:1 on the %s ground", (_, theme) => {
    for (const name of names.filter((n) => n !== "paper")) {
      expect(contrast(theme[name] ?? "", theme["paper"] ?? ""), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)("ground-coloured text reaches 4.5:1 on the accent in the %s theme", (_, theme) => {
    // The primary button sets paper on accent.
    expect(contrast(theme["paper"] ?? "", theme["accent"] ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("computes contrast as WCAG defines it", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
