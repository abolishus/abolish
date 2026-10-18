import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  aggregateCell,
  aggregateHash,
  type CellCheck,
  checkTally,
  type CommittedVote,
  decode,
  DecodeError,
  decodeTallyOpening,
  element,
  encodeTallyOpening,
  GROUP_ORDER,
  identityKey,
  list,
  openCell,
  type Share,
  shareVote,
  signTallyOpening,
  sortTallyOpenings,
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
    readonly aggregateHash: string;
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
    readonly boardedAfter?: readonly (readonly string[])[];
    readonly electionFailure?: { readonly code: string; readonly attributedTo: string };
    readonly result: {
      readonly ok: boolean;
      readonly failure?: { readonly cell: number; readonly code: string; readonly option?: number };
      readonly cells: readonly VectorCell[];
      readonly stray: readonly Report[];
      readonly rejected: readonly { readonly at: number; readonly error: string }[];
    };
  }[];
  /** Tally-opening version 2, a live poll's: version 1's record byte for byte apart from the header. */
  readonly version2: {
    readonly openings: readonly { readonly id: string; readonly encoding: string }[];
    readonly decodeErrors: Vectors["decodeErrors"];
    readonly elections: readonly Omit<
      Vectors["elections"][number],
      "boardedAfter" | "electionFailure"
    >[];
  };
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
      aggregate_hash: hex(v.aggregateHash),
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
    const payloads = v.openings.map((b) => hex(b));
    expect(asVector(checkTally(election, cells, payloads, 1))).toEqual(v.result);
    if (v.boardedAfter === undefined) return;
    // A late ballot that would be selected isn't ignored: verifier 7.1 fails
    // the election against the operator, while the tally check still passes.
    expect(v.electionFailure).toEqual({ code: "tally-late", attributedTo: "operator" });
    // What the counted extent rule prevents: counting a ballot boarded after
    // it would turn every honest opening of its cell into tally-aggregate.
    const widened = cells.map((c, i) => [
      ...c,
      ...(v.boardedAfter?.[i] ?? []).map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]),
    ]);
    const r = checkTally(election, widened, payloads, 1);
    expect(r.ok).toBe(false);
    for (const [i, extra] of v.boardedAfter.entries())
      if (extra.length > 0)
        expect(r.cells[i]?.failing.every((f) => f.code === "tally-aggregate")).toBe(true);
  });
});

describe("tally-opening.json, version 2 (docs/spec/tally.md, Tally-opening version 2)", () => {
  const byId = new Map(vectors.openings.map((o) => [o.id, o]));

  test.each(vectors.version2.openings)("$id decodes to version 1's fields and re-encodes", (v) => {
    const one = byId.get(v.id);
    if (one === undefined) throw new Error(`no version-1 vector ${v.id}`);
    const opening = decodeTallyOpening(hex(v.encoding), 2);
    expect(opening).toEqual(decodeTallyOpening(hex(one.encoding), 1));
    expect(toHex(encodeTallyOpening(opening, 2))).toBe(v.encoding);
    // The signature doesn't sign the header, so it is the same statement's.
    expect(toHex(tallyOpeningStatement(opening))).toBe(one.message);
  });

  test.each(vectors.version2.decodeErrors)("$id is rejected with $error at $offset", (v) => {
    let caught: unknown;
    try {
      decodeTallyOpening(hex(v.encoding), 2);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    expect((caught as DecodeError).code).toBe(v.error);
    expect((caught as DecodeError).offset).toBe(v.offset);
  });

  test.each(vectors.version2.elections)("election $id", (v) => {
    const cells = v.cells.map((c) => c.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]));
    const payloads = v.openings.map((b) => hex(b));
    expect(asVector(checkTally(election, cells, payloads, 2))).toEqual(v.result);
  });

  test("every version-1 election's openings are rejected entries under pin 2, and its version-2 ones under pin 1", () => {
    for (const v of vectors.version2.elections) {
      const payloads = v.openings.map((b) => hex(b));
      const cells = v.cells.map((c) => c.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]));
      const asOne = checkTally(election, cells, payloads, 1);
      // A version-2 payload never opens a cell of a poll pinning version 1 (T-31).
      for (const [at, b] of payloads.entries())
        if (b[2] === 2) expect(asOne.rejected).toContainEqual({ at, error: "profile-mismatch" });
      // And a version-1 payload never opens a cell of a live poll's.
      const asTwo = checkTally(election, cells, payloads, 2);
      for (const [at, b] of payloads.entries())
        if (b[2] === 1) expect(asTwo.rejected).toContainEqual({ at, error: "profile-mismatch" });
    }
  });

  test("a version other than 1 or 2 is refused by the whole opening's codec, from an untyped caller too", () => {
    const one = vectors.openings[0];
    if (one === undefined) throw new Error("no opening vector");
    const opening = decodeTallyOpening(hex(one.encoding), 1);
    expect(() => encodeTallyOpening(opening, 3 as unknown as 1)).toThrow(RangeError);
    expect(() => decodeTallyOpening(hex(one.encoding), 3 as unknown as 1)).toThrow(RangeError);
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
        aggregate_hash: aggregateHash(aggregateCell(input.rules, c.ballots)),
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
          records,
          1,
        );
        expect(r.ok).toBe(true);
        r.cells.forEach((c, i) => {
          expect(c.ok && c.counts).toEqual(cells[i]?.counts);
          expect(c.passing).toEqual([{ at: i, signer: input.signer }]);
        });
        expect(r.stray).toEqual([]);
        expect(r.rejected).toEqual([]);
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("under pin 2 the same openings labelled version 2 give version 1's verdict, and version-1 ones open nothing", () => {
    fc.assert(
      fc.property(arbElection, (input) => {
        const { el, cells, records } = honestTally(input);
        const ballots = cells.map((c) => c.ballots);
        const two = records.map((r) => encodeTallyOpening(decodeTallyOpening(r, 1), 2));
        expect(checkTally(el, ballots, two, 2)).toEqual(checkTally(el, ballots, records, 1));
        const crossed = checkTally(el, ballots, records, 2);
        expect(crossed.ok).toBe(false);
        expect(crossed.rejected).toEqual(
          records.map((_, at) => ({ at, error: "profile-mismatch" })),
        );
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
          const r = checkTally(
            el,
            cells.map((c) => c.ballots),
            [changed],
            1,
          );
          const reports = [...r.stray, ...r.cells.flatMap((c) => [...c.passing, ...c.failing])];
          if (r.rejected.length === 1) {
            expect(reports).toEqual([]);
            return;
          }
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
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.record({ v: scalarArb, r: scalarArb }), { maxLength: 64 }),
        (definitionHash, cell, aggregate, signer, opening) => {
          const o = signTallyOpening(SECRETS[signer - 1] as Uint8Array, {
            definition_hash: definitionHash,
            cell,
            aggregate_hash: aggregate,
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

describe("sortTallyOpenings", () => {
  test.each(vectors.elections)("sorts and attributes $id as checkTally does", (v) => {
    const payloads = v.openings.map((b) => hex(b));
    const sorted = sortTallyOpenings(election, v.cells.length, payloads, 1);
    const r = checkTally(
      election,
      v.cells.map((c) => c.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"])),
      payloads,
      1,
    );
    expect(sorted.map((o) => o.at)).toEqual(payloads.map((_, at) => at));
    expect(sorted.flatMap((o) => ("error" in o ? [o] : []))).toEqual(r.rejected);
    expect(
      sorted.flatMap((o) =>
        "error" in o || o.cell !== null ? [] : [{ at: o.at, signer: o.signer }],
      ),
    ).toEqual(r.stray);
    for (const [c, cell] of r.cells.entries()) {
      const mine = sorted.flatMap((o) => ("error" in o || o.cell !== c ? [] : [o]));
      const reported = [...cell.passing, ...cell.failing].sort((a, b) => a.at - b.at);
      expect(mine.map((o) => ({ at: o.at, signer: o.signer }))).toEqual(
        reported.map(({ at, signer }) => ({ at, signer })),
      );
    }
  });

  test("needs a 32-byte definition hash and from 1 to 256 cells", () => {
    expect(() => sortTallyOpenings(election, 0, [], 1)).toThrow(RangeError);
    expect(() => sortTallyOpenings(election, 257, [], 1)).toThrow(RangeError);
    expect(() => sortTallyOpenings(election, 1.5, [], 1)).toThrow(RangeError);
    expect(() =>
      sortTallyOpenings({ ...election, definitionHash: new Uint8Array(31) }, 1, [], 1),
    ).toThrow(RangeError);
    expect(sortTallyOpenings(election, 256, [], 1)).toEqual([]);
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

  test("a payload with a non-canonical scalar is a rejected entry, not reduced", () => {
    const { el, cells, records } = honestTally({
      rules: { optionCount: 2, threshold: 2, panelSize: 3 },
      signer: 1,
      definitionHash: new Uint8Array(32),
      votes: [[[1, 0]]],
    });
    const bad = Uint8Array.from(records[0] as Uint8Array);
    // Option 0's V, little-endian after the 3-byte header, 66 bytes of fields
    // and the 4-byte count: adding ℓ keeps it under 2²⁵⁶ for a count of 0 or 1.
    const v = bad.subarray(73, 105);
    let x = 0n;
    for (let i = 31; i >= 0; i--) x = (x << 8n) | BigInt(v[i] as number);
    x += GROUP_ORDER;
    for (let i = 0; i < 32; i++) v[i] = Number((x >> BigInt(8 * i)) & 0xffn);
    const r = checkTally(
      el,
      cells.map((c) => c.ballots),
      [bad],
      1,
    );
    expect(r.rejected).toEqual([{ at: 0, error: "non-canonical" }]);
    expect(r.failure).toEqual({ cell: 0, code: "tally-missing" });
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
      records,
      1,
    );
    expect(r.ok).toBe(true);
    expect(r.cells[0]?.passing).toEqual([{ at: 0, signer: null }]);
  });
});
