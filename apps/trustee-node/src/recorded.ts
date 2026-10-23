// The contract path's recorded-event reads: for the availability duty
// (docs/spec/availability.md, Contract path), the record the board contract
// recorded for a seat's slot; for the receipt and complaint duties
// (docs/spec/delivery.md, What a node owes), the batches it recorded for a
// seat and the postings naming it. Each is read as the seat's own L2 node
// shows it in finalized history, which the node derives from finalized L1,
// never a sequencer's soft confirmation, so a record the sequencer later
// drops is never taken as recorded (T-71).
//
// The L2 node is trusted for which logs exist, as for the registration
// `l1BoardAnchors` reads: no reader proves the board's logs yet (P1-19's L2
// reads). A node that hides the seat's record makes the seat resend its
// stored bytes, which the contract takes as a no-op; one that shows a record
// the contract never recorded either matches the stored bytes, so the seat
// stops sending a record that may not be on L2 (an `unrecorded` the seat
// can't see, T-53), or doesn't, and the seat raises `foreign-record` and
// stops. Either way it never signs a second record of the slot: what it
// signs is decided by its store, never by this read (T-24).
import {
  type AvailabilityEvent,
  checkContractEvent,
  decodeAvailabilityAttestation,
  decodeAvailabilityComplaint,
  DecodeError,
  decodeSharePosting,
  type EventContracts,
} from "@abolishus/crypto";
import {
  AVAILABILITY_ATTESTATION_SUBMITTED,
  AVAILABILITY_COMPLAINT_SUBMITTED,
  chainId,
  contractLogs,
  L2Error,
  l2Finalized,
  READ_VERSION,
  type Rpc,
  RpcError,
} from "@abolishus/node";
import { keccak256, toBytes } from "viem";
import type { AvailabilityKind, ContractPath } from "./availability.ts";
import type { ComplaintPath, RecordedPosting } from "./complaint.ts";
import type { ReceiptPath } from "./delivery.ts";
import type { AvailabilityRecords } from "./summing.ts";

export interface RecordedOptions {
  /** The seat's own L2 node. */
  readonly l2: Rpc;
  readonly l2ChainId: bigint;
  /** The deployment's board contract, 20 bytes. */
  readonly board: Uint8Array;
  /** The board's deployment block: its logs are read from here. */
  readonly l2FromBlock: bigint;
}

/** Why the read can't be set up; a retry doesn't change it. */
export class RecordedError extends Error {
  override readonly name = "RecordedError";
  readonly code: "chain";
  constructor(code: "chain") {
    super(code);
    this.code = code;
  }
}

// The board's role only: no other contract's log is asked for, and a zero
// address is no contract's.
const boardOnly = (board: Uint8Array): EventContracts => ({
  electionRegistry: new Uint8Array(20),
  trusteeRegistry: new Uint8Array(20),
  groupRegistry: new Uint8Array(20),
  board,
});

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const EVENTS = {
  attestation: {
    topic: AVAILABILITY_ATTESTATION_SUBMITTED,
    event: "AvailabilityAttestationSubmitted",
    decode: (r: Uint8Array) => decodeAvailabilityAttestation(r, 1),
  },
  complaint: {
    topic: AVAILABILITY_COMPLAINT_SUBMITTED,
    event: "AvailabilityComplaintSubmitted",
    decode: (r: Uint8Array) => decodeAvailabilityComplaint(r, 1),
  },
} as const;

/**
 * `ContractPath.recorded` over the seat's own L2 node: the one record of the
 * kind the board emitted for the definition, panel, seat and point, from the
 * board's deployment block to the node's finalized block. Checks the node's
 * chain once, here (`RecordedError`). Each read throws the node package's
 * `L2Error` (`l2-repeated`) when two records fill one slot, which the board
 * never emits, and `RpcError` when the node's answer can't be read.
 */
export async function l2RecordedAvailability(
  options: RecordedOptions,
): Promise<ContractPath["recorded"]> {
  const { l2, board } = options;
  if ((await chainId(l2)) !== options.l2ChainId) throw new RecordedError("chain");
  const contracts = boardOnly(board);
  return async (
    kind: AvailabilityKind,
    definitionHash: Uint8Array,
    panel: number,
    seat: number,
    point: number,
  ) => {
    // The board's `seat` topic is a `uint8`.
    if (!Number.isInteger(seat) || seat < 0 || seat > 0xff)
      throw new RangeError("recorded: seat must be a u8");
    const spec = EVENTS[kind];
    const seatWord = new Uint8Array(32);
    seatWord[31] = seat;
    // A node still syncing to the board's deployment has nothing recorded.
    const finalized = await l2Finalized(l2);
    if (finalized < options.l2FromBlock) return undefined;
    const logs = await contractLogs(
      l2,
      board,
      [spec.topic, definitionHash, seatWord],
      options.l2FromBlock,
      finalized,
    );
    const found: Uint8Array[] = [];
    // A log failing the event check, or naming another slot, is no evidence
    // of this one's: it is passed over, as a withheld log would be.
    for (const log of logs) {
      const checked = checkContractEvent(log, contracts, READ_VERSION);
      if (!checked.ok || checked.event.event !== spec.event) continue;
      const e = checked.event;
      if (!equal(e.definitionHash, definitionHash) || e.seat !== seat) continue;
      // The event check decoded the record strictly as version 1.
      const r = spec.decode(e.record);
      if (r.panel === panel && r.point === point) found.push(e.record);
    }
    if (found.length > 1) throw new L2Error("l2-repeated");
    return found[0];
  };
}

/**
 * The summed-share rule's read (`AvailabilityRecords`) over the seat's own
 * L2 node: every availability attestation and complaint the board emitted
 * for the definition, whatever its seat, panel or point, from the board's
 * deployment block to the node's finalized block, in event order with each
 * one's L2 block timestamp, by which the availability check judges it in
 * time, and the finalized block's timestamp. A log failing the event check
 * is passed over, as a withheld one would be; the check judges the rest.
 * The node is trusted for which logs exist, as for the seat's own slot: one
 * that hides attestations makes the seat find the election unavailable and
 * never sum (liveness), and one that shows attestations the board never
 * recorded, or recorded after `t_A'` under an earlier block's time, can
 * make it sum over an election that failed, given `k` seats' signed
 * attestations (T-53). Checks the node's chain once, here
 * (`RecordedError`); each read throws `RpcError` when the node's answer
 * can't be read or isn't in block order.
 */
export async function l2AvailabilityRecords(
  options: RecordedOptions,
): Promise<AvailabilityRecords> {
  const { l2, board } = options;
  if ((await chainId(l2)) !== options.l2ChainId) throw new RecordedError("chain");
  const contracts = boardOnly(board);
  return async (definitionHash: Uint8Array) => {
    const finalized = await l2Finalized(l2);
    const finalizedAt = await l2BlockTime(l2, finalized);
    if (finalized < options.l2FromBlock) return { finalizedAt, events: [] };
    const logs = await contractLogs(
      l2,
      board,
      [[EVENTS.attestation.topic, EVENTS.complaint.topic], definitionHash],
      options.l2FromBlock,
      finalized,
    );
    const events: AvailabilityEvent[] = [];
    const times = new Map<bigint, bigint>();
    let previous = options.l2FromBlock;
    for (const log of logs) {
      // `eth_getLogs` answers in block order, which the board's event order
      // follows; a node that doesn't can't be read.
      if (log.l2_block < previous) throw new RpcError("eth_getLogs: not in block order");
      previous = log.l2_block;
      const checked = checkContractEvent(log, contracts, READ_VERSION);
      if (
        !checked.ok ||
        (checked.event.event !== EVENTS.attestation.event &&
          checked.event.event !== EVENTS.complaint.event) ||
        !equal(checked.event.definitionHash, definitionHash)
      )
        continue;
      let submittedAt = times.get(log.l2_block);
      if (submittedAt === undefined) {
        submittedAt = await l2BlockTime(l2, log.l2_block);
        times.set(log.l2_block, submittedAt);
      }
      // L2 timestamps never decrease along its blocks.
      const last = events.at(-1)?.submittedAt;
      if (last !== undefined && submittedAt < last)
        throw new RpcError("eth_getBlockByNumber: timestamps out of order");
      events.push({ payload: checked.event.record, submittedAt });
    }
    return { finalizedAt, events };
  };
}

const SHARE_RECEIPT_BATCH_SUBMITTED = keccak256(
  toBytes("ShareReceiptBatchSubmitted(bytes32,uint8,bytes)"),
  "bytes",
);
const SHARE_COMPLAINT_BATCH_SUBMITTED = keccak256(
  toBytes("ShareComplaintBatchSubmitted(bytes32,uint8,bytes)"),
  "bytes",
);
const SHARE_POSTED = keccak256(toBytes("SharePosted(bytes32,bytes32,bytes)"), "bytes");

/**
 * `ReceiptPath.recorded` over the seat's own L2 node: every share-receipt
 * batch the board emitted for the definition and seat, from the board's
 * deployment block to the node's finalized block. The board takes any number
 * of batches per seat, so any number may be returned; the seat looks only
 * for its stored ones among them. A node that hides a batch makes the seat
 * resend it, which the board takes as a no-op, and one that shows a batch
 * the board never recorded stops the seat sending it, which only a node the
 * seat trusts for its own L2 can do (T-53, T-71). Checks the node's chain
 * once, here (`RecordedError`); each read throws `RpcError` when the node's
 * answer can't be read.
 */
export async function l2RecordedReceiptBatches(
  options: RecordedOptions,
): Promise<ReceiptPath["recorded"]> {
  return seatBatches(options, SHARE_RECEIPT_BATCH_SUBMITTED, "ShareReceiptBatchSubmitted");
}

/**
 * `ComplaintPath.recorded` over the seat's own L2 node: every
 * share-complaint batch the board emitted for the definition and seat, read
 * and trusted as `l2RecordedReceiptBatches` reads receipt batches.
 */
export async function l2RecordedComplaintBatches(
  options: RecordedOptions,
): Promise<ComplaintPath["recorded"]> {
  return seatBatches(options, SHARE_COMPLAINT_BATCH_SUBMITTED, "ShareComplaintBatchSubmitted");
}

async function seatBatches(
  options: RecordedOptions,
  topic: Uint8Array,
  name: "ShareReceiptBatchSubmitted" | "ShareComplaintBatchSubmitted",
): Promise<(definitionHash: Uint8Array, seat: number) => Promise<readonly Uint8Array[]>> {
  const { l2, board } = options;
  if ((await chainId(l2)) !== options.l2ChainId) throw new RecordedError("chain");
  const contracts = boardOnly(board);
  return async (definitionHash: Uint8Array, seat: number) => {
    // The board's `seat` topic is a `uint8`.
    if (!Number.isInteger(seat) || seat < 0 || seat > 0xff)
      throw new RangeError("recorded: seat must be a u8");
    const seatWord = new Uint8Array(32);
    seatWord[31] = seat;
    const finalized = await l2Finalized(l2);
    if (finalized < options.l2FromBlock) return [];
    const logs = await contractLogs(
      l2,
      board,
      [topic, definitionHash, seatWord],
      options.l2FromBlock,
      finalized,
    );
    const found: Uint8Array[] = [];
    for (const log of logs) {
      const checked = checkContractEvent(log, contracts, READ_VERSION);
      if (!checked.ok || checked.event.event !== name) continue;
      const e = checked.event;
      if (equal(e.definitionHash, definitionHash) && e.seat === seat) found.push(e.record);
    }
    return found;
  };
}

/**
 * `ComplaintPath.postings` over the seat's own L2 node: every share posting
 * the board emitted for the definition that names the seat, from the board's
 * deployment block to the node's finalized block, each with its L2 block's
 * timestamp, by which the delivery deadline judges it, and that block's
 * timestamp. The node is trusted for which logs exist, as for the recorded
 * batches: one that hides a posting in time keeps the seat from complaining
 * about it, which only the seat's own L2 node can do (T-53). Checks the
 * node's chain once, here (`RecordedError`); each read throws `RpcError`
 * when the node's answer can't be read.
 */
export async function l2Postings(options: RecordedOptions): Promise<ComplaintPath["postings"]> {
  const { l2, board } = options;
  if ((await chainId(l2)) !== options.l2ChainId) throw new RecordedError("chain");
  const contracts = boardOnly(board);
  return async (definitionHash: Uint8Array, seat: number) => {
    const finalized = await l2Finalized(l2);
    const finalizedAt = await l2BlockTime(l2, finalized);
    if (finalized < options.l2FromBlock) return { finalizedAt, postings: [] };
    // The board's posting event has no seat topic: the seat is the record's.
    const logs = await contractLogs(
      l2,
      board,
      [SHARE_POSTED, definitionHash],
      options.l2FromBlock,
      finalized,
    );
    const postings: RecordedPosting[] = [];
    const times = new Map<bigint, bigint>();
    for (const log of logs) {
      const checked = checkContractEvent(log, contracts, READ_VERSION);
      if (!checked.ok || checked.event.event !== "SharePosted") continue;
      const e = checked.event;
      if (!equal(e.definitionHash, definitionHash)) continue;
      // A posting of a version this node doesn't read names no seat it can
      // complain for; the duty decodes it again as the definition reads it.
      let named;
      try {
        named = decodeSharePosting(e.record, 1).seat;
      } catch (err) {
        if (err instanceof DecodeError) continue;
        throw err;
      }
      if (named !== seat) continue;
      let submittedAt = times.get(log.l2_block);
      if (submittedAt === undefined) {
        submittedAt = await l2BlockTime(l2, log.l2_block);
        times.set(log.l2_block, submittedAt);
      }
      postings.push({ record: e.record, submittedAt });
    }
    return { finalizedAt, postings };
  };
}

/** The timestamp of L2 block `n`, as the seat's own L2 node gives it. */
export async function l2BlockTime(l2: Rpc, n: bigint): Promise<bigint> {
  const block = (await l2.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])) as {
    number?: unknown;
    timestamp?: unknown;
  } | null;
  const quantity = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/u;
  if (
    typeof block?.number !== "string" ||
    typeof block.timestamp !== "string" ||
    !quantity.test(block.number) ||
    !quantity.test(block.timestamp) ||
    BigInt(block.number) !== n
  )
    throw new RpcError("eth_getBlockByNumber: not a block");
  return BigInt(block.timestamp);
}
