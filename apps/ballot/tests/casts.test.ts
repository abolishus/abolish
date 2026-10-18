import {
  type CastShare,
  decodeBallot,
  encodeBallotV3,
  encodeBoardEntry,
  shareCiphertextHash,
} from "@abolishus/crypto";
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
// block, each with its qualified seats' shares (`ct_i` and `m_i`, [[delivery]],
// Client rule 4) and its checked board entry or none, so a damaged record
// can never read as fewer casts than were made (T-45, T-38). Storing them
// in IndexedDB is tests/worker.e2e.ts's.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VECTORS = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/ballot-v3-records.json", import.meta.url),
    "utf8",
  ),
) as { ballots: { encoding: string }[] };

// Ciphertexts stand in as bytes: a stored share is judged by its hash
// against the ballot's share hash, never decrypted here.
const vector = decodeBallot(new Uint8Array(Buffer.from(VECTORS.ballots[0]!.encoding, "hex")), 3);
const PANEL = vector.committed_vote.share_hashes.length;
// Every seat qualified but the second, whose share hash is zero.
const UNQUALIFIED = 2;
const SHARES: readonly CastShare[] = Array.from({ length: PANEL }, (_, i) => i + 1)
  .filter((seat) => seat !== UNQUALIFIED)
  .map((seat) => ({
    seat,
    ciphertext: new Uint8Array(40 + seat).fill(seat),
    m: new Uint8Array(32).fill(0x80 + seat),
  }));
const BALLOT = encodeBallotV3({
  ...vector,
  committed_vote: {
    ...vector.committed_vote,
    share_hashes: vector.committed_vote.share_hashes.map((_, i) => {
      const share = SHARES.find((s) => s.seat === i + 1);
      return share === undefined ? new Uint8Array(32) : shareCiphertextHash(share.ciphertext);
    }),
  },
});
const shares = () =>
  SHARES.map(({ seat, ciphertext, m }) => ({ seat, ciphertext: ciphertext.slice(), m: m.slice() }));

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
              ? { ballot, l1Number: n, shares: shares(), boarded: boardedFor(ballot) }
              : { ballot, l1Number: n, shares: shares() };
          }),
        ),
    ),
  );

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 2,
  casts: [{ ballot: naming(10n), shares: shares(), boarded: null }],
  ...over,
});

/** Share lists that aren't exactly the ballot's qualified seats', each with what is wrong. */
function sharesRefused(): [string, unknown][] {
  const with_ = (i: number, change: Record<string, unknown>) =>
    shares().map((share, j) => (j === i ? { ...share, ...change } : share));
  const flipped = (bytes: Uint8Array) => {
    const b = bytes.slice();
    b[0] = (b[0] as number) ^ 1;
    return b;
  };
  const first = SHARES[0] as CastShare;
  return [
    ["shares that aren't a list", {}],
    ["no shares", []],
    ["a qualified seat's share missing", shares().slice(1)],
    ["the shares out of seat order", shares().toReversed()],
    ["a share for the unqualified seat", [...shares(), { ...first, seat: UNQUALIFIED }]],
    ["a seat's share twice", [first, ...shares()]],
    ["a share for another seat", with_(0, { seat: UNQUALIFIED })],
    ["a seat as a string", with_(0, { seat: String(first.seat) })],
    ["a share with a key more", with_(0, { panel: 0 })],
    ["a share without its m", shares().map(({ seat, ciphertext }) => ({ seat, ciphertext }))],
    [
      "a ciphertext not hashing to its share hash",
      with_(0, { ciphertext: flipped(first.ciphertext) }),
    ],
    ["another seat's ciphertext", with_(0, { ciphertext: (SHARES[1] as CastShare).ciphertext })],
    ["a ciphertext that isn't bytes", with_(0, { ciphertext: [...first.ciphertext] })],
    ["an m of 31 bytes", with_(0, { m: first.m.subarray(1) })],
    ["an m of 33 bytes", with_(0, { m: Uint8Array.of(...first.m, 0) })],
    ["an m that isn't bytes", with_(0, { m: [...first.m] })],
    ["a list with an extra property", Object.assign(shares(), { x: 1 })],
  ];
}

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
    cast!.shares[0]!.m.fill(0);
    cast!.shares[0]!.ciphertext.fill(0);
    expect(parseStoredCasts(stored)).toEqual([
      { ballot: naming(10n), l1Number: 10n, shares: shares() },
    ]);
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
  const HOLED = [, { ballot, shares: shares(), boarded: null }];
  test.each<[string, unknown]>([
    ["not an object", "casts"],
    ["a list", []],
    ["another version", record({ v: 1 })],
    ["version as a string", record({ v: "2" })],
    ["a key missing", { v: 2 }],
    ["a key more", record({ tier: 0 })],
    ["casts not a list", record({ casts: {} })],
    ["a list with a hole", record({ casts: HOLED })],
    [
      "a list with an extra property",
      record({ casts: Object.assign([{ ballot, shares: shares(), boarded: null }], { x: 1 }) }),
    ],
    ["a cast without its answer", record({ casts: [{ ballot, shares: shares() }] })],
    [
      "a cast with a key more",
      record({ casts: [{ ballot, shares: shares(), boarded: null, tier: 0 }] }),
    ],
    ["a cast without its shares", record({ casts: [{ ballot, boarded: null }] })],
    ...sharesRefused().map(([name, list]): [string, unknown] => [
      name,
      record({ casts: [{ ballot, shares: list, boarded: null }] }),
    ]),
    [
      "a ballot that isn't bytes",
      record({ casts: [{ ballot: [...ballot], shares: shares(), boarded: null }] }),
    ],
    [
      "a ballot that doesn't decode",
      record({ casts: [{ ballot: ballot.subarray(0, -1), shares: shares(), boarded: null }] }),
    ],
    [
      "a ballot of another record type",
      record({
        casts: [
          { ballot: Uint8Array.of(0, 4, ...ballot.subarray(2)), shares: shares(), boarded: null },
        ],
      }),
    ],
    [
      "two casts on the same block",
      record({
        casts: [
          { ballot, shares: shares(), boarded: null },
          { ballot: naming(10n), shares: shares(), boarded: null },
        ],
      }),
    ],
    [
      "casts out of order",
      record({
        casts: [
          { ballot: naming(11n), shares: shares(), boarded: null },
          { ballot, shares: shares(), boarded: null },
        ],
      }),
    ],
    [
      "an answer that isn't an object",
      record({ casts: [{ ballot, shares: shares(), boarded: "x" }] }),
    ],
    [
      "an answer without its link",
      record({
        casts: [{ ballot, shares: shares(), boarded: { entry: boardedFor(ballot).entry } }],
      }),
    ],
    [
      "an answer with a key more",
      record({
        casts: [{ ballot, shares: shares(), boarded: { ...boardedFor(ballot), index: 1n } }],
      }),
    ],
    [
      "a link of 31 bytes",
      record({
        casts: [
          {
            ballot,
            shares: shares(),
            boarded: { ...boardedFor(ballot), link: new Uint8Array(31) },
          },
        ],
      }),
    ],
    [
      "an entry of another length than the ballot fixes",
      record({
        casts: [
          {
            ballot,
            shares: shares(),
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
      record({ casts: [{ ballot, shares: shares(), boarded: boardedFor(naming(11n)) }] }),
    ],
    [
      "casts naming two definitions",
      record({
        casts: [
          { ballot, shares: shares(), boarded: null },
          { ballot: otherDefinition(naming(11n)), shares: shares(), boarded: null },
        ],
      }),
    ],
    [
      "answers naming two elections",
      record({
        casts: [
          { ballot, shares: shares(), boarded: boardedFor(ballot) },
          {
            ballot: naming(11n),
            shares: shares(),
            boarded: boardedFor(naming(11n), new Uint8Array(32).fill(0x5f)),
          },
        ],
      }),
    ],
  ])("%s is unreadable", (_, value) => {
    expect(parseStoredCasts(value)).toBeUndefined();
  });

  test("storing casts it would read back otherwise throws", () => {
    const a = { ballot: naming(10n), l1Number: 10n, shares: shares() };
    expect(() => storedCasts([a, a])).toThrow(TypeError);
    expect(() =>
      storedCasts([{ ballot: naming(11n), l1Number: 11n, shares: shares() }, a]),
    ).toThrow(TypeError);
    // A block that isn't the one the ballot names.
    expect(() => storedCasts([{ ballot: naming(10n), l1Number: 9n, shares: shares() }])).toThrow(
      TypeError,
    );
    expect(() =>
      storedCasts([{ ballot: ballot.subarray(1), l1Number: 10n, shares: shares() }]),
    ).toThrow(TypeError);
    // Storing copies only the fields it writes, so an extra key or property
    // isn't stored at all; every other refused list throws.
    const copiedAway = new Set(["a share with a key more", "a list with an extra property"]);
    for (const [name, list] of sharesRefused())
      if (!copiedAway.has(name))
        expect(() =>
          storedCasts([{ ballot: naming(10n), l1Number: 10n, shares: list as CastShare[] }]),
        ).toThrow(TypeError);
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

  // Five full ballot decodes a run: at CI's 1000 runs, past the 5-second default.
  test(
    "refuses another definition, cell, block number or block hash (T-45, T-38)",
    { timeout: 60_000 },
    () => {
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
    },
  );

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
