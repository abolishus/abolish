// The simulated board contract (docs/spec/contracts.md, Board (direct
// submit)): the direct-submit path, where a ballot cast while our servers
// are down, a trustee node's share receipts and a voter's postings reach
// the board without the operator (T-25). It takes every election's
// parameters from the election registry and its key set from the trustee
// registry, never from a submitter (T-71), refuses what the contract
// refuses, in the contract's order, accepts a byte-identical repeat as a
// no-op, and emits each accepted record as its event through an event
// accumulator, crypto's, whose state a reader replays the board's
// contract-event records against (T-25, T-17). Framing, the shape check,
// the ballot hash, the receipt's signature and the share-ciphertext hash are
// @abolishus/crypto's; this file only orders them as the contract does.
//
// What the simulation leaves out (SIMULATION_STUBS): the membership proof
// (step 9), since a run without a prover gives ballots a placeholder, and
// one with a prover has the client check its proof before submitting;
// complaints, the relayed path
// and close statements, which nothing sends; calldata, gas and the
// contract's decode offsets. And where the contract only frames an element,
// this board decodes the record strictly to read its cell and shape, so it
// refuses a member's ballot or posting whose elements frame but aren't
// points, which the contract accepts and the verifier rejects later; no
// honest client makes one.

import {
  type ContractEventRecord,
  CONTRACT_EVENT_SIGNATURES,
  DecodeError,
  decodeBallot,
  decodeSharePosting,
  decodeShareReceipt,
  decodeShareReceiptBatch,
  eventAccumulatorGenesis,
  eventAccumulatorStep,
  type FramedRecord,
  frameBallot,
  frameDelivery,
  type ProvenEventAccumulator,
  RECORD_TYPES,
  shapeOk,
  shareCiphertextHash,
  shareReceiptBatchStatement,
  shareReceiptStatement,
  verifyStatement,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type {
  BoardParameters,
  L2Block,
  SimulatedElectionRegistry,
  SimulatedTrusteeRegistry,
} from "./l2.ts";

/** The board's refusals, by the contract's codes, in its checking order per call. */
export type BoardRefusal =
  // Any decode error: a record type, length or field the board's framing refuses.
  | "decode"
  | "ballot-stray"
  | "profile-mismatch"
  | "unknown-version"
  | "ballot-cell"
  | "validity-shape"
  | "share-hash-unqualified"
  | "ballot-window"
  | "ReceiptBatchLength"
  | "delivery-stray"
  | "delivery-seat"
  | "delivery-signature"
  | "posting-length"
  | "posting-ballot"
  | "posting-hash";

export type BoardResult =
  | {
      readonly ok: true;
      /** Events the call emitted: 0 for a repeat. */
      readonly emitted: number;
    }
  | {
      readonly ok: false;
      readonly refusal: BoardRefusal;
      /** The refused record's position in a receipt batch, from 0. */
      readonly at?: number;
    };

/** A share receipt's length; a batch is a whole number of them (Calls). */
export const SHARE_RECEIPT_LENGTH = 164;

// A posting's ciphertext follows its fixed fields: type and version (3),
// definition and ballot hashes (64), seat (1) and `m` (32).
const POSTING_CIPHERTEXT_AT = 100;

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const typeOf = (b: Uint8Array) => ((b[0] ?? 0) << 8) | (b[1] ?? 0);

// Topic 0 of each board event, from contract-event version 7's table, the
// version the profile pins (docs/spec/contracts.md, Event tables (version 7)).
const topic0 = (name: string): Uint8Array => {
  const signature = CONTRACT_EVENT_SIGNATURES[7].board.find((s) => s.startsWith(`${name}(`));
  if (signature === undefined) throw new Error(`simulation: the board has no event ${name}`);
  return keccak_256(utf8(signature));
};
const TOPIC0 = {
  ballot: topic0("BallotSubmitted"),
  receipt: topic0("ShareReceiptSubmitted"),
  posting: topic0("SharePosted"),
  batch: topic0("ShareReceiptBatchSubmitted"),
} as const;

// `abi.encode(bytes)`: the offset word, the length word, the bytes padded
// with zeros to a whole word, as every board event's data carries its record.
function abiBytes(record: Uint8Array): Uint8Array {
  const out = new Uint8Array(64 + Math.ceil(record.length / 32) * 32);
  out[31] = 0x20;
  let len = record.length;
  for (let i = 63; len > 0; i--, len = Math.floor(len / 256)) out[i] = len % 256;
  out.set(record, 64);
  return out;
}

/** A ballot the ballot check admitted: what its event and a posting's check read. */
interface Admitted extends FramedRecord {
  readonly params: BoardParameters;
  readonly shareHashes: readonly Uint8Array[];
}

export class SimulatedBoardContract {
  readonly #address: Uint8Array;
  readonly #registry: Pick<SimulatedElectionRegistry, "parametersOf">;
  readonly #trustees: Pick<SimulatedTrusteeRegistry, "keySetOf">;
  // Every accepted record, by the keccak-256 of its bytes: a storage key,
  // never a protocol hash (Calls, Repeats).
  readonly #accepted = new Set<string>();
  readonly #events: ContractEventRecord[] = [];
  // The accumulator after each event, with the event's block.
  readonly #history: { readonly block: bigint; readonly accumulator: Uint8Array }[] = [];
  readonly #genesis: Uint8Array;
  #accumulator: Uint8Array;

  readonly l2ChainId: bigint;

  /**
   * A board at `address` on chain `l2ChainId`, pinning the election
   * registry and trustee registry it reads (Deployment).
   */
  constructor(
    l2ChainId: bigint,
    address: Uint8Array,
    registry: Pick<SimulatedElectionRegistry, "parametersOf">,
    trustees: Pick<SimulatedTrusteeRegistry, "keySetOf">,
  ) {
    this.l2ChainId = l2ChainId;
    this.#address = Uint8Array.from(address);
    this.#registry = registry;
    this.#trustees = trustees;
    this.#genesis = eventAccumulatorGenesis(l2ChainId, this.#address);
    this.#accumulator = this.#genesis;
  }

  get address(): Uint8Array {
    return Uint8Array.from(this.#address);
  }

  /** Every log the board emitted, as contract-event records, in order of `n`. */
  get events(): readonly ContractEventRecord[] {
    return this.#events;
  }

  /**
   * The accumulator and count in the board's storage after L2 block
   * `block`: what a storage proof at that block shows (Event accumulator,
   * Verification). Read from memory (SIMULATION_STUBS).
   */
  accumulatorAt(block: bigint): ProvenEventAccumulator {
    let count = 0;
    while (count < this.#history.length && (this.#history[count]?.block ?? 0n) <= block) count++;
    const accumulator = count === 0 ? this.#genesis : this.#history[count - 1]?.accumulator;
    return {
      block,
      accumulator: Uint8Array.from(accumulator as Uint8Array),
      count: BigInt(count),
    };
  }

  #isRepeat(record: Uint8Array): boolean {
    return this.#accepted.has(hex(keccak_256(record)));
  }

  #emit(at: L2Block, topics: readonly Uint8Array[], record: Uint8Array): void {
    const last = this.#events.at(-1);
    // L2 time never runs backwards; a call out of order is a bug in the run.
    if (last !== undefined && (at.number < last.l2_block || at.timestamp < last.l2_timestamp))
      throw new Error("simulation: a board call before the board's last event");
    const n = BigInt(this.#events.length);
    const event: ContractEventRecord = {
      contract: Uint8Array.from(this.#address),
      n,
      l2_block: at.number,
      l2_timestamp: at.timestamp,
      topics: topics.map((t) => Uint8Array.from(t)),
      data: abiBytes(record),
    };
    this.#accumulator = eventAccumulatorStep(this.#accumulator, n, {
      block: event.l2_block,
      timestamp: event.l2_timestamp,
      topics: event.topics,
      data: event.data,
    });
    this.#events.push(event);
    this.#history.push({ block: at.number, accumulator: this.#accumulator });
    this.#accepted.add(hex(keccak_256(record)));
  }

  /** The key set's seats for the election, read before the check (Calls). */
  #qualified(params: BoardParameters) {
    const { stubHash, panelId } = params.ceremony;
    return this.#trustees.keySetOf(stubHash, panelId)?.seats ?? [];
  }

  // Ballots, steps 1 to 8 (docs/spec/contracts.md, Board, Ballots): the
  // header, the election, the version, the framing, the cell, the shape and
  // the qualified share hashes. Step 9, the membership proof, isn't checked
  // (SIMULATION_STUBS).
  #checkBallot(record: Uint8Array): Admitted | BoardRefusal {
    if (record.length < 3 || typeOf(record) !== RECORD_TYPES.ballot) return "decode";
    if (record.length < 35) return "decode";
    const params = this.#registry.parametersOf(record.subarray(3, 35));
    if (params === undefined || params.ballotVersion === 0) return "ballot-stray";
    if (record[2] !== params.ballotVersion) return "profile-mismatch";
    // The simulation pins ballot version 2 only, the one definition version
    // 4 allows; the contract also reads 1 and 3.
    if (params.ballotVersion !== 2) return "unknown-version";
    const framed = frameBallot(record);
    if (framed === undefined) return "decode";
    let ballot;
    try {
      ballot = decodeBallot(record, 2);
    } catch (e) {
      if (e instanceof DecodeError) return "decode";
      throw e;
    }
    if (ballot.cell >= params.cellCount) return "ballot-cell";
    const question = params.questions[0];
    if (params.questions.length !== 1 || question === undefined) return "validity-shape";
    const shaped = shapeOk(
      {
        optionCount: params.optionCount,
        minSelections: question.minSelections,
        maxSelections: question.maxSelections,
        threshold: params.threshold,
        panelSize: params.panelSize,
        definitionHash: framed.definitionHash,
        ballotVersion: 2,
        cell: ballot.cell,
        nullifier: ballot.nullifier,
      },
      ballot.committed_vote,
    );
    if (!shaped) return "validity-shape";
    const qualified = new Set(this.#qualified(params).map((s) => s.index));
    const hashes = ballot.committed_vote.share_hashes;
    if (hashes.some((h, i) => !qualified.has(i + 1) && h.some((x) => x !== 0)))
      return "share-hash-unqualified";
    return { ...framed, params, shareHashes: hashes };
  }

  /**
   * `submitBallot(record)` in a block `at`: a repeat is a no-op; otherwise
   * the ballot check, then `opens_at ≤ block.timestamp ≤ closes_at`
   * (`ballot-window`), then `BallotSubmitted`.
   */
  submitBallot(record: Uint8Array, at: L2Block): BoardResult {
    if (this.#isRepeat(record)) return { ok: true, emitted: 0 };
    const checked = this.#checkBallot(record);
    if (typeof checked === "string") return { ok: false, refusal: checked };
    const { opensAt, closesAt } = checked.params;
    if (at.timestamp < opensAt || at.timestamp > closesAt)
      return { ok: false, refusal: "ballot-window" };
    this.#emit(at, [TOPIC0.ballot, checked.definitionHash, checked.ballotHash], record);
    return { ok: true, emitted: 1 };
  }

  // Delivery records, steps 1 to 5 (docs/spec/contracts.md, Board, Delivery
  // records): the header, the election, the version, the framing and the
  // seat. Returns the record's election parameters and the seat's key.
  #checkDelivery(
    type: number,
    record: Uint8Array,
  ):
    | {
        readonly framed: FramedRecord;
        readonly params: BoardParameters;
        readonly seat: { readonly index: number; readonly signingKey: Uint8Array };
      }
    | BoardRefusal {
    if (record.length < 3 || typeOf(record) !== type || record.length < 35) return "decode";
    const params = this.#registry.parametersOf(record.subarray(3, 35));
    if (params === undefined || params.ballotVersion === 0) return "delivery-stray";
    if (params.ballotVersion > 3) return "unknown-version";
    if (record[2] !== 1) return "profile-mismatch";
    const framed = frameDelivery(type, record);
    if (framed === undefined) return "decode";
    const seat = this.#qualified(params).find((s) => s.index === record[67]);
    if (seat === undefined) return "delivery-seat";
    return { framed, params, seat };
  }

  /**
   * `submitReceipts(receipts)`: one or more 164-byte share receipts, each
   * checked in turn and signed by its seat's registered signing key, all
   * emitted or none (Calls). A repeat in the batch is a no-op.
   */
  submitReceipts(receipts: Uint8Array, at: L2Block): BoardResult {
    if (receipts.length === 0 || receipts.length % SHARE_RECEIPT_LENGTH !== 0)
      return { ok: false, refusal: "ReceiptBatchLength" };
    const fresh: { readonly record: Uint8Array; readonly framed: FramedRecord }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i * SHARE_RECEIPT_LENGTH < receipts.length; i++) {
      const record = receipts.slice(i * SHARE_RECEIPT_LENGTH, (i + 1) * SHARE_RECEIPT_LENGTH);
      const key = hex(keccak_256(record));
      if (this.#isRepeat(record) || seen.has(key)) continue;
      const checked = this.#checkDelivery(RECORD_TYPES.shareReceipt, record);
      if (typeof checked === "string") return { ok: false, refusal: checked, at: i };
      const r = decodeShareReceipt(record, 1);
      // The seat's per-election signing key, never its identity key (step 6).
      if (
        !verifyStatement(
          checked.seat.signingKey,
          "abolish/v1/sig/share-receipt",
          shareReceiptStatement(r),
          r.signature,
        )
      )
        return { ok: false, refusal: "delivery-signature", at: i };
      seen.add(key);
      fresh.push({ record, framed: checked.framed });
    }
    for (const { record, framed } of fresh)
      this.#emit(at, [TOPIC0.receipt, framed.definitionHash, framed.ballotHash], record);
    return { ok: true, emitted: fresh.length };
  }

  /**
   * `submitReceiptBatch(record)`: one share-receipt batch, strictly decoded
   * (its pairs ascending), for a registered election and a seat of its key
   * set, signed once by that seat's registered signing key, emitted whole
   * with its definition hash and seat as topics (Calls). A repeat is a no-op.
   */
  submitReceiptBatch(record: Uint8Array, at: L2Block): BoardResult {
    if (this.#isRepeat(record)) return { ok: true, emitted: 0 };
    if (record.length < 35 || typeOf(record) !== RECORD_TYPES.shareReceiptBatch)
      return { ok: false, refusal: "decode" };
    const params = this.#registry.parametersOf(record.subarray(3, 35));
    if (params === undefined || params.ballotVersion === 0)
      return { ok: false, refusal: "delivery-stray" };
    if (params.ballotVersion > 3) return { ok: false, refusal: "unknown-version" };
    if (record[2] !== 1) return { ok: false, refusal: "profile-mismatch" };
    let batch;
    try {
      batch = decodeShareReceiptBatch(record, 1);
    } catch (e) {
      if (e instanceof DecodeError) return { ok: false, refusal: "decode" };
      throw e;
    }
    const seat = this.#qualified(params).find((s) => s.index === batch.seat);
    if (seat === undefined) return { ok: false, refusal: "delivery-seat" };
    if (
      !verifyStatement(
        seat.signingKey,
        "abolish/v1/sig/share-receipt-batch",
        shareReceiptBatchStatement(batch),
        batch.signature,
      )
    )
      return { ok: false, refusal: "delivery-signature" };
    const seatWord = new Uint8Array(32);
    seatWord[31] = batch.seat;
    this.#emit(at, [TOPIC0.batch, batch.definition_hash, seatWord], record);
    return { ok: true, emitted: 1 };
  }

  /**
   * `submitPosting(posting, ballot)`: the posting's checks, its length for
   * the election's options, then its ballot through the whole ballot check
   * (never emitted or admitted), which must be the posting's election and
   * ballot hash and commit to its ciphertext for its seat (step 7). A
   * repeat is the posting's bytes alone, whatever ballot carries it.
   */
  submitPosting(posting: Uint8Array, ballot: Uint8Array, at: L2Block): BoardResult {
    if (this.#isRepeat(posting)) return { ok: true, emitted: 0 };
    const checked = this.#checkDelivery(RECORD_TYPES.sharePosting, posting);
    if (typeof checked === "string") return { ok: false, refusal: checked };
    let sealed: number;
    try {
      sealed = decodeSharePosting(posting, 1).ciphertext.sealed.length;
    } catch (e) {
      if (e instanceof DecodeError) return { ok: false, refusal: "decode" };
      throw e;
    }
    if (sealed !== 4 + 64 * checked.params.optionCount + 16)
      return { ok: false, refusal: "posting-length" };
    const admitted = this.#checkBallot(ballot);
    if (typeof admitted === "string") return { ok: false, refusal: admitted };
    if (
      !same(admitted.definitionHash, checked.framed.definitionHash) ||
      !same(admitted.ballotHash, checked.framed.ballotHash)
    )
      return { ok: false, refusal: "posting-ballot" };
    const committed = admitted.shareHashes[checked.seat.index - 1];
    if (
      committed === undefined ||
      !same(shareCiphertextHash(posting.subarray(POSTING_CIPHERTEXT_AT)), committed)
    )
      return { ok: false, refusal: "posting-hash" };
    const { definitionHash, ballotHash } = checked.framed;
    this.#emit(at, [TOPIC0.posting, definitionHash, ballotHash], posting);
    return { ok: true, emitted: 1 };
  }
}
