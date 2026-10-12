// The check the client runs before showing an election (src/election.ts),
// against the published vectors in docs/spec/vectors/: every definition the
// vectors call undecodable or ill-formed is refused, every display-text record
// is shown only if it decodes, matches the definition's commitment and is
// well-formed, and the text shown is the vector's own (T-34, T-41).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  decodeElectionDefinition,
  type ElectionDefinition,
  encodeElectionDefinition,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { checkElection } from "../src/election.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

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

describe("the election definition", () => {
  const anyText = hex(goodText.encoding);

  test.each(definitionVectors.filter((v) => v.error !== undefined))(
    "refuses $id, which doesn't decode",
    ({ encoding }) => {
      expect(checkElection(new Uint8Array(32), hex(encoding), anyText)).toEqual({
        ok: false,
        problem: "definition-undecodable",
      });
    },
  );

  test.each(definitionVectors.filter((v) => v.illFormed !== undefined))(
    "refuses $id, which breaks $illFormed",
    ({ encoding, illFormed }) => {
      const id = decodeElectionDefinition(hex(encoding)).election_id;
      expect(checkElection(id, hex(encoding), anyText)).toEqual({
        ok: false,
        problem: "definition-ill-formed",
        rule: illFormed,
      });
    },
  );

  test.each(definitionVectors.filter((v) => v.error === undefined && v.illFormed === undefined))(
    "refuses $id under any other election's id",
    ({ encoding }) => {
      const own = decodeElectionDefinition(hex(encoding)).election_id;
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (other) => {
          fc.pre(!own.every((b, i) => b === other[i]));
          expect(checkElection(other, hex(encoding), anyText)).toEqual({
            ok: false,
            problem: "another-election",
          });
        }),
        { numRuns },
      );
    },
  );

  test("shows the definition's own hash, as the vector gives it", () => {
    const encoding = encodeElectionDefinition(goodDefinition());
    const result = checkElection(typical.election_id, encoding, hex(goodText.encoding));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The vector's hash is of another definition; this one is recomputed by
    // the spec's formula over the bytes, independently of the client's code.
    const tag = Buffer.from("abolish/v1/election-definition", "ascii");
    expect(result.election.definitionHash).toBe(
      createHash("sha256")
        .update(Buffer.concat([Buffer.from([tag.length]), tag, encoding]))
        .digest("hex"),
    );
  });

  test("never throws on arbitrary bytes, and shows nothing it can't decode", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const result = checkElection(typical.election_id, bytes, hex(goodText.encoding));
        expect(result.ok).toBe(false);
      }),
      { numRuns },
    );
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

  // The attack the check exists for: text served for one election, or
  // relabelled for one voter, under a definition that commits to other text.
  test("refuses well-formed text the definition doesn't commit to", () => {
    for (const v of withDefinition.filter((x) => x.illFormed === undefined && x !== goodText))
      expect(
        checkElection(
          typical.election_id,
          encodeElectionDefinition(goodDefinition()),
          hex(v.encoding),
        ),
      ).toMatchObject({ ok: false });
  });

  test("refuses the text after any change to any byte", () => {
    const definition = encodeElectionDefinition(goodDefinition());
    const original = hex(goodText.encoding);
    fc.assert(
      fc.property(
        fc.nat({ max: original.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = original.slice();
          changed[at] = (changed[at] as number) ^ flip;
          expect(checkElection(typical.election_id, definition, changed).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  test("refuses text that doesn't decode, whatever its bytes", () => {
    const definition = encodeElectionDefinition(goodDefinition());
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(checkElection(typical.election_id, definition, bytes).ok).toBe(false);
      }),
      { numRuns },
    );
  });
});
