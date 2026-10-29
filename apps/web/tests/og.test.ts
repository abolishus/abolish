// The link-preview renderer (src/og/): real PNGs of the right size for every
// variant, byte-identical for the same model, and no result on any surface
// of a poll whose results are sealed or not released.

import fc from "fast-check";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import satori from "satori";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { shortCode } from "@abolishus/core/short-codes";

import { DEFAULT_LOCALE, LOCALES } from "../src/locales.ts";
import { loadCatalog } from "../src/messages.ts";
import { PALETTE, PreviewCard } from "../src/og/card.tsx";
import {
  checkPreview,
  type PollPreview,
  type PreviewFormat,
  PREVIEW_SIZE,
  shortLink,
} from "../src/og/model.ts";
import { leadOf, pollPreview, previewLocale, previewPath, previewVersion } from "../src/og/poll.ts";
import { DRAWABLE, drawable } from "../src/og/glyphs.ts";
import { isolated } from "../src/titles.ts";
import { FONTS, renderPreview } from "../src/og/render.ts";
import { previewText } from "../src/og/text.ts";
import type { PollView } from "../src/poll.ts";
import type { PollResults } from "../src/results.ts";
import { fromHex } from "../src/values.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// A card draws in its model's locale, whose catalog a page has loaded.
beforeAll(() => Promise.all(LOCALES.map(loadCatalog)));
const FORMATS: readonly PreviewFormat[] = ["landscape", "square"];
const SEAL = "1c8a56f03dbcedea6909b56ab69cbec253c423da046f482587a01f1ebec1614f";
const CODE = shortCode(fromHex(SEAL));

const base = {
  locale: "en-US",
  seal: SEAL,
  code: CODE,
  host: "abolish.us",
  question: "Which one improvement should Riverside ask the city for next year?",
  askedBy: "Riverside Residents' Association",
  place: "Riverside",
  questionCount: 1,
  answers: 2418,
  closesAt: "2026-11-15T20:00:00.000Z",
} as const;

const LEAD = {
  leaders: "Better lighting on the river path",
  tied: false,
  text: "Most picked: \u2068Better lighting on the river path\u2069, by 41% of those who answered.",
  share: 0.41,
};
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
  "by tier": { ...base, answers: undefined, civic: false, results: { state: "by-tier" } },
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
    // Rendering in a fresh module reloads the fonts: well past the default
    // timeout on a loaded CI runner.
  }, 30_000);

  test("draws a question in a script its fonts lack without failing", async () => {
    const model = { ...VARIANTS["sealed"]!, question: "Ελληνικά, 中文 und Ümlaute 🎉?" };
    expect(pngSize(await renderPreview(model, "landscape"))).toEqual(PREVIEW_SIZE.landscape);
  });
});

// P2-24 part 6: an author's words go on the image only when its fonts draw
// every character, never with boxes in place of the letters they lack; the
// text beside the image, which a chat draws in its own fonts, keeps them.
describe("an author's words on the image", () => {
  const isDrawn = (c: number) => DRAWABLE.some(([first, last]) => c >= first && c <= last);

  test("every drawable character is a glyph of both weights the card draws in", async () => {
    // As the card sets it (src/og/card.tsx): Oxanium, the Latin Extended
    // subset reached only as satori's fallback.
    const svg = (text: string, weight: 400 | 600) =>
      satori(
        createElement(
          "div",
          { style: { display: "flex", fontFamily: "Oxanium", fontSize: 40, fontWeight: weight } },
          text,
        ),
        { width: 400, height: 80, fonts: FONTS },
      );
    for (const weight of [400, 600] as const) {
      // A private-use character no font has: the box drawn for any missing glyph.
      const missing = await svg("x\u{E000}x", weight);
      // So the comparison can't pass vacuously: a letter both subsets lack is
      // that box, and two letters alone are not.
      expect(await svg("x\u0108x", weight)).toBe(missing);
      expect(await svg("xx", weight)).not.toBe(missing);
      for (const [first, last] of DRAWABLE)
        for (let c = first; c <= last; c++)
          expect(
            await svg(`x${String.fromCodePoint(c)}x`, weight),
            `U+${c.toString(16)} at ${weight}`,
          ).not.toBe(missing);
    }
  }, 60_000);

  test("takes text whole, composed, only when every character is drawable", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (text) => {
        const drawn = drawable(text);
        const composed = text.normalize("NFC");
        const every = Array.from(composed).every((c) => isDrawn(c.codePointAt(0) ?? -1));
        expect(drawn).toBe(every && composed.trim() !== "" ? composed : undefined);
      }),
      { numRuns },
    );
    expect(drawable("Cafe\u0301 on Ma\u0301ster Street?")).toBe("Café on Máster Street?");
    expect(drawable("Ā or ā, ł, ő, ș and ẞ?")).toBe("Ā or ā, ł, ő, ș and ẞ?");
    for (const text of [
      "Ελληνικά?",
      "中文",
      "مرحبا",
      "Yes 🎉",
      "a\u202Eb",
      "a\u200Bb",
      "x\u0336",
      " ",
      "",
    ])
      expect(drawable(text)).toBeUndefined();
  });

  test("the card draws a drawable question, and names the poll by its code otherwise", () => {
    const sealed = VARIANTS["sealed"]!;
    expect(cardText(sealed, "landscape")).toContain(base.question);
    for (const question of ["Ελληνικά, 中文 und Ümlaute 🎉?", "Should the park ⁦stay⁩ open?"]) {
      const model = { ...sealed, question };
      for (const format of FORMATS) {
        const drawn = cardText(model, format);
        expect(drawn).toContain(`Poll ${CODE}`);
        expect(drawn).not.toContain("Ümlaute");
        expect(drawn).not.toContain("park");
      }
      // A chat draws the text beside the image in its own fonts.
      expect(previewText(model).title).toBe(question);
    }
    expect(cardText({ ...sealed, question: "Cafe\u0301?" }, "landscape")).toContain("Café?");
    const civic = { ...VARIANTS["civic sealed"]!, question: "中文?" };
    expect(cardText(civic, "landscape")).toContain(`Poll ${CODE}`);
  });

  test("the byline drops a name or place the card can't draw, keeping the rest", () => {
    const sealed = VARIANTS["sealed"]!;
    expect(cardText(sealed, "landscape")).toContain(
      "Asked by Riverside Residents' Association · Riverside",
    );
    const text = cardText({ ...sealed, askedBy: "Ассоциация", place: "Москва" }, "landscape");
    expect(text).toContain("Asked on abolish.us");
    expect(text).not.toContain("·");
    expect(cardText({ ...sealed, place: "東京" }, "landscape")).toContain(
      "Asked by Riverside Residents' Association ",
    );
    expect(cardText({ ...sealed, place: "東京" }, "landscape")).not.toContain("東京");
  });

  test("a title isolates an author's words, dropping any control that could end the isolate early", () => {
    const controls = /[\u202a-\u202e\u2066-\u2069]/u;
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (text) => {
        const out = isolated(text);
        expect(out.startsWith("\u2068") && out.endsWith("\u2069")).toBe(true);
        expect(controls.test(out.slice(1, -1))).toBe(false);
        expect(out.slice(1, -1)).toBe(text.replace(new RegExp(controls, "gu"), ""));
      }),
      { numRuns },
    );
    expect(isolated("Q\u2069\u202e")).toBe("\u2068Q\u2069");
  });

  test("draws a question in Latin Extended letters as a PNG", async () => {
    const model = { ...VARIANTS["sealed"]!, question: "Czy Łódź i Kraków mają ścieżki?" };
    expect(pngSize(await renderPreview(model, "landscape"))).toEqual(PREVIEW_SIZE.landscape);
  });
});

describe("a poll without released results", () => {
  // Words only a released result puts on a card or in its description.
  const RESULT =
    /%|\bleads\b|came first|Final count|\byes\b|updated|Question 1 of|Conteo final|\bsí\b|actualizado|Pregunta 1 de/;

  const text = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => !RESULT.test(s));
  const unreleased = fc
    .record({
      locale: fc.constantFrom(...LOCALES),
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
        // Everyday only: a civic card has a row per tier.
        { state: "by-tier" } as const,
      ),
      // A code of the seal, of any length a poll can get, or none.
      codeLength: fc.option(fc.integer({ min: 7, max: 52 }), { nil: undefined }),
    })
    .map(({ codeLength, ...model }) => ({
      ...model,
      civic: model.civic && model.results.state !== "by-tier",
      code: codeLength === undefined ? undefined : shortCode(fromHex(model.seal), codeLength),
    })) as fc.Arbitrary<PollPreview>;

  test("shows no result in the card or its text", () => {
    fc.assert(
      fc.property(unreleased, fc.constantFrom(...FORMATS), (model, format) => {
        expect(cardText(model, format)).not.toMatch(RESULT);
        const { title, description } = previewText(model);
        expect(`${title} ${description}`).not.toMatch(RESULT);
      }),
      { numRuns },
    );
    // CI's FC_NUM_RUNS (1000) of card text takes about 2 s locally and passed
    // the 5 s default on a CI runner.
  }, 30_000);

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
    ["a lead by tier", { state: "by-tier", lead: LEAD }],
  ])("can't carry %s past the runtime check either", async (_, results) => {
    const model = { ...base, civic: false, results } as unknown as PollPreview;
    expect(() => checkPreview(model)).toThrow(TypeError);
    await expect(renderPreview(model, "landscape")).rejects.toThrow(TypeError);
  });
});

describe("the short code", () => {
  test("is printed as the link and headline only when the model has one", () => {
    const open = VARIANTS["open"]!;
    expect(shortLink(open)).toBe(`abolish.us/p/${CODE}`);
    expect(previewText(open).title).toBe(`Poll ${CODE}`);
    expect(cardText(open, "landscape")).toContain(`abolish.us/p/${CODE}`);
    const uncoded = { ...open, code: undefined };
    expect(shortLink(uncoded)).toBe("abolish.us");
    expect(previewText(uncoded).title).toBe("A poll on abolish.us");
    expect(cardText(uncoded, "landscape")).not.toContain("/p/");
  });

  test("a collided poll's longer code is printed whole", () => {
    const longer = shortCode(fromHex(SEAL), 9);
    expect(shortLink({ ...base, code: longer })).toBe(`abolish.us/p/${longer}`);
    expect(() => checkPreview({ ...VARIANTS["open"]!, code: longer })).not.toThrow();
  });

  test("must be a prefix of the seal", async () => {
    const nine = shortCode(fromHex(SEAL), 9);
    const last = nine.endsWith("z") ? "y" : "z";
    for (const code of [
      CODE.startsWith("z") ? `y${CODE.slice(1)}` : `z${CODE.slice(1)}`,
      `${nine.slice(0, -1)}${last}`,
    ]) {
      const model = { ...VARIANTS["open"]!, code };
      expect(() => checkPreview(model)).toThrow(RangeError);
      await expect(renderPreview(model, "landscape")).rejects.toThrow(RangeError);
    }
  });
});

// The second language (P2-28 part 4c-2): a preview's words are its model's
// locale's, and its image's address names that locale, so a chat that
// fetches it with no headers of the reader's still gets that language.
describe("a preview in Spanish", () => {
  const es = (model: PollPreview): PollPreview => ({ ...model, locale: "es-US" });

  test("draws the card's and the text's words from the Spanish catalog", () => {
    const sealed = es(VARIANTS["sealed"]!);
    const text = cardText(sealed, "landscape");
    expect(text).toContain("Resultados cuando cierre el 15 nov");
    expect(text).toContain("2,418 respuestas hasta ahora");
    expect(text).toContain("Pregunta de Riverside Residents' Association · Riverside");
    expect(text).not.toMatch(/Results|answers|Asked/);
    expect(previewText(sealed).description).toBe(
      "Pregunta de Riverside Residents' Association en Riverside. 2,418 respuestas hasta ahora. " +
        "Los resultados quedan sellados hasta que cierre el 15 nov. Cualquiera puede comprobar el conteo.",
    );
    const open = es(VARIANTS["open"]!);
    expect(previewText(open)).toEqual({
      title: `Encuesta ${CODE}`,
      description: "Abierta hasta que cierre el 15 nov. Cualquiera puede comprobar el conteo.",
    });
    expect(previewText({ ...open, code: undefined }).title).toBe("Una encuesta en abolish.us");
    const civic = cardText(es(VARIANTS["civic"]!), "square");
    expect(civic).toContain("Registro cívico · Referendum");
    expect(civic).toContain("Cualquiera puede volver a contarlo");
    expect(civic).not.toMatch(/Civic record|recount/);
  });

  test("words a single answer and a single question as one", () => {
    const one = es({ ...VARIANTS["sealed"]!, answers: 1 });
    expect(cardText(one, "landscape")).toContain("1 respuesta hasta ahora.");
    expect(cardText({ ...VARIANTS["sealed"]!, answers: 1 }, "landscape")).toContain(
      "1 answer so far.",
    );
  });

  test("renders as PNGs of both sizes", async () => {
    for (const format of FORMATS)
      expect(pngSize(await renderPreview(es(VARIANTS["live"]!), format))).toEqual(
        PREVIEW_SIZE[format],
      );
  });

  test("refuses a model in no locale of ours", () => {
    for (const locale of ["fr-FR", "es", "en-us", ""])
      expect(() =>
        checkPreview({ ...VARIANTS["open"]!, locale } as unknown as PollPreview),
      ).toThrow(RangeError);
  });

  test("names its language in the image's address, and the default's address is unchanged", () => {
    const id = "ab".repeat(32);
    expect(previewPath(id, "landscape", DEFAULT_LOCALE)).toBe(`/polls/${id}/preview.png`);
    expect(previewPath(id, "square", DEFAULT_LOCALE, "v1")).toBe(
      `/polls/${id}/preview.png?format=square&v=v1`,
    );
    expect(previewPath(id, "landscape", "es-US", "v1")).toBe(
      `/polls/${id}/preview.png?lang=es-US&v=v1`,
    );
    // Every address a path names reads back as its locale.
    for (const locale of LOCALES) {
      const url = new URL(previewPath(id, "square", locale), "https://abolish.us");
      expect(previewLocale(url.searchParams.get("lang"))).toBe(locale);
    }
  });

  test("an image's lang is exactly one of our other locales, or none", () => {
    expect(previewLocale(null)).toBe(DEFAULT_LOCALE);
    expect(previewLocale("es-US")).toBe("es-US");
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constantFrom("en-US", "es", "es-us", "ES-US", " es-US", "")),
        (lang) => {
          fc.pre(lang !== "es-US");
          expect(previewLocale(lang)).toBeUndefined();
        },
      ),
      { numRuns },
    );
  });
});

describe("a poll page's preview today", () => {
  const poll: PollView = {
    electionId: "ab".repeat(32),
    version: 1,
    definitionHash: SEAL,
    illFormed: undefined,
    counting: "plurality",
    questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
    electorate: [{ tier: 0, groupSize: "5000" }],
    threshold: 4,
    panelSize: 7,
    opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
    closesAt: { seconds: "1794772800", iso: "2026-11-15T20:00:00.000Z" },
  };
  const closes = Date.parse("2026-11-15T20:00:00.000Z");

  test("is open until it closes, then counting, and never a result", () => {
    expect(pollPreview(poll, CODE, "abolish.us", closes - 1, "en-US").results).toEqual({
      state: "open",
    });
    expect(pollPreview(poll, CODE, "abolish.us", closes, "en-US").results).toEqual({
      state: "counting",
    });
  });

  // P2-24 part 4: the result card.
  const read = (
    ...tiers: { tier: 0 | 1 | 2; counted: number; questions?: string[][] | undefined }[]
  ) =>
    ({
      kind: "read",
      tiers: tiers.map((t) => ({ questions: undefined, ...t })),
    }) as PollResults;
  const COUNTED = read({ tier: 0, counted: 12, questions: [["6", "3", "1"]] });
  const LABELS = { question: "Should the park stay open late?", place: undefined };
  const OPTIONS = { ...LABELS, options: ["Yes", "No", "Only in summer"] };
  const results = fc.oneof(
    fc.constantFrom<PollResults>(
      { kind: "unopened" },
      { kind: "not-counted" },
      { kind: "not-ready" },
      { kind: "unavailable" },
    ),
    fc
      .array(
        fc.record({
          tier: fc.constantFrom(0 as const, 1 as const, 2 as const),
          counted: fc.nat({ max: 1000 }),
          questions: fc.option(
            fc.array(fc.array(fc.nat({ max: 1000 }).map(String), { minLength: 1, maxLength: 5 }), {
              minLength: 1,
              maxLength: 3,
            }),
            { nil: undefined },
          ),
        }),
        { maxLength: 3 },
      )
      .map((tiers) => read(...tiers)),
  );

  test("shows nothing of any result before it closes, whatever the API answers", () => {
    fc.assert(
      fc.property(results, fc.integer({ min: 0, max: closes - 1 }), (served, now) => {
        const model = pollPreview(poll, CODE, "abolish.us", now, "en-US", OPTIONS, served);
        expect(model.results).toEqual({ state: "open" });
        expect(model.answers).toBeUndefined();
      }),
      { numRuns },
    );
  });

  test("once closed, gives the first question's final lead from its one tier's count", () => {
    const model = pollPreview(poll, CODE, "abolish.us", closes, "en-US", OPTIONS, COUNTED);
    expect(model.answers).toBe(12);
    expect(model.results).toEqual({
      state: "closed",
      lead: {
        leaders: "Yes",
        tied: false,
        text: "Most picked: \u2068Yes\u2069, by 50% of those who answered.",
        share: 0.5,
      },
    });
    const card = cardText(model, "landscape");
    expect(card).toMatch(/Most picked\s+Yes\s+50%/);
    expect(card).toContain("Final count · 12 answers counted");
    expect(card).toContain("Closed 15 Nov");
    expect(previewText(model).description).toBe(
      "Closed on 15 Nov. Most picked: \u2068Yes\u2069, by 50% of those who answered. " +
        "Anyone can check the count.",
    );
    // A version-5 poll's lead is its first question's, never a sum of its questions (T-16).
    const several = pollPreview(
      { ...poll, version: 5, questions: [poll.questions[0]!, poll.questions[0]!] },
      CODE,
      "abolish.us",
      closes,
      "en-US",
      OPTIONS,
      read({
        tier: 0,
        counted: 8,
        questions: [
          ["1", "7", "0"],
          ["8", "0", "0"],
        ],
      }),
    );
    expect(several.results).toMatchObject({ lead: { leaders: "No", share: 0.875 } });
    expect(cardText(several, "landscape")).toMatch(/Question 1 of 2 · Most picked\s+No\s+87\.5%/);
  });

  test("says the lead in the page's language", () => {
    const model = pollPreview(poll, CODE, "abolish.us", closes, "es-US", OPTIONS, COUNTED);
    expect(model.results).toMatchObject({
      lead: { text: "La más elegida: \u2068Yes\u2069, por el 50% de quienes respondieron." },
    });
    const card = cardText(model, "landscape");
    expect(card).toMatch(/La más elegida\s+Yes\s+50\s?%/);
    expect(card).toContain("Conteo final");
  });

  test("names an option by number where it has no words, or the image can't draw them", () => {
    // A hidden poll's text is withheld; its result never is (docs/moderation-policy.md).
    expect(leadOf(["1", "3", "0"], 4, "en-US", undefined)).toEqual({
      leaders: "Answer 2",
      tied: false,
      text: "Most picked: Answer 2, by 75% of those who answered.",
      share: 0.75,
    });
    expect(leadOf(["3", "1"], 4, "en-US", ["Ναι", "Όχι"])).toEqual({
      leaders: "Answer 1",
      tied: false,
      text: "Most picked: \u2068Ναι\u2069, by 75% of those who answered.",
      share: 0.75,
    });
  });

  test("says a tie as one, and a count where nothing was picked", () => {
    const tie = leadOf(["2", "2", "1"], 5, "en-US", ["Yes", "No", "Maybe"]);
    expect(tie).toMatchObject({ leaders: "Yes and No", tied: true, share: 0.4 });
    expect(tie.text).toBe(
      "Tied for most picked: \u2068Yes\u2069 and \u2068No\u2069, each by 40% of those who answered.",
    );
    const none = leadOf(["0", "0"], 3, "en-US", ["Yes", "No"]);
    expect(none).toEqual({
      leaders: undefined,
      tied: false,
      text: "No answer was picked.",
      share: 0,
    });
    const card = cardText(
      { ...base, civic: false, results: { state: "closed", lead: none } },
      "square",
    );
    expect(card).toContain("No answer was picked.");
    expect(card).not.toMatch(/%|Most picked/);
    expect(leadOf(["0", "0"], 0, "en-US", ["Yes", "No"]).share).toBe(0);
  });

  test("leads with the leader's share of those who answered, as the page does", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 10_000 }), { minLength: 1, maxLength: 8 }),
        fc.nat({ max: 10_000 }),
        (picks, extra) => {
          const counted = Math.max(...picks) + extra;
          const lead = leadOf(picks.map(String), counted, "en-US", undefined);
          const top = Math.max(...picks);
          expect(lead.share).toBeCloseTo(top === 0 ? 0 : top / counted, 5);
          expect(lead.tied).toBe(top > 0 && picks.filter((p) => p === top).length > 1);
          expect(lead.leaders === undefined).toBe(top === 0);
        },
      ),
      { numRuns },
    );
  });

  test("shows no lead across tiers, and none until a count is published", () => {
    const at = (served: PollResults) =>
      pollPreview(poll, CODE, "abolish.us", closes, "en-US", OPTIONS, served);
    const tiers = read(
      { tier: 0, counted: 12, questions: [["6", "3", "1"]] },
      { tier: 2, counted: 2 },
    );
    expect(at(tiers).results).toEqual({ state: "by-tier" });
    expect(at(tiers).answers).toBeUndefined();
    expect(previewText(at(tiers)).description).toBe(
      "Closed on 15 Nov. Each tier is counted on its own. Anyone can check the count.",
    );
    expect(at(read({ tier: 0, counted: 1 }, { tier: 2, counted: 2 })).results).toEqual({
      state: "counting",
    });
    for (const served of [
      { kind: "unopened" },
      { kind: "not-counted" },
      { kind: "not-ready" },
      { kind: "unavailable" },
      read(),
      read({ tier: 0, counted: 12 }),
    ] as PollResults[]) {
      expect(at(served).results).toEqual({ state: "counting" });
      expect(at(served).answers).toBeUndefined();
    }
    expect(pollPreview(poll, CODE, "abolish.us", closes, "en-US").results).toEqual({
      state: "counting",
    });
  });

  test("draws a closed poll's lead as a PNG, a long one too", async () => {
    const long = { ...OPTIONS, options: ["A".repeat(200), "No", "Maybe"] };
    for (const words of [OPTIONS, long])
      for (const format of FORMATS) {
        const model = pollPreview(poll, CODE, "abolish.us", closes, "en-US", words, COUNTED);
        expect(pngSize(await renderPreview(model, format))).toEqual(PREVIEW_SIZE[format]);
      }
  });

  test("gets a new version once its count is published", async () => {
    const counting = pollPreview(poll, CODE, "abolish.us", closes, "en-US", OPTIONS);
    const counted = pollPreview(poll, CODE, "abolish.us", closes, "en-US", OPTIONS, COUNTED);
    expect(await previewVersion(counted, "landscape")).not.toBe(
      await previewVersion(counting, "landscape"),
    );
  });

  test("counts a version-5 poll's questions, and draws one for a poll with none", () => {
    const q = poll.questions[0]!; // the fixture has one
    expect(pollPreview(poll, CODE, "abolish.us", 0, "en-US").questionCount).toBe(1);
    expect(
      pollPreview({ ...poll, questions: [q, q, q] }, CODE, "abolish.us", 0, "en-US").questionCount,
    ).toBe(3);
    // An ill-formed definition (`questions`) still gets a card the model accepts.
    const none = pollPreview({ ...poll, questions: [] }, CODE, "abolish.us", 0, "en-US");
    expect(none.questionCount).toBe(1);
    expect(() => checkPreview(none)).not.toThrow();
  });

  test("shows the words the page checked, and only those", () => {
    const words = { question: "Should the park stay open late?", place: "Riverside" };
    const shown = pollPreview(poll, CODE, "abolish.us", 0, "en-US", words);
    expect(shown.question).toBe(words.question);
    expect(shown.place).toBe(words.place);
    expect(shown.askedBy).toBeUndefined();
    expect(previewText(shown).title).toBe(words.question);
    const none = pollPreview(poll, CODE, "abolish.us", 0, "en-US");
    expect(none.question).toBeUndefined();
    expect(none.place).toBeUndefined();
    expect(previewText(none).title).toBe(`Poll ${CODE}`);
  });

  test("gets a new version when what it draws changes, and only then", async () => {
    const open = pollPreview(poll, CODE, "abolish.us", closes - 1, "en-US");
    const version = await previewVersion(open, "landscape");
    expect(version).toMatch(/^[0-9a-f]{24}$/);
    expect(
      await previewVersion(pollPreview(poll, CODE, "abolish.us", 0, "en-US"), "landscape"),
    ).toBe(version);
    expect(
      await previewVersion(pollPreview(poll, CODE, "abolish.us", closes, "en-US"), "landscape"),
    ).not.toBe(version);
    expect(await previewVersion(open, "square")).not.toBe(version);
    // A registration recorded, or a longer code, is a new image.
    expect(
      await previewVersion(
        pollPreview(poll, undefined, "abolish.us", closes - 1, "en-US"),
        "landscape",
      ),
    ).not.toBe(version);
    // So is another language.
    expect(
      await previewVersion(pollPreview(poll, CODE, "abolish.us", closes - 1, "es-US"), "landscape"),
    ).not.toBe(version);
    // So are the poll's words, once they can be shown.
    expect(
      await previewVersion(
        pollPreview(poll, CODE, "abolish.us", closes - 1, "en-US", {
          question: "Should the park stay open late?",
          place: undefined,
        }),
        "landscape",
      ),
    ).not.toBe(version);
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
