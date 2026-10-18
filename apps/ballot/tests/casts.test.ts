import { decodeBallot, encodeBoardEntry } from "@abolishus/crypto";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import {
  type CastAsked,
  castAsAsked,
  type CastRecord,
  newestBlock,
  parseStoredCasts,
  storedCasts,
} from "../src/casts.ts";

// The record of this device's casts in one election and tier (src/casts.ts;
// [[revoting]], Client rule 3): read back only as this client writes it, a
// version-3 ballot record per cast in strictly ascending order of its L1
// block, each with its checked board entry or none, so a damaged record
// can never read as fewer casts than were made (T-45, T-38). Storing them
// in IndexedDB is tests/worker.e2e.ts's.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VECTORS = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/ballot-v3-records.json", import.meta.url),
    "utf8",
  ),
) as { ballots: { encoding: string }[] };

const BALLOT = new Uint8Array(Buffer.from(VECTORS.ballots[0]!.encoding, "hex"));

// After the record header (3), the definition hash (32), the cell (1) and
// the nullifier (32): `l1_ref_number`, a u64.
const L1_AT = 3 + 32 + 1 + 32;

/** The vector's ballot naming L1 block `n`, which decoding doesn't judge. */
function naming(n: bigint): Uint8Array {
  const b = BALLOT.slice();
  new DataView(b.buffer).setBigUint64(L1_AT, n);
  return b;
}

const ENTRY_OVERHEAD = 51;

/** `ballot` naming another definition hash, its first byte flipped. */
function otherDefinition(ballot: Uint8Array): Uint8Array {
  const b = ballot.slice();
  b[3] = (b[3] as number) ^ 1;
  return b;
}
const ELECTION = new Uint8Array(32).fill(0x5e);
const boardedFor = (ballot: Uint8Array, electionId = ELECTION) => ({
  entry: encodeBoardEntry({ election_id: electionId, index: 1n, segment: 0, payload: ballot }, 5),
  link: new Uint8Array(32).fill(9),
});

// Distinct blocks in ascending order, each cast boarded or not.
const casts = fc
  .uniqueArray(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { maxLength: 6 })
  .chain((blocks) =>
    fc.tuple(
      ...blocks
        .toSorted((a, b) => (a < b ? -1 : 1))
        .map((n) =>
          fc.boolean().map((boarded): CastRecord => {
            const ballot = naming(n);
            return boarded
              ? { ballot, l1Number: n, boarded: boardedFor(ballot) }
              : { ballot, l1Number: n };
          }),
        ),
    ),
  );

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  casts: [{ ballot: naming(10n), boarded: null }],
  ...over,
});

describe("the stored casts", () => {
  // Every ballot is decoded twice per run (stored, then read back): at CI's
  // FC_NUM_RUNS this takes several seconds.
  test("round-trip through what is stored, with the block read from each ballot", () => {
    fc.assert(
      fc.property(casts, (list) => {
        expect(parseStoredCasts(storedCasts(list))).toEqual(list);
      }),
      { numRuns },
    );
  }, 120_000);

  test("hand out copies, never the stored arrays", () => {
    const stored = record();
    const [cast] = parseStoredCasts(stored) as CastRecord[];
    cast!.ballot.fill(0);
    expect(parseStoredCasts(stored)).toEqual([{ ballot: naming(10n), l1Number: 10n }]);
  });

  test("an empty list is no casts", () => {
    expect(parseStoredCasts(record({ casts: [] }))).toEqual([]);
    expect(newestBlock([])).toBeUndefined();
  });

  test("the newest block is the last cast's", () => {
    fc.assert(
      fc.property(casts, (list) => {
        const blocks = list.map((c) => c.l1Number);
        expect(newestBlock(list)).toBe(
          blocks.length === 0 ? undefined : blocks.reduce((a, b) => (a > b ? a : b)),
        );
      }),
      { numRuns },
    );
  });

  const ballot = naming(10n);
  // oxlint-disable-next-line no-sparse-arrays -- a hole is what is refused
  const HOLED = [, { ballot, boarded: null }];
  test.each<[string, unknown]>([
    ["not an object", "casts"],
    ["a list", []],
    ["another version", record({ v: 2 })],
    ["version as a string", record({ v: "1" })],
    ["a key missing", { v: 1 }],
    ["a key more", record({ tier: 0 })],
    ["casts not a list", record({ casts: {} })],
    ["a list with a hole", record({ casts: HOLED })],
    [
      "a list with an extra property",
      record({ casts: Object.assign([{ ballot, boarded: null }], { x: 1 }) }),
    ],
    ["a cast without its answer", record({ casts: [{ ballot }] })],
    ["a cast with a key more", record({ casts: [{ ballot, boarded: null, tier: 0 }] })],
    ["a ballot that isn't bytes", record({ casts: [{ ballot: [...ballot], boarded: null }] })],
    [
      "a ballot that doesn't decode",
      record({ casts: [{ ballot: ballot.subarray(0, -1), boarded: null }] }),
    ],
    [
      "a ballot of another record type",
      record({ casts: [{ ballot: Uint8Array.of(0, 4, ...ballot.subarray(2)), boarded: null }] }),
    ],
    [
      "two casts on the same block",
      record({
        casts: [
          { ballot, boarded: null },
          { ballot: naming(10n), boarded: null },
        ],
      }),
    ],
    [
      "casts out of order",
      record({
        casts: [
          { ballot: naming(11n), boarded: null },
          { ballot, boarded: null },
        ],
      }),
    ],
    ["an answer that isn't an object", record({ casts: [{ ballot, boarded: "x" }] })],
    [
      "an answer without its link",
      record({ casts: [{ ballot, boarded: { entry: boardedFor(ballot).entry } }] }),
    ],
    [
      "an answer with a key more",
      record({ casts: [{ ballot, boarded: { ...boardedFor(ballot), index: 1n } }] }),
    ],
    [
      "a link of 31 bytes",
      record({ casts: [{ ballot, boarded: { ...boardedFor(ballot), link: new Uint8Array(31) } }] }),
    ],
    [
      "an entry of another length than the ballot fixes",
      record({
        casts: [
          {
            ballot,
            boarded: {
              ...boardedFor(ballot),
              entry: new Uint8Array(ballot.length + ENTRY_OVERHEAD + 1),
            },
          },
        ],
      }),
    ],
    [
      "an entry carrying other bytes than the cast's",
      record({ casts: [{ ballot, boarded: boardedFor(naming(11n)) }] }),
    ],
    [
      "casts naming two definitions",
      record({
        casts: [
          { ballot, boarded: null },
          { ballot: otherDefinition(naming(11n)), boarded: null },
        ],
      }),
    ],
    [
      "answers naming two elections",
      record({
        casts: [
          { ballot, boarded: boardedFor(ballot) },
          {
            ballot: naming(11n),
            boarded: boardedFor(naming(11n), new Uint8Array(32).fill(0x5f)),
          },
        ],
      }),
    ],
  ])("%s is unreadable", (_, value) => {
    expect(parseStoredCasts(value)).toBeUndefined();
  });

  test("storing casts it would read back otherwise throws", () => {
    const a = { ballot: naming(10n), l1Number: 10n };
    expect(() => storedCasts([a, a])).toThrow(TypeError);
    expect(() => storedCasts([{ ballot: naming(11n), l1Number: 11n }, a])).toThrow(TypeError);
    // A block that isn't the one the ballot names.
    expect(() => storedCasts([{ ballot: naming(10n), l1Number: 9n }])).toThrow(TypeError);
    expect(() => storedCasts([{ ballot: ballot.subarray(1), l1Number: 10n }])).toThrow(TypeError);
  });
});

describe("a cast's ballot, against what the cast asked for", () => {
  // Each vector ballot's own fields, read by the crypto package's decoder.
  const asked = (ballot: Uint8Array): CastAsked => {
    const { definition_hash, cell, l1_ref_number, l1_ref_hash } = decodeBallot(ballot, 3);
    return { definitionHash: definition_hash, cell, l1Number: l1_ref_number, l1Hash: l1_ref_hash };
  };
  const ballots = VECTORS.ballots.map((b) => new Uint8Array(Buffer.from(b.encoding, "hex")));

  test("passes a ballot naming exactly the poll, the cell and the L1 block asked for", () => {
    for (const ballot of ballots) expect(castAsAsked(ballot, asked(ballot))).toBe(true);
  });

  test("refuses another definition, cell, block number or block hash (T-45, T-38)", () => {
    const flip = (bytes: Uint8Array, at: number) => bytes.with(at, (bytes[at] as number) ^ 1);
    fc.assert(
      fc.property(
        fc.nat({ max: ballots.length - 1 }),
        fc.nat({ max: 31 }),
        fc.integer({ min: 1, max: 255 }),
        fc.bigInt({ min: 1n, max: 2n ** 64n - 1n }),
        (i, at, cellDelta, numberDelta) => {
          const ballot = ballots[i] as Uint8Array;
          const own = asked(ballot);
          for (const other of [
            { ...own, definitionHash: flip(own.definitionHash, at) },
            { ...own, cell: (own.cell + cellDelta) % 256 },
            { ...own, l1Number: (own.l1Number + numberDelta) % 2n ** 64n },
            { ...own, l1Hash: flip(own.l1Hash, at) },
          ])
            expect(castAsAsked(ballot, other)).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  test("refuses bytes that aren't a version-3 ballot record", () => {
    const own = asked(BALLOT);
    for (const bytes of [
      new Uint8Array(),
      BALLOT.subarray(0, -1),
      Uint8Array.of(...BALLOT, 0),
      BALLOT.with(2, (BALLOT[2] as number) ^ 1),
    ])
      expect(castAsAsked(bytes, own)).toBe(false);
  });
});
