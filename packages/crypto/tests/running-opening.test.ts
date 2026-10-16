import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  aggregateCell,
  aggregateHash,
  boardRunningOpenings,
  type CommittedVote,
  decode,
  DecodeError,
  decodeRunningOpening,
  element,
  encodeRunningOpening,
  identityKey,
  list,
  openCell,
  readRunningOpenings,
  type ReleaseSchedule,
  type RunningOpening,
  type RunningOpeningsRead,
  runningOpeningStatement,
  type Share,
  shareVote,
  signRunningOpening,
  sumShares,
  type TallyElection,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/running-opening.json comes from an independent Python
// implementation of docs/spec/tally.md, Running opening record
// (scripts/running-opening-vectors.py, with its own strict decoder, P-256
// ECDSA, running sets and boarding rule), so these bytes and verdicts never
// come from the code under test.

interface Vectors {
  readonly format: string;
  readonly tag: string;
  readonly recordType: string;
  readonly version: number;
  readonly election: {
    readonly definitionHash: string;
    readonly rules: TallyElection["rules"];
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
    readonly chosen: readonly { readonly tier: number; readonly snapshots: readonly number[] }[];
    readonly chosenIsInput: boolean;
    readonly cells: readonly {
      readonly cell: number;
      readonly tier: number;
      readonly ballots: readonly { readonly enters: number; readonly vss: string }[];
      readonly aggregateHashes: readonly {
        readonly snapshot: number;
        readonly aggregateHash: string;
      }[];
    }[];
  };
  readonly records: readonly {
    readonly id: string;
    readonly signingSecret: string;
    readonly signingKey: string;
    readonly definitionHash: string;
    readonly cell: number;
    readonly snapshot: number;
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
  readonly attributions: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly signer: number | null;
  }[];
  readonly boards: readonly {
    readonly id: string;
    readonly payloads: readonly string[];
    readonly result: unknown;
  }[];
  readonly boardings: readonly {
    readonly id: string;
    readonly offered: readonly string[];
    readonly boarded: readonly boolean[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("running-opening.json", SPEC_VECTORS), "utf8"),
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

const cellBallots = vectors.election.cells.map((c) =>
  c.ballots.map((b) => ({
    enters: b.enters,
    vss: decode(VSS, hex(b.vss)) as CommittedVote["vss"],
  })),
);

/** `R_{q,c}`: the ballots that entered at or before `q`, since running sets only grow. */
const runningSet = (cell: number, snapshot: number) =>
  (cellBallots[cell] ?? []).filter((b) => b.enters <= snapshot).map((b) => b.vss);

const schedule: ReleaseSchedule = {
  cellTiers: vectors.election.cells.map((c) => c.tier),
  chosen: new Map(vectors.election.chosen.map((t) => [t.tier, t.snapshots])),
  runningSet,
};

/** The read in the vector file's shape: counts as decimal strings. */
const asVector = (r: RunningOpeningsRead) => ({
  ...r,
  releases: r.releases.map((x) => ({
    ...x,
    counts: x.counts === null ? null : x.counts.map((v) => v.toString()),
  })),
});

describe("running-opening.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-running-opening-vectors/1");
    expect(vectors.tag).toBe("abolish/v1/sig/running-opening");
    expect(vectors.recordType).toBe("0x0018");
    expect(vectors.version).toBe(1);
    // The release choice is part 2b's; here the chosen releases are inputs.
    expect(vectors.election.chosenIsInput).toBe(true);
  });

  test("each running set's aggregate hash is the spec's", () => {
    for (const c of vectors.election.cells)
      for (const a of c.aggregateHashes)
        expect(
          toHex(aggregateHash(aggregateCell(election.rules, runningSet(c.cell, a.snapshot)))),
        ).toBe(a.aggregateHash);
  });

  test.each(vectors.records)("$id is re-made byte for byte", (v) => {
    const secret = hex(v.signingSecret);
    expect(toHex(identityKey(secret))).toBe(v.signingKey);
    const statement = {
      definition_hash: hex(v.definitionHash),
      cell: v.cell,
      snapshot: v.snapshot,
      aggregate_hash: hex(v.aggregateHash),
      signer: v.signer,
      opening: v.opening.map((s) => ({ v: BigInt(s.v), r: BigInt(s.r) })),
    };
    expect(toHex(runningOpeningStatement(statement))).toBe(v.message);
    const signed = signRunningOpening(secret, statement);
    expect(toHex(signed.signature)).toBe(v.signature);
    expect(toHex(encodeRunningOpening(signed))).toBe(v.encoding);
    expect(decodeRunningOpening(hex(v.encoding), 1)).toEqual(signed);
  });

  test.each(vectors.decodeErrors)("$id is rejected with $error at $offset", (v) => {
    let caught: unknown;
    try {
      decodeRunningOpening(hex(v.encoding), 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    expect((caught as DecodeError).code).toBe(v.error);
    expect((caught as DecodeError).offset).toBe(v.offset);
  });

  test.each(vectors.attributions)("$id is attributed to $signer", (v) => {
    const [entry] = readRunningOpenings(election, schedule, [hex(v.encoding)]).entries;
    expect(entry !== undefined && "signer" in entry ? entry.signer : "rejected").toBe(v.signer);
  });

  test.each(vectors.boards)("board $id", (v) => {
    const payloads = v.payloads.map((b) => hex(b));
    expect(asVector(readRunningOpenings(election, schedule, payloads))).toEqual(v.result);
  });

  test.each(vectors.boardings)("boarding $id", (v) => {
    const offered = v.offered.map((b) => hex(b));
    expect(boardRunningOpenings(election, schedule, [], offered)).toEqual(v.boarded);
    // What is already on the board counts as boarded: offered again, each is refused.
    const boarded = offered.filter((_, i) => v.boarded[i]);
    expect(boardRunningOpenings(election, schedule, boarded, boarded).every((b) => !b)).toBe(true);
  });
});

/** Fixed per-election signing secrets for seats 1 to 3 (test data, never keys). */
const SECRETS = [1, 2, 3].map((i) => Uint8Array.from({ length: 32 }, (_, b) => (b === 31 ? i : 7)));

const REGISTERED = [1, 2, 3].map((index) => ({
  index,
  signingKey: identityKey(SECRETS[index - 1] as Uint8Array),
}));

/** An honest live cell: each ballot's snapshot of entry, its VSS, and every seat's shares. */
function honestCell(rules: TallyElection["rules"], votes: readonly (readonly (0 | 1)[])[]) {
  const validity = { ...rules, minSelections: 0, maxSelections: rules.optionCount };
  return votes.map((v) => shareVote(validity, v));
}

/** Seat `signer`'s signed opening of `R_{q,c}`, from every seat's summed shares, as a node makes it. */
function honestOpening(
  rules: TallyElection["rules"],
  definitionHash: Uint8Array,
  sharings: readonly ReturnType<typeof shareVote>[],
  cell: number,
  snapshot: number,
  signer: number,
): RunningOpening {
  const ballots = sharings.map((s) => s.vss);
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
  if (!opened.ok) throw new Error("an honest running set opens");
  return signRunningOpening(SECRETS[signer - 1] as Uint8Array, {
    definition_hash: definitionHash,
    cell,
    snapshot,
    aggregate_hash: aggregateHash(aggregateCell(rules, ballots)),
    signer,
    opening: opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint })),
  });
}

const arbLive = fc
  .record({
    m: fc.integer({ min: 2, max: 3 }),
    k: fc.integer({ min: 2, max: 3 }),
    signer: fc.integer({ min: 1, max: 3 }),
    snapshots: fc.uniqueArray(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 3 }),
  })
  .chain(({ m, k, signer, snapshots }) =>
    fc.record({
      rules: fc.constant({ optionCount: m, threshold: k, panelSize: 3 }),
      signer: fc.constant(signer),
      snapshots: fc.constant([...snapshots].sort((a, b) => a - b)),
      definitionHash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
      // Each ballot's vote and the snapshot it enters at.
      ballots: fc.array(
        fc.record({
          vote: fc.array(fc.constantFrom<0 | 1>(0, 1), { minLength: m, maxLength: m }),
          enters: fc.integer({ min: 1, max: 6 }),
        }),
        { maxLength: 4 },
      ),
    }),
  );

function honestLive(input: {
  rules: TallyElection["rules"];
  signer: number;
  snapshots: number[];
  definitionHash: Uint8Array;
  ballots: { vote: (0 | 1)[]; enters: number }[];
}) {
  const el: TallyElection = {
    definitionHash: input.definitionHash,
    rules: input.rules,
    registered: REGISTERED,
  };
  const sharings = honestCell(
    input.rules,
    input.ballots.map((b) => b.vote),
  );
  const at = (q: number) => sharings.filter((_, i) => (input.ballots[i]?.enters ?? 0) <= q);
  const sched: ReleaseSchedule = {
    cellTiers: [0],
    chosen: new Map([[0, input.snapshots]]),
    runningSet: (_, q) => at(q).map((s) => s.vss),
  };
  const records = input.snapshots.map((q) =>
    honestOpening(input.rules, input.definitionHash, at(q), 0, q, input.signer),
  );
  const counts = (q: number) =>
    Array.from({ length: input.rules.optionCount }, (_, j) =>
      BigInt(input.ballots.filter((b) => b.enters <= q && b.vote[j] === 1).length),
    );
  return { el, sched, records, counts };
}

describe("properties", { timeout: 120_000 }, () => {
  test("decode(encode(x)) = x and encode(decode(b)) = b", () => {
    fc.assert(
      fc.property(arbLive, (input) => {
        for (const o of honestLive(input).records) {
          const b = encodeRunningOpening(o);
          expect(decodeRunningOpening(b, 1)).toEqual(o);
          expect(encodeRunningOpening(decodeRunningOpening(b, 1))).toEqual(b);
          // 141 + 64·m' bytes.
          expect(b.length).toBe(141 + 64 * o.opening.length);
        }
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("honest signed openings of every chosen release pass with the running totals, attributed to their signer, and are boarded", () => {
    fc.assert(
      fc.property(arbLive, (input) => {
        const { el, sched, records, counts } = honestLive(input);
        const payloads = records.map(encodeRunningOpening);
        const read = readRunningOpenings(el, sched, payloads);
        expect(read.entries).toEqual(
          input.snapshots.map((snapshot, at) => ({
            at,
            kind: "release",
            snapshot,
            cell: 0,
            signer: input.signer,
            passes: true,
          })),
        );
        expect(read.releases).toEqual(
          input.snapshots.map((snapshot) => ({ snapshot, cell: 0, counts: counts(snapshot) })),
        );
        expect(boardRunningOpenings(el, sched, [], payloads).every(Boolean)).toBe(true);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("a signed release moved to another snapshot, cell or definition is never attributed to its signer", () => {
    fc.assert(
      fc.property(
        arbLive,
        fc.integer({ min: 1, max: 0xffff_ffff }),
        fc.integer({ min: 1, max: 255 }),
        (input, snapshot, cell) => {
          const { el, sched, records } = honestLive(input);
          const o = records[0] as RunningOpening;
          const moved: RunningOpening[] = [
            ...(snapshot === o.snapshot ? [] : [{ ...o, snapshot }]),
            { ...o, cell },
            { ...o, definition_hash: o.definition_hash.map((x, i) => (i === 0 ? x ^ 1 : x)) },
          ];
          for (const m of moved) {
            const [entry] = readRunningOpenings(el, sched, [encodeRunningOpening(m)]).entries;
            expect(entry !== undefined && "signer" in entry && entry.signer).toBe(null);
          }
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("any single-byte change to a boardable record is refused", () => {
    // The vector file's first record, which the boarding vectors board.
    const b = hex((vectors.records[0] as Vectors["records"][number]).encoding);
    expect(boardRunningOpenings(election, schedule, [], [b])).toEqual([true]);
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 1, max: 255 }), (pos, flip) => {
        const changed = Uint8Array.from(b);
        const i = pos % b.length;
        changed[i] = (changed[i] as number) ^ flip;
        // Every byte before the signature is signed, header included; a
        // changed signature doesn't decode (high s) or doesn't verify.
        expect(boardRunningOpenings(election, schedule, [], [changed])).toEqual([false]);
      }),
      { numRuns },
    );
  });

  test("a second opening per seat, release and cell is refused; another seat's is boarded", () => {
    fc.assert(
      fc.property(arbLive, (input) => {
        const { el, sched, records } = honestLive(input);
        const first = records[0] as RunningOpening;
        const other = (input.signer % 3) + 1;
        const theirs = signRunningOpening(SECRETS[other - 1] as Uint8Array, {
          ...first,
          signer: other,
        });
        const payloads = [first, first, theirs].map(encodeRunningOpening);
        expect(boardRunningOpenings(el, sched, [], payloads)).toEqual([true, false, true]);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});

describe("arguments", () => {
  test("a definition hash of another length, no cells or a snapshot outside u32 throws", () => {
    const short = { ...election, definitionHash: new Uint8Array(31) };
    expect(() => readRunningOpenings(short, schedule, [])).toThrow(RangeError);
    expect(() => readRunningOpenings(election, { ...schedule, cellTiers: [] }, [])).toThrow(
      RangeError,
    );
    for (const q of [0, 2 ** 32, 1.5])
      expect(() =>
        boardRunningOpenings(election, { ...schedule, chosen: new Map([[0, [q]]]) }, [], []),
      ).toThrow(RangeError);
  });
});
