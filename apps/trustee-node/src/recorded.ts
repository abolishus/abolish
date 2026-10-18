// The availability duty's recorded-event read (docs/spec/availability.md,
// Contract path): the record the board contract recorded for a seat's slot,
// as the seat's own L2 node shows it in finalized history, which the node
// derives from finalized L1, never a sequencer's soft confirmation, so a
// record the sequencer later drops is never taken as recorded (T-71).
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
  checkContractEvent,
  decodeAvailabilityAttestation,
  decodeAvailabilityComplaint,
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
} from "@abolishus/node";
import type { AvailabilityKind, ContractPath } from "./availability.ts";

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
    const logs = await contractLogs(
      l2,
      board,
      [spec.topic, definitionHash, seatWord],
      options.l2FromBlock,
      await l2Finalized(l2) + 1n,
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
