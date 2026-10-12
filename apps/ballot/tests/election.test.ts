// What the client shows of a checked election (src/election.ts): the text
// exactly as the record holds it, the definition's own hash and counting rule,
// and a refusal passed on as @abolishus/crypto's `checkElectionToShow` gave it.
// The checks themselves are tested against every vector in packages/crypto
// (tests/show-election.test.ts); here, one refusal of each kind shows none is
// lost on the way (T-34, T-41).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  decodeElectionDefinition,
  type ElectionDefinition,
  encodeElectionDefinition,
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
    const result = checkElection(typical.election_id, encoding, anyText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tag = Buffer.from("abolish/v1/election-definition", "ascii");
    expect(result.election.definitionHash).toBe(
      createHash("sha256")
        .update(Buffer.concat([Buffer.from([tag.length]), tag, encoding]))
        .digest("hex"),
    );
  });

  test("names an approval election as one", () => {
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
      checkElection(definition.election_id, encodeElectionDefinition(definition), anyText),
    ).toMatchObject({
      ok: true,
      election: { electionType: "approval", minSelections: 1, maxSelections: 2 },
    });
  });

  test.each([
    ["definition-truncated", "definition-undecodable", undefined],
    ["definition-one-option", "definition-ill-formed", "option-count"],
  ])("passes on the refusal of %s", (id, problem, rule) => {
    const encoding = hex(vector(definitionVectors, id).encoding);
    const electionId =
      rule === undefined ? typical.election_id : decodeElectionDefinition(encoding).election_id;
    expect(checkElection(electionId, encoding, anyText)).toEqual(
      rule === undefined ? { ok: false, problem } : { ok: false, problem, rule },
    );
  });

  test("passes on the refusal of another election's definition", () => {
    expect(
      checkElection(
        new Uint8Array(32).fill(0xff),
        encodeElectionDefinition(goodDefinition()),
        anyText,
      ),
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
      const result = checkElection(
        definition.election_id,
        encodeElectionDefinition(definition),
        hex(v.encoding),
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.election.translations).toEqual(
        v.value.translations.map((t) => ({
          language: text(t.language),
          question: text(t.question),
          description: text(t.description),
          options: t.options.map((o) => ({
            label: text(o.label),
            description: text(o.description),
          })),
        })),
      );
      expect(result.election).toMatchObject({
        electionId: Buffer.from(definition.election_id).toString("hex"),
        electionType: "plurality",
        minSelections: definition.min_selections,
        maxSelections: definition.max_selections,
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
        checkElection(
          definition.election_id,
          encodeElectionDefinition(definition),
          hex(v.encoding),
        ),
      ).toEqual({ ok: false, problem: "display-text-ill-formed", rule: v.illFormed });
    },
  );

  test.each(textVectors.filter((v) => v.error !== undefined))(
    "refuses $id, which doesn't decode",
    ({ encoding }) => {
      expect(
        checkElection(
          typical.election_id,
          encodeElectionDefinition(goodDefinition()),
          hex(encoding),
        ),
      ).toEqual({ ok: false, problem: "display-text-undecodable" });
    },
  );

  // The attack the check exists for: text relabelled for one voter, under a
  // definition that commits to the original.
  test("refuses text the definition doesn't commit to", () => {
    for (const v of withDefinition.filter((x) => x.illFormed === undefined && x !== goodText))
      expect(
        checkElection(
          typical.election_id,
          encodeElectionDefinition(goodDefinition()),
          hex(v.encoding),
        ),
      ).toEqual({ ok: false, problem: "display-text-ill-formed", rule: "commitment" });
  });
});
