import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type CellCheck,
  checkTally,
  type CommittedVote,
  decode,
  DecodeError,
  decodeTallyOpening,
  element,
  EncodeError,
  encodeTallyOpening,
  GROUP_ORDER,
  identityKey,
  list,
  openCell,
  type Share,
  shareVote,
  signTallyOpening,
  sumShares,
  type TallyCheck,
  type TallyElection,
  type TallyOpening,
  tallyOpeningStatement,
} from "../src/index.ts";
import { differ } from "../src/tally-opening.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/tally-opening.json comes from an independent Python
// implementation of docs/spec/tally.md, Opening record and Opening checks
// (scripts/tally-opening-vectors.py, with its own strict decoder, P-256 ECDSA
// and per-cell checks), so these bytes and verdicts never come from the code
// under test.

interface Report {
  readonly at: number;
  readonly signer: number | null;
}

interface VectorCell {
  readonly ok: boolean;
  readonly code?: string;
  readonly option?: number;
  readonly counts?: readonly string[];
  readonly passing: readonly Report[];
  readonly failing: readonly (Report & { readonly code: string; readonly option?: number })[];
}

interface Vectors {
  readonly format: string;
  readonly tag: string;
  readonly recordType: string;
  readonly version: number;
  readonly election: {
    readonly definitionHash: string;
    readonly rules: TallyElection["rules"];
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
  };
  readonly openings: readonly {
    readonly id: string;
    readonly signingSecret: string;
    readonly signingKey: string;
    readonly definitionHash: string;
    readonly cell: number;
    readonly signer: number;
    readonly opening: readonly { readonly v: string; readonly r: string }[];
    readonly message: string;
    readonly signature: string;
    readonly encoding: string;
  }[];
  readonly decodeErrors: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly elections: readonly {
    readonly id: string;
    readonly cells: readonly (readonly string[])[];
    readonly openings: readonly string[];
    readonly result: {
      readonly ok: boolean;
      readonly failure?: { readonly cell: number; readonly code: string; readonly option?: number };
      readonly cells: readonly VectorCell[];
      readonly stray: readonly Report[];
    };
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("tally-opening.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VSS = list(list(element, 16), 64);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const election: TallyElection = {
  definitionHash: hex(vectors.election.definitionHash),
  rules: vectors.election.rules,
  registered: vectors.election.registered.map((k) => ({
    index: k.index,
    signingKey: hex(k.signingKey),
  })),
};

/** The check's output in the vector file's shape: counts as decimal strings. */
function asVector(r: TallyCheck): unknown {
  const cell = (c: CellCheck) =>
    c.ok ? { ...c, counts: c.counts.map((x) => x.toString()) } : { ...c };
  return { ...r, cells: r.cells.map(cell) };
}

describe("tally-opening.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-tally-opening-vectors/1");
    expect(vectors.tag).toBe("abolish/v1/sig/tally-opening");
    expect(vectors.recordType).toBe("0x0006");
    expect(vectors.version).toBe(1);
  });

  test.each(vectors.openings)("$id is re-made byte for byte", (v) => {
    const secret = hex(v.signingSecret);
    expect(toHex(identityKey(secret))).toBe(v.signingKey);
    const statement = {
      definition_hash: hex(v.definitionHash),
      cell: v.cell,
      signer: v.signer,
      opening: v.opening.map((s) => ({ v: BigInt(s.v), r: BigInt(s.r) })),
    };
    expect(toHex(tallyOpeningStatement(statement))).toBe(v.message);
    const signed = signTallyOpening(secret, statement);
    expect(toHex(signed.signature)).toBe(v.signature);
    expect(toHex(encodeTallyOpening(signed))).toBe(v.encoding);
    expect(decodeTallyOpening(hex(v.encoding), 1)).toEqual(signed);
  });

  test.each(vectors.decodeErrors)("$id is rejected with $error at $offset", (v) => {
    let caught: unknown;
    try {
      decodeTallyOpening(hex(v.encoding), 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    expect((caught as DecodeError).code).toBe(v.error);
    expect((caught as DecodeError).offset).toBe(v.offset);
  });

  test.each(vectors.elections)("election $id", (v) => {
    const cells = v.cells.map((c) => c.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]));
    const openings = v.openings.map((b) => decodeTallyOpening(hex(b), 1));
    expect(asVector(checkTally(election, cells, openings))).toEqual(v.result);
  });
});

/** Fixed per-election signing secrets for seats 1 to 4 (test data, never keys). */
const SECRETS = [1, 2, 3, 4].map((i) =>
  Uint8Array.from({ length: 32 }, (_, b) => (b === 31 ? i : 7)),
);

function honestCell(rules: TallyElection["rules"], votes: readonly (readonly (0 | 1)[])[]) {
  const validity = { ...rules, minSelections: 0, maxSelections: rules.optionCount };
  const sharings = votes.map((v) => shareVote(validity, v));
  const ballots: CommittedVote["vss"][] = sharings.map((s) => s.vss);
  const summed = new Map(
    Array.from({ length: rules.panelSize }, (_, i) => [
      i + 1,
      sumShares(
        rules,
        sharings.map((s) => s.shares[i] as readonly Share[]),
      ),
    ]),
  );
  const opened = openCell(rules, ballots, summed);
  if (!opened.ok) throw new Error("an honest cell opens");
  const opening = opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint }));
  return { ballots, opening, counts: opened.counts };
}

const arbElection = fc
  .record({
    m: fc.integer({ min: 2, max: 3 }),
    k: fc.integer({ min: 2, max: 3 }),
    cells: fc.integer({ min: 1, max: 3 }),
    signer: fc.integer({ min: 1, max: 3 }),
  })
  .chain(({ m, k, cells, signer }) =>
    fc.record({
      rules: fc.constant({ optionCount: m, threshold: k, panelSize: 3 }),
      signer: fc.constant(signer),
      definitionHash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
      votes: fc.array(
        fc.array(fc.array(fc.constantFrom<0 | 1>(0, 1), { minLength: m, maxLength: m }), {
          maxLength: 3,
        }),
        { minLength: cells, maxLength: cells },
      ),
    }),
  );

function honestTally(input: {
  rules: TallyElection["rules"];
  signer: number;
  definitionHash: Uint8Array;
  votes: (0 | 1)[][][];
}) {
  const el: TallyElection = {
    definitionHash: input.definitionHash,
    rules: input.rules,
    registered: [1, 2, 3].map((index) => ({
      index,
      signingKey: identityKey(SECRETS[index - 1] as Uint8Array),
    })),
  };
  const cells = input.votes.map((v) => honestCell(input.rules, v));
  const records = cells.map((c, cell) =>
    encodeTallyOpening(
      signTallyOpening(SECRETS[input.signer - 1] as Uint8Array, {
        definition_hash: input.definitionHash,
        cell,
        signer: input.signer,
        opening: c.opening,
      }),
    ),
  );
  return { el, cells, records };
}

describe("properties", () => {
  test("honest signed openings of every cell pass, attributed to their signer", () => {
    fc.assert(
      fc.property(arbElection, (input) => {
        const { el, cells, records } = honestTally(input);
        const r = checkTally(
          el,
          cells.map((c) => c.ballots),
          records.map((b) => decodeTallyOpening(b, 1)),
        );
        expect(r.ok).toBe(true);
        r.cells.forEach((c, i) => {
          expect(c.ok && c.counts).toEqual(cells[i]?.counts);
          expect(c.passing).toEqual([{ at: i, signer: input.signer }]);
        });
        expect(r.stray).toEqual([]);
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("a changed byte never leaves an opening attributed to its signer", () => {
    fc.assert(
      fc.property(
        arbElection.chain((input) =>
          fc.record({
            input: fc.constant(input),
            at: fc.nat(),
            flip: fc.integer({ min: 1, max: 255 }),
          }),
        ),
        ({ input, at, flip }) => {
          const { el, cells, records } = honestTally(input);
          const original = records[0] as Uint8Array;
          const changed = Uint8Array.from(original);
          const i = at % changed.length;
          changed[i] = (changed[i] as number) ^ flip;
          let o: TallyOpening;
          try {
            o = decodeTallyOpening(changed, 1);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          const r = checkTally(
            el,
            cells.map((c) => c.ballots),
            [o],
          );
          const reports = [...r.stray, ...r.cells.flatMap((c) => [...c.passing, ...c.failing])];
          expect(reports).toHaveLength(1);
          expect(reports[0]?.signer).toBeNull();
        },
      ),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("random bytes are rejected or re-encode to themselves", () => {
    fc.assert(
      fc.property(
        fc
          .uint8Array({ maxLength: 300 })
          .map((tail) => Uint8Array.from([0x00, 0x06, 0x01, ...tail])),
        (b) => {
          let o: TallyOpening;
          try {
            o = decodeTallyOpening(b, 1);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(encodeTallyOpening(o)).toEqual(b);
        },
      ),
      { numRuns },
    );
  });

  test("records round-trip", () => {
    const scalarArb = fc.bigInt({ min: 0n, max: GROUP_ORDER - 1n });
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.nat(255),
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.record({ v: scalarArb, r: scalarArb }), { maxLength: 64 }),
        (definitionHash, cell, signer, opening) => {
          const o = signTallyOpening(SECRETS[signer - 1] as Uint8Array, {
            definition_hash: definitionHash,
            cell,
            signer,
            opening,
          });
          expect(decodeTallyOpening(encodeTallyOpening(o), 1)).toEqual(o);
        },
      ),
      { numRuns: Math.max(10, numRuns / 10) },
    );
  });
});

describe("checks without vectors", () => {
  test("two passing openings that differ are a conflict", () => {
    // Building them needs log_g h, so no vector can; the comparison is checked directly.
    const a = [{ v: 1n, r: 2n }];
    expect(differ(a, [{ v: 1n, r: 2n }])).toBe(false);
    expect(differ(a, [{ v: 1n, r: 3n }])).toBe(true);
    expect(differ(a, [{ v: 0n, r: 2n }])).toBe(true);
    expect(differ(a, [...a, ...a])).toBe(true);
  });

  test("a hand-built opening with a non-canonical scalar is refused, not reduced", () => {
    const { el, cells, records } = honestTally({
      rules: { optionCount: 2, threshold: 2, panelSize: 3 },
      signer: 1,
      definitionHash: new Uint8Array(32),
      votes: [[[1, 0]]],
    });
    const o = decodeTallyOpening(records[0] as Uint8Array, 1);
    const bad = {
      ...o,
      opening: o.opening.map((s, j) => (j === 0 ? { v: s.v + GROUP_ORDER, r: s.r } : s)),
    };
    expect(() =>
      checkTally(
        el,
        cells.map((c) => c.ballots),
        [bad],
      ),
    ).toThrow(EncodeError);
  });

  test("an opening for a seat outside the registered set is unattributed", () => {
    const { el, cells, records } = honestTally({
      rules: { optionCount: 2, threshold: 2, panelSize: 3 },
      signer: 2,
      definitionHash: new Uint8Array(32),
      votes: [[[0, 1]]],
    });
    const fewer = { ...el, registered: el.registered.filter((k) => k.index !== 2) };
    const r = checkTally(
      fewer,
      cells.map((c) => c.ballots),
      records.map((b) => decodeTallyOpening(b, 1)),
    );
    expect(r.ok).toBe(true);
    expect(r.cells[0]?.passing).toEqual([{ at: 0, signer: null }]);
  });
});
