import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  aggregateCell,
  aggregateHash,
  checkTally,
  type CommittedVote,
  encodeTallyOpening,
  identityKey,
  openCell,
  type Share,
  shareVote,
  signTallyOpening,
  sumShares,
  type TallyElection,
} from "@abolishus/crypto";
import { countedResults, type FixedCountedTally } from "../src/index.ts";

// The results of a decided counted tally (docs/spec/verifier.md, Results
// from the counted tally). Every expected count here is summed from the
// votes the test casts, never read back from the code under test.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

/** Fixed per-election signing secrets for seats 1 to 3 (test data, never keys). */
const SECRETS = [1, 2, 3].map((i) => Uint8Array.from({ length: 32 }, (_, b) => (b === 31 ? i : 7)));

type Votes = readonly (readonly (0 | 1)[])[];

/** A cell's ballots and the honest opening its seats combine. */
function honestCell(rules: TallyElection["rules"], votes: Votes) {
  const validity = {
    optionCount: rules.optionCount,
    threshold: rules.threshold,
    panelSize: rules.panelSize,
    minSelections: 0,
    maxSelections: rules.optionCount,
  };
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
  return {
    ballots,
    opening: opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint })),
  };
}

/**
 * A decided tally over `cells` (each cell's tier and votes), and seat
 * `signer`'s signed opening of every cell but those in `unopened`.
 */
function tallyOf(
  rules: TallyElection["rules"],
  cells: readonly { readonly tier: number; readonly votes: Votes }[],
  signer = 1,
  unopened: ReadonlySet<number> = new Set(),
) {
  const definitionHash = new Uint8Array(32).fill(9);
  const election: TallyElection = {
    definitionHash,
    rules,
    registered: [1, 2, 3].map((index) => ({
      index,
      signingKey: identityKey(SECRETS[index - 1] as Uint8Array),
    })),
  };
  const honest = cells.map((c) => honestCell(rules, c.votes));
  const aggregates = honest.map((c) => aggregateCell(rules, c.ballots));
  const tally: FixedCountedTally = {
    ok: true,
    election,
    aggregates,
    counted: cells.map((c) => c.votes.length),
    tiers: cells.map((c) => c.tier),
    pinned: 1,
  };
  const payloads = honest.flatMap((c, cell) =>
    unopened.has(cell)
      ? []
      : [
          encodeTallyOpening(
            signTallyOpening(SECRETS[signer - 1] as Uint8Array, {
              definition_hash: definitionHash,
              cell,
              aggregate_hash: aggregateHash(aggregates[cell] as (typeof aggregates)[number]),
              signer,
              opening: c.opening,
            }),
          ),
        ],
  );
  return { tally, payloads, ballots: honest.map((c) => c.ballots) };
}

/** Per option, how many of `votes` chose it, as decimal strings. */
const sums = (votes: Votes, m: number) =>
  Array.from({ length: m }, (_, j) => String(votes.filter((v) => v[j] === 1).length));

const RULES = { optionCount: 2, threshold: 2, panelSize: 3 } as const;

describe("countedResults", () => {
  test("every cell's counts, and each tier's summed from its own cells only", () => {
    const cells = [
      {
        tier: 0,
        votes: [
          [1, 0],
          [1, 0],
          [0, 1],
        ] as Votes,
      },
      { tier: 0, votes: [[1, 1]] as Votes },
      {
        tier: 2,
        votes: [
          [0, 1],
          [0, 0],
        ] as Votes,
      },
    ];
    const { tally, payloads } = tallyOf(RULES, cells, 2);
    const r = countedResults(tally, payloads);
    expect(r.ok).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.cells).toEqual(
      cells.map((c, cell) => ({
        cell,
        tier: c.tier,
        counted: c.votes.length,
        counts: sums(c.votes, 2),
        signers: [2],
      })),
    );
    // Tiers are never blended: tier 2's counts are its one cell's.
    expect(r.tiers).toEqual([
      { tier: 0, counted: 4, counts: ["3", "2"] },
      { tier: 2, counted: 2, counts: ["0", "1"] },
    ]);
    expect(r.questions).toBeUndefined();
  });

  test("a cell no opening opened yet is tally-missing, and its tier has no counts", () => {
    const cells = [
      { tier: 0, votes: [[1, 0]] as Votes },
      { tier: 1, votes: [[0, 1]] as Votes },
      { tier: 1, votes: [[1, 0]] as Votes },
    ];
    const { tally, payloads } = tallyOf(RULES, cells, 1, new Set([2]));
    const r = countedResults(tally, payloads);
    expect(r.ok).toBe(false);
    expect(r.failure).toEqual({ cell: 2, code: "tally-missing" });
    expect(r.cells[2]).toEqual({
      cell: 2,
      tier: 1,
      counted: 1,
      code: "tally-missing",
      signers: [],
    });
    expect(r.tiers).toEqual([
      { tier: 0, counted: 1, counts: ["1", "0"] },
      { tier: 1, counted: 2 },
    ]);
  });

  test("each question's slice and its method, never a figure joining two", () => {
    const rules = {
      optionCount: 5,
      threshold: 2,
      panelSize: 3,
      questions: [
        { optionCount: 2, minSelections: 0, maxSelections: 1 },
        { optionCount: 3, minSelections: 0, maxSelections: 3 },
      ],
    };
    const votes: Votes = [
      [1, 0, 1, 1, 0],
      [0, 1, 0, 0, 0],
      [1, 0, 0, 1, 1],
    ];
    const { tally, payloads } = tallyOf(rules, [{ tier: 0, votes }]);
    const r = countedResults(tally, payloads);
    expect(r.ok).toBe(true);
    expect(r.cells[0]?.counts).toEqual(["2", "1", "1", "2", "1"]);
    expect(r.cells[0]?.byQuestion).toEqual([
      ["2", "1"],
      ["1", "2", "1"],
    ]);
    expect(r.tiers[0]?.byQuestion).toEqual(r.cells[0]?.byQuestion);
    expect(r.questions).toEqual([
      { question: 0, options: 2, minSelections: 0, maxSelections: 1, method: "pick one" },
      { question: 1, options: 3, minSelections: 0, maxSelections: 3, method: "pick any" },
    ]);
  });

  test("an undercounted cell fails tally-range rather than showing its opening", () => {
    const { tally, payloads } = tallyOf(RULES, [
      {
        tier: 0,
        votes: [
          [1, 0],
          [1, 1],
        ],
      },
    ]);
    const r = countedResults({ ...tally, counted: [1] }, payloads);
    expect(r.failure).toEqual({ cell: 0, code: "tally-range", option: 0 });
    expect(r.cells[0]?.counts).toBeUndefined();
    expect(r.tiers).toEqual([{ tier: 0, counted: 1 }]);
  });

  test("gives crypto's checkTally verdict over the same ballots, cell by cell", () => {
    fc.assert(
      fc.property(
        fc
          .array(
            fc.record({
              tier: fc.integer({ min: 0, max: 2 }),
              votes: fc.array(
                fc.array(fc.constantFrom<0 | 1>(0, 1), { minLength: 2, maxLength: 2 }),
                {
                  maxLength: 3,
                },
              ),
            }),
            { minLength: 1, maxLength: 3 },
          )
          .chain((cells) =>
            fc.record({
              cells: fc.constant(cells),
              unopened: fc.subarray(cells.map((_, i) => i)),
              signer: fc.integer({ min: 1, max: 3 }),
            }),
          ),
        ({ cells, unopened, signer }) => {
          const { tally, payloads, ballots } = tallyOf(RULES, cells, signer, new Set(unopened));
          const r = countedResults(tally, payloads);
          const expected = checkTally(tally.election, ballots, payloads, 1);
          expect(r.ok).toBe(expected.ok);
          expect(r.ok).toBe(unopened.length === 0);
          r.cells.forEach((c, cell) => {
            const e = expected.cells[cell];
            if (e === undefined) throw new Error("a cell checkTally didn't report");
            expect(c.counts).toEqual(e.ok ? e.counts.map(String) : undefined);
            expect(c.code).toEqual(e.ok ? undefined : e.code);
            if (e.ok) expect(c.counts).toEqual(sums(cells[cell]?.votes ?? [], 2));
          });
          // A tier has counts exactly when every one of its cells opened.
          for (const t of r.tiers) {
            const own = cells.flatMap((c, i) => (c.tier === t.tier ? [i] : []));
            expect(t.counts !== undefined).toBe(own.every((i) => !unopened.includes(i)));
            expect(t.counted).toBe(own.reduce((n, i) => n + (cells[i]?.votes.length ?? 0), 0));
          }
        },
      ),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("refuses a tally without one count and one tier per cell", () => {
    const { tally, payloads } = tallyOf(RULES, [{ tier: 0, votes: [[1, 0]] }]);
    expect(() => countedResults({ ...tally, counted: [] }, payloads)).toThrow(RangeError);
    expect(() => countedResults({ ...tally, tiers: [0, 0] }, payloads)).toThrow(RangeError);
  });
});
