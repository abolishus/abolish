import {
  type ArchivedContractLog,
  checkEventAccumulatorProof,
  type ContractEventEvidence,
  decodeContractEventEvidence,
  encodeContractEventEvidence,
  objectCar,
  objectCid,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ACCUMULATOR_SLOT,
  checkContractEventEvidence,
  DEFAULT_EVIDENCE_READS,
  EVIDENCE_DATA_LIMIT,
  type EvidenceListing,
  latestEvidence,
  MAX_EVIDENCE_RECORD,
  readEvidence,
} from "../src/index.ts";
import { type Account, l2State, word } from "./state.ts";

// The evidence check (docs/spec/archive.md, Contract-event evidence, The
// evidence check; src/evidence.ts). Records are encoded by packages/crypto
// (vectored by archive-v2.json) over states the tests' own trie writer
// builds (tests/state.ts), and over archive-v2.json's real Base Sepolia
// record, so neither the proofs nor the expected accumulators come from the
// reader under test (T-71, T-17).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IPropertyWithHooks<T> | fc.IProperty<T>) => fc.assert(p, { numRuns });

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const L2 = 84_532n;
const BOARD = hex("00000000000000000000000000000000000b0a2d");
const BLOCK = 1_000n;
const S = word(ACCUMULATOR_SLOT);
const S1 = word(ACCUMULATOR_SLOT + 1n);
const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });

const ascending = (nodes: readonly Uint8Array[]) =>
  [...new Map(nodes.map((n) => [toHex(n), n])).values()].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
    return a.length - b.length;
  });

// The board contract's accumulator and count at `BLOCK`, beside `others`,
// as a record holding every node the state has.
function record(
  accumulator: Uint8Array,
  count: bigint,
  others: readonly Account[] = [],
  block = BLOCK,
): ContractEventEvidence {
  const { evidence } = l2State(
    [
      {
        address: BOARD,
        storage: [
          [S, accumulator],
          [S1, word(count)],
        ],
      },
      ...others,
    ],
    block,
    1_800_000_000n,
  );
  return {
    l2_chain_id: L2,
    contract: BOARD,
    game_index: 28_322n,
    game: new Uint8Array(20).fill(0x9a),
    output_root: evidence.outputRoot,
    message_passer_storage_root: evidence.messagePasserStorageRoot,
    header: evidence.header,
    nodes: ascending(evidence.nodes),
  };
}

const claim = { contract: BOARD, l2Block: BLOCK };

const logs: ArchivedContractLog[] = [0n, 1n, 2n].map((n) => ({
  n,
  block: 900n + n,
  timestamp: 1_799_999_000n + n,
  topics: [keccak_256(Uint8Array.of(Number(n)))],
  data: new Uint8Array(0),
}));
const replayed = replayEventAccumulator(L2, BOARD, logs);
const honest = () => record(replayed.accumulator, replayed.count);

const otherAccount = fc.record({
  address: bytes(20).filter((a) => toHex(a) !== toHex(BOARD)),
  storage: fc.uniqueArray(fc.tuple(bytes(32), bytes(32)), {
    maxLength: 2,
    selector: ([slot]) => toHex(slot),
  }),
});

describe("checkContractEventEvidence", () => {
  test("proves the contract's accumulator at the listing's block, which the event check accepts", () => {
    const r = honest();
    const check = checkContractEventEvidence(r, claim, L2);
    expect(check).toMatchObject({
      ok: true,
      gameIndex: 28_322n,
      game: r.game,
      outputRoot: r.output_root,
      accumulator: { block: BLOCK, timestamp: 1_800_000_000n, count: 3n },
    });
    if (!check.ok) throw new Error("unreachable");
    expect(check.accumulator.accumulator).toEqual(replayed.accumulator);
    expect(checkEventAccumulatorProof(L2, BOARD, logs, check.accumulator)).toBeNull();
    expect(checkEventAccumulatorProof(L2, BOARD, logs.slice(1), check.accumulator)).not.toBeNull();
  });

  test("any accumulator and count of a lone contract is proven exactly", () => {
    run(
      fc.property(bytes(32), fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (acc, count) => {
        const check = checkContractEventEvidence(record(acc, count), claim, L2);
        expect(check.ok).toBe(true);
        if (!check.ok) return;
        expect(check.accumulator.accumulator).toEqual(acc);
        expect(check.accumulator.count).toBe(count);
      }),
    );
  });

  test("refuses another L2 or another contract than the listing's (evidence-foreign)", () => {
    const r = honest();
    expect(checkContractEventEvidence(r, claim, L2 + 1n)).toEqual({
      ok: false,
      code: "evidence-foreign",
    });
    const other = { ...claim, contract: new Uint8Array(20).fill(0x11) };
    expect(checkContractEventEvidence(r, other, L2)).toEqual({
      ok: false,
      code: "evidence-foreign",
    });
    // The record's own contract is the one proven: one naming another
    // contract than its listing is refused before its proof is read.
    const renamed = { ...r, contract: other.contract };
    expect(checkContractEventEvidence(renamed, claim, L2).ok).toBe(false);
    expect(checkContractEventEvidence(renamed, other, L2)).toEqual({
      ok: false,
      code: "l2-contract-absent",
    });
  });

  test("refuses a record whose root the header and message-passer root don't hash to", () => {
    run(
      fc.property(
        fc.nat(255),
        fc.constantFrom("output_root", "message_passer_storage_root"),
        (bit, field) => {
          const r = honest();
          const changed = Uint8Array.from(r[field]);
          changed[bit >> 3] = (changed[bit >> 3] as number) ^ (1 << (bit & 7));
          expect(checkContractEventEvidence({ ...r, [field]: changed }, claim, L2)).toEqual({
            ok: false,
            code: "output-root",
          });
        },
      ),
    );
  });

  test("refuses a header that isn't one RLP header, and a proof short of a node", () => {
    const r = honest();
    expect(
      checkContractEventEvidence({ ...r, header: Uint8Array.of(...r.header, 0) }, claim, L2),
    ).toEqual({ ok: false, code: "l2-header" });
    for (let i = 0; i < r.nodes.length; i++) {
      const nodes = r.nodes.filter((_, j) => j !== i);
      expect(checkContractEventEvidence({ ...r, nodes }, claim, L2)).toEqual({
        ok: false,
        code: "l2-proof-missing",
      });
    }
  });

  test("refuses a contract with no account, and a count above a u64", () => {
    const absent = record(new Uint8Array(32).fill(1), 1n);
    const elsewhere = new Uint8Array(20).fill(0x22);
    expect(
      checkContractEventEvidence(
        { ...absent, contract: elsewhere },
        { ...claim, contract: elsewhere },
        L2,
      ),
    ).toEqual({ ok: false, code: "l2-contract-absent" });
    expect(checkContractEventEvidence(record(new Uint8Array(32), 1n << 64n), claim, L2)).toEqual({
      ok: false,
      code: "l2-count",
    });
  });

  test("refuses a header of another block than the listing's (evidence-block)", () => {
    run(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (block) => {
        fc.pre(block !== BLOCK);
        expect(checkContractEventEvidence(honest(), { ...claim, l2Block: block }, L2)).toEqual({
          ok: false,
          code: "evidence-block",
        });
      }),
    );
  });

  test("refuses a node no walk of the proof uses (evidence-node-unused)", () => {
    run(
      fc.property(fc.array(otherAccount, { minLength: 1, maxLength: 3 }), (others) => {
        const unique = others.filter(
          (a, i) => others.findIndex((b) => toHex(b.address) === toHex(a.address)) === i,
        );
        // Every node of a state with other accounts: theirs aren't on the
        // board contract's paths.
        const r = record(replayed.accumulator, replayed.count, unique);
        expect(checkContractEventEvidence(r, claim, L2)).toEqual({
          ok: false,
          code: "evidence-node-unused",
        });
      }),
    );
    // A node of any bytes beside an honest proof.
    run(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 532 }), (extra) => {
        const r = honest();
        fc.pre(!r.nodes.some((n) => toHex(n) === toHex(extra)));
        const nodes = ascending([...r.nodes, extra]);
        expect(checkContractEventEvidence({ ...r, nodes }, claim, L2)).toEqual({
          ok: false,
          code: "evidence-node-unused",
        });
      }),
    );
  });

  test("reports the first check that fails, in the spec's order", () => {
    const r = honest();
    const extra = ascending([...r.nodes, Uint8Array.of(0xc0)]);
    // Foreign before the proof is read.
    expect(
      checkContractEventEvidence({ ...r, output_root: new Uint8Array(32) }, claim, L2 + 1n),
    ).toEqual({ ok: false, code: "evidence-foreign" });
    // The proof before the block.
    expect(
      checkContractEventEvidence(
        { ...r, output_root: new Uint8Array(32) },
        { ...claim, l2Block: 7n },
        L2,
      ),
    ).toEqual({ ok: false, code: "output-root" });
    // The block before an unused node.
    expect(
      checkContractEventEvidence({ ...r, nodes: extra }, { ...claim, l2Block: 7n }, L2),
    ).toEqual({ ok: false, code: "evidence-block" });
  });

  test("archive-v2.json's Base Sepolia records prove other slots, never an accumulator", () => {
    const file = JSON.parse(
      readFileSync(new URL("../../../docs/spec/vectors/archive-v2.json", import.meta.url), "utf8"),
    ) as { readonly records: readonly { readonly id: string; readonly encoding: string }[] };
    // Each record's nodes are a predeploy's account proof and the storage
    // proofs of its slots 0 and up, from eth_getProof at the game's block,
    // with the header the game's root commits to. The message passer's
    // storage trie is deep, so the walk to `S` needs a node the record
    // doesn't carry; L1Block's is small enough that the nodes on the way
    // prove `S` unwritten, and the leaves of slots 0 to 3 go unused.
    const expected = new Map([
      ["base-sepolia-message-passer", "l2-proof-missing"],
      ["base-sepolia-l1-block", "evidence-node-unused"],
    ]);
    for (const [id, code] of expected) {
      const v = file.records.find((x) => x.id === id);
      if (v === undefined) throw new Error(`${id} is missing`);
      const r = decodeContractEventEvidence(hex(v.encoding), 1);
      const at = { contract: r.contract, l2Block: 48_233_063n };
      expect(checkContractEventEvidence(r, at, L2)).toEqual({ ok: false, code });
      // The proof's code comes before the block's.
      expect(checkContractEventEvidence(r, { ...at, l2Block: 1n }, L2)).toEqual(
        code === "l2-proof-missing" ? { ok: false, code } : { ok: false, code: "evidence-block" },
      );
    }
  });

  test("refuses a claim whose contract isn't 20 bytes", () => {
    expect(() =>
      checkContractEventEvidence(honest(), { contract: BOARD.subarray(1), l2Block: BLOCK }, L2),
    ).toThrow(RangeError);
  });
});

describe("readEvidence", () => {
  const tx = (n: number) => new Uint8Array(32).fill(n);
  const encoded = encodeContractEventEvidence(honest());
  const cid = objectCid(encoded);
  const listing = (transactions: readonly Uint8Array[], c = cid): EvidenceListing => ({
    contract: BOARD,
    l2Block: BLOCK,
    cid: c,
    transactions,
  });

  function source(held: ReadonlyMap<string, readonly Uint8Array[]>) {
    const asked: string[] = [];
    return {
      asked,
      source: async (t: Uint8Array, limit: number) => {
        expect(limit).toBe(EVIDENCE_DATA_LIMIT);
        asked.push(toHex(t));
        return held.get(toHex(t)) ?? [];
      },
    };
  }

  test("the record's bound is the spec's 35,459 bytes, one raw block", () => {
    expect(MAX_EVIDENCE_RECORD).toBe(35_459);
    expect(EVIDENCE_DATA_LIMIT).toBe(59 + 3 + 36 + 35_459);
  });

  test("reads the record from the first transaction serving its CAR and proves it", async () => {
    const { source: s, asked } = source(
      new Map([
        [toHex(tx(2)), [Uint8Array.of(1, 2, 3), objectCar(encoded)]],
        [toHex(tx(3)), [objectCar(encoded)]],
      ]),
    );
    const got = await readEvidence(listing([tx(1), tx(2), tx(3)]), L2, s);
    expect(got).toMatchObject({ kind: "proven", transaction: tx(2), gameIndex: 28_322n });
    if (got.kind !== "proven") throw new Error("unreachable");
    expect(got.accumulator.accumulator).toEqual(replayed.accumulator);
    expect(asked).toEqual([toHex(tx(1)), toHex(tx(2))]);
  });

  test("an answer past the data limit is never parsed", async () => {
    const car = objectCar(encoded);
    const long = Uint8Array.of(...car, ...new Uint8Array(EVIDENCE_DATA_LIMIT + 1 - car.length));
    const got = await readEvidence(
      listing([tx(1)]),
      L2,
      source(new Map([[toHex(tx(1)), [long]]])).source,
    );
    expect(got).toEqual({ kind: "evidence-unavailable", transactions: [tx(1)] });
  });

  test("no transaction serving the CID is evidence-unavailable, with every one tried", async () => {
    const other = objectCar(encodeContractEventEvidence(record(new Uint8Array(32).fill(5), 1n)));
    const { source: s, asked } = source(new Map([[toHex(tx(1)), [other]]]));
    expect(await readEvidence(listing([tx(1), tx(2)]), L2, s)).toEqual({
      kind: "evidence-unavailable",
      transactions: [tx(1), tx(2)],
    });
    expect(asked).toEqual([toHex(tx(1)), toHex(tx(2))]);
  });

  test("bytes its CID names that aren't a version-1 record settle the listing as malformed", async () => {
    const v2 = Uint8Array.from(encoded);
    v2[2] = 2;
    const { source: s, asked } = source(
      new Map([
        [toHex(tx(1)), [objectCar(v2)]],
        [toHex(tx(2)), [objectCar(v2)]],
      ]),
    );
    expect(await readEvidence(listing([tx(1), tx(2)], objectCid(v2)), L2, s)).toEqual({
      kind: "evidence-malformed",
      transaction: tx(1),
    });
    expect(asked).toEqual([toHex(tx(1))]);
  });

  test("a record that checks as nothing for its listing settles it with the check's code", async () => {
    const held = new Map([[toHex(tx(1)), [objectCar(encoded)]]]);
    expect(
      await readEvidence({ ...listing([tx(1)]), l2Block: 9n }, L2, source(held).source),
    ).toEqual({
      kind: "evidence-check",
      code: "evidence-block",
      transaction: tx(1),
    });
    expect(await readEvidence(listing([tx(1)]), 1n, source(held).source)).toEqual({
      kind: "evidence-check",
      code: "evidence-foreign",
      transaction: tx(1),
    });
  });
});

describe("latestEvidence", () => {
  const tx = (n: number) => new Uint8Array(32).fill(n);
  // The honest accumulator over three events, proven at `block`.
  const at = (block: bigint, count = replayed.count) => {
    const encoded = encodeContractEventEvidence(
      record(
        count === replayed.count ? replayed.accumulator : new Uint8Array(32).fill(7),
        count,
        [],
        block,
      ),
    );
    return { encoded, cid: objectCid(encoded) };
  };
  const listing = (
    r: { readonly cid: Uint8Array },
    block: bigint,
    transactions: readonly Uint8Array[],
  ): EvidenceListing => ({ contract: BOARD, l2Block: block, cid: r.cid, transactions });

  // Serves each transaction's CAR; every ask is recorded.
  function source(held: ReadonlyMap<string, Uint8Array>) {
    const asked: string[] = [];
    return {
      asked,
      source: async (t: Uint8Array) => {
        asked.push(toHex(t));
        const b = held.get(toHex(t));
        return b === undefined ? [] : [objectCar(b)];
      },
    };
  }

  test("takes the latest block's record, asking nothing of earlier ones", async () => {
    const early = at(1_000n);
    const late = at(2_000n);
    const { source: s, asked } = source(
      new Map([
        [toHex(tx(1)), early.encoded],
        [toHex(tx(2)), late.encoded],
      ]),
    );
    const got = await latestEvidence(
      [listing(early, 1_000n, [tx(1)]), listing(late, 2_000n, [tx(2)])],
      L2,
      3,
      s,
    );
    expect(got.findings).toEqual([]);
    expect(got.reads).toBe(1);
    expect(got.proven).toMatchObject({
      cid: late.cid,
      transaction: tx(2),
      gameIndex: 28_322n,
      accumulator: { block: 2_000n, count: 3n },
    });
    expect(asked).toEqual([toHex(tx(2))]);
  });

  test("reports each later listing that doesn't hold up and takes the next one that does", async () => {
    const good = at(1_000n);
    const v2 = Uint8Array.from(at(3_000n).encoded);
    v2[2] = 2;
    const wrongBlock = at(4_000n);
    const { source: s, asked } = source(
      new Map([
        [toHex(tx(1)), good.encoded],
        [toHex(tx(3)), v2],
        [toHex(tx(4)), wrongBlock.encoded],
      ]),
    );
    const got = await latestEvidence(
      [
        listing(good, 1_000n, [tx(1)]),
        listing({ cid: objectCid(v2) }, 3_000n, [tx(3)]),
        // Listed under a block its header isn't.
        listing(wrongBlock, 5_000n, [tx(4)]),
        listing(at(2_000n), 2_000n, [tx(5), tx(6)]),
      ],
      L2,
      3,
      s,
    );
    expect(got.findings).toEqual([
      {
        code: "evidence-check",
        check: "evidence-block",
        l2Block: 5_000n,
        cid: wrongBlock.cid,
        transaction: tx(4),
      },
      { code: "evidence-malformed", l2Block: 3_000n, cid: objectCid(v2), transaction: tx(3) },
      {
        code: "evidence-unavailable",
        l2Block: 2_000n,
        cid: at(2_000n).cid,
        transactions: [tx(5), tx(6)],
      },
    ]);
    expect(got.proven).toMatchObject({ cid: good.cid, transaction: tx(1) });
    expect(got.reads).toBe(5);
    expect(asked).toEqual([4, 3, 5, 6, 1].map((n) => toHex(tx(n))));
  });

  test("passes over a record of more events than the bundle carries", async () => {
    const early = at(1_000n);
    const more = at(2_000n, 4n);
    const { source: s } = source(
      new Map([
        [toHex(tx(1)), early.encoded],
        [toHex(tx(2)), more.encoded],
      ]),
    );
    const listings = [listing(early, 1_000n, [tx(1)]), listing(more, 2_000n, [tx(2)])];
    const got = await latestEvidence(listings, L2, 3, s);
    expect(got.findings).toEqual([
      { code: "evidence-count", l2Block: 2_000n, cid: more.cid, count: 4n },
    ]);
    expect(got.proven).toMatchObject({ cid: early.cid });
    // With four events the later one is taken.
    expect((await latestEvidence(listings, L2, 4, s)).proven).toMatchObject({ cid: more.cid });
  });

  test("listings of one block are read in walk order", async () => {
    const a = at(1_000n);
    const b = at(1_000n, 1n);
    const { source: s } = source(
      new Map([
        [toHex(tx(1)), a.encoded],
        [toHex(tx(2)), b.encoded],
      ]),
    );
    const first = await latestEvidence(
      [listing(b, 1_000n, [tx(2)]), listing(a, 1_000n, [tx(1)])],
      L2,
      3,
      s,
    );
    expect(first.proven).toMatchObject({ cid: b.cid, accumulator: { count: 1n } });
    const second = await latestEvidence(
      [listing(a, 1_000n, [tx(1)]), listing(b, 1_000n, [tx(2)])],
      L2,
      3,
      s,
    );
    expect(second.proven).toMatchObject({ cid: a.cid, accumulator: { count: 3n } });
  });

  test("the read budget stops the reads, never calling unasked transactions unavailable", async () => {
    const good = at(1_000n);
    const { source: s, asked } = source(new Map([[toHex(tx(9)), good.encoded]]));
    // Three dead transactions for the latest, then the good one.
    const listings = [
      listing(good, 1_000n, [tx(9)]),
      listing(at(2_000n), 2_000n, [tx(1), tx(2), tx(3)]),
    ];
    expect(await latestEvidence(listings, L2, 3, s, 2)).toEqual({
      reads: 2,
      findings: [{ code: "evidence-reads-over-budget", maxReads: 2 }],
    });
    expect(asked).toEqual([toHex(tx(1)), toHex(tx(2))]);
    // Spent exactly by one listing, the next isn't asked.
    const spent = await latestEvidence(listings, L2, 3, s, 3);
    expect(spent.proven).toBeUndefined();
    expect(spent.findings).toEqual([
      {
        code: "evidence-unavailable",
        l2Block: 2_000n,
        cid: at(2_000n).cid,
        transactions: [tx(1), tx(2), tx(3)],
      },
      { code: "evidence-reads-over-budget", maxReads: 3 },
    ]);
    expect((await latestEvidence(listings, L2, 3, s, 4)).proven).toMatchObject({ cid: good.cid });
    expect(DEFAULT_EVIDENCE_READS).toBe(64);
  });

  test("whatever the listings, the reads never pass the budget and every listing asked is reported", async () => {
    const good = at(1_000n);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 3_000 }), fc.integer({ min: 0, max: 4 })), {
          maxLength: 12,
        }),
        fc.integer({ min: 1, max: 20 }),
        async (spec, maxReads) => {
          // Only transaction 200 serves anything: the good record, at block 1,000.
          const listings = spec
            .map(([block, dead], i) =>
              listing(at(BigInt(block)), BigInt(block), [
                ...Array.from({ length: dead }, (_, j) => tx(1 + ((i * 5 + j) % 199))),
                ...(block === 1_000 ? [tx(200)] : []),
              ]),
            )
            .filter((l) => l.transactions.length > 0);
          const { source: s, asked } = source(new Map([[toHex(tx(200)), good.encoded]]));
          const got = await latestEvidence(listings, L2, 3, s, maxReads);
          expect(got.reads).toBe(asked.length);
          expect(got.reads).toBeLessThanOrEqual(maxReads);
          if (got.proven === undefined)
            expect(
              got.findings.some((f) => f.code === "evidence-reads-over-budget") ||
                !listings.some((l) => l.l2Block === 1_000n),
            ).toBe(true);
          else expect(got.proven.cid).toEqual(good.cid);
        },
      ),
      { numRuns },
    );
  });

  test("refuses a read budget that isn't a positive integer", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53])
      await expect(latestEvidence([], L2, 3, async () => [], bad)).rejects.toThrow(RangeError);
  });
});
