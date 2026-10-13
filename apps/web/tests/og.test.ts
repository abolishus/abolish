// The link-preview renderer (src/og/): real PNGs of the right size for every
// variant, byte-identical for the same model, and no result on any surface
// of a poll whose results are sealed or not released.

import fc from "fast-check";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";

import { PALETTE, PreviewCard } from "../src/og/card.tsx";
import {
  checkPreview,
  type PollPreview,
  type PreviewFormat,
  PREVIEW_SIZE,
  shortCode,
} from "../src/og/model.ts";
import { pollPreview, previewVersion } from "../src/og/poll.ts";
import { renderPreview } from "../src/og/render.ts";
import { previewText } from "../src/og/text.ts";
import type { PollView } from "../src/poll.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const FORMATS: readonly PreviewFormat[] = ["landscape", "square"];
const SEAL = "1c8a56f03dbcedea6909b56ab69cbec253c423da046f482587a01f1ebec1614f";

const base = {
  seal: SEAL,
  host: "abolish.us",
  question: "Which one improvement should Riverside ask the city for next year?",
  askedBy: "Riverside Residents' Association",
  place: "Riverside",
  questionCount: 1,
  answers: 2418,
  closesAt: "2026-11-15T20:00:00.000Z",
} as const;

const LEAD = { sentence: "Better lighting on the river path leads, with 41%.", share: 0.41 };
const TIERS = [
  { name: "Verified residents", ballots: 40_112, share: 0.624, result: "62.4% yes" },
  { name: "Accounts", ballots: 52_118, share: 0.581, result: "58.1% yes" },
];

const VARIANTS: Record<string, PollPreview> = {
  live: {
    ...base,
    civic: false,
    results: { state: "live", lead: LEAD, releasedAt: "2026-11-07T12:00:00.000Z" },
  },
  sealed: { ...base, civic: false, results: { state: "sealed" } },
  closed: { ...base, questionCount: 3, civic: false, results: { state: "closed", lead: LEAD } },
  open: {
    ...base,
    question: undefined,
    askedBy: undefined,
    place: undefined,
    answers: undefined,
    civic: false,
    results: { state: "open" },
  },
  counting: { ...base, civic: false, results: { state: "counting" } },
  civic: { ...base, civic: true, kind: "Referendum", results: { state: "closed", tiers: TIERS } },
  "civic sealed": { ...base, civic: true, kind: "Referendum", results: { state: "sealed" } },
};

/** Width and height from a PNG's signature and IHDR chunk, or a failure. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(view.getUint32(8)).toBe(13);
  expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
  expect(new TextDecoder().decode(png.subarray(-8, -4))).toBe("IEND");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Every word the card would draw. */
const cardText = (model: PollPreview, format: PreviewFormat) =>
  renderToStaticMarkup(createElement(PreviewCard, { model, format }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'");

describe("renderPreview", () => {
  test.each(Object.keys(VARIANTS))("draws %s as PNGs of both sizes", async (name) => {
    for (const format of FORMATS) {
      const png = await renderPreview(VARIANTS[name]!, format);
      expect(pngSize(png)).toEqual(PREVIEW_SIZE[format]);
      // Chats fetch it on every unfurl (docs/design/sharing.md).
      expect(png.length).toBeLessThan(300_000);
    }
  });

  test("gives the same bytes for the same model, in a fresh module too", async () => {
    for (const format of FORMATS) {
      const first = await renderPreview(VARIANTS["live"]!, format);
      expect(await renderPreview(VARIANTS["live"]!, format)).toEqual(first);
      vi.resetModules();
      const fresh = (await import("../src/og/render.ts")) as typeof import("../src/og/render.ts");
      expect(await fresh.renderPreview(VARIANTS["live"]!, format)).toEqual(first);
    }
  });

  test("draws a question in a script its fonts lack without failing", async () => {
    const model = { ...VARIANTS["sealed"]!, question: "Ελληνικά, 中文 und Ümlaute 🎉?" };
    expect(pngSize(await renderPreview(model, "landscape"))).toEqual(PREVIEW_SIZE.landscape);
  });
});

describe("a poll without released results", () => {
  // Words only a released result puts on a card or in its description.
  const RESULT = /%|\bleads\b|came first|Final count|\byes\b|updated|Question 1 of/;

  const text = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => !RESULT.test(s));
  const unreleased = fc.record({
    seal: fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")),
    host: fc.constant("abolish.us"),
    question: fc.option(text, { nil: undefined }),
    askedBy: fc.option(text, { nil: undefined }),
    place: fc.option(text, { nil: undefined }),
    questionCount: fc.integer({ min: 1, max: 9 }),
    answers: fc.option(fc.nat(), { nil: undefined }),
    closesAt: fc.option(
      fc.integer({ min: 0, max: 4_102_444_800_000 }).map((ms) => new Date(ms).toISOString()),
      { nil: undefined },
    ),
    civic: fc.boolean(),
    kind: fc.constant("Referendum"),
    results: fc.constantFrom(
      { state: "sealed" } as const,
      { state: "open" } as const,
      { state: "counting" } as const,
    ),
  }) as fc.Arbitrary<PollPreview>;

  test("shows no result in the card or its text", () => {
    fc.assert(
      fc.property(unreleased, fc.constantFrom(...FORMATS), (model, format) => {
        expect(cardText(model, format)).not.toMatch(RESULT);
        const { title, description } = previewText(model);
        expect(`${title} ${description}`).not.toMatch(RESULT);
      }),
      { numRuns },
    );
  });

  test("says when results appear, and the count, while sealed", () => {
    const text = cardText(VARIANTS["sealed"]!, "landscape");
    expect(text).toContain("Results when it closes on 15 Nov");
    expect(text).toContain("2,418 answers so far");
    expect(previewText(VARIANTS["sealed"]!).description).toBe(
      "Asked by Riverside Residents' Association in Riverside. 2,418 answers so far. " +
        "Results are sealed until it closes on 15 Nov. Anyone can check the count.",
    );
  });

  test("can't carry a result: the types refuse one", () => {
    const sealed: PollPreview = {
      ...base,
      civic: false,
      // @ts-expect-error sealed results have no lead
      results: { state: "sealed", lead: LEAD },
    };
    const civic: PollPreview = {
      ...base,
      civic: true,
      kind: "Referendum",
      // @ts-expect-error sealed results have no tiers
      results: { state: "sealed", tiers: TIERS },
    };
    // @ts-expect-error results without a state's own shape
    const open: PollPreview = { ...base, civic: false, results: { state: "open", share: 0.5 } };
    expect([sealed, civic, open]).toHaveLength(3);
  });

  test.each([
    ["a lead", { state: "sealed", lead: LEAD }],
    ["tiers", { state: "sealed", tiers: TIERS }],
    ["a share", { state: "open", share: 0.4 }],
    ["an ordering", { state: "counting", order: ["a", "b"] }],
  ])("can't carry %s past the runtime check either", async (_, results) => {
    const model = { ...base, civic: false, results } as unknown as PollPreview;
    expect(() => checkPreview(model)).toThrow(TypeError);
    await expect(renderPreview(model, "landscape")).rejects.toThrow(TypeError);
  });
});

describe("shortCode", () => {
  test("is the definition hash's first 35 bits in Crockford base32", () => {
    expect(shortCode("0".repeat(64))).toBe("0000000");
    expect(shortCode("f".repeat(64))).toBe("zzzzzzz");
    const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const seal = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        const code = shortCode(seal);
        expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{7}$/);
        const bits = code
          .split("")
          .map((c) => alphabet.indexOf(c).toString(2).padStart(5, "0"))
          .join("");
        const prefix = Array.from(bytes.subarray(0, 5), (b) => b.toString(2).padStart(8, "0"))
          .join("")
          .slice(0, 35);
        expect(bits).toBe(prefix);
      }),
      { numRuns },
    );
  });
});

describe("a poll page's preview today", () => {
  const poll = {
    electionId: "ab".repeat(32),
    definitionHash: SEAL,
    closesAt: { seconds: "1794772800", iso: "2026-11-15T20:00:00.000Z" },
  } as PollView;
  const closes = Date.parse("2026-11-15T20:00:00.000Z");

  test("is open until it closes, then counting, and never a result", () => {
    expect(pollPreview(poll, "abolish.us", closes - 1).results).toEqual({ state: "open" });
    expect(pollPreview(poll, "abolish.us", closes).results).toEqual({ state: "counting" });
  });

  test("gets a new version when what it draws changes, and only then", async () => {
    const open = pollPreview(poll, "abolish.us", closes - 1);
    const version = await previewVersion(open, "landscape");
    expect(version).toMatch(/^[0-9a-f]{24}$/);
    expect(await previewVersion(pollPreview(poll, "abolish.us", 0), "landscape")).toBe(version);
    expect(await previewVersion(pollPreview(poll, "abolish.us", closes), "landscape")).not.toBe(
      version,
    );
    expect(await previewVersion(open, "square")).not.toBe(version);
    expect(await previewVersion({ ...VARIANTS["live"]!, answers: 2419 }, "landscape")).not.toBe(
      await previewVersion(VARIANTS["live"]!, "landscape"),
    );
  });
});

describe("the card's palette", () => {
  // oklch -> sRGB (Björn Ottosson's Oklab matrices), as packages/ui's contrast test.
  function oklchToHex(l: number, c: number, h: number): string {
    const a = c * Math.cos((h * Math.PI) / 180);
    const b = c * Math.sin((h * Math.PI) / 180);
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const linear = [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    ];
    return `#${linear
      .map((x) => Math.min(1, Math.max(0, x)))
      .map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))
      .map((x) =>
        Math.round(x * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  }

  test("is the light theme's tokens", () => {
    const css = readFileSync(
      new URL("../../../packages/ui/src/styles.css", import.meta.url),
      "utf8",
    );
    const start = css.indexOf(`[data-theme="light"] {`);
    const body = css.slice(start, css.indexOf("}", start));
    const token = (name: string) => {
      const m = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\);`).exec(body);
      if (m === null) throw new Error(`no --${name}`);
      return oklchToHex(Number(m[1]), Number(m[2]), Number(m[3]));
    };
    const near = (a: string, b: string) =>
      [1, 3, 5].every(
        (i) =>
          Math.abs(
            Number.parseInt(a.slice(i, i + 2), 16) - Number.parseInt(b.slice(i, i + 2), 16),
          ) <= 2,
      );
    for (const [key, name] of [
      ["background", "background"],
      ["foreground", "foreground"],
      ["mutedForeground", "muted-foreground"],
      ["muted", "muted"],
      ["border", "border"],
      ["primary", "primary"],
    ] as const)
      expect([name, near(PALETTE[key], token(name))]).toEqual([name, true]);
  });
});
