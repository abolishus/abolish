import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  checkElectionToShow,
  decodeElectionDefinition,
  type ElectionDefinition,
  encodeElectionDefinition,
  RECORD_TYPES,
} from "../src/index.ts";

// `checkElectionToShow`, the checks software must pass before it shows an
// election to a voter (docs/spec/display-text.md, Checks), against the
// published vectors: every definition the vectors call undecodable or
// ill-formed is refused, so is every good one under another election's id,
// and display text is shown only if it decodes, matches the definition's
// commitment and is well formed (T-34, T-41).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface DefinitionVector {
  id: string;
  encoding: string;
  error?: string;
  illFormed?: string;
}
interface TextVector {
  id: string;
  encoding: string;
  error?: string;
  illFormed?: string;
  definition?: { optionCount: string; displayTextCommitment: string };
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

function vector<T extends { id: string }>(list: T[], id: string): T {
  const found = list.find((v) => v.id === id);
  if (found === undefined) throw new Error(`no vector ${id}`);
  return found;
}

// A well-formed plurality definition; any option count from 2 to 64 keeps it so.
const typical = decodeElectionDefinition(
  hex(vector(definitionVectors, "definition-typical").encoding),
);

/** The typical definition, committing to a text vector's commitment and option count. */
function definitionFor(v: TextVector): ElectionDefinition {
  if (v.definition === undefined) throw new Error(`${v.id} has no definition`);
  return {
    ...typical,
    option_count: Number(v.definition.optionCount),
    display_text_commitment: hex(v.definition.displayTextCommitment),
  };
}

const goodText = vector(textVectors, "display-text-two-languages");
const goodDefinition = encodeElectionDefinition(definitionFor(goodText));
const withDefinition = textVectors.filter((v) => v.definition !== undefined);

describe("the election definition", () => {
  const anyText = hex(goodText.encoding);

  test.each(definitionVectors.filter((v) => v.error !== undefined))(
    "refuses $id, which doesn't decode",
    ({ encoding }) => {
      expect(checkElectionToShow(typical.election_id, hex(encoding), anyText)).toEqual({
        ok: false,
        problem: "definition-undecodable",
      });
    },
  );

  test.each(definitionVectors.filter((v) => v.illFormed !== undefined))(
    "refuses $id, which breaks $illFormed",
    ({ encoding, illFormed }) => {
      const id = decodeElectionDefinition(hex(encoding)).election_id;
      expect(checkElectionToShow(id, hex(encoding), anyText)).toEqual({
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
          expect(checkElectionToShow(other, hex(encoding), anyText)).toEqual({
            ok: false,
            problem: "another-election",
          });
        }),
        { numRuns },
      );
    },
  );

  test("refuses an election id that isn't 32 bytes", () => {
    for (const id of [new Uint8Array(31), new Uint8Array(33)])
      expect(() => checkElectionToShow(id, goodDefinition, anyText)).toThrow(TypeError);
  });

  test("never throws on arbitrary bytes, and accepts none", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(checkElectionToShow(typical.election_id, bytes, anyText).ok).toBe(false);
      }),
      { numRuns },
    );
  });
});

describe("the display text", () => {
  test.each(withDefinition.filter((v) => v.illFormed === undefined))(
    "accepts $id under a definition that commits to it",
    (v) => {
      const definition = definitionFor(v);
      const result = checkElectionToShow(
        definition.election_id,
        encodeElectionDefinition(definition),
        hex(v.encoding),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.definition).toEqual(definition);
      // The record shown is the one served: its commitment, by the spec's
      // formula over the served bytes, is the definition's.
      const tag = Buffer.from("abolish/v1/display-text", "ascii");
      expect(
        createHash("sha256")
          .update(Buffer.concat([Buffer.from([tag.length]), tag, hex(v.encoding)]))
          .digest("hex"),
      ).toBe(v.definition?.displayTextCommitment);
    },
  );

  test.each(withDefinition.filter((v) => v.illFormed !== undefined))(
    "refuses $id, which breaks $illFormed",
    (v) => {
      const definition = definitionFor(v);
      expect(
        checkElectionToShow(
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
      expect(checkElectionToShow(typical.election_id, goodDefinition, hex(encoding))).toEqual({
        ok: false,
        problem: "display-text-undecodable",
      });
    },
  );

  // The attack the check exists for: text served for another election, or
  // relabelled for one voter, under a definition that commits to other text.
  test.each(withDefinition.filter((v) => v.illFormed === undefined && v !== goodText))(
    "refuses $id under a definition that commits to other text",
    ({ encoding }) => {
      expect(checkElectionToShow(typical.election_id, goodDefinition, hex(encoding))).toEqual({
        ok: false,
        problem: "display-text-ill-formed",
        rule: "commitment",
      });
    },
  );

  test("refuses text whose version the definition pins but this package can't decode", () => {
    const definition = {
      ...definitionFor(goodText),
      profile: {
        ...typical.profile,
        pins: typical.profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.displayText ? { ...p, version: 2 } : p,
        ),
      },
    };
    const bytes = encodeElectionDefinition(definition);
    // Still well formed: the rules require a pin of version 1 or more.
    expect(checkElectionToShow(definition.election_id, bytes, hex(goodText.encoding))).toEqual({
      ok: false,
      problem: "display-text-undecodable",
    });
  });

  test("refuses the text after any change to any byte", () => {
    const original = hex(goodText.encoding);
    fc.assert(
      fc.property(
        fc.nat({ max: original.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = original.slice();
          changed[at] = (changed[at] as number) ^ flip;
          expect(checkElectionToShow(typical.election_id, goodDefinition, changed).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  test("never throws on arbitrary text bytes, and accepts none", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(checkElectionToShow(typical.election_id, goodDefinition, bytes).ok).toBe(false);
      }),
      { numRuns },
    );
  });
});
