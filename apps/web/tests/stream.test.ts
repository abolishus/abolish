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
import { contract, MAX_SEARCH_QUERY, MAX_SEARCH_TERMS } from "@abolishus/api-contract";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { streamHref } from "../src/components/stream.tsx";
import {
  isStreamSearch,
  MAX_STREAM_QUERY,
  MAX_STREAM_TERMS,
  pickTranslation,
  streamCard,
  streamQuery,
} from "../src/stream.ts";
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
    // The first question under the title, and its answers for the card's links.
    expect(card.text).toEqual({
      language: "en",
      heading: "Park and library",
      question: "Should the park stay open late?",
      options: ["Yes", "No", "Abstain"],
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
      options: ["Yes", "No", "Abstain"],
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

  test("carry a card's tapped answer in the fragment, in the form the ballot client reads", () => {
    // apps/ballot's parseLink: `&pick=` then the option in its one decimal spelling.
    fc.assert(
      fc.property(fc.nat({ max: 63 }), (pick) => {
        const link = new URL(ballotLink("https://abolish.ch/vote/", ID, pick));
        expect(link.hash).toMatch(/^#election=[0-9a-f]{64}&pick=(0|[1-9][0-9]?)$/);
        expect(link.hash).toBe(`#election=${ID}&pick=${pick}`);
        expect(`${link.origin}${link.pathname}${link.search}`).toBe("https://abolish.ch/vote/");
      }),
      runs,
    );
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

describe("streamQuery", () => {
  const input = contract.elections.list["~orpc"].inputSchema!;
  /** Whether the API's contract takes `q` as a listing's search. */
  const admits = (q: string) => {
    const result = input["~standard"].validate({ limit: "1", q });
    if (result instanceof Promise) throw new Error("the contract validates synchronously");
    return result.issues === undefined;
  };
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  test("its bounds are the API contract's", () => {
    expect([MAX_STREAM_QUERY, MAX_STREAM_TERMS]).toEqual([MAX_SEARCH_QUERY, MAX_SEARCH_TERMS]);
  });

  test("reads nothing, or only whitespace, as no search", () => {
    for (const q of [undefined, "", " ", "\t\n", "\u3000"])
      expect(streamQuery(q)).toEqual({ kind: "none" });
  });

  test("trims a query, and refuses one too long or of too many words", () => {
    expect(streamQuery("  park  library ")).toEqual({ kind: "search", q: "park  library" });
    expect(streamQuery(words(MAX_SEARCH_TERMS)).kind).toBe("search");
    expect(streamQuery(words(MAX_SEARCH_TERMS + 1))).toEqual({ kind: "refused" });
    expect(streamQuery("a".repeat(MAX_SEARCH_QUERY)).kind).toBe("search");
    expect(streamQuery(` ${"a".repeat(MAX_SEARCH_QUERY)} `).kind).toBe("search");
    expect(streamQuery("a".repeat(MAX_SEARCH_QUERY + 1))).toEqual({ kind: "refused" });
  });

  test("searches for exactly the queries the API's contract takes, trimmed", () => {
    const piece = fc.oneof(
      fc.string({ unit: "binary", maxLength: 6 }),
      fc.constantFrom(" ", "\t", "\n", "\u3000", "\u00a0", "\u2028", "\ufeff", "\u180e"),
      fc.constantFrom("\u0085", "\u0001", "a".repeat(40)),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 60 }), (pieces) => {
        const q = pieces.join("");
        const query = streamQuery(q);
        if (q.trim() === "") {
          expect(query.kind).toBe("none");
          return;
        }
        expect(query.kind === "search", JSON.stringify(q)).toBe(admits(q.trim()));
        if (query.kind === "search") {
          expect(query.q).toBe(q.trim());
          expect(isStreamSearch(query.q)).toBe(true);
          expect(isStreamSearch(q)).toBe(q === q.trim());
        }
      }),
      runs,
    );
  });

  test("a search's links carry it whole, read back as the same text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", minLength: 1, maxLength: 40 }), (q) => {
        const href = streamHref("closing", "ab".repeat(32), q);
        const params = new URL(href, "https://web.test").searchParams;
        expect(params.get("q")).toBe(q);
        expect(params.get("sort")).toBe("closing");
        expect(params.get("after")).toBe("ab".repeat(32));
        expect(params.getAll("q")).toHaveLength(1);
      }),
      runs,
    );
  });
});
