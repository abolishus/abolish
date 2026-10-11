import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  aggregateCell,
  type CellAggregate,
  type CellOpening,
  checkOpening,
  checkSummedShares,
  type CommittedVote,
  decode,
  DecodeError,
  deriveTotal,
  element,
  elementOrIdentity,
  GROUP_ORDER,
  lagrangeAtZero,
  list,
  openCell,
  type Share,
  SHARES,
  shareVote,
  sumShares,
  type TallyRules,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/tally.json comes from an independent Python
// implementation of docs/spec/tally.md (scripts/tally-vectors.py), which
// solves for every coefficient instead of using Lagrange coefficients, so
// these aggregates, verdicts and openings never come from the code under test.

interface CellVector {
  readonly id: string;
  readonly rules: TallyRules;
  readonly ballots: readonly { readonly votes: readonly number[]; readonly vss: string }[];
  readonly trusteeShares: readonly {
    readonly seat: number;
    readonly ballotShares: readonly string[];
    readonly summed: string;
  }[];
  readonly aggregate: string;
  readonly received: readonly {
    readonly seat: number;
    readonly how: string;
    readonly shares: string;
    readonly valid: boolean;
  }[];
  readonly result:
    | {
        readonly ok: true;
        readonly combined: readonly number[];
        readonly lagrange: readonly string[];
        readonly counts: readonly string[];
        readonly randomness: readonly string[];
        readonly excluded: readonly number[];
      }
    | {
        readonly ok: false;
        readonly code: string;
        readonly option?: number;
        readonly excluded: readonly number[];
      };
}

interface Vectors {
  readonly format: string;
  readonly cells: readonly CellVector[];
  readonly openings: readonly {
    readonly id: string;
    readonly cell: string;
    readonly opening: string | null;
    readonly result:
      | { readonly ok: true; readonly counts: readonly string[] }
      | { readonly ok: false; readonly code: string; readonly option?: number };
  }[];
  readonly totals: readonly {
    readonly id: string;
    readonly cells: readonly string[];
    readonly total: readonly string[];
  }[];
}

const vectors = JSON.parse(readFileSync(new URL("tally.json", SPEC_VECTORS), "utf8")) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VSS = list(list(element, 16), 64);
const AGGREGATE = list(list(elementOrIdentity, 16), 64);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const aggregateHex = (a: CellAggregate) =>
  a.map((row) => row.map((x) => toHex(x.toBytes())).join("")).join("");

function expected(r: CellVector["result"]): CellOpening {
  if (!r.ok) return { ...r, code: r.code as "tally-quorum" };
  return {
    ok: true,
    counts: r.counts.map(BigInt),
    randomness: r.randomness.map(BigInt),
    combined: r.combined,
    excluded: r.excluded,
  };
}

describe("tally.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-tally-vectors/1");
    expect(vectors.cells.length).toBeGreaterThan(0);
  });

  test.each(vectors.cells.map((c) => [c.id, c] as const))("%s", (_, c) => {
    const ballots = c.ballots.map((b) => decode(VSS, hex(b.vss)));
    const aggregate = aggregateCell(c.rules, ballots);
    expect(aggregateHex(aggregate)).toBe(aggregateHex(decode(AGGREGATE, hex(c.aggregate))));
    for (const t of c.trusteeShares) {
      const summed = sumShares(
        c.rules,
        t.ballotShares.map((s) => decode(SHARES, hex(s))),
      );
      expect(summed).toEqual(decode(SHARES, hex(t.summed)));
    }
    const posted = new Map<number, readonly Share[]>();
    for (const p of c.received) {
      const shares = decode(SHARES, hex(p.shares));
      posted.set(p.seat, shares);
      expect(checkSummedShares(aggregate, p.seat, shares)).toBe(p.valid);
    }
    expect(openCell(c.rules, ballots, posted)).toEqual(expected(c.result));
    if (c.result.ok)
      expect(lagrangeAtZero(c.result.combined)).toEqual(c.result.lagrange.map(BigInt));
  });

  test.each(vectors.openings.map((o) => [o.id, o] as const))("opening %s", (_, o) => {
    const c = vectors.cells.find((x) => x.id === o.cell);
    if (!c) throw new Error(`no cell ${o.cell}`);
    const ballots = c.ballots.map((b) => decode(VSS, hex(b.vss)));
    // Bytes with no canonical decoding carry no opening.
    let opening: readonly Share[] | undefined;
    try {
      opening = o.opening === null ? undefined : decode(SHARES, hex(o.opening));
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
    }
    const expected = o.result.ok ? { ok: true, counts: o.result.counts.map(BigInt) } : o.result;
    expect(checkOpening(c.rules, ballots, opening)).toEqual(expected);
  });

  test.each(vectors.totals.map((t) => [t.id, t] as const))("total %s", (_, t) => {
    const counts = t.cells.map((id) => {
      const r = vectors.cells.find((c) => c.id === id)?.result;
      if (!r?.ok) throw new Error(`no opening for ${id}`);
      return r.counts.map(BigInt);
    });
    expect(deriveTotal(counts)).toEqual(t.total.map(BigInt));
  });
});

/** An election shape and a cell of honest ballots, shared by `shareVote`. */
const arbCell = fc
  .record({
    m: fc.integer({ min: 1, max: 3 }),
    k: fc.integer({ min: 2, max: 4 }),
    extra: fc.integer({ min: 0, max: 2 }),
  })
  .chain(({ m, k, extra }) =>
    fc.record({
      rules: fc.constant({ optionCount: m, threshold: k, panelSize: k + extra }),
      votes: fc.array(fc.array(fc.constantFrom<0 | 1>(0, 1), { minLength: m, maxLength: m }), {
        maxLength: 4,
      }),
    }),
  );

function honestCell(rules: TallyRules, votes: readonly (readonly (0 | 1)[])[]) {
  const validity = { ...rules, minSelections: 0, maxSelections: rules.optionCount };
  const sharings = votes.map((v) => shareVote(validity, v));
  const ballots: CommittedVote["vss"][] = sharings.map((s) => s.vss);
  const summed = Array.from({ length: rules.panelSize }, (_, i) =>
    sumShares(
      rules,
      sharings.map((s) => s.shares[i] as readonly Share[]),
    ),
  );
  const counts = Array.from({ length: rules.optionCount }, (_, j) =>
    BigInt(votes.reduce((a, v) => a + (v[j] as number), 0)),
  );
  return { ballots, summed, counts };
}

describe("properties", () => {
  test("honest summed shares from any k or more seats open the cell to its counts", () => {
    fc.assert(
      fc.property(
        arbCell.chain((c) =>
          fc.record({
            cell: fc.constant(c),
            seats: fc.subarray(
              Array.from({ length: c.rules.panelSize }, (_, i) => i + 1),
              { minLength: c.rules.threshold },
            ),
          }),
        ),
        ({ cell, seats }) => {
          const { ballots, summed, counts } = honestCell(cell.rules, cell.votes);
          const posted = new Map(seats.map((s) => [s, summed[s - 1] as readonly Share[]]));
          const r = openCell(cell.rules, ballots, posted);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.counts).toEqual(counts);
          expect(r.combined).toEqual(
            [...seats].sort((a, b) => a - b).slice(0, cell.rules.threshold),
          );
          expect(r.excluded).toEqual([]);
          // Any other k passing seats interpolate to the same opening.
          const other = [...seats].sort((a, b) => b - a).slice(0, cell.rules.threshold);
          const lambda = lagrangeAtZero(other);
          for (let j = 0; j < cell.rules.optionCount; j++) {
            const at = (pick: (s: Share) => bigint) =>
              other.reduce(
                (acc, seat, q) =>
                  (acc + (lambda[q] as bigint) * pick((summed[seat - 1] as Share[])[j] as Share)) %
                  GROUP_ORDER,
                0n,
              );
            expect(at((s) => s.v)).toBe(r.counts[j]);
            expect(at((s) => s.r)).toBe(r.randomness[j]);
          }
        },
      ),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("any changed summed share fails the check and is excluded", () => {
    fc.assert(
      fc.property(
        arbCell,
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        fc.bigInt({ min: 1n, max: GROUP_ORDER - 1n }),
        ({ rules, votes }, seatPick, optionPick, onV, delta) => {
          const { ballots, summed } = honestCell(rules, votes);
          const seat = (seatPick % rules.panelSize) + 1;
          const j = optionPick % rules.optionCount;
          const bad = (summed[seat - 1] as Share[]).map((s, o) =>
            o !== j
              ? s
              : onV
                ? { v: (s.v + delta) % GROUP_ORDER, r: s.r }
                : { v: s.v, r: (s.r + delta) % GROUP_ORDER },
          );
          const aggregate = aggregateCell(rules, ballots);
          expect(checkSummedShares(aggregate, seat, bad)).toBe(false);
          const posted = new Map(summed.map((s, i) => [i + 1, i + 1 === seat ? bad : s]));
          const r = openCell(rules, ballots, posted);
          expect(r.excluded).toEqual([seat]);
        },
      ),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("a sum over any other set of ballots fails against the cell's aggregate", () => {
    fc.assert(
      fc.property(
        arbCell.filter((c) => c.votes.length > 0),
        fc.nat(),
        ({ rules, votes }, drop) => {
          const validity = { ...rules, minSelections: 0, maxSelections: rules.optionCount };
          const sharings = votes.map((v) => shareVote(validity, v));
          const ballots = sharings.map((s) => s.vss);
          const d = drop % sharings.length;
          const aggregate = aggregateCell(rules, ballots);
          for (let i = 1; i <= rules.panelSize; i++) {
            const partial = sumShares(
              rules,
              sharings.filter((_, b) => b !== d).map((s) => s.shares[i - 1] as readonly Share[]),
            );
            expect(checkSummedShares(aggregate, i, partial)).toBe(false);
          }
        },
      ),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });
});

describe("checks and inputs", () => {
  const rules: TallyRules = { optionCount: 2, threshold: 2, panelSize: 3 };

  test("fewer than k passing seats is tally-quorum, whatever else was posted", () => {
    const { ballots, summed } = honestCell(rules, [[1, 0]]);
    const posted = new Map([
      [1, summed[0] as readonly Share[]],
      [2, (summed[1] as Share[]).slice(1)],
    ]);
    expect(openCell(rules, ballots, posted)).toEqual({
      ok: false,
      code: "tally-quorum",
      excluded: [2],
    });
  });

  test("tally-range catches a count above the cell's ballots", () => {
    // A vote of 2 can't be shared through shareVote; scale an honest cell of
    // one ballot by two (every commitment doubled, every share doubled).
    const { ballots, summed } = honestCell(rules, [[1, 0]]);
    const doubled = ballots.map((vss) => vss.map((e) => e.map((x) => x.add(x))));
    const posted = new Map(
      summed.map((s, i) => [
        i + 1,
        s.map((x) => ({ v: (2n * x.v) % GROUP_ORDER, r: (2n * x.r) % GROUP_ORDER })),
      ]),
    );
    expect(openCell(rules, doubled, posted)).toEqual({
      ok: false,
      code: "tally-range",
      option: 0,
      excluded: [],
    });
  });

  test("rejects caller errors", () => {
    const { ballots, summed } = honestCell(rules, [[0, 1]]);
    expect(() => openCell(rules, ballots, new Map([[4, summed[0] as Share[]]]))).toThrow(
      RangeError,
    );
    expect(() => openCell(rules, ballots, new Map([[0, summed[0] as Share[]]]))).toThrow(
      RangeError,
    );
    expect(() => aggregateCell({ ...rules, optionCount: 3 }, ballots)).toThrow(RangeError);
    expect(() => aggregateCell({ ...rules, threshold: 1 }, ballots)).toThrow(RangeError);
    expect(() => sumShares(rules, [[{ v: 0n, r: 0n }]])).toThrow(RangeError);
    expect(() =>
      sumShares(rules, [
        [
          { v: GROUP_ORDER, r: 0n },
          { v: 0n, r: 0n },
        ],
      ]),
    ).toThrow(RangeError);
    expect(() => lagrangeAtZero([1, 1])).toThrow(RangeError);
    expect(() => lagrangeAtZero([0, 1])).toThrow(RangeError);
    expect(() => lagrangeAtZero([1, 17])).toThrow(RangeError);
    expect(() => deriveTotal([])).toThrow(RangeError);
    expect(() => deriveTotal([[1n], [1n, 2n]])).toThrow(RangeError);
  });

  test("a summed share that isn't a canonical scalar fails, though it would pass mod ℓ", () => {
    const { ballots, summed } = honestCell(rules, [[1, 0]]);
    const aliased = (summed[0] as Share[]).map((s, j) =>
      j === 0 ? { v: s.v + GROUP_ORDER, r: s.r } : s,
    );
    expect(checkSummedShares(aggregateCell(rules, ballots), 1, aliased)).toBe(false);
    const posted = new Map(summed.map((s, i) => [i + 1, i === 0 ? aliased : s]));
    const r = openCell(rules, ballots, posted);
    expect(r).toMatchObject({ ok: true, combined: [2, 3], excluded: [1], counts: [1n, 0n] });
  });

  test("checkOpening accepts exactly what openCell publishes, and rejects non-scalars", () => {
    const { ballots, summed } = honestCell(rules, [
      [1, 0],
      [0, 1],
      [1, 0],
    ]);
    const r = openCell(rules, ballots, new Map(summed.map((s, i) => [i + 1, s])));
    if (!r.ok) throw new Error("honest cell failed");
    const opening = r.counts.map((v, j) => ({ v, r: r.randomness[j] as bigint }));
    expect(checkOpening(rules, ballots, opening)).toEqual({ ok: true, counts: [2n, 1n] });
    const aliased = opening.map((s, j) => (j === 0 ? { v: s.v + GROUP_ORDER, r: s.r } : s));
    expect(checkOpening(rules, ballots, aliased)).toEqual({ ok: false, code: "tally-missing" });
    expect(checkOpening(rules, ballots, undefined)).toEqual({ ok: false, code: "tally-missing" });
  });

  test("an empty cell opens to zero from (0, 0) sums", () => {
    const zero = [
      { v: 0n, r: 0n },
      { v: 0n, r: 0n },
    ];
    const r = openCell(
      rules,
      [],
      new Map([
        [2, zero],
        [3, zero],
      ]),
    );
    expect(r).toEqual({
      ok: true,
      counts: [0n, 0n],
      randomness: [0n, 0n],
      combined: [2, 3],
      excluded: [],
    });
  });
});
