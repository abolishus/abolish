// What the client shows of a checked election (src/election.ts), for
// definition versions 1 and 5: the text exactly as the record holds it, the
// definition's own hash and each question's limits, and a refusal passed on as
// @abolishus/crypto's `checkElectionRecordToShow` gave it. The checks
// themselves are tested against every vector in packages/crypto
// (tests/show-election.test.ts, tests/definition-v5.property.test.ts); here,
// one refusal of each kind shows none is lost on the way (T-34, T-41).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  type ElectionDefinition,
  type ElectionDefinitionV5,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";

import { checkElection } from "../src/election.ts";

interface DefinitionVector {
  id: string;
  encoding: string;
  hash?: string;
  error?: string;
  illFormed?: string;
}
interface TextVector {
  id: string;
  encoding: string;
  error?: string;
  illFormed?: string;
  definition?: { optionCount: string; displayTextCommitment: string };
  value?: {
    translations: {
      language: string;
      question: string;
      description: string;
      options: { label: string; description: string }[];
    }[];
  };
}

const vectors = <T>(name: string): T[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../../docs/spec/vectors/${name}.json`, import.meta.url), "utf8"),
    ) as { vectors: T[] }
  ).vectors;

const definitionVectors = vectors<DefinitionVector>("election-definition");
const textVectors = vectors<TextVector>("display-text");

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

/** The definition hash by the spec's formula, with node:crypto rather than the code under test. */
const definitionHash = (bytes: Uint8Array) => {
  const tag = Buffer.from("abolish/v1/election-definition", "ascii");
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([tag.length]), tag, bytes]))
    .digest();
};

/** The check, with the registry holding the hash of exactly the definition served. */
const check = (electionId: Uint8Array, definition: Uint8Array, displayText: Uint8Array) =>
  checkElection(electionId, Uint8Array.from(definitionHash(definition)), definition, displayText);
const text = (s: string) => Buffer.from(s, "hex").toString("utf8");

function vector<T extends { id: string }>(list: T[], id: string): T {
  const found = list.find((v) => v.id === id);
  if (found === undefined) throw new Error(`no vector ${id}`);
  return found;
}

// A well-formed plurality definition, any number of options from 2 to 64.
const typical = decodeElectionDefinition(
  hex(vector(definitionVectors, "definition-typical").encoding),
);

/** The typical definition, committing to `commitment` with `optionCount` options. */
function definitionFor(optionCount: number, commitment: Uint8Array): ElectionDefinition {
  return { ...typical, option_count: optionCount, display_text_commitment: commitment };
}

const goodText = vector(textVectors, "display-text-two-languages");
const goodDefinition = () => {
  if (goodText.definition === undefined) throw new Error("vector has no definition");
  return definitionFor(
    Number(goodText.definition.optionCount),
    hex(goodText.definition.displayTextCommitment),
  );
};

describe("the election", () => {
  const anyText = hex(goodText.encoding);

  test("shows the definition's own hash, by the spec's formula over its bytes", () => {
    const encoding = encodeElectionDefinition(goodDefinition());
    const result = check(typical.election_id, encoding, anyText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.election.definitionHash).toBe(definitionHash(encoding).toString("hex"));
  });

  test("carries the definition's limits as its one question's", () => {
    const approval = decodeElectionDefinition(
      hex(vector(definitionVectors, "definition-approval").encoding),
    );
    const definition = {
      ...goodDefinition(),
      election_type: approval.election_type,
      min_selections: 1,
      max_selections: 2,
    };
    expect(
      check(definition.election_id, encodeElectionDefinition(definition), anyText),
    ).toMatchObject({
      ok: true,
      election: { version: 1, questions: [{ minSelections: 1, maxSelections: 2 }] },
    });
  });

  test.each([
    ["definition-truncated", "definition-undecodable", undefined],
    ["definition-one-option", "definition-ill-formed", "option-count"],
  ])("passes on the refusal of %s", (id, problem, rule) => {
    const encoding = hex(vector(definitionVectors, id).encoding);
    const electionId =
      rule === undefined ? typical.election_id : decodeElectionDefinition(encoding).election_id;
    expect(check(electionId, encoding, anyText)).toEqual(
      rule === undefined ? { ok: false, problem } : { ok: false, problem, rule },
    );
  });

  test("passes on the refusal of a definition the registry doesn't hold, with the served hash", () => {
    const served = encodeElectionDefinition(goodDefinition());
    expect(checkElection(typical.election_id, new Uint8Array(32), served, anyText)).toEqual({
      ok: false,
      problem: "unregistered-definition",
      servedHash: definitionHash(served).toString("hex"),
    });
  });

  test("passes on the refusal of another election's definition", () => {
    expect(
      check(new Uint8Array(32).fill(0xff), encodeElectionDefinition(goodDefinition()), anyText),
    ).toEqual({ ok: false, problem: "another-election" });
  });
});

describe("the display text", () => {
  const withDefinition = textVectors.filter((v) => v.definition !== undefined);

  test.each(withDefinition.filter((v) => v.illFormed === undefined))(
    "shows $id, exactly as the record holds it",
    (v) => {
      if (v.definition === undefined || v.value === undefined) throw new Error("incomplete vector");
      const definition = definitionFor(
        Number(v.definition.optionCount),
        hex(v.definition.displayTextCommitment),
      );
      const result = check(
        definition.election_id,
        encodeElectionDefinition(definition),
        hex(v.encoding),
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.election.translations).toEqual(
        v.value.translations.map((t) => ({
          language: text(t.language),
          title: "",
          description: "",
          questions: [
            {
              question: text(t.question),
              description: text(t.description),
              options: t.options.map((o) => ({
                label: text(o.label),
                description: text(o.description),
              })),
            },
          ],
        })),
      );
      expect(result.election).toMatchObject({
        electionId: Buffer.from(definition.election_id).toString("hex"),
        version: 1,
        questions: [
          { minSelections: definition.min_selections, maxSelections: definition.max_selections },
        ],
        // Version 1 is never sealed, so it offers no tier to cast in.
        tiers: [],
        boardEntryVersion: undefined,
        opensAt: definition.opens_at,
        closesAt: definition.closes_at,
      });
    },
  );

  test.each(withDefinition.filter((v) => v.illFormed !== undefined))(
    "refuses $id, which breaks $illFormed",
    (v) => {
      if (v.definition === undefined) throw new Error("incomplete vector");
      const definition = definitionFor(
        Number(v.definition.optionCount),
        hex(v.definition.displayTextCommitment),
      );
      expect(
        check(definition.election_id, encodeElectionDefinition(definition), hex(v.encoding)),
      ).toEqual({ ok: false, problem: "display-text-ill-formed", rule: v.illFormed });
    },
  );

  test.each(textVectors.filter((v) => v.error !== undefined))(
    "refuses $id, which doesn't decode",
    ({ encoding }) => {
      expect(
        check(typical.election_id, encodeElectionDefinition(goodDefinition()), hex(encoding)),
      ).toEqual({ ok: false, problem: "display-text-undecodable" });
    },
  );

  // The attack the check exists for: text relabelled for one voter, under a
  // definition that commits to the original.
  test("refuses text the definition doesn't commit to", () => {
    for (const v of withDefinition.filter((x) => x.illFormed === undefined && x !== goodText))
      expect(
        check(typical.election_id, encodeElectionDefinition(goodDefinition()), hex(v.encoding)),
      ).toEqual({ ok: false, problem: "display-text-ill-formed", rule: "commitment" });
  });
});

interface TextV2Vector {
  id: string;
  encoding: string;
  /** The display-text version the vector is decoded under. */
  pinned: number;
  error?: string;
  illFormed?: string;
  definition?: { optionCounts: string[]; displayTextCommitment: string };
  value?: {
    translations: {
      language: string;
      title: string;
      description: string;
      questions: {
        question: string;
        description: string;
        options: { label: string; description: string }[];
      }[];
    }[];
  };
}

describe("a version-5 election, a poll of questions", () => {
  const textVectors = vectors<TextV2Vector>("display-text-v2");
  const typicalV5 = decodeElectionDefinitionV5(
    hex(
      vector(vectors<DefinitionVector>("election-definition-v5"), "definition-v5-typical").encoding,
    ),
  );

  /** The typical version-5 definition with one question per count, the last two required, committing to `commitment`. */
  function definitionV5(counts: readonly string[], commitment: string): ElectionDefinitionV5 {
    return {
      ...typicalV5,
      questions: counts.map((m, q) => ({
        method: 1,
        option_count: Number(m),
        min_selections: q === 0 ? 0 : 1,
        max_selections: q === 0 ? Number(m) : 1,
      })),
      display_text_commitment: hex(commitment),
    };
  }
  const forVector = (v: TextV2Vector) => {
    if (v.definition === undefined) throw new Error("vector has no definition");
    return definitionV5(v.definition.optionCounts, v.definition.displayTextCommitment);
  };
  const two = vector(textVectors, "display-text-v2-two-questions");
  const withDefinition = textVectors.filter((v) => v.definition !== undefined);

  test.each(withDefinition.filter((v) => v.illFormed === undefined))(
    "shows $id: every question's text exactly as the record holds it, with its limits",
    (v) => {
      if (v.value === undefined) throw new Error("incomplete vector");
      const definition = forVector(v);
      const encoding = encodeElectionDefinitionV5(definition);
      const result = check(definition.election_id, encoding, hex(v.encoding));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.election).toEqual({
        electionId: Buffer.from(definition.election_id).toString("hex"),
        // The same tag and formula as version 1's, over the version-5 encoding.
        definitionHash: definitionHash(encoding).toString("hex"),
        version: 5,
        questions: definition.questions.map((q) => ({
          minSelections: q.min_selections,
          maxSelections: q.max_selections,
        })),
        tiers: definition.electorate.map((tier) => tier.tier),
        // The board entries the poll's answers are decoded under (`checkBoarded`).
        boardEntryVersion: pinnedVersion(definition, RECORD_TYPES.boardEntry),
        opensAt: definition.opens_at,
        closesAt: definition.closes_at,
        translations: v.value.translations.map((t) => ({
          language: text(t.language),
          title: text(t.title),
          description: text(t.description),
          questions: t.questions.map((q) => ({
            question: text(q.question),
            description: text(q.description),
            options: q.options.map((o) => ({
              label: text(o.label),
              description: text(o.description),
            })),
          })),
        })),
      });
    },
  );

  test.each(withDefinition.filter((v) => v.illFormed !== undefined))(
    "refuses $id, which breaks $illFormed",
    (v) => {
      const definition = forVector(v);
      expect(
        check(definition.election_id, encodeElectionDefinitionV5(definition), hex(v.encoding)),
      ).toEqual({ ok: false, problem: "display-text-ill-formed", rule: v.illFormed });
    },
  );

  // A definition pinning version 2 decodes under 2: a vector that fails only under another pin is left out.
  test.each(textVectors.filter((v) => v.error !== undefined && v.pinned === 2))(
    "refuses $id, which doesn't decode",
    ({ encoding }) => {
      const definition = forVector(two);
      expect(
        check(definition.election_id, encodeElectionDefinitionV5(definition), hex(encoding)),
      ).toEqual({ ok: false, problem: "display-text-undecodable" });
    },
  );

  test("passes on an ill-formed definition's refusal with the question it names", () => {
    const definition = forVector(two);
    const broken: ElectionDefinitionV5 = {
      ...definition,
      questions: [
        definition.questions[0] as ElectionDefinitionV5["questions"][number],
        { method: 1, option_count: 2, min_selections: 0, max_selections: 3 },
      ],
    };
    expect(
      check(broken.election_id, encodeElectionDefinitionV5(broken), hex(two.encoding)),
    ).toEqual({ ok: false, problem: "definition-ill-formed", rule: "selections", question: 1 });
  });

  test("passes on the refusal of a definition the registry doesn't hold, with the served hash", () => {
    const served = encodeElectionDefinitionV5(forVector(two));
    expect(
      checkElection(typicalV5.election_id, new Uint8Array(32), served, hex(two.encoding)),
    ).toEqual({
      ok: false,
      problem: "unregistered-definition",
      servedHash: definitionHash(served).toString("hex"),
    });
  });

  // The attack the check exists for, with questions: text whose two
  // questions are swapped, under a definition committing to the original.
  test("refuses another text, and a version-1 text, under a version-5 definition", () => {
    const definition = forVector(two);
    const encoding = encodeElectionDefinitionV5(definition);
    for (const v of withDefinition.filter((x) => x.illFormed === undefined && x !== two))
      expect(check(definition.election_id, encoding, hex(v.encoding))).toMatchObject({
        ok: false,
        problem: "display-text-ill-formed",
        rule: "commitment",
      });
    expect(check(definition.election_id, encoding, hex(goodText.encoding))).toEqual({
      ok: false,
      problem: "display-text-undecodable",
    });
  });

  test("refuses a version-2 text under a version-1 definition", () => {
    expect(
      check(typical.election_id, encodeElectionDefinition(goodDefinition()), hex(two.encoding)),
    ).toEqual({ ok: false, problem: "display-text-undecodable" });
  });

  // Author panels and live results aren't read by the client yet (P2-16).
  test("refuses a version-6 definition as undecodable", () => {
    const v6 = hex(
      vector(vectors<DefinitionVector>("election-definition-v6"), "definition-v6-typical").encoding,
    );
    expect(check(new Uint8Array(32), v6, hex(two.encoding))).toEqual({
      ok: false,
      problem: "definition-undecodable",
    });
  });
});
