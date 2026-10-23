import {
  CHUNK_SIZE,
  type ContractEventRun,
  contractEventRunRecords,
  decodeContractEventRun,
  encodeContractEvent,
  encodeContractEventRun,
  MAX_CONTRACT_EVENT_RUN,
  objectCar,
  objectCid,
  type RunEvent,
} from "@abolishus/crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  archivedDataLimit,
  DEFAULT_RUN_BYTES,
  readRuns,
  type RunFinding,
  type RunListing,
  runBound,
} from "../src/index.ts";

// The event replay's reads (docs/spec/archive.md, The event replay): a
// contract's archived sequence from n = 0, assembled from the run listings a
// walk keeps, each run read by its CID and held to its listing. Runs are
// written through packages/crypto's encoder (vectored by archive-v3.json),
// archived as their CARs under made-up transaction IDs, and served by a
// scripted source.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const L2 = 84_532n;
const BOARD = new Uint8Array(20).fill(0xb0);
const REGISTRY = new Uint8Array(20).fill(0xc0);

const tx = (n: number) => {
  const t = new Uint8Array(32);
  t[0] = 0x7b;
  t[30] = (n >>> 8) & 0xff;
  t[31] = n & 0xff;
  return t;
};

// Event `n` of a contract's made-up sequence: its block, time, one topic and
// data all name `n`, so each event is told apart from every other.
const event = (n: bigint, data = Uint8Array.of(Number(n & 0xffn))): RunEvent => ({
  l2_block: 100n + n,
  l2_timestamp: 1_000n + 2n * n,
  topics: [new Uint8Array(32).fill(Number(n & 0xffn))],
  data,
});

interface Stored {
  readonly run: ContractEventRun;
  readonly bytes: Uint8Array;
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
}

function stored(
  first: bigint,
  count: number,
  t: number,
  fields: Partial<ContractEventRun> = {},
): Stored {
  const run: ContractEventRun = {
    l2_chain_id: L2,
    contract: BOARD,
    first,
    events: Array.from({ length: count }, (_, i) => event(first + BigInt(i))),
    ...fields,
  };
  const bytes = encodeContractEventRun(run);
  return { run, bytes, cid: objectCid(bytes), transaction: tx(t) };
}

const listing = (s: Stored, over: Partial<RunListing> = {}): RunListing => ({
  contract: s.run.contract,
  first: s.run.first,
  count: s.run.events.length,
  cid: s.cid,
  transactions: [s.transaction],
  ...over,
});

// Serves each stored run's CAR under its transaction, after any answers
// given first for that transaction, and records every ask.
function arweave(runs: readonly Stored[], before = new Map<string, Uint8Array[]>()) {
  const held = new Map<string, Uint8Array[]>();
  for (const s of runs)
    held.set(bytesToHex(s.transaction), [
      ...(before.get(bytesToHex(s.transaction)) ?? []),
      objectCar(s.bytes),
    ]);
  for (const [t, answers] of before) if (!held.has(t)) held.set(t, answers);
  const asked: { transaction: string; limit: number }[] = [];
  const source = async (t: Uint8Array, limit: number): Promise<Uint8Array[]> => {
    asked.push({ transaction: bytesToHex(t), limit });
    return held.get(bytesToHex(t)) ?? [];
  };
  return { source, asked };
}

const codes = (f: readonly RunFinding[]) => f.map((x) => x.code);

// The first of `make(0)`, `make(1)`, … whose CID sorts below `than`'s, so a
// test knows which of two listings at one index is read first.
function below(than: Stored, make: (d: number) => Stored): Stored {
  for (let d = 0; d < 256; d++) {
    const s = make(d);
    if (bytesToHex(s.cid) < bytesToHex(than.cid)) return s;
  }
  throw new Error("no CID below");
}
const sequence = (count: number) =>
  contractEventRunRecords({
    l2_chain_id: L2,
    contract: BOARD,
    first: 0n,
    events: Array.from({ length: count }, (_, i) => event(BigInt(i))),
  });

describe("readRuns", () => {
  test("assembles the sequence from runs in order, one ask each", async () => {
    const runs = [stored(0n, 3, 1), stored(3n, 1, 2), stored(4n, 6, 3)];
    const { source, asked } = arweave(runs);
    // Listed in another order than the sequence's: the reads go by `first`.
    const got = await readRuns(
      [runs[2], runs[0], runs[1]].map((s) => listing(s as Stored)),
      BOARD,
      L2,
      10n,
      source,
    );
    expect(got.complete).toBe(true);
    expect(got.findings).toEqual([]);
    expect(got.records).toEqual(sequence(10));
    expect(got.taken.map((r) => [r.first, r.count])).toEqual([
      [0n, 3],
      [3n, 1],
      [4n, 6],
    ]);
    expect(got.reads).toBe(3);
    expect(asked.map((a) => a.transaction)).toEqual(runs.map((s) => bytesToHex(s.transaction)));
    expect(got.spent).toBe(runs.reduce((n, s) => n + objectCar(s.bytes).length, 0));
    // Each ask's limit is the CAR of a run of its listing's count.
    for (const [i, s] of runs.entries())
      expect(asked[i]?.limit).toBe(archivedDataLimit(runBound(s.run.events.length)));
  });

  test("stops once the count is reached, even partway through a run's span", async () => {
    const runs = [stored(0n, 3, 1), stored(3n, 3, 2), stored(6n, 3, 3)];
    const { source, asked } = arweave(runs);
    const got = await readRuns(
      runs.map((s) => listing(s)),
      BOARD,
      L2,
      4n,
      source,
    );
    expect(got.complete).toBe(true);
    // The run that reaches past the count is taken whole: the caller
    // replays the first `count` against the evidence.
    expect(got.records).toEqual(sequence(6));
    expect(asked).toHaveLength(2);
  });

  test("a count of 0 needs nothing, and asks nothing", async () => {
    const { source, asked } = arweave([stored(0n, 1, 1)]);
    const got = await readRuns([listing(stored(0n, 1, 1))], BOARD, L2, 0n, source);
    expect(got).toMatchObject({ complete: true, records: [], findings: [], reads: 0 });
    expect(asked).toEqual([]);
  });

  test("an index where no listing starts is a gap, and nothing past it is read", async () => {
    const runs = [stored(0n, 2, 1), stored(3n, 2, 2)];
    const { source, asked } = arweave(runs);
    const got = await readRuns(
      runs.map((s) => listing(s)),
      BOARD,
      L2,
      5n,
      source,
    );
    expect(got.complete).toBe(false);
    expect(got.findings).toEqual([{ code: "run-gap", n: 2n }]);
    expect(got.records).toEqual(sequence(2));
    expect(asked).toHaveLength(1);
    // Nothing listed at all is a gap at 0.
    const none = await readRuns([], BOARD, L2, 1n, source);
    expect(none.findings).toEqual([{ code: "run-gap", n: 0n }]);
  });

  test("only the contract asked about is read", async () => {
    const other = stored(0n, 2, 1, { contract: REGISTRY });
    const ours = stored(0n, 2, 2);
    const { source, asked } = arweave([other, ours]);
    const got = await readRuns([listing(other), listing(ours)], BOARD, L2, 2n, source);
    expect(got.complete).toBe(true);
    expect(asked.map((a) => a.transaction)).toEqual([bytesToHex(ours.transaction)]);
  });

  test("a listing no transaction serves is unavailable, and the next at its index is tried", async () => {
    const good = stored(0n, 2, 1);
    const lost = below(good, (d) =>
      stored(0n, 2, 2, { events: [event(0n, Uint8Array.of(d)), event(1n)] }),
    );
    const { source } = arweave([good]);
    const got = await readRuns(
      [listing(good), listing(lost, { transactions: [tx(50), tx(51)] })],
      BOARD,
      L2,
      2n,
      source,
    );
    expect(got.complete).toBe(true);
    expect(got.records).toEqual(sequence(2));
    expect(got.findings).toEqual([
      { code: "run-unavailable", first: 0n, cid: lost.cid, transactions: [tx(50), tx(51)] },
    ]);
  });

  test("of two runs at one index the first in CID order is taken, and the other never read", async () => {
    const x = stored(0n, 2, 1);
    const y = stored(0n, 2, 2, { events: [event(0n, Uint8Array.of(7)), event(1n)] });
    const [low, high] = bytesToHex(x.cid) < bytesToHex(y.cid) ? [x, y] : [y, x];
    const { source, asked } = arweave([x, y]);
    // Listed high first: the order is the CIDs', never the walk's.
    const got = await readRuns([listing(high), listing(low)], BOARD, L2, 2n, source);
    expect(got.taken).toEqual([
      { first: 0n, count: 2, cid: low.cid, transaction: low.transaction },
    ]);
    expect(got.records).toEqual(contractEventRunRecords(low.run));
    expect(asked.map((a) => a.transaction)).toEqual([bytesToHex(low.transaction)]);
  });

  test("a listing whose run disagrees with it or the L2 is foreign", async () => {
    const good = stored(0n, 2, 9);
    const cases: [Stored, Partial<RunListing>][] = [
      [stored(0n, 2, 1, { l2_chain_id: L2 + 1n }), {}],
      [stored(0n, 2, 2, { contract: REGISTRY }), { contract: BOARD }],
      [stored(1n, 2, 3), { first: 0n }],
      [stored(0n, 3, 4), { count: 2 }],
      [stored(0n, 1, 5), { count: 2 }],
    ];
    for (const [s, over] of cases) {
      const { source } = arweave([s, good]);
      const bad = listing(s, over);
      const got = await readRuns([bad, listing(good)], BOARD, L2, 2n, source);
      expect(got.complete).toBe(true);
      expect(got.records).toEqual(sequence(2));
      // Read first only where its CID sorts below the good run's.
      expect(got.findings).toEqual(
        bytesToHex(s.cid) < bytesToHex(good.cid)
          ? [{ code: "run-foreign", first: 0n, cid: s.cid, transaction: s.transaction }]
          : [],
      );
      // Alone, it leaves a gap.
      const alone = await readRuns([bad], BOARD, L2, 2n, source);
      expect(codes(alone.findings)).toEqual(["run-foreign", "run-gap"]);
    }
  });

  test("bytes that read as the CID but aren't a run are malformed, and settle it", async () => {
    const junk = Uint8Array.of(0x00, 0x26, 0x01, 1, 2, 3);
    const cid = objectCid(junk);
    const { source, asked } = arweave([], new Map([[bytesToHex(tx(1)), [objectCar(junk)]]]));
    const bad: RunListing = {
      contract: BOARD,
      first: 0n,
      count: 1,
      cid,
      transactions: [tx(1), tx(2)],
    };
    const got = await readRuns([bad], BOARD, L2, 1n, source);
    expect(got.findings).toEqual([
      { code: "run-malformed", first: 0n, cid, transaction: tx(1) },
      { code: "run-gap", n: 0n },
    ]);
    // The CID fixes the bytes, so the second transaction is never asked.
    expect(asked).toHaveLength(1);
  });

  test("a CID listed twice is read once, and judged against each listing", async () => {
    const s = stored(0n, 2, 1);
    const { source, asked } = arweave([s]);
    // A count of 1 sorts first and is foreign; the count of 2 then takes the
    // bytes already read.
    const got = await readRuns([listing(s), listing(s, { count: 1 })], BOARD, L2, 2n, source);
    expect(got.complete).toBe(true);
    expect(got.findings).toEqual([
      { code: "run-foreign", first: 0n, cid: s.cid, transaction: s.transaction },
    ]);
    expect(asked).toHaveLength(1);
  });

  test(
    "an object over its count's bound is over-bound, and read again for a larger count",
    { timeout: 30_000 },
    async () => {
      // Fifteen identical events of exactly one chunk each: every chunk but
      // the first and last is the same block, so the CAR is about two
      // chunks while the run is fifteen, within the data limit of a run of 2.
      const same: RunEvent = {
        l2_block: 0n,
        l2_timestamp: 0n,
        topics: [],
        data: new Uint8Array(CHUNK_SIZE - 24),
      };
      const s = stored(0n, 15, 1, { events: Array.from({ length: 15 }, () => same) });
      expect(s.bytes.length).toBeGreaterThan(runBound(2));
      expect(objectCar(s.bytes).length).toBeLessThanOrEqual(archivedDataLimit(runBound(2)));
      const { source, asked } = arweave([s]);
      const alone = await readRuns([listing(s, { count: 2 })], BOARD, L2, 15n, source);
      expect(alone.findings).toEqual([
        { code: "run-over-bound", first: 0n, cid: s.cid, transaction: s.transaction },
        { code: "run-gap", n: 0n },
      ]);
      asked.length = 0;
      const both = await readRuns(
        [listing(s, { count: 2 }), listing(s, { count: 2, transactions: [tx(2)] }), listing(s)],
        BOARD,
        L2,
        15n,
        source,
      );
      expect(both.complete).toBe(true);
      expect(codes(both.findings)).toEqual(["run-over-bound", "run-over-bound"]);
      // Once for the count of 2, never for its second listing, again for 15.
      expect(asked.map((a) => a.limit)).toEqual([
        archivedDataLimit(runBound(2)),
        archivedDataLimit(runBound(15)),
      ]);
    },
  );

  test("junk before the run is that source's failure, and an answer past the limit is never parsed", async () => {
    const s = stored(0n, 1, 1);
    const limit = archivedDataLimit(runBound(1));
    const before = new Map([
      [bytesToHex(s.transaction), [Uint8Array.of(1, 2, 3), new Uint8Array(limit + 1)]],
    ]);
    const got = await readRuns([listing(s)], BOARD, L2, 1n, arweave([s], before).source);
    expect(got.complete).toBe(true);
    // The junk is charged; the answer past the limit isn't held.
    expect(got.spent).toBe(3 + objectCar(s.bytes).length);
  });

  test("a transaction listed twice is asked once", async () => {
    const s = stored(0n, 1, 1);
    const { source, asked } = arweave([], new Map());
    const got = await readRuns(
      [listing(s, { transactions: [tx(5), tx(5), tx(6)] })],
      BOARD,
      L2,
      1n,
      source,
    );
    expect(got.findings).toEqual([
      { code: "run-unavailable", first: 0n, cid: s.cid, transactions: [tx(5), tx(6)] },
      { code: "run-gap", n: 0n },
    ]);
    expect(asked).toHaveLength(2);
  });

  test("the read budget stops the reads, exactly spent or not", async () => {
    const runs = [stored(0n, 1, 1), stored(1n, 1, 2), stored(2n, 1, 3)];
    const { source } = arweave(runs);
    const all = runs.map((s) => listing(s));
    const short = await readRuns(all, BOARD, L2, 3n, source, DEFAULT_RUN_BYTES, 2);
    expect(short.complete).toBe(false);
    expect(short.findings).toEqual([
      { code: "runs-over-budget", n: 2n, maxBytes: DEFAULT_RUN_BYTES, maxReads: 2 },
    ]);
    expect(short.reads).toBe(2);
    const exact = await readRuns(all, BOARD, L2, 3n, source, DEFAULT_RUN_BYTES, 3);
    expect(exact).toMatchObject({ complete: true, reads: 3, findings: [] });
  });

  test("a byte budget short of a run's bound with nothing read is over budget, never unavailable", async () => {
    const s = stored(0n, 1, 1);
    const car = objectCar(s.bytes).length;
    // Enough for the honest run: read, though the budget is under its bound.
    const fits = await readRuns([listing(s)], BOARD, L2, 1n, arweave([s]).source, car);
    expect(fits).toMatchObject({ complete: true, spent: car });
    // Nothing served under a budget short of the bound: an honest answer may have been too long.
    const none = await readRuns([listing(s)], BOARD, L2, 1n, arweave([]).source, 1_000);
    expect(none.findings).toEqual([
      { code: "runs-over-budget", n: 0n, maxBytes: 1_000, maxReads: 1_024 },
    ]);
    // Spent on junk: the reads stop at the next ask.
    const junk = new Map([[bytesToHex(tx(9)), [new Uint8Array(1_000)]]]);
    const spent = await readRuns(
      [listing(s, { transactions: [tx(9), s.transaction] })],
      BOARD,
      L2,
      1n,
      arweave([s], junk).source,
      1_000,
    );
    expect(spent).toMatchObject({ spent: 1_000, reads: 1 });
    expect(codes(spent.findings)).toEqual(["runs-over-budget"]);
  });

  test("reads never pass either budget, and an honest archive read within them gives its whole sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 4_000 }),
        fc.array(fc.nat(3), { maxLength: 6 }),
        async (sizes, maxReads, maxBytes, junk) => {
          const runs: Stored[] = [];
          let first = 0n;
          for (const [i, size] of sizes.entries()) {
            runs.push(stored(first, size, i + 1));
            first += BigInt(size);
          }
          // Some transactions answer junk first.
          const before = new Map(
            junk.map((j, i) => [bytesToHex(tx(i + 1)), [new Uint8Array(j * 50 + 1)]]),
          );
          const { source, asked } = arweave(runs, before);
          const got = await readRuns(
            runs.map((s) => listing(s)),
            BOARD,
            L2,
            first,
            source,
            maxBytes,
            maxReads,
          );
          expect(got.reads).toBe(asked.length);
          expect(got.reads).toBeLessThanOrEqual(maxReads);
          expect(got.spent).toBeLessThanOrEqual(maxBytes);
          if (got.complete) expect(got.records).toEqual(sequence(Number(first)));
          else expect(codes(got.findings)).toEqual(["runs-over-budget"]);
          // With room for everything, everything is read.
          const roomy = await readRuns(
            runs.map((s) => listing(s)),
            BOARD,
            L2,
            first,
            source,
          );
          expect(roomy.complete).toBe(true);
          expect(roomy.records).toEqual(sequence(Number(first)));
        },
      ),
      { numRuns },
    );
  });

  test("archive-v3.json's election-registry run reads back as contract-event-v9.json's records", async () => {
    const file = JSON.parse(
      readFileSync(new URL("../../../docs/spec/vectors/archive-v3.json", import.meta.url), "utf8"),
    ) as {
      runs: { id: string; cid: string; encoding: string; records: string[] }[];
    };
    const v = file.runs.find((r) => r.id === "election-registry-sequence");
    if (v === undefined) throw new Error("no election-registry run");
    const bytes = hexToBytes(v.encoding);
    const run = decodeContractEventRun(bytes, 1);
    const s: Stored = { run, bytes, cid: hexToBytes(v.cid), transaction: tx(1) };
    const got = await readRuns(
      [listing(s)],
      run.contract,
      run.l2_chain_id,
      BigInt(run.events.length),
      arweave([s]).source,
    );
    expect(got.complete).toBe(true);
    expect(got.records.map((r) => bytesToHex(encodeContractEvent(r, 9)))).toEqual(v.records);
  });

  test("needs a 20-byte contract, a u64 count and positive budgets", async () => {
    const { source } = arweave([]);
    await expect(readRuns([], BOARD.subarray(1), L2, 1n, source)).rejects.toThrow(RangeError);
    await expect(readRuns([], BOARD, L2, -1n, source)).rejects.toThrow(RangeError);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(readRuns([], BOARD, L2, 1n, source, bad)).rejects.toThrow(RangeError);
      await expect(readRuns([], BOARD, L2, 1n, source, 1, bad)).rejects.toThrow(RangeError);
    }
    expect(() => runBound(0)).toThrow(RangeError);
    expect(runBound(65_536)).toBe(MAX_CONTRACT_EVENT_RUN);
  });
});
