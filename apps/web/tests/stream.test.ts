// The stream's cards (src/stream.ts): a poll's words reach a card only when
// its display text passes the ballot client's checks against the definition
// beside it (T-34, T-41), in the translation the page's locale picks.

import { readFileSync } from "node:fs";

import {
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { pickTranslation, streamCard } from "../src/stream.ts";
import { ballotBase, ballotLink, fromHex, toHex } from "../src/values.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

// The published cross-language vectors (docs/spec/vectors), never values
// computed by the code under test.
const load = <V>(name: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8"),
    ) as { vectors: V[] }
  ).vectors;
const find = <V extends { id: string }>(vectors: V[], id: string): V => {
  const v = vectors.find((x) => x.id === id);
  if (v === undefined) throw new Error(`vector ${id} missing`);
  return v;
};

interface TextVector {
  id: string;
  encoding: string;
  commitment?: string;
}
const textV1 = find(load<TextVector>("display-text.json"), "display-text-two-languages");
const textV2 = find(load<TextVector>("display-text-v2.json"), "display-text-v2-two-questions");
const minimalV2 = find(load<TextVector>("display-text-v2.json"), "display-text-v2-minimal");
const definitionV1 = find(
  load<{ id: string; encoding: string }>("election-definition.json"),
  "definition-typical",
);
const definitionV5 = find(
  load<{ id: string; encoding: string }>("election-definition-v5.json"),
  "definition-v5-typical",
);

const ID = "a1".repeat(32);

/** The typical version-1 definition under `ID`, committed to the two-language text's three options. */
const pollV1 = toHex(
  encodeElectionDefinition({
    ...decodeElectionDefinition(fromHex(definitionV1.encoding)),
    election_id: fromHex(ID),
    option_count: 3,
    max_selections: 1,
    display_text_commitment: fromHex(textV1.commitment!),
  }),
);

/** The typical version-5 definition under `ID`, with the two-question text's questions. */
function pollV5(commitment: string, optionCounts: readonly number[]): string {
  const typical = decodeElectionDefinitionV5(fromHex(definitionV5.encoding));
  const first = typical.questions[0]!;
  return toHex(
    encodeElectionDefinitionV5({
      ...typical,
      election_id: fromHex(ID),
      questions: optionCounts.map((option_count) => ({
        ...first,
        option_count,
        min_selections: 0,
        max_selections: 1,
      })),
      display_text_commitment: fromHex(commitment),
    }),
  );
}

describe("streamCard", () => {
  test("shows a version-5 poll's title in the locale's language", () => {
    const card = streamCard(ID, pollV5(textV2.commitment!, [3, 2]), textV2.encoding, "en-US");
    if (card.kind !== "poll") throw new Error(`refused: ${card.problem}`);
    expect(card.text).toEqual({
      language: "en",
      heading: "Park and library",
      question: undefined,
    });
    expect(card.poll.questions).toHaveLength(2);
    // Another locale gets its own translation, by primary language.
    const spanish = streamCard(ID, pollV5(textV2.commitment!, [3, 2]), textV2.encoding, "es-MX");
    expect(spanish.kind === "poll" && spanish.text.language).toBe("es-419");
  });

  test("a version-1 poll's heading is its one question", () => {
    const card = streamCard(ID, pollV1, textV1.encoding, "en-US");
    if (card.kind !== "poll") throw new Error(`refused: ${card.problem}`);
    expect(card.text).toEqual({
      language: "en",
      heading: "Should the park stay open late?",
      question: undefined,
    });
  });

  test("refuses text the definition doesn't commit to, showing none of it (T-41)", () => {
    // The two-question text beside a definition committed to other bytes.
    const other = pollV5(minimalV2.commitment!, [3, 2]);
    expect(streamCard(ID, other, textV2.encoding, "en-US")).toEqual({
      kind: "unavailable",
      electionId: ID,
      problem: "text",
    });
    // The right commitment, but the definition's questions have other option counts.
    expect(streamCard(ID, pollV5(textV2.commitment!, [3, 3]), textV2.encoding, "en-US")).toEqual({
      kind: "unavailable",
      electionId: ID,
      problem: "text",
    });
    // A version-1 text beside a version-5 definition.
    expect(streamCard(ID, pollV5(textV1.commitment!, [3]), textV1.encoding, "en-US").kind).toBe(
      "unavailable",
    );
  });

  test("a card with no text served, or text that isn't hex, has no words", () => {
    for (const text of [undefined, "zz", "0"])
      expect(streamCard(ID, pollV1, text, "en-US")).toEqual({
        kind: "unavailable",
        electionId: ID,
        problem: "text",
      });
  });

  test("refuses a definition as the poll page does (T-34)", () => {
    expect(streamCard("b2".repeat(32), pollV1, textV1.encoding, "en-US")).toEqual({
      kind: "unavailable",
      electionId: "b2".repeat(32),
      problem: "another-election",
    });
    expect(streamCard(ID, "00", textV1.encoding, "en-US")).toMatchObject({
      problem: "undecodable",
    });
  });

  test("refuses any change to the text's bytes", () => {
    const definition = pollV5(textV2.commitment!, [3, 2]);
    const bytes = fromHex(textV2.encoding);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: bytes.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = bytes.slice();
          changed[at]! ^= flip;
          expect(streamCard(ID, definition, toHex(changed), "en-US").kind).toBe("unavailable");
        },
      ),
      runs,
    );
  });
});

describe("pickTranslation", () => {
  const tags = (...languages: string[]) => languages.map((language) => ({ language }));

  test("takes the exact tag, then the primary language, then the first", () => {
    expect(pickTranslation(tags("en", "en-us", "es"), "en-US").language).toBe("en-us");
    expect(pickTranslation(tags("de", "en-gb"), "en-US").language).toBe("en-gb");
    expect(pickTranslation(tags("de", "fr"), "en-US").language).toBe("de");
  });

  test("always returns one of the record's own translations", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("en", "en-gb", "es", "es-419", "fr", "de"), { minLength: 1 }),
        fc.constantFrom("en-US", "es-MX", "fr", "ja"),
        (languages, locale) => {
          const translations = tags(...languages);
          expect(translations).toContain(pickTranslation(translations, locale));
        },
      ),
      runs,
    );
    expect(() => pickTranslation([], "en-US")).toThrow(RangeError);
  });
});

describe("ballot links", () => {
  test("accept an https address and put the poll in the fragment (T-10, T-11)", () => {
    expect(ballotBase("https://abolish.ch")).toBe("https://abolish.ch/");
    expect(ballotBase("https://abolish.ch/vote/")).toBe("https://abolish.ch/vote/");
    expect(ballotLink("https://abolish.ch/", ID)).toBe(`https://abolish.ch/#election=${ID}`);
  });

  test.each([
    undefined,
    "",
    "abolish.ch",
    "http://abolish.ch",
    "https://user:pw@abolish.ch",
    "https://abolish.ch/?a=1",
    "https://abolish.ch/?",
    "https://abolish.ch/#",
    "https://abolish.ch/#election=00",
    "javascript:alert(1)",
  ])("refuse %j", (value) => {
    expect(ballotBase(value)).toBeUndefined();
  });
});
