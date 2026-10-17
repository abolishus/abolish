import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  aggregateCell,
  aggregateHash,
  checkOpening,
  checkTally,
  type CommittedVote,
  decode,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV6,
  deriveTotal,
  element,
  type ElectionDefinitionV5,
  encodeTallyOpening,
  GROUP_ORDER,
  identityKey,
  list,
  openCell,
  type QuestionRules,
  questionResults,
  type Share,
  shareVote,
  shareVoteV3,
  signTallyOpening,
  sumShares,
  type TallyElection,
  type TallyRules,
  tallyRules,
} from "../src/index.ts";
import { firstQuestionOutside } from "../src/tally.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/tally-questions.json, printed by scripts/ballot-v3-vectors.py
// (an independent Python reading of docs/spec/tally.md, Opening checks), run
// through the production tally: the rules from the decoded version-5
// definition, each cell's aggregate, and every verdict, through both the
// trustee's own check (`checkOpening`) and the verifier's (`checkTally`), so
// tally-question-range's verdicts never come from the code under test (T-29,
// T-28, T-36).

const numRuns = Number(process.env.FC_NUM_RUNS ?? 100);

interface File {
  readonly election: {
    readonly definition: string;
    readonly definitionHash: string;
    readonly questions: readonly (QuestionRules & { readonly offset: number })[];
    readonly optionTotal: number;
    readonly threshold: number;
    readonly panelSize: number;
  };
  readonly cells: readonly {
    readonly id: string;
    readonly ballots: readonly string[];
    readonly aggregate: readonly string[];
    readonly opening: readonly { readonly v: string; readonly r: string }[];
    readonly result:
      | "ok"
      | { readonly code: string; readonly option?: number; readonly question?: number };
  }[];
}

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;

const file = read<File>("tally-questions.json");
const VSS = list(list(element, 16), 64);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const definition = decodeElectionDefinitionV5(hex(file.election.definition));
const rules = tallyRules({ version: 5, value: definition });

const SECRETS = [1, 2, 3].map((i) => Uint8Array.from({ length: 32 }, (_, b) => (b === 31 ? i : 9)));

/** One cell's openings, signed by seat 1, through the verifier's check of the board. */
function verifierVerdict(
  r: TallyRules,
  definitionHash: Uint8Array,
  ballots: readonly CommittedVote["vss"][],
  opening: readonly Share[],
) {
  const election: TallyElection = {
    definitionHash,
    rules: r,
    registered: [1, 2, 3].map((index) => ({
      index,
      signingKey: identityKey(SECRETS[index - 1] as Uint8Array),
    })),
  };
  const record = encodeTallyOpening(
    signTallyOpening(SECRETS[0] as Uint8Array, {
      definition_hash: definitionHash,
      cell: 0,
      aggregate_hash: aggregateHash(aggregateCell(r, ballots)),
      signer: 1,
      opening,
    }),
  );
  return checkTally(election, [ballots], [record], 1);
}

describe("tally-questions.json (docs/spec/tally.md, Opening checks)", () => {
  test("the rules come from the registered version-5 definition", () => {
    expect(rules).toEqual({
      optionCount: file.election.optionTotal,
      threshold: file.election.threshold,
      panelSize: file.election.panelSize,
      questions: file.election.questions.map(({ optionCount, minSelections, maxSelections }) => ({
        optionCount,
        minSelections,
        maxSelections,
      })),
    });
  });

  test.each(file.cells.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const ballots = c.ballots.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]);
    const aggregate = aggregateCell(rules, ballots);
    expect(aggregate.map((row) => toHex((row[0] as (typeof row)[0]).toBytes()))).toEqual(
      c.aggregate,
    );
    const opening = c.opening.map((x) => ({ v: BigInt(x.v), r: BigInt(x.r) }));
    const counts = opening.map((s) => s.v);
    const trustee = checkOpening(rules, ballots, opening);
    const verifier = verifierVerdict(rules, hex(file.election.definitionHash), ballots, opening);
    if (c.result === "ok") {
      expect(trustee).toEqual({ ok: true, counts });
      expect(verifier.ok).toBe(true);
      expect(verifier.cells[0]).toMatchObject({ ok: true, counts });
      // Each question's result is its slice at its options.
      expect(questionResults(rules, counts)).toEqual(
        file.election.questions.map((q) => counts.slice(q.offset, q.offset + q.optionCount)),
      );
    } else {
      expect(trustee).toEqual({ ok: false, ...c.result });
      expect(verifier.ok).toBe(false);
      expect(verifier.failure).toEqual({ cell: 0, ...c.result });
    }
  });

  test("tally-opening runs for every option before tally-range", () => {
    // range-before-question-range fails tally-range at option 0; with option
    // 5's randomness changed it must fail tally-opening at option 5 instead,
    // in the spec's order, for the trustee's check and the verifier's alike.
    const c = file.cells.find((x) => x.id === "range-before-question-range");
    if (c === undefined) throw new Error("no range-before-question-range cell");
    const ballots = c.ballots.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]);
    const opening = c.opening.map((x, j) => ({
      v: BigInt(x.v),
      r: j === 5 ? (BigInt(x.r) + 1n) % GROUP_ORDER : BigInt(x.r),
    }));
    expect(checkOpening(rules, ballots, opening)).toEqual({
      ok: false,
      code: "tally-opening",
      option: 5,
    });
    expect(
      verifierVerdict(rules, hex(file.election.definitionHash), ballots, opening).failure,
    ).toEqual({ cell: 0, code: "tally-opening", option: 5 });
  });

  test("without the questions, the cells failing only tally-question-range would pass", () => {
    // The mutation the check guards against: a tally over the flat options
    // alone admits every question count from 0 to |S_c| times its width.
    const flat: TallyRules = {
      optionCount: rules.optionCount,
      threshold: rules.threshold,
      panelSize: rules.panelSize,
    };
    const failing = file.cells.filter(
      (c) => c.result !== "ok" && c.result.code === "tally-question-range",
    );
    expect(failing.map((c) => c.id)).toEqual(["over-question-0", "under-question-3"]);
    for (const c of failing) {
      const ballots = c.ballots.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]);
      const opening = c.opening.map((x) => ({ v: BigInt(x.v), r: BigInt(x.r) }));
      expect(checkOpening(flat, ballots, opening).ok).toBe(true);
      expect(checkOpening(rules, ballots, opening).ok).toBe(false);
    }
  });
});

describe("tallyRules", () => {
  const first = (name: string, pick: (v: { id: string; encoding: string }) => boolean) => {
    const v = read<{ vectors: readonly { id: string; encoding: string }[] }>(name).vectors.find(
      pick,
    );
    if (v === undefined) throw new Error(`no vector in ${name}`);
    return hex(v.encoding);
  };

  test("versions 1, 3 and 4 give one question over every option, with no question limits", () => {
    for (const [name, id] of [
      ["election-definition.json", "definition-typical"],
      ["election-definition-v3.json", "definition-v3-typical"],
      ["election-definition-v4.json", "definition-v4-typical"],
    ] as const) {
      const record = decodeElectionDefinitionRecord(first(name, (v) => v.id === id));
      const r = tallyRules(record);
      expect(r).toEqual({
        optionCount: record.value.option_count,
        threshold: record.value.threshold,
        panelSize: record.value.panel_size,
      });
      const counts = Array.from({ length: r.optionCount }, (_, j) => BigInt(j));
      expect(questionResults(r, counts)).toEqual([counts]);
    }
  });

  // election-definition-v6.json's own values, not the decoder's, give the
  // expected rules; its ill-formed vectors are refused whatever their panels.
  interface V6Vector {
    readonly id: string;
    readonly encoding: string;
    readonly illFormed?: string;
    readonly value?: {
      readonly questions: readonly {
        readonly option_count: string;
        readonly min_selections: string;
        readonly max_selections: string;
      }[];
      readonly threshold: string;
      readonly panel_size: string;
      readonly author_keys: readonly string[];
    };
  }
  const v6 = read<{ vectors: readonly V6Vector[] }>("election-definition-v6.json").vectors.filter(
    (v) => v.value !== undefined,
  );

  test("a version-6 definition without an author panel takes its questions, k and n, as version 5's does", () => {
    const sole = v6.filter((v) => v.illFormed === undefined && v.value?.author_keys.length === 0);
    expect(sole.length).toBeGreaterThanOrEqual(3);
    for (const v of sole) {
      const value = v.value as NonNullable<V6Vector["value"]>;
      const questions = value.questions.map((q) => ({
        optionCount: Number(q.option_count),
        minSelections: Number(q.min_selections),
        maxSelections: Number(q.max_selections),
      }));
      expect(tallyRules({ version: 6, value: decodeElectionDefinitionV6(hex(v.encoding)) })).toEqual(
        {
          optionCount: questions.reduce((t, q) => t + q.optionCount, 0),
          threshold: Number(value.threshold),
          panelSize: Number(value.panel_size),
          questions,
        },
      );
    }
  });

  test("a version-6 definition with an author panel is refused: its halves are tallied per panel", () => {
    const paired = v6.filter((v) => v.illFormed === undefined && v.value?.author_keys.length !== 0);
    expect(paired.length).toBeGreaterThanOrEqual(3);
    for (const v of paired)
      expect(() =>
        tallyRules({ version: 6, value: decodeElectionDefinitionV6(hex(v.encoding)) }),
      ).toThrow(/tallied per panel/);
  });

  test("a version-6 definition that isn't well-formed is refused, with or without an author panel", () => {
    const bad = v6.filter((v) => v.illFormed !== undefined);
    expect(bad.some((v) => v.value?.author_keys.length === 0)).toBe(true);
    for (const v of bad)
      expect(() =>
        tallyRules({ version: 6, value: decodeElectionDefinitionV6(hex(v.encoding)) }),
      ).toThrow(/isn't well-formed/);
  });

  test("a version-5 definition that isn't well-formed is refused", () => {
    const bad = read<{
      vectors: readonly { id: string; encoding: string; illFormed?: string }[];
    }>("election-definition-v5.json").vectors.filter(
      (v) => v.illFormed === "selections" || v.illFormed === "option-count",
    );
    let refused = 0;
    for (const v of bad) {
      let value: ElectionDefinitionV5;
      try {
        value = decodeElectionDefinitionV5(hex(v.encoding));
      } catch {
        continue; // a layout no decoder admits never reaches the tally
      }
      expect(() => tallyRules({ version: 5, value })).toThrow(RangeError);
      refused++;
    }
    expect(refused).toBeGreaterThan(5);
  });

  test("question lists that don't partition the options are refused", () => {
    const base = { threshold: 2, panelSize: 3 };
    const q = (optionCount: number, minSelections: number, maxSelections: number) => ({
      optionCount,
      minSelections,
      maxSelections,
    });
    for (const bad of [
      { ...base, optionCount: 5, questions: [q(2, 0, 1), q(2, 0, 2)] },
      { ...base, optionCount: 3, questions: [q(2, 0, 1), q(2, 0, 2)] },
      { ...base, optionCount: 2, questions: [] },
      { ...base, optionCount: 2, questions: [q(2, 2, 1)] },
      { ...base, optionCount: 2, questions: [q(2, 0, 3)] },
      { ...base, optionCount: 2, questions: [q(2, -1, 1)] },
      { ...base, optionCount: 2, questions: [q(2, 0, 1.5)] },
    ])
      expect(() => checkOpening(bad, [], undefined)).toThrow();
  });
});

describe("questionResults and firstQuestionOutside", () => {
  test("slices the counts at each question's options, in order", () => {
    expect(questionResults(rules, [1n, 0n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n])).toEqual([
      [1n, 0n],
      [2n, 3n, 4n],
      [5n, 6n, 7n],
      [8n, 9n, 10n],
    ]);
    expect(() => questionResults(rules, [1n])).toThrow(RangeError);
  });

  test("the limits are inclusive at min · |S_c| and max · |S_c|", () => {
    // Questions: pick one of 2 (0–1), any of 3 (0–3), up to 2 of 3 (0–2), exactly 2 of 3 (2–2).
    const at = (counts: readonly bigint[], ballots: number) =>
      firstQuestionOutside(rules, ballots, counts);
    expect(at([1n, 1n, 2n, 2n, 2n, 2n, 1n, 1n, 2n, 1n, 1n], 2)).toBeNull();
    expect(at([2n, 1n, 2n, 2n, 2n, 2n, 1n, 1n, 2n, 1n, 1n], 2)).toBe(0);
    expect(at([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 2n, 1n, 1n], 2)).toBeNull();
    expect(at([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 2n, 1n, 2n], 2)).toBe(3);
    expect(at([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 2n, 1n, 0n], 2)).toBe(3);
    expect(at([0n, 0n, 0n, 0n, 0n, 3n, 0n, 0n, 2n, 1n, 1n], 2)).toBeNull();
    expect(at([0n, 0n, 0n, 0n, 0n, 3n, 2n, 0n, 2n, 1n, 1n], 2)).toBe(2);
    expect(
      at(
        Array.from({ length: 11 }, () => 0n),
        0,
      ),
    ).toBeNull();
  });
});

describe("properties over honest multi-question cells", () => {
  // Up to four questions of up to four options, each with random limits, and
  // up to four ballots within them, shared under ballot version 3's rules.
  const arbQuestion = fc.integer({ min: 2, max: 4 }).chain((m) =>
    fc.tuple(fc.integer({ min: 0, max: m }), fc.integer({ min: 0, max: m })).map(([a, b]) => ({
      optionCount: m,
      minSelections: Math.min(a, b),
      maxSelections: Math.max(1, Math.max(a, b)),
    })),
  );
  const arbVote = (q: QuestionRules) =>
    fc.integer({ min: q.minSelections, max: q.maxSelections }).chain((count) =>
      fc
        .shuffledSubarray(
          Array.from({ length: q.optionCount }, (_, i) => i),
          { minLength: count, maxLength: count },
        )
        .map((picked) =>
          Array.from({ length: q.optionCount }, (_, i) => (picked.includes(i) ? 1 : 0) as 0 | 1),
        ),
    );
  const arbCell = fc
    .record({
      questions: fc.array(arbQuestion, { minLength: 1, maxLength: 4 }),
      k: fc.integer({ min: 2, max: 3 }),
    })
    .chain(({ questions, k }) =>
      fc.record({
        questions: fc.constant(questions),
        k: fc.constant(k),
        votes: fc.array(
          fc.tuple(...questions.map(arbVote)).map((qs) => qs.flat()),
          {
            maxLength: 4,
          },
        ),
      }),
    );

  test("an honest cell opens to its counts, passes every check and slices into each question's result", () => {
    fc.assert(
      fc.property(arbCell, ({ questions, k, votes }) => {
        const optionCount = questions.reduce((t, q) => t + q.optionCount, 0);
        const r: TallyRules = { optionCount, threshold: k, panelSize: k + 1, questions };
        const sharings = votes.map((v) =>
          shareVoteV3({ questions, threshold: k, panelSize: k + 1 }, v),
        );
        const ballots = sharings.map((s) => s.vss);
        const summed = new Map(
          Array.from({ length: k + 1 }, (_, i) => [
            i + 1,
            sumShares(
              r,
              sharings.map((s) => s.shares[i] as readonly Share[]),
            ),
          ]),
        );
        const opened = openCell(r, ballots, summed);
        const counts = Array.from({ length: optionCount }, (_, j) =>
          BigInt(votes.reduce((a, v) => a + (v[j] as number), 0)),
        );
        expect(opened).toMatchObject({ ok: true, counts });
        if (!opened.ok) return;
        const opening = opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint }));
        expect(checkOpening(r, ballots, opening)).toEqual({ ok: true, counts });
        expect(verifierVerdict(r, new Uint8Array(32).fill(1), ballots, opening).ok).toBe(true);
        const results = questionResults(r, counts);
        expect(results.flat()).toEqual(counts);
        results.forEach((slice, q) => {
          const { minSelections, maxSelections, optionCount: m } = questions[q] as QuestionRules;
          expect(slice).toHaveLength(m);
          const total = slice.reduce((a, v) => a + v, 0n);
          expect(total >= BigInt(minSelections * votes.length)).toBe(true);
          expect(total <= BigInt(maxSelections * votes.length)).toBe(true);
        });
        // A coarser total over two copies of the cell is per question too.
        expect(questionResults(r, deriveTotal([counts, counts]))).toEqual(
          results.map((s) => s.map((v) => 2n * v)),
        );
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("a trustee's own check refuses to open a cell whose ballots break a question's limits", () => {
    // Pick one of 2, then pick exactly 1 of 2: a flat sharing that selects
    // both options of question 0, which question range proofs would refuse.
    const questions = [
      { optionCount: 2, minSelections: 0, maxSelections: 1 },
      { optionCount: 2, minSelections: 1, maxSelections: 1 },
    ];
    const r: TallyRules = { optionCount: 4, threshold: 2, panelSize: 3, questions };
    const flat = { optionCount: 4, minSelections: 0, maxSelections: 4, threshold: 2, panelSize: 3 };
    for (const [votes, question] of [
      [[1, 1, 1, 0], 0],
      [[1, 0, 0, 0], 1],
      [[0, 0, 1, 1], 1],
    ] as const) {
      const s = shareVote(flat, [...votes]);
      const summed = new Map(
        [1, 2, 3].map((i) => [i, sumShares(r, [s.shares[i - 1] as readonly Share[]])]),
      );
      const opened = openCell(r, [s.vss], summed);
      expect(opened).toEqual({ ok: false, code: "tally-question-range", question, excluded: [] });
      // The same opening, published anyway, fails the verifier's check.
      const flatOpened = openCell({ optionCount: 4, threshold: 2, panelSize: 3 }, [s.vss], summed);
      if (!flatOpened.ok) throw new Error("the flat opening passes");
      const opening = flatOpened.counts.map((v, j) => ({
        v,
        r: flatOpened.randomness[j] as bigint,
      }));
      expect(verifierVerdict(r, new Uint8Array(32).fill(2), [s.vss], opening).failure).toEqual({
        cell: 0,
        code: "tally-question-range",
        question,
      });
    }
  });
});
