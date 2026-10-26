import {
  contractEventLog,
  contractEventRunRecords,
  type ContractEventRun,
  encodeContractEventEvidence,
  encodeContractEventRun,
  objectCar,
  objectCid,
  replayEventAccumulator,
  type RunEvent,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  ACCUMULATOR_SLOT,
  type ContractSequence,
  DEFAULT_REPLAY_EVIDENCE_READS,
  type EvidenceListing,
  replayArchive,
  type RunListing,
} from "../src/index.ts";
import { l2State, word } from "./state.ts";

// 4.4's replay of the archive (docs/spec/verifier.md 4.4; docs/spec/archive.md,
// The event replay; src/replay.ts): each contract's runs replayed against
// every one of its evidence records. Runs and records are written through
// packages/crypto's encoders (vectored by archive-v2.json and
// archive-v3.json), the records over states the tests' own trie writer
// builds (tests/state.ts), and the expected accumulators come from
// packages/crypto's replay over the events as written here, never from the
// reader under test (T-71, T-53).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const L2 = 84_532n;
const CONTRACTS = {
  "election-registry": new Uint8Array(20).fill(0xc0),
  "trustee-registry": new Uint8Array(20).fill(0xc1),
  "group-registry": new Uint8Array(20).fill(0xc2),
  board: new Uint8Array(20).fill(0xb0),
};
const { board: BOARD, "election-registry": REGISTRY } = CONTRACTS;

let nextTx = 0;
const tx = () => {
  const t = new Uint8Array(32);
  t[0] = 0x7c;
  t[31] = ++nextTx;
  return t;
};

// Event `n` of a made-up sequence: block 100 + n, so a record at block
// 100 + k counts the first k + 1 events.
const event = (n: bigint, topics = 1): RunEvent => ({
  l2_block: 100n + n,
  l2_timestamp: 1_000n + 2n * n,
  topics: Array.from({ length: topics }, () => new Uint8Array(32).fill(Number(n & 0xffn))),
  data: Uint8Array.of(Number(n & 0xffn)),
});
const events = (first: bigint, count: number) =>
  Array.from({ length: count }, (_, i) => event(first + BigInt(i)));

/** An archive's objects, served by transaction, with every ask recorded. */
class Archive {
  readonly held = new Map<string, Uint8Array>();
  readonly evidence: EvidenceListing[] = [];
  readonly runs: RunListing[] = [];
  readonly asked: string[] = [];

  run(contract: Uint8Array, first: bigint, list: readonly RunEvent[]) {
    const run: ContractEventRun = { l2_chain_id: L2, contract, first, events: [...list] };
    const bytes = encodeContractEventRun(run);
    const t = tx();
    this.held.set(bytesToHex(t), objectCar(bytes));
    this.runs.push({
      contract,
      first,
      count: list.length,
      cid: objectCid(bytes),
      transactions: [t],
    });
    return this;
  }

  // The contract's accumulator after `logs`, proven at `block`, or the
  // `accumulator` and `count` given instead.
  record(
    contract: Uint8Array,
    block: bigint,
    logs: readonly RunEvent[],
    accumulator?: Uint8Array,
    count = BigInt(logs.length),
  ) {
    const state = replayEventAccumulator(
      L2,
      contract,
      logs.map((e) => ({
        block: e.l2_block,
        timestamp: e.l2_timestamp,
        topics: e.topics,
        data: e.data,
      })),
    );
    const { evidence } = l2State(
      [
        {
          address: contract,
          storage: [
            [word(ACCUMULATOR_SLOT), accumulator ?? state.accumulator],
            [word(ACCUMULATOR_SLOT + 1n), word(count)],
          ],
        },
      ],
      block,
      1_800_000_000n + block,
    );
    const nodes = [...new Map(evidence.nodes.map((n) => [bytesToHex(n), n])).values()].sort(
      (a, b) => (bytesToHex(a) < bytesToHex(b) ? -1 : 1),
    );
    const bytes = encodeContractEventEvidence({
      l2_chain_id: L2,
      contract,
      game_index: 3n,
      game: new Uint8Array(20).fill(0x9a),
      output_root: evidence.outputRoot,
      message_passer_storage_root: evidence.messagePasserStorageRoot,
      header: evidence.header,
      nodes,
    });
    const t = tx();
    this.held.set(bytesToHex(t), objectCar(bytes));
    this.evidence.push({ contract, l2Block: block, cid: objectCid(bytes), transactions: [t] });
    return this;
  }

  source = async (t: Uint8Array): Promise<Uint8Array[]> => {
    this.asked.push(bytesToHex(t));
    const car = this.held.get(bytesToHex(t));
    return car === undefined ? [] : [car];
  };

  replay(budgets = {}) {
    return replayArchive(this, CONTRACTS, L2, this.source, budgets);
  }
}

const of = (replay: readonly ContractSequence[], contract: Uint8Array) => {
  const c = replay.find((r) => bytesToHex(r.contract) === bytesToHex(contract));
  if (c === undefined) throw new Error("no such contract");
  return c;
};
const replays = (c: ContractSequence) => c.evidence.records.map((r) => r.replay);

describe("replayArchive", () => {
  test("an honest archive holds every record of every contract, in role order", async () => {
    const all = events(0n, 6);
    const a = new Archive()
      .run(BOARD, 0n, all.slice(0, 3))
      .run(BOARD, 3n, all.slice(3))
      .record(BOARD, 105n, all)
      .record(BOARD, 102n, all.slice(0, 3))
      .run(REGISTRY, 0n, events(0n, 2))
      .record(REGISTRY, 101n, events(0n, 2));
    const replay = await a.replay();
    expect(replay.map((c) => c.role)).toEqual([
      "election-registry",
      "trustee-registry",
      "group-registry",
      "board",
    ]);
    const board = of(replay, BOARD);
    // Records in ascending order of block, both reproduced.
    expect(board.evidence.records.map((r) => r.accumulator.block)).toEqual([102n, 105n]);
    expect(replays(board)).toEqual([null, null]);
    expect(board.held).toBe(6n);
    expect(board.runs).toMatchObject({ complete: true, findings: [], reads: 2 });
    expect(board.records).toEqual(
      contractEventRunRecords({ l2_chain_id: L2, contract: BOARD, first: 0n, events: all }),
    );
    expect(of(replay, REGISTRY).held).toBe(2n);
    // A contract with nothing archived holds nothing and asks for nothing.
    for (const c of [CONTRACTS["trustee-registry"], CONTRACTS["group-registry"]])
      expect(of(replay, c)).toMatchObject({
        held: 0n,
        records: [],
        evidence: { records: [], reads: 0, findings: [] },
        runs: { taken: [], complete: true, reads: 0 },
      });
    // Each record and run once: 3 records and 3 runs.
    expect(a.asked).toHaveLength(6);
  });

  test("a record the events don't reproduce breaks `accumulator`, and holds nothing", async () => {
    const all = events(0n, 4);
    const a = new Archive()
      .run(BOARD, 0n, all)
      .record(BOARD, 101n, all.slice(0, 2))
      .record(BOARD, 103n, all, new Uint8Array(32).fill(7));
    const board = of(await a.replay(), BOARD);
    expect(replays(board)).toEqual([null, "accumulator"]);
    expect(board.held).toBe(2n);
  });

  test("a record dated before an event it counts breaks `block-range`", async () => {
    const all = events(0n, 3);
    // Three events, the last at block 102, proven at block 101.
    const a = new Archive().run(BOARD, 0n, all).record(BOARD, 101n, all);
    const board = of(await a.replay(), BOARD);
    expect(replays(board)).toEqual(["block-range"]);
    expect(board.held).toBe(0n);
  });

  test("runs that stop short leave the later records unreached, the earlier held", async () => {
    const all = events(0n, 6);
    const a = new Archive()
      .run(BOARD, 0n, all.slice(0, 3))
      .record(BOARD, 102n, all.slice(0, 3))
      .record(BOARD, 105n, all);
    const board = of(await a.replay(), BOARD);
    expect(board.runs).toMatchObject({ complete: false, findings: [{ code: "run-gap", n: 3n }] });
    expect(replays(board)).toEqual([null, "unreached"]);
    expect(board.held).toBe(3n);
  });

  test("an event with no topic is never replayed: the records counting it are unreached", async () => {
    const list = [event(0n), event(1n, 0), event(2n)];
    const a = new Archive()
      .run(BOARD, 0n, list)
      .record(BOARD, 100n, list.slice(0, 1))
      // Three events, which no replay reaches: never compared.
      .record(BOARD, 102n, [], new Uint8Array(32).fill(1), 3n);
    const board = of(await a.replay(), BOARD);
    expect(board.runs.complete).toBe(true);
    expect(board.records).toHaveLength(3);
    expect(replays(board)).toEqual([null, "unreached"]);
    expect(board.held).toBe(1n);
  });

  test("the budgets are shared by the contracts in role order", async () => {
    const a = new Archive()
      .run(REGISTRY, 0n, events(0n, 1))
      .record(REGISTRY, 100n, events(0n, 1))
      .run(BOARD, 0n, events(0n, 1))
      .record(BOARD, 100n, events(0n, 1));
    // The registry, first in role order, spends the one evidence read.
    const short = await a.replay({ maxEvidenceReads: 1 });
    expect(of(short, REGISTRY).held).toBe(1n);
    expect(of(short, BOARD).evidence.findings).toEqual([
      { code: "evidence-reads-over-budget", maxReads: 1 },
    ]);
    // And the one run read.
    const runs = await a.replay({ maxRunReads: 1 });
    expect(of(runs, REGISTRY).held).toBe(1n);
    expect(of(runs, BOARD).runs).toMatchObject({
      complete: false,
      findings: [{ code: "runs-over-budget", n: 0n }],
    });
    expect(replays(of(runs, BOARD))).toEqual(["unreached"]);
    for (const budget of ["maxEvidenceReads", "maxRunBytes", "maxRunReads"])
      for (const value of [0, 1.5, -1])
        await expect(a.replay({ [budget]: value })).rejects.toThrow(RangeError);
    expect(DEFAULT_REPLAY_EVIDENCE_READS).toBeGreaterThanOrEqual(4 * 24 * 42);
  });

  test("held is the largest count a proven record the events reproduce gives", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.uniqueArray(fc.nat({ max: 9 }), { maxLength: 4 }),
        fc.option(fc.nat({ max: 9 }), { nil: undefined }),
        async (count, at, forged) => {
          const all = events(0n, count);
          const a = new Archive().run(BOARD, 0n, all);
          // A record at block 100 + k counts the events at or before it.
          for (const k of at) {
            const logs = all.filter((e) => e.l2_block <= 100n + BigInt(k));
            a.record(
              BOARD,
              100n + BigInt(k),
              logs,
              k === forged ? new Uint8Array(32).fill(0xee) : undefined,
            );
          }
          const board = of(await a.replay(), BOARD);
          const honest = at.filter((k) => k !== forged);
          const expected = honest.reduce((c, k) => Math.max(c, Math.min(count, k + 1)), 0);
          expect(board.held).toBe(BigInt(expected));
          const records = board.records.slice(0, expected).map(contractEventLog);
          expect(records.map((r) => r.n)).toEqual(records.map((_, i) => BigInt(i)));
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});
