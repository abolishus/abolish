import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import { type CastRecord, newestBlock, parseStoredCasts, storedCasts } from "../src/casts.ts";

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
const boardedFor = (ballot: Uint8Array) => ({
  entry: new Uint8Array(ballot.length + ENTRY_OVERHEAD).fill(7),
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
  test("round-trip through what is stored, with the block read from each ballot", () => {
    fc.assert(
      fc.property(casts, (list) => {
        expect(parseStoredCasts(storedCasts(list))).toEqual(list);
      }),
      { numRuns },
    );
  });

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
