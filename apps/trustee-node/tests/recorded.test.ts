import { readFile } from "node:fs/promises";
import {
  AVAILABILITY_POINTS,
  batchShareReceipts,
  encodeAvailabilityAttestation,
  encodeAvailabilityComplaint,
  encodeShareReceiptBatch,
  SEAT_PANELS,
  signAvailabilityAttestation,
  signAvailabilityComplaint,
} from "@abolishus/crypto";
import { L2Error, type Rpc, RpcError } from "@abolishus/node";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { hex, padded, word } from "../../node/tests/anvil.ts";
import type { AvailabilityKind } from "../src/availability.ts";
import {
  l2RecordedAvailability,
  l2RecordedReceiptBatches,
  RecordedError,
} from "../src/recorded.ts";

// The availability duty's recorded-event read (P4-3 part 2c-4b-2a): the one
// record the board emitted for a seat's slot, in the seat's own L2 node's
// finalized history, whatever else the node answers (T-24, T-53, T-71).
// The board's topics and one real log come from contract-event-v8.json, the
// records' signing secret and a CID from availability.json, rather than the
// node's constants.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const vector = async (file: string) =>
  JSON.parse(
    await readFile(new URL(`../../../docs/spec/vectors/${file}`, import.meta.url), "utf8"),
  );
const v8 = (await vector("contract-event-v8.json")) as {
  events: { signature: string; topic0: string }[];
  records: {
    id: string;
    fields: { contract: string; l2Block: string; topics: string[]; data: string };
    event?: { record: string };
  }[];
};
const topic0 = (signature: string) => {
  const t = v8.events.find((e) => e.signature.startsWith(`${signature}(`))?.topic0;
  if (t === undefined) throw new Error(`no ${signature} in the vectors`);
  return `0x${t}`;
};
const TOPICS: Record<AvailabilityKind, string> = {
  attestation: topic0("AvailabilityAttestationSubmitted"),
  complaint: topic0("AvailabilityComplaintSubmitted"),
};
const records = (await vector("availability.json")) as {
  records: { id: string; signingSecret: string; fields: { cid?: string } }[];
};
const complaintRaw = records.records.find((r) => r.id === "complaint-raw");
if (complaintRaw?.fields.cid === undefined) throw new Error("no complaint-raw in the vectors");
const SECRET = hexToBytes(complaintRaw.signingSecret);
const CID = hexToBytes(complaintRaw.fields.cid);

const BOARD = new Uint8Array(20).fill(0xb0);
const L2_CHAIN_ID = 31338n;
const FINALIZED = 100n;
const D = new Uint8Array(32).fill(0xd1);
const CHECKPOINT = new Uint8Array(32).fill(0xc4);

interface Slot {
  readonly kind: AvailabilityKind;
  readonly definitionHash: Uint8Array;
  readonly panel: 1 | 2;
  readonly seat: number;
  readonly point: 1 | 2;
}

interface Log {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly removed?: boolean;
}

/** The record a seat signs for `slot`, its checkpoint varied by `salt`. */
function recordOf(slot: Slot, salt = 0): Uint8Array {
  const fields = {
    definition_hash: slot.definitionHash,
    panel: slot.panel,
    seat: slot.seat,
    point: slot.point,
    checkpoint_hash: CHECKPOINT.map((b) => b ^ salt),
  };
  return slot.kind === "attestation"
    ? encodeAvailabilityAttestation(signAvailabilityAttestation(SECRET, { ...fields, roots: [] }))
    : encodeAvailabilityComplaint(signAvailabilityComplaint(SECRET, { ...fields, cid: CID }));
}

/** The board's log of `record` for `slot`, ABI-encoded as docs/spec/contracts.md lists it. */
function logOf(slot: Slot, record: Uint8Array, block = FINALIZED, address = BOARD): Log {
  return {
    address: hex(address),
    topics: [TOPICS[slot.kind], hex(slot.definitionHash), hex(word(BigInt(slot.seat)))],
    data: hex(concatBytes(word(32n), word(BigInt(record.length)), padded(record))),
    blockNumber: `0x${block.toString(16)}`,
  };
}

/**
 * An L2 node answering from `logs`: filtering by topics and range as a real
 * one does, or, with `honest` false, returning every log it holds.
 */
function l2Node(
  logs: readonly Log[],
  options: { honest?: boolean; chain?: bigint; finalized?: bigint } = {},
) {
  const asked: unknown[] = [];
  const rpc: Rpc = {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${(options.chain ?? L2_CHAIN_ID).toString(16)}`;
      if (method === "eth_getBlockByNumber")
        return { number: `0x${(options.finalized ?? FINALIZED).toString(16)}` };
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const [filter] = params as [
        { address: string; fromBlock: string; toBlock: string; topics: (string | string[])[] },
      ];
      asked.push(filter);
      if (options.honest === false) return logs;
      return logs.filter(
        (l) =>
          l.address === filter.address &&
          BigInt(l.blockNumber) >= BigInt(filter.fromBlock) &&
          BigInt(l.blockNumber) <= BigInt(filter.toBlock) &&
          filter.topics.every((t, i) =>
            Array.isArray(t) ? t.includes(l.topics[i] as string) : t === l.topics[i],
          ),
      );
    },
  };
  return { rpc, asked };
}

const reader = (rpc: Rpc) =>
  l2RecordedAvailability({ l2: rpc, l2ChainId: L2_CHAIN_ID, board: BOARD, l2FromBlock: 7n });

const read = (r: Awaited<ReturnType<typeof reader>>, s: Slot) =>
  r(s.kind, s.definitionHash, s.panel, s.seat, s.point);

const ballot: Slot = {
  kind: "attestation",
  definitionHash: D,
  panel: SEAT_PANELS.default,
  seat: 2,
  point: AVAILABILITY_POINTS.ballotExtent,
};

describe("l2RecordedAvailability", () => {
  test("reads the record in the board's own encoding (contract-event-v8.json)", async () => {
    const v = v8.records.find((x) => x.id === "availability-attestation-ballot-extent");
    if (v?.event === undefined) throw new Error("no availability-attestation-ballot-extent");
    const board = hexToBytes(v.fields.contract);
    const log: Log = {
      address: `0x${v.fields.contract}`,
      topics: v.fields.topics.map((t) => `0x${t}`),
      data: `0x${v.fields.data}`,
      blockNumber: `0x${BigInt(v.fields.l2Block).toString(16)}`,
    };
    const { rpc } = l2Node([log], { honest: false, finalized: BigInt(v.fields.l2Block) });
    const recorded = await l2RecordedAvailability({
      l2: rpc,
      l2ChainId: L2_CHAIN_ID,
      board,
      l2FromBlock: 0n,
    });
    const definitionHash = hexToBytes(v.fields.topics[1] as string);
    // The vector's record: default seat 1 attesting the ballot extent.
    const got = await recorded("attestation", definitionHash, 1, 1, 1);
    expect(got && bytesToHex(got)).toBe(v.event.record);
    expect(await recorded("attestation", definitionHash, 1, 1, 2)).toBeUndefined();
    expect(await recorded("complaint", definitionHash, 1, 1, 1)).toBeUndefined();
  });

  test("asks for the slot's logs from the board's deployment block to the finalized block", async () => {
    const record = recordOf(ballot);
    const { rpc, asked } = l2Node([logOf(ballot, record)]);
    const got = await read(await reader(rpc), ballot);
    expect(got).toEqual(record);
    expect(asked).toEqual([
      {
        address: hex(BOARD),
        fromBlock: "0x7",
        toBlock: `0x${FINALIZED.toString(16)}`,
        topics: [TOPICS.attestation, hex(D), hex(word(2n))],
      },
    ]);
  });

  test("nothing recorded yet is undefined", async () => {
    const { rpc } = l2Node([]);
    expect(await read(await reader(rpc), ballot)).toBeUndefined();
  });

  test("a log past the finalized block, reorganised away or of another address isn't recorded", async () => {
    const record = recordOf(ballot);
    for (const log of [
      logOf(ballot, record, FINALIZED + 1n),
      logOf(ballot, record, 6n),
      { ...logOf(ballot, record), removed: true },
      logOf(ballot, record, FINALIZED, new Uint8Array(20).fill(0xb1)),
    ]) {
      const { rpc } = l2Node([log], { honest: false });
      expect(await read(await reader(rpc), ballot)).toBeUndefined();
    }
  });

  test("a log failing the event check is passed over", async () => {
    const record = recordOf(ballot);
    const good = logOf(ballot, record);
    const other = recordOf({ ...ballot, seat: 3 });
    for (const log of [
      // The record's seat isn't the topic's.
      { ...good, data: logOf(ballot, other).data },
      // A complaint's record under the attestation's event.
      { ...good, data: logOf(ballot, recordOf({ ...ballot, kind: "complaint" })).data },
      // Cut short.
      { ...good, data: good.data.slice(0, -64) },
      // A fourth topic.
      { ...good, topics: [...good.topics, hex(word(1n))] },
    ]) {
      const { rpc } = l2Node([log], { honest: false });
      expect(await read(await reader(rpc), ballot)).toBeUndefined();
    }
  });

  test("an author seat's record of the same seat number and point isn't the default seat's", async () => {
    const author: Slot = { ...ballot, panel: SEAT_PANELS.author };
    const { rpc } = l2Node([logOf(author, recordOf(author))]);
    const r = await reader(rpc);
    expect(await read(r, ballot)).toBeUndefined();
    expect(await read(r, author)).toEqual(recordOf(author));
  });

  test("a node finalized below the board's deployment block has nothing recorded, unasked", async () => {
    const { rpc, asked } = l2Node([logOf(ballot, recordOf(ballot), 3n)], { finalized: 6n });
    expect(await read(await reader(rpc), ballot)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test("two records filling one slot, which the board never emits, are refused", async () => {
    const { rpc } = l2Node([logOf(ballot, recordOf(ballot)), logOf(ballot, recordOf(ballot, 1))]);
    const r = await reader(rpc);
    await expect(read(r, ballot)).rejects.toEqual(new L2Error("l2-repeated"));
  });

  test("a node on another chain is refused once, at setup", async () => {
    const { rpc } = l2Node([], { chain: L2_CHAIN_ID + 1n });
    await expect(reader(rpc)).rejects.toEqual(new RecordedError("chain"));
  });

  test("a node's unreadable answer is an RpcError", async () => {
    const rpc: Rpc = {
      call: async (method) => {
        if (method === "eth_chainId") return `0x${L2_CHAIN_ID.toString(16)}`;
        if (method === "eth_getBlockByNumber") return { number: `0x${FINALIZED.toString(16)}` };
        return { not: "a list" };
      },
    };
    await expect(read(await reader(rpc), ballot)).rejects.toBeInstanceOf(RpcError);
  });

  test("a seat outside a u8 is refused before anything is asked", async () => {
    const { rpc, asked } = l2Node([]);
    const r = await reader(rpc);
    for (const seat of [256, -1, 1.5])
      await expect(read(r, { ...ballot, seat })).rejects.toBeInstanceOf(RangeError);
    expect(asked).toEqual([]);
  });

  test("over any logs, honest filter or not, gives exactly the slot's one finalized record", async () => {
    const slot = fc.record({
      kind: fc.constantFrom<AvailabilityKind>("attestation", "complaint"),
      definitionHash: fc.constantFrom(D, new Uint8Array(32).fill(0xd2)),
      panel: fc.constantFrom<1 | 2>(1, 2),
      seat: fc.integer({ min: 1, max: 3 }),
      point: fc.constantFrom<1 | 2>(1, 2),
    });
    const entry = fc.record({
      slot,
      salt: fc.integer({ min: 0, max: 1 }),
      block: fc.constantFrom(5n, 7n, FINALIZED, FINALIZED + 1n),
      removed: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(entry, { maxLength: 8 }),
        slot,
        fc.boolean(),
        async (es, s, honest) => {
          const logs = es.map((e) => ({
            ...logOf(e.slot, recordOf(e.slot, e.salt), e.block),
            ...(e.removed && { removed: true }),
          }));
          const same = (a: Slot) =>
            a.kind === s.kind &&
            bytesToHex(a.definitionHash) === bytesToHex(s.definitionHash) &&
            a.panel === s.panel &&
            a.seat === s.seat &&
            a.point === s.point;
          const counted = es.filter(
            (e) => same(e.slot) && !e.removed && e.block >= 7n && e.block <= FINALIZED,
          );
          const r = await reader(l2Node(logs, { honest }).rpc);
          if (counted.length > 1) {
            await expect(read(r, s)).rejects.toEqual(new L2Error("l2-repeated"));
            return;
          }
          const got = await read(r, s);
          const want = counted[0];
          expect(got).toEqual(want && recordOf(want.slot, want.salt));
        },
      ),
      { numRuns },
    );
  });
});

describe("l2RecordedReceiptBatches", () => {
  // The receipt duty's read (P2-13 part 4b-2b-1): every share-receipt batch
  // the board emitted for the definition and seat in finalized history, the
  // event's topic from contract-event-v8.json.
  const TOPIC = topic0("ShareReceiptBatchSubmitted");

  /** One batch of `seat`'s receipts for `definitionHash`, its pairs varied by `salt`. */
  const batchOf = (definitionHash: Uint8Array, seat: number, salt = 0) => {
    const [batch] = batchShareReceipts(SECRET, definitionHash, seat, [
      { ballot_hash: new Uint8Array(32).fill(0x10 + salt), share_hash: new Uint8Array(32).fill(1) },
    ]);
    if (batch === undefined) throw new Error("one pair makes one batch");
    return encodeShareReceiptBatch(batch);
  };
  const batchLog = (
    definitionHash: Uint8Array,
    seat: number,
    record: Uint8Array,
    block = FINALIZED,
  ): Log => ({
    address: hex(BOARD),
    topics: [TOPIC, hex(definitionHash), hex(word(BigInt(seat)))],
    data: hex(concatBytes(word(32n), word(BigInt(record.length)), padded(record))),
    blockNumber: `0x${block.toString(16)}`,
  });
  const batches = (rpc: Rpc) =>
    l2RecordedReceiptBatches({ l2: rpc, l2ChainId: L2_CHAIN_ID, board: BOARD, l2FromBlock: 7n });

  test("gives every batch of the seat's, asked from the deployment block to the finalized block", async () => {
    const [a, b] = [batchOf(D, 2), batchOf(D, 2, 1)];
    const { rpc, asked } = l2Node([batchLog(D, 2, a), batchLog(D, 2, b)]);
    expect(await (await batches(rpc))(D, 2)).toEqual([a, b]);
    expect(asked).toEqual([
      {
        address: hex(BOARD),
        fromBlock: "0x7",
        toBlock: `0x${FINALIZED.toString(16)}`,
        topics: [TOPIC, hex(D), hex(word(2n))],
      },
    ]);
  });

  test("passes over another seat's or definition's batch, a log failing the event check, and one not final", async () => {
    const own = batchOf(D, 2);
    const good = batchLog(D, 2, own);
    const other = new Uint8Array(32).fill(0xd2);
    const logs = [
      batchLog(D, 3, batchOf(D, 3)),
      batchLog(other, 2, batchOf(other, 2)),
      // The batch's seat isn't the topic's.
      { ...good, data: batchLog(D, 3, batchOf(D, 3)).data },
      // Cut short.
      { ...good, data: good.data.slice(0, -64) },
      { ...good, removed: true },
      batchLog(D, 2, own, FINALIZED + 1n),
      batchLog(D, 2, own, 6n),
    ];
    const { rpc } = l2Node(logs, { honest: false });
    expect(await (await batches(rpc))(D, 2)).toEqual([]);
  });

  test("a node finalized below the deployment block has nothing recorded, unasked", async () => {
    const { rpc, asked } = l2Node([batchLog(D, 2, batchOf(D, 2), 3n)], { finalized: 6n });
    expect(await (await batches(rpc))(D, 2)).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a node on another chain is refused at setup, and a seat outside a u8 before asking", async () => {
    await expect(batches(l2Node([], { chain: L2_CHAIN_ID + 1n }).rpc)).rejects.toEqual(
      new RecordedError("chain"),
    );
    const { rpc, asked } = l2Node([]);
    const read = await batches(rpc);
    for (const seat of [256, -1, 1.5])
      await expect(read(D, seat)).rejects.toBeInstanceOf(RangeError);
    expect(asked).toEqual([]);
  });
});
