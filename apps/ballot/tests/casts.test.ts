import {
  ballotHashV3,
  type CastShare,
  decodeBallot,
  encodeBallotV3,
  encodeBoardEntry,
  encodeShareReceipt,
  MEMBERSHIP_PROOF_LENGTH,
  shareCiphertextHash,
} from "@abolishus/crypto";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import {
  answeredCast,
  type CastAsked,
  castAsAsked,
  type CastRecord,
  type CheckedReceipt,
  type KeptShare,
  keepsShares,
  newestBlock,
  parseStoredCasts,
  storedCasts,
  unboardedReceipts,
  unsentCast,
  withCast,
  withHanded,
  withPostingDeclined,
  withReceipt,
  withReceiptBoarded,
  withSharesErased,
} from "../src/casts.ts";

// The record of this device's casts in one election and tier (src/casts.ts;
// [[revoting]], Client rule 3): read back only as this client writes it, a
// version-3 ballot record per cast in strictly ascending order of its L1
// block, each with its qualified seats' shares (`ct_i` and `m_i`, or the
// seat's receipt once one passed, [[delivery]], Client rules 2 and 4, with
// the checked board entry carrying it once the operator answered, Client
// rule 3) and its checked board entry or none, so a damaged record
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
// Every share held here keeps its `m`, as the worker hands one before any receipt.
const SHARES: readonly (CastShare & { readonly m: Uint8Array })[] = Array.from(
  { length: PANEL },
  (_, i) => i + 1,
)
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
/** `shares()` as stored: each with no receipt yet. */
const kept = () => shares().map((share) => ({ ...share, receipt: null, boarded: null }));

const DECODED = decodeBallot(BALLOT, 3);
/** The ballot hash every cast of this ballot carries, whatever L1 block it names. */
const BALLOT_HASH = ballotHashV3(
  { definitionHash: DECODED.definition_hash, cell: DECODED.cell, nullifier: DECODED.nullifier },
  DECODED.committed_vote,
);
/** A share receipt record for `seat` of this ballot; its signature is only canonical, never checked here. */
const receiptFor = (seat: number, over: Record<string, unknown> = {}) =>
  encodeShareReceipt({
    definition_hash: DECODED.definition_hash,
    ballot_hash: BALLOT_HASH,
    seat,
    share_hash: DECODED.committed_vote.share_hashes[seat - 1] as Uint8Array,
    signature: new Uint8Array(64).fill(1),
    ...over,
  });
const FIRST = (SHARES[0] as CastShare).seat;
/** What the worker client hands back for a receipt the worker passed; here, made by hand. */
const checkedOf = (seat: number, receipt: Uint8Array) =>
  ({ seat, receipt }) as unknown as CheckedReceipt;
/** `shares()` with the first seat receipted, its `m` gone. */
const receipted = (): KeptShare[] =>
  shares().map(({ seat, ciphertext, m }) =>
    seat === FIRST ? { seat, ciphertext, receipt: receiptFor(seat) } : { seat, ciphertext, m },
  );

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
/** The operator's checked answer for `receipt`: an entry carrying it, after the ballot's. */
const receiptBoardedFor = (receipt: Uint8Array, electionId = ELECTION) => ({
  entry: encodeBoardEntry({ election_id: electionId, index: 2n, segment: 0, payload: receipt }, 5),
  link: new Uint8Array(32).fill(8),
});
/** `receipted()` with the first seat's receipt seen onto the board. */
const receiptedBoarded = (): KeptShare[] =>
  receipted().map((share) =>
    "receipt" in share ? { ...share, boarded: receiptBoardedFor(share.receipt) } : share,
  );

/** `receipted()` once the posting cutoff passed: every other seat's `ct_i` and `m_i` erased. */
const erased = (): KeptShare[] =>
  receipted().map((share) => ("m" in share ? { seat: share.seat, erased: true } : share));

// Distinct blocks in ascending order, each cast boarded or not, and marked handed or not.
const casts = fc
  .uniqueArray(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { maxLength: 6 })
  .chain((blocks) =>
    fc.tuple(
      ...blocks
        .toSorted((a, b) => (a < b ? -1 : 1))
        .map((n) =>
          fc
            .tuple(fc.boolean(), fc.constantFrom(0, 1, 2, 3), fc.boolean())
            .map(([boarded, receipt, handed]): CastRecord => {
              const ballot = naming(n);
              const list = [shares, receipted, receiptedBoarded, erased][receipt]!();
              const cast: CastRecord = boarded
                ? { ballot, l1Number: n, shares: list, boarded: boardedFor(ballot) }
                : { ballot, l1Number: n, shares: list };
              return handed ? { ...cast, handed } : cast;
            }),
        ),
    ),
  );

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 6,
  casts: [{ ballot: naming(10n), shares: kept(), handed: false, boarded: null }],
  ...over,
});

/** Share lists that aren't exactly the ballot's qualified seats', each with what is wrong. */
function sharesRefused(): [string, unknown][] {
  const with_ = (i: number, change: Record<string, unknown>) =>
    kept().map((share, j) => (j === i ? { ...share, ...change } : share));
  const flipped = (bytes: Uint8Array) => {
    const b = bytes.slice();
    b[0] = (b[0] as number) ^ 1;
    return b;
  };
  const first = { ...(SHARES[0] as (typeof SHARES)[number]), receipt: null, boarded: null };
  const second = (SHARES[1] as CastShare).seat;
  // The first seat receipted, its receipt's board entry `boarded`.
  const entry = (boarded: unknown) =>
    with_(0, { m: null, receipt: receiptFor(first.seat), boarded });
  const ownEntry = receiptBoardedFor(receiptFor(first.seat));
  return [
    ["shares that aren't a list", {}],
    ["no shares", []],
    ["a qualified seat's share missing", kept().slice(1)],
    ["the shares out of seat order", kept().toReversed()],
    ["a share for the unqualified seat", [...kept(), { ...first, seat: UNQUALIFIED }]],
    ["a seat's share twice", [first, ...kept()]],
    ["a share for another seat", with_(0, { seat: UNQUALIFIED })],
    ["a seat as a string", with_(0, { seat: String(first.seat) })],
    ["a share with a key more", with_(0, { panel: 0 })],
    ["a share without its m", kept().map(({ seat, ciphertext }) => ({ seat, ciphertext }))],
    ["a share without its receipt", shares()],
    [
      "a share without its board entry",
      kept().map(({ seat, ciphertext, m, receipt }) => ({ seat, ciphertext, m, receipt })),
    ],
    ["a board entry beside an m", with_(0, { boarded: ownEntry })],
    ["a receipt's board entry that isn't an object", entry("x")],
    ["a receipt's board entry with a key more", entry({ ...ownEntry, index: 2n })],
    [
      "a receipt's board entry with a link of 31 bytes",
      entry({ ...ownEntry, link: new Uint8Array(31) }),
    ],
    [
      "a receipt's board entry carrying another seat's receipt",
      entry(receiptBoardedFor(receiptFor(second))),
    ],
    [
      "a receipt's board entry carrying a receipt for another ballot",
      entry(receiptBoardedFor(receiptFor(first.seat, { ballot_hash: new Uint8Array(32) }))),
    ],
    ["a receipt's board entry carrying the ballot", entry(boardedFor(naming(10n)))],
    [
      "a receipt's board entry with a byte past its payload",
      entry({ ...ownEntry, entry: Uint8Array.of(...ownEntry.entry, 0) }),
    ],
    ["a receipt's board entry cut short", entry({ ...ownEntry, entry: new Uint8Array(50) })],
    ["a share with neither its m nor a receipt", with_(0, { m: null })],
    ["an m without its ciphertext", with_(0, { ciphertext: null })],
    [
      "an erased share with a receipt",
      with_(0, { ciphertext: null, m: null, receipt: receiptFor(first.seat) }),
    ],
    [
      "an erased share with a board entry",
      with_(0, { ciphertext: null, m: null, boarded: ownEntry }),
    ],
    [
      "an erased share for another seat",
      with_(0, { seat: UNQUALIFIED, ciphertext: null, m: null }),
    ],
    ["an erased share of undefineds", with_(0, { ciphertext: undefined, m: undefined })],
    ["a share with both its m and a receipt", with_(0, { receipt: receiptFor(first.seat) })],
    [
      "a receipt for another seat",
      with_(0, { m: null, receipt: receiptFor((SHARES[1] as CastShare).seat) }),
    ],
    [
      "a receipt for another ballot",
      with_(0, { m: null, receipt: receiptFor(first.seat, { ballot_hash: new Uint8Array(32) }) }),
    ],
    [
      "a receipt for another share",
      with_(0, {
        m: null,
        receipt: receiptFor(first.seat, { share_hash: new Uint8Array(32).fill(3) }),
      }),
    ],
    [
      "a receipt for another definition",
      with_(0, {
        m: null,
        receipt: receiptFor(first.seat, { definition_hash: new Uint8Array(32).fill(4) }),
      }),
    ],
    ["a receipt that isn't a receipt record", with_(0, { m: null, receipt: new Uint8Array(4) })],
    ["a receipt that isn't bytes", with_(0, { m: null, receipt: [...receiptFor(first.seat)] })],
    [
      "a ciphertext not hashing to its share hash",
      with_(0, { ciphertext: flipped(first.ciphertext) }),
    ],
    ["another seat's ciphertext", with_(0, { ciphertext: (SHARES[1] as CastShare).ciphertext })],
    ["a ciphertext that isn't bytes", with_(0, { ciphertext: [...first.ciphertext] })],
    ["an m of 31 bytes", with_(0, { m: first.m.subarray(1) })],
    ["an m of 33 bytes", with_(0, { m: Uint8Array.of(...first.m, 0) })],
    ["an m that isn't bytes", with_(0, { m: [...first.m] })],
    ["a list with an extra property", Object.assign(kept(), { x: 1 })],
  ];
}

describe("the stored casts", () => {
  // Every ballot is decoded twice per run (stored, then read back), and a
  // receipted one hashed twice too: at CI's FC_NUM_RUNS this takes minutes
  // on a slow runner.
  test("round-trip through what is stored, with the block read from each ballot", () => {
    fc.assert(
      fc.property(casts, (list) => {
        expect(parseStoredCasts(storedCasts(list))).toEqual(list);
      }),
      { numRuns },
    );
  }, 600_000);

  test("hand out copies, never the stored arrays", () => {
    const stored = record();
    const [cast] = parseStoredCasts(stored) as CastRecord[];
    cast!.ballot.fill(0);
    (cast!.shares[0] as { m: Uint8Array }).m.fill(0);
    (cast!.shares[0] as { ciphertext: Uint8Array }).ciphertext.fill(0);
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
  const HOLED = [, { ballot, shares: kept(), handed: false, boarded: null }];
  test.each<[string, unknown]>([
    ["not an object", "casts"],
    ["a list", []],
    ["another version", record({ v: 2 })],
    ["version as a string", record({ v: "6" })],
    ["version 3, which kept no receipts' entries", record({ v: 3 })],
    ["version 4, which kept no erased shares", record({ v: 4 })],
    ["version 5, which kept no handed mark", record({ v: 5 })],
    ["a key missing", { v: 6 }],
    ["a key more", record({ tier: 0 })],
    ["casts not a list", record({ casts: {} })],
    ["a list with a hole", record({ casts: HOLED })],
    [
      "a list with an extra property",
      record({
        casts: Object.assign([{ ballot, shares: kept(), handed: false, boarded: null }], { x: 1 }),
      }),
    ],
    ["a cast without its answer", record({ casts: [{ ballot, shares: kept(), handed: false }] })],
    [
      "a cast without its handed mark",
      record({ casts: [{ ballot, shares: kept(), boarded: null }] }),
    ],
    ...[1, 0, "true", null, undefined].map((handed): [string, unknown] => [
      `a handed mark of ${String(handed)}`,
      record({ casts: [{ ballot, shares: kept(), handed, boarded: null }] }),
    ]),
    [
      "a cast with a key more",
      record({ casts: [{ ballot, shares: kept(), handed: false, boarded: null, tier: 0 }] }),
    ],
    ["a cast without its shares", record({ casts: [{ ballot, handed: false, boarded: null }] })],
    ...sharesRefused().map(([name, list]): [string, unknown] => [
      name,
      record({ casts: [{ ballot, shares: list, handed: false, boarded: null }] }),
    ]),
    [
      "a ballot that isn't bytes",
      record({ casts: [{ ballot: [...ballot], shares: kept(), handed: false, boarded: null }] }),
    ],
    [
      "a ballot that doesn't decode",
      record({
        casts: [{ ballot: ballot.subarray(0, -1), shares: kept(), handed: false, boarded: null }],
      }),
    ],
    [
      "a ballot of another record type",
      record({
        casts: [
          {
            ballot: Uint8Array.of(0, 4, ...ballot.subarray(2)),
            shares: kept(),
            handed: false,
            boarded: null,
          },
        ],
      }),
    ],
    [
      "two casts on the same block",
      record({
        casts: [
          { ballot, shares: kept(), handed: false, boarded: null },
          { ballot: naming(10n), shares: kept(), handed: false, boarded: null },
        ],
      }),
    ],
    [
      "casts out of order",
      record({
        casts: [
          { ballot: naming(11n), shares: kept(), handed: false, boarded: null },
          { ballot, shares: kept(), handed: false, boarded: null },
        ],
      }),
    ],
    [
      "an answer that isn't an object",
      record({ casts: [{ ballot, shares: kept(), handed: false, boarded: "x" }] }),
    ],
    [
      "an answer without its link",
      record({
        casts: [
          { ballot, shares: kept(), handed: false, boarded: { entry: boardedFor(ballot).entry } },
        ],
      }),
    ],
    [
      "an answer with a key more",
      record({
        casts: [
          { ballot, shares: kept(), handed: false, boarded: { ...boardedFor(ballot), index: 1n } },
        ],
      }),
    ],
    [
      "a link of 31 bytes",
      record({
        casts: [
          {
            ballot,
            shares: kept(),
            handed: false,
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
            shares: kept(),
            handed: false,
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
      record({
        casts: [{ ballot, shares: kept(), handed: false, boarded: boardedFor(naming(11n)) }],
      }),
    ],
    [
      "casts naming two definitions",
      record({
        casts: [
          { ballot, shares: kept(), handed: false, boarded: null },
          { ballot: otherDefinition(naming(11n)), shares: kept(), handed: false, boarded: null },
        ],
      }),
    ],
    [
      "answers naming two elections",
      record({
        casts: [
          { ballot, shares: kept(), handed: false, boarded: boardedFor(ballot) },
          {
            ballot: naming(11n),
            shares: kept(),
            handed: false,
            boarded: boardedFor(naming(11n), new Uint8Array(32).fill(0x5f)),
          },
        ],
      }),
    ],
    [
      "a receipt's entry naming another election than the ballot's",
      record({
        casts: [
          {
            ballot,
            shares: kept().map((share, i) =>
              i === 0
                ? {
                    ...share,
                    m: null,
                    receipt: receiptFor(share.seat),
                    boarded: receiptBoardedFor(
                      receiptFor(share.seat),
                      new Uint8Array(32).fill(0x5f),
                    ),
                  }
                : share,
            ),
            handed: false,
            boarded: boardedFor(ballot),
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
    // A board entry is written only beside a receipt.
    const copiedAway = new Set([
      "a share with a key more",
      "a list with an extra property",
      "a board entry beside an m",
      "a receipt's board entry with a key more",
    ]);
    // In memory, a share without a receipt or a board entry has no such key.
    const inMemory = (list: unknown) =>
      Array.isArray(list)
        ? list.map((share: unknown) => {
            if (typeof share !== "object" || share === null) return share;
            const copy = { ...(share as Record<string, unknown>) };
            for (const key of ["receipt", "boarded"]) if (copy[key] === null) delete copy[key];
            return copy;
          })
        : list;
    const sameInMemory = new Set([
      "a share without its receipt",
      "a share without its board entry",
    ]);
    for (const [name, list] of sharesRefused())
      if (!copiedAway.has(name) && !sameInMemory.has(name))
        expect(() =>
          storedCasts([
            { ballot: naming(10n), l1Number: 10n, shares: inMemory(list) as KeptShare[] },
          ]),
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

describe("a seat's receipt in the casts", () => {
  const first = (casts: readonly CastRecord[], at: number) => casts[at]?.shares[0] as KeptShare;
  const cast = (n: bigint): CastRecord => ({ ballot: naming(n), l1Number: n, shares: shares() });

  test("takes the place of the seat's m in the cast it receipts and every recast of it", () => {
    const held = [cast(10n), cast(11n)];
    const changed = withReceipt(held, naming(10n), checkedOf(FIRST, receiptFor(FIRST)));
    if (changed === "missing") throw new Error("expected the casts");
    for (const at of [0, 1]) {
      expect(first(changed, at)).toEqual({
        seat: FIRST,
        ciphertext: (SHARES[0] as CastShare).ciphertext,
        receipt: receiptFor(FIRST),
      });
      expect(changed[at]?.shares.slice(1)).toEqual(shares().slice(1));
    }
    // What is stored no longer holds that m, and reads back as it was written.
    const stored = storedCasts(changed);
    expect(
      JSON.stringify(stored, (_, v: unknown) => (v instanceof Uint8Array ? [...v] : v)),
    ).not.toContain(JSON.stringify([...(SHARES[0] as (typeof SHARES)[number]).m]).slice(1, -1));
    expect(parseStoredCasts(stored)).toEqual(changed);
  });

  test("keeps a seat's first receipt", () => {
    const once = withReceipt([cast(10n)], naming(10n), checkedOf(FIRST, receiptFor(FIRST)));
    if (once === "missing") throw new Error("expected the casts");
    const other = receiptFor(FIRST, { signature: new Uint8Array(64).fill(2) });
    expect(withReceipt(once, naming(10n), checkedOf(FIRST, other))).toEqual(once);
  });

  test("is missing for a ballot no cast has, and changes nothing", () => {
    expect(withReceipt([cast(11n)], naming(10n), checkedOf(FIRST, receiptFor(FIRST)))).toBe(
      "missing",
    );
    expect(withReceipt([], naming(10n), checkedOf(FIRST, receiptFor(FIRST)))).toBe("missing");
  });

  test("throws for a receipt that doesn't name the seat and exactly the ballot", () => {
    const held = [cast(10n)];
    const second = (SHARES[1] as CastShare).seat;
    for (const receipt of [
      receiptFor(second),
      receiptFor(FIRST, { ballot_hash: new Uint8Array(32) }),
      receiptFor(FIRST).subarray(1),
    ])
      expect(() => withReceipt(held, naming(10n), checkedOf(FIRST, receipt))).toThrow(TypeError);
    expect(() =>
      withReceipt(held, naming(10n), checkedOf(UNQUALIFIED, receiptFor(UNQUALIFIED))),
    ).toThrow(TypeError);
  });

  test("carries over to a recast recorded after it, whose m is never kept", () => {
    const once = withReceipt([cast(10n)], naming(10n), checkedOf(FIRST, receiptFor(FIRST)));
    if (once === "missing") throw new Error("expected the casts");
    const recast = withCast(once, naming(11n), shares());
    if (typeof recast === "string") throw new Error(recast);
    expect(first(recast, 1)).toEqual(first(once, 0));
    expect(recast[1]?.shares.slice(1)).toEqual(shares().slice(1));
  });

  test("takes the place of a recast's share the worker erased the m of (receiptSealV3)", () => {
    const once = withReceipt([cast(10n)], naming(10n), checkedOf(FIRST, receiptFor(FIRST)));
    if (once === "missing") throw new Error("expected the casts");
    const erased = shares().map(({ seat, ciphertext, m }) =>
      seat === FIRST ? { seat, ciphertext } : { seat, ciphertext, m },
    );
    const recast = withCast(once, naming(11n), erased);
    if (typeof recast === "string") throw new Error(recast);
    expect(first(recast, 1)).toEqual(first(once, 0));
    expect(recast[1]?.shares.slice(1)).toEqual(shares().slice(1));
  });

  test("is unreceipted for a share with no m that no receipt kept here covers, and nothing is kept", () => {
    const erased = shares().map(({ seat, ciphertext, m }) =>
      seat === FIRST ? { seat, ciphertext } : { seat, ciphertext, m },
    );
    // No cast held, an earlier cast with no receipt, and another seal's receipt.
    expect(withCast([], naming(11n), erased)).toBe("unreceipted");
    expect(withCast([cast(10n)], naming(11n), erased)).toBe("unreceipted");
    const once = withReceipt([cast(10n)], naming(10n), checkedOf(FIRST, receiptFor(FIRST)));
    if (once === "missing") throw new Error("expected the casts");
    const otherSeal = BALLOT.slice();
    otherSeal[3 + 32 + 1 + 31] = (otherSeal[3 + 32 + 1 + 31] as number) ^ 1;
    new DataView(otherSeal.buffer).setBigUint64(L1_AT, 11n);
    expect(withCast(once, otherSeal, erased)).toBe("unreceipted");
    // The block and the poll come first, and a malformed share without m still throws.
    expect(withCast([cast(11n)], naming(11n), erased)).toBe("not-newer");
    expect(withCast([cast(10n)], otherDefinition(naming(11n)), erased)).toBe("other-election");
    const misplaced: CastShare[] = [
      { seat: FIRST, ciphertext: (SHARES[1] as CastShare).ciphertext },
      ...erased.slice(1),
    ];
    expect(() => withCast([], naming(11n), misplaced)).toThrow(TypeError);
    expect(() => withCast([], naming(11n), erased.slice(1))).toThrow(TypeError);
  });

  test("doesn't carry to another seal's cast, whose shares are its own", () => {
    const once = withReceipt([cast(10n)], naming(10n), checkedOf(FIRST, receiptFor(FIRST)));
    if (once === "missing") throw new Error("expected the casts");
    // Another nullifier: another seal's ballot hash, under the same shares.
    const otherSeal = BALLOT.slice();
    otherSeal[3 + 32 + 1 + 31] = (otherSeal[3 + 32 + 1 + 31] as number) ^ 1;
    new DataView(otherSeal.buffer).setBigUint64(L1_AT, 11n);
    const recast = withCast(once, otherSeal, shares());
    if (typeof recast === "string") throw new Error(recast);
    expect(recast[1]?.shares).toEqual(shares());
  });
});

describe("a cast added to the casts", () => {
  test("comes after them only on a strictly newer block of the same poll", () => {
    const held = withCast([], naming(10n), shares());
    if (typeof held === "string") throw new Error(held);
    expect(held).toEqual([{ ballot: naming(10n), l1Number: 10n, shares: shares() }]);
    expect(withCast(held, naming(10n), shares())).toBe("not-newer");
    expect(withCast(held, naming(9n), shares())).toBe("not-newer");
    expect(withCast(held, otherDefinition(naming(11n)), shares())).toBe("other-election");
  });

  test("throws for shares that aren't the worker's: exactly the qualified seats', each with its m", () => {
    expect(() => withCast([], naming(10n), receipted() as unknown as CastShare[])).toThrow(
      TypeError,
    );
    expect(() => withCast([], naming(10n), kept() as unknown as CastShare[])).toThrow(TypeError);
    expect(() => withCast([], naming(10n), shares().slice(1))).toThrow(TypeError);
    expect(() => withCast([], naming(10n).subarray(1), shares())).toThrow(TypeError);
  });
});

// Each valid committed vote of the spec's vectors with its context and core
// hash, the tracking code the voter was shown, computed by the vectors' own
// generator, never by the code under test.
const CORE_VECTORS = (
  JSON.parse(
    readFileSync(new URL("../../../docs/spec/vectors/ballot-v3.json", import.meta.url), "utf8"),
  ) as {
    ballots: {
      id: string;
      context: { definitionHash: string; cell: number };
      encoding: string;
      coreHash: string;
      result: string;
    }[];
  }
).ballots.filter((b) => b.result === "ok");

// A version-3 ballot record ends with its committed vote, after the header,
// `definition_hash`, `cell`, `nullifier`, `l1_ref_number`, `l1_ref_hash` and
// the membership proof ([[ballot-validity]], Ballot record (version 3)).
const VOTE_AT = 3 + 32 + 1 + 32 + 8 + 32 + MEMBERSHIP_PROOF_LENGTH;

/** The records vector's ballot carrying a vector's committed vote, definition hash and cell instead. */
function recordOf(v: (typeof CORE_VECTORS)[number]): Uint8Array {
  const b = Uint8Array.of(...BALLOT.subarray(0, VOTE_AT), ...Buffer.from(v.encoding, "hex"));
  b.set(Buffer.from(v.context.definitionHash, "hex"), 3);
  b[35] = v.context.cell;
  return b;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("an unsent cast", () => {
  const definition = DECODED.definition_hash;

  test("is none for no casts, and for a boarded newest whatever came before it", () => {
    expect(unsentCast([], definition)).toBeUndefined();
    const older: CastRecord = { ballot: naming(9n), l1Number: 9n, shares: shares() };
    const newest: CastRecord = {
      ballot: naming(10n),
      l1Number: 10n,
      shares: shares(),
      boarded: boardedFor(naming(10n)),
    };
    expect(unsentCast([newest], definition)).toBeUndefined();
    // An older cast never went, but the newest outranks it wherever both are boarded.
    expect(unsentCast([older, newest], definition)).toBeUndefined();
  });

  test("is the newest when no answer is kept for it, with every seat still holding its m undelivered", () => {
    const boarded: CastRecord = {
      ballot: naming(9n),
      l1Number: 9n,
      shares: shares(),
      boarded: boardedFor(naming(9n)),
    };
    const newest: CastRecord = { ballot: naming(10n), l1Number: 10n, shares: receipted() };
    const unsent = unsentCast([boarded, newest], definition);
    if (unsent === undefined || unsent === "other-election") throw new Error("expected a cast");
    expect(unsent.ballot).toEqual(naming(10n));
    // The receipted seat is never delivered again: its m is gone (Client rule 2).
    expect(unsent.undelivered).toEqual(
      SHARES.filter(({ seat }) => seat !== FIRST).map(({ seat, ciphertext }) => ({
        seat,
        ciphertext,
      })),
    );
  });

  test("hands out copies, never the record's arrays", () => {
    const cast: CastRecord = { ballot: naming(10n), l1Number: 10n, shares: shares() };
    const unsent = unsentCast([cast], definition);
    if (unsent === undefined || unsent === "other-election") throw new Error("expected a cast");
    unsent.ballot.fill(0);
    for (const { ciphertext } of unsent.undelivered) ciphertext.fill(0);
    expect(cast.ballot).toEqual(naming(10n));
    expect(cast.shares).toEqual(shares());
  });

  test.each(CORE_VECTORS.map((v) => [v.id, v] as const))(
    "carries the tracking code shown before the cast (%s)",
    (_, v) => {
      const ballot = recordOf(v);
      const decoded = decodeBallot(ballot, 3);
      const cast: CastRecord = { ballot, l1Number: decoded.l1_ref_number, shares: [] };
      const unsent = unsentCast([cast], decoded.definition_hash);
      if (unsent === undefined || unsent === "other-election") throw new Error("expected a cast");
      expect(hex(unsent.trackingCode)).toBe(v.coreHash);
      expect(unsent.undelivered).toEqual([]);
    },
  );

  test("is other-election for a newest cast of another poll, or bytes that aren't a version-3 record", () => {
    const other: CastRecord = {
      ballot: otherDefinition(naming(10n)),
      l1Number: 10n,
      shares: shares(),
    };
    expect(unsentCast([other], definition)).toBe("other-election");
    const torn: CastRecord = { ballot: naming(10n).subarray(1), l1Number: 10n, shares: shares() };
    expect(unsentCast([torn], definition)).toBe("other-election");
    expect(
      unsentCast([{ ...other, ballot: naming(10n) }], otherDefinition(BALLOT).subarray(3, 35)),
    ).toBe("other-election");
  });

  test("is exactly the newest cast without a board entry or an erased share, with its seats holding an m (fast-check)", () => {
    fc.assert(
      fc.property(casts, (held) => {
        const unsent = unsentCast(held, definition);
        const newest = held.at(-1);
        if (
          newest === undefined ||
          newest.boarded !== undefined ||
          newest.shares.some((share) => "erased" in share)
        ) {
          expect(unsent).toBeUndefined();
          return;
        }
        if (unsent === undefined || unsent === "other-election") throw new Error("expected a cast");
        expect(unsent.ballot).toEqual(newest.ballot);
        expect(unsent.undelivered.map(({ seat }) => seat)).toEqual(
          newest.shares.filter((share) => "m" in share).map(({ seat }) => seat),
        );
      }),
      { numRuns },
    );
  });
});

describe("an answered cast", () => {
  const definition = DECODED.definition_hash;
  const boarded = (n: bigint, list = receipted()): CastRecord => ({
    ballot: naming(n),
    l1Number: n,
    shares: list,
    boarded: boardedFor(naming(n)),
  });

  test("is none for no casts, and for a newest the board never took, whatever came before it", () => {
    expect(answeredCast([], definition)).toBeUndefined();
    const newest: CastRecord = { ballot: naming(10n), l1Number: 10n, shares: shares() };
    expect(answeredCast([newest], definition)).toBeUndefined();
    // The earlier one is in, but the newest is unsent, declined or erased: only it is the voter's last.
    expect(answeredCast([boarded(9n), newest], definition)).toBeUndefined();
    const declined: CastRecord = { ballot: naming(10n), l1Number: 10n, shares: erased() };
    expect(answeredCast([boarded(9n), declined], definition)).toBeUndefined();
  });

  test.each(CORE_VECTORS.map((v) => [v.id, v] as const))(
    "is the tracking code shown before the cast, once the board took it (%s)",
    (_, v) => {
      const ballot = recordOf(v);
      const decoded = decodeBallot(ballot, 3);
      const cast: CastRecord = {
        ballot,
        l1Number: decoded.l1_ref_number,
        shares: [],
        boarded: boardedFor(ballot),
      };
      expect(hex(answeredCast([cast], decoded.definition_hash) ?? new Uint8Array())).toBe(
        v.coreHash,
      );
    },
  );

  test("is none for a newest cast of another poll, or bytes that aren't a version-3 record", () => {
    const other = { ...boarded(10n), ballot: otherDefinition(naming(10n)) };
    expect(answeredCast([other], definition)).toBeUndefined();
    const torn = { ...boarded(10n), ballot: naming(10n).subarray(1) };
    expect(answeredCast([torn], definition)).toBeUndefined();
    expect(answeredCast([boarded(10n)], otherDefinition(BALLOT).subarray(3, 35))).toBeUndefined();
  });

  test("is said exactly when the newest cast of this poll is boarded (fast-check)", () => {
    fc.assert(
      fc.property(casts, (held) => {
        expect(answeredCast(held, definition) !== undefined).toBe(
          held.at(-1)?.boarded !== undefined,
        );
      }),
      { numRuns },
    );
  });
});

describe("a receipt's board entry in the casts", () => {
  const cast = (n: bigint, list = receipted()): CastRecord => ({
    ballot: naming(n),
    l1Number: n,
    shares: list,
  });
  const second = (SHARES[1] as CastShare).seat;
  const own = receiptFor(FIRST);
  /** An earlier receipt for the seat in other bytes, as the board path may already carry (Boarding, rule 5). */
  const earlier = receiptFor(FIRST, { signature: new Uint8Array(64).fill(2) });

  test("is kept beside the seat's receipt in the cast it receipts and every recast of it", () => {
    const held = [cast(10n), cast(11n)];
    const changed = withReceiptBoarded(
      held,
      naming(10n),
      checkedOf(FIRST, own),
      receiptBoardedFor(own),
    );
    if (changed === "missing") throw new Error("expected the casts");
    for (const at of [0, 1]) {
      expect(changed[at]?.shares[0]).toEqual({
        seat: FIRST,
        ciphertext: (SHARES[0] as CastShare).ciphertext,
        receipt: own,
        boarded: receiptBoardedFor(own),
      });
      expect(changed[at]?.shares.slice(1)).toEqual(receipted().slice(1));
    }
    expect(parseStoredCasts(storedCasts(changed))).toEqual(changed);
  });

  test("keeps an earlier receipt's entry beside the seat's own receipt", () => {
    const changed = withReceiptBoarded(
      [cast(10n)],
      naming(10n),
      checkedOf(FIRST, earlier),
      receiptBoardedFor(earlier),
    );
    if (changed === "missing") throw new Error("expected the casts");
    expect(changed[0]?.shares[0]).toMatchObject({
      receipt: own,
      boarded: receiptBoardedFor(earlier),
    });
    expect(parseStoredCasts(storedCasts(changed))).toEqual(changed);
  });

  test("keeps the first entry kept for a seat", () => {
    const once = withReceiptBoarded(
      [cast(10n)],
      naming(10n),
      checkedOf(FIRST, own),
      receiptBoardedFor(own),
    );
    if (once === "missing") throw new Error("expected the casts");
    expect(
      withReceiptBoarded(once, naming(10n), checkedOf(FIRST, earlier), receiptBoardedFor(earlier)),
    ).toEqual(once);
  });

  test("doesn't reach another seal's cast", () => {
    const otherSeal = BALLOT.slice();
    otherSeal[3 + 32 + 1 + 31] = (otherSeal[3 + 32 + 1 + 31] as number) ^ 1;
    new DataView(otherSeal.buffer).setBigUint64(L1_AT, 11n);
    const theirs: CastRecord = { ballot: otherSeal, l1Number: 11n, shares: shares() };
    const changed = withReceiptBoarded(
      [cast(10n), theirs],
      naming(10n),
      checkedOf(FIRST, own),
      receiptBoardedFor(own),
    );
    if (changed === "missing") throw new Error("expected the casts");
    expect(changed[1]).toEqual(theirs);
  });

  test("is missing for a ballot no cast has, or a seat not receipted in it", () => {
    const entry = receiptBoardedFor(own);
    expect(withReceiptBoarded([cast(11n)], naming(10n), checkedOf(FIRST, own), entry)).toBe(
      "missing",
    );
    expect(withReceiptBoarded([], naming(10n), checkedOf(FIRST, own), entry)).toBe("missing");
    expect(
      withReceiptBoarded([cast(10n, shares())], naming(10n), checkedOf(FIRST, own), entry),
    ).toBe("missing");
  });

  test("throws for an entry that doesn't carry exactly the checked receipt, or a receipt not for this ballot's seat", () => {
    const held = [cast(10n)];
    expect(() =>
      withReceiptBoarded(held, naming(10n), checkedOf(FIRST, own), receiptBoardedFor(earlier)),
    ).toThrow(TypeError);
    expect(() =>
      withReceiptBoarded(held, naming(10n), checkedOf(FIRST, own), boardedFor(naming(10n))),
    ).toThrow(TypeError);
    expect(() =>
      withReceiptBoarded(held, naming(10n), checkedOf(FIRST, own), {
        ...receiptBoardedFor(own),
        link: new Uint8Array(31),
      }),
    ).toThrow(TypeError);
    const theirs = receiptFor(second);
    expect(() =>
      withReceiptBoarded(held, naming(10n), checkedOf(FIRST, theirs), receiptBoardedFor(theirs)),
    ).toThrow(TypeError);
    const otherBallot = receiptFor(FIRST, { ballot_hash: new Uint8Array(32) });
    expect(() =>
      withReceiptBoarded(
        held,
        naming(10n),
        checkedOf(FIRST, otherBallot),
        receiptBoardedFor(otherBallot),
      ),
    ).toThrow(TypeError);
  });

  test("carries over to a recast recorded after it", () => {
    const once = withReceiptBoarded(
      [cast(10n)],
      naming(10n),
      checkedOf(FIRST, own),
      receiptBoardedFor(own),
    );
    if (once === "missing") throw new Error("expected the casts");
    const recast = withCast(once, naming(11n), shares());
    if (typeof recast === "string") throw new Error(recast);
    expect(recast[1]?.shares[0]).toEqual(once[0]?.shares[0]);
    expect(recast[1]?.shares.slice(1)).toEqual(shares().slice(1));
  });
});

describe("a cast's unboarded receipts", () => {
  const own = receiptFor(FIRST);

  test("are its receipted seats whose receipt no kept entry carries, in seat order", () => {
    const held: CastRecord[] = [{ ballot: naming(10n), l1Number: 10n, shares: receipted() }];
    expect(unboardedReceipts(held, naming(10n))).toEqual([{ seat: FIRST, receipt: own }]);
    const boarded: CastRecord[] = [
      { ballot: naming(10n), l1Number: 10n, shares: receiptedBoarded() },
    ];
    expect(unboardedReceipts(boarded, naming(10n))).toEqual([]);
  });

  test("are none for a cast with no receipt, or a ballot no cast has", () => {
    const held: CastRecord[] = [{ ballot: naming(10n), l1Number: 10n, shares: shares() }];
    expect(unboardedReceipts(held, naming(10n))).toEqual([]);
    expect(unboardedReceipts(held, naming(11n))).toEqual([]);
    expect(unboardedReceipts([], naming(10n))).toEqual([]);
  });

  test("hand out copies", () => {
    const held: CastRecord[] = [{ ballot: naming(10n), l1Number: 10n, shares: receipted() }];
    unboardedReceipts(held, naming(10n))[0]?.receipt.fill(0);
    expect(unboardedReceipts(held, naming(10n))).toEqual([{ seat: FIRST, receipt: own }]);
  });
});

describe("the shares erased at the posting cutoff", () => {
  test("are every seat still holding its m, in every cast, its ct and m gone and the rest untouched (fast-check)", () => {
    fc.assert(
      fc.property(casts, (list) => {
        const changed = withSharesErased(list);
        if (!keepsShares(list)) {
          expect(changed).toBe("none");
          return;
        }
        if (changed === "none") throw new Error("expected casts");
        expect(keepsShares(changed)).toBe(false);
        expect(changed).toHaveLength(list.length);
        changed.forEach((cast, i) => {
          const before = list[i] as CastRecord;
          expect(cast.ballot).toEqual(before.ballot);
          expect(cast.l1Number).toBe(before.l1Number);
          expect(cast.boarded).toEqual(before.boarded);
          expect(cast.shares).toEqual(
            before.shares.map((share) =>
              "m" in share ? { seat: share.seat, erased: true } : share,
            ),
          );
        });
        // Read back as written.
        expect(parseStoredCasts(storedCasts(changed))).toEqual(changed);
      }),
      { numRuns },
    );
  }, 600_000);

  test("are none for casts that keep no m", () => {
    expect(withSharesErased([])).toBe("none");
    const cast: CastRecord = { ballot: naming(10n), l1Number: 10n, shares: erased() };
    expect(keepsShares([cast])).toBe(false);
    expect(withSharesErased([cast])).toBe("none");
  });

  test("are stored with nothing but the seat", () => {
    const [cast] = withSharesErased([
      { ballot: naming(10n), l1Number: 10n, shares: receipted() },
    ]) as CastRecord[];
    const stored = storedCasts([cast!]) as { casts: { shares: unknown[] }[] };
    expect(stored.casts[0]?.shares[1]).toEqual({
      seat: (SHARES[1] as CastShare).seat,
      ciphertext: null,
      m: null,
      receipt: null,
      boarded: null,
    });
  });

  test("leave a newest cast holding one never resumed", () => {
    const older: CastRecord = { ballot: naming(9n), l1Number: 9n, shares: shares() };
    const newest: CastRecord = { ballot: naming(10n), l1Number: 10n, shares: erased() };
    expect(unsentCast([older, newest], DECODED.definition_hash)).toBeUndefined();
  });

  test("take no receipt in their place: the receipt is missing, never answered as kept", () => {
    const list: CastRecord[] = [{ ballot: naming(10n), l1Number: 10n, shares: erased() }];
    const second = (SHARES[1] as CastShare).seat;
    expect(withReceipt(list, naming(10n), checkedOf(second, receiptFor(second)))).toBe("missing");
    // The seat receipted before the erasure keeps its receipt, which passes again.
    expect(withReceipt(list, naming(10n), checkedOf(FIRST, receiptFor(FIRST)))).toEqual(list);
  });

  test("are never taken from the worker's shares", () => {
    const asErased = shares().map(({ seat }, i) =>
      i === 0 ? { seat, ciphertext: null, m: null } : shares()[i],
    );
    expect(() => withCast([], naming(10n), asErased as unknown as CastShare[])).toThrow(TypeError);
  });

  test("leave a later recast's carried receipts as they were", () => {
    const list: CastRecord[] = [{ ballot: naming(10n), l1Number: 10n, shares: erased() }];
    const recast = withCast(list, naming(11n), shares()) as CastRecord[];
    expect(recast[1]?.shares[0]).toEqual(erased()[0]);
    expect(recast[1]?.shares.slice(1)).toEqual(shares().slice(1));
  });
});

describe("the shares erased once the voter declines a posting", () => {
  test("are the declined cast's seats still holding an m, in it and every cast of the same seal (fast-check)", () => {
    fc.assert(
      fc.property(
        casts.filter((list) => list.length > 0),
        fc.nat(),
        (list, pick) => {
          const declined = list[pick % list.length] as CastRecord;
          const changed = withPostingDeclined(list, declined.ballot);
          if (changed === "missing") throw new Error("expected casts");
          const seats = new Set(declined.shares.flatMap((s) => ("m" in s ? [s.seat] : [])));
          expect(changed).toHaveLength(list.length);
          changed.forEach((cast, i) => {
            const before = list[i] as CastRecord;
            expect(cast.ballot).toEqual(before.ballot);
            expect(cast.boarded).toEqual(before.boarded);
            expect(cast.handed).toEqual(before.handed);
            // Every cast here is of one seal, so its shares are the declined one's.
            expect(cast.shares).toEqual(
              before.shares.map((share) =>
                "m" in share && seats.has(share.seat) ? { seat: share.seat, erased: true } : share,
              ),
            );
          });
          expect(changed[pick % list.length]?.shares.some((s) => "m" in s)).toBe(false);
          expect(parseStoredCasts(storedCasts(changed))).toEqual(changed);
        },
      ),
      { numRuns },
    );
  }, 600_000);

  test("leave receipted seats and another seal's casts as they were, and the declined cast unresumed", () => {
    // Another seal: other ciphertexts, so other share hashes in its ballot.
    const otherShares = SHARES.map(({ seat, m }) => ({
      seat,
      ciphertext: new Uint8Array(40 + seat).fill(0x40 + seat),
      m: m.slice(),
    }));
    const other = encodeBallotV3({
      ...vector,
      committed_vote: {
        ...vector.committed_vote,
        share_hashes: vector.committed_vote.share_hashes.map((_, i) => {
          const share = otherShares.find((s) => s.seat === i + 1);
          return share === undefined ? new Uint8Array(32) : shareCiphertextHash(share.ciphertext);
        }),
      },
    });
    new DataView(other.buffer).setBigUint64(L1_AT, 9n);
    const older: CastRecord = { ballot: other, l1Number: 9n, shares: otherShares };
    const declined: CastRecord = { ballot: naming(10n), l1Number: 10n, shares: receipted() };
    const changed = withPostingDeclined([older, declined], naming(10n));
    if (changed === "missing") throw new Error("expected casts");
    expect(changed[0]).toEqual(older);
    expect(changed[1]?.shares).toEqual(erased());
    expect(unsentCast(changed, DECODED.definition_hash)).toBeUndefined();
    expect(parseStoredCasts(storedCasts(changed))).toEqual(changed);
  });

  test("are missing for a ballot no cast has, and change nothing", () => {
    expect(withPostingDeclined([], naming(10n))).toBe("missing");
    const list: CastRecord[] = [{ ballot: naming(11n), l1Number: 11n, shares: shares() }];
    expect(withPostingDeclined(list, naming(10n))).toBe("missing");
  });
});

describe("a cast marked handed", () => {
  const definition = DECODED.definition_hash;
  const cast = (n: bigint): CastRecord => ({ ballot: naming(n), l1Number: n, shares: shares() });

  test("is the cast with these bytes and every cast of its seal, stored and read back so (fast-check)", () => {
    fc.assert(
      fc.property(
        casts.filter((list) => list.length > 0),
        fc.nat(),
        (list, pick) => {
          const marked = list[pick % list.length] as CastRecord;
          const changed = withHanded(list, marked.ballot);
          if (changed === "missing") throw new Error("expected casts");
          // Every cast here is of one seal, so each carries the marked one's postings.
          expect(changed).toEqual(list.map((c) => ({ ...c, handed: true })));
          expect(parseStoredCasts(storedCasts(changed))).toEqual(changed);
        },
      ),
      { numRuns },
    );
  }, 600_000);

  test("stays marked when marked again, and is missing for a ballot no cast has", () => {
    const once = withHanded([cast(10n)], naming(10n));
    if (once === "missing") throw new Error("expected casts");
    expect(withHanded(once, naming(10n))).toEqual(once);
    expect(withHanded([cast(11n)], naming(10n))).toBe("missing");
    expect(withHanded([], naming(10n))).toBe("missing");
  });

  test("keeps its mark through a receipt, a decline and the erasure at the close", () => {
    const marked = withHanded([cast(10n)], naming(10n));
    if (marked === "missing") throw new Error("expected casts");
    const receiptOf = withReceipt(marked, naming(10n), checkedOf(FIRST, receiptFor(FIRST)));
    const declined = withPostingDeclined(marked, naming(10n));
    const erasedAll = withSharesErased(marked);
    for (const changed of [receiptOf, declined, erasedAll]) {
      if (typeof changed === "string") throw new Error(changed);
      expect(changed[0]?.handed).toBe(true);
    }
  });

  test("is resumed as handed, so the page waits for its postings after a reload", () => {
    const marked = withHanded([cast(9n), cast(10n)], naming(10n));
    if (marked === "missing") throw new Error("expected casts");
    const unsent = unsentCast(marked, definition);
    if (unsent === undefined || unsent === "other-election") throw new Error("expected a cast");
    expect(unsent.handed).toBe(true);
    // An older cast's mark isn't the newest's.
    const newest = unsentCast([{ ...cast(9n), handed: true }, cast(10n)], definition);
    if (newest === undefined || newest === "other-election") throw new Error("expected a cast");
    expect(newest).not.toHaveProperty("handed");
  });

  test("carries its mark to a recast of the same seal, whose postings are its own byte for byte", () => {
    const marked = withHanded([cast(10n)], naming(10n));
    if (marked === "missing") throw new Error("expected casts");
    const recast = withCast(marked, naming(11n), shares());
    if (typeof recast === "string") throw new Error(recast);
    expect(recast[1]?.handed).toBe(true);
    // Unmarked casts carry nothing.
    const plain = withCast([cast(10n)], naming(11n), shares());
    if (typeof plain === "string") throw new Error(plain);
    expect(plain[1]).not.toHaveProperty("handed");
  });

  test("marks a recast of the same seal recorded before it, and no other seal's cast", () => {
    const otherSeal = BALLOT.slice();
    otherSeal[3 + 32 + 1 + 31] = (otherSeal[3 + 32 + 1 + 31] as number) ^ 1;
    new DataView(otherSeal.buffer).setBigUint64(L1_AT, 12n);
    const other: CastRecord = { ballot: otherSeal, l1Number: 12n, shares: shares() };
    const changed = withHanded([cast(10n), cast(11n), other], naming(10n));
    if (changed === "missing") throw new Error("expected casts");
    expect(changed.map((c) => c.handed)).toEqual([true, true, undefined]);
  });

  test("doesn't carry its mark to another seal's cast, whose postings name another ballot hash", () => {
    const marked = withHanded([cast(10n)], naming(10n));
    if (marked === "missing") throw new Error("expected casts");
    // Another nullifier: another seal's ballot hash, under the same shares.
    const otherSeal = BALLOT.slice();
    otherSeal[3 + 32 + 1 + 31] = (otherSeal[3 + 32 + 1 + 31] as number) ^ 1;
    new DataView(otherSeal.buffer).setBigUint64(L1_AT, 11n);
    const recast = withCast(marked, otherSeal, shares());
    if (typeof recast === "string") throw new Error(recast);
    expect(recast[1]).not.toHaveProperty("handed");
  });
});
