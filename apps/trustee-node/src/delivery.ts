// A seat's receipt duty on the contract path (docs/spec/delivery.md, Direct
// submit): once the obligation is decided at `c_I`, the receipts it owes are
// signed as share-receipt batches of at most `RECEIPT_BATCH_MAX` pairs, each
// carrying the `share_hash` intake receipted, and written once before
// anything is sent, so a crash, a restart or a retry resends the stored
// bytes and the seat never signs a second set. Each batch is sent through
// the board's `submitReceiptBatch`, forced through L1 when the sequencer
// doesn't take it, until the seat's own L2 node shows it in finalized
// history, and by `c_D = t_D − F` at the latest, so a deposit lands by the
// delivery deadline `t_D` (T-25, T-52, T-54).
//
// A seat sends every receipt it owes, even one whose passing receipt is
// anchored already, which the spec lets it skip: the contract takes the
// batch beside it, at the cost of the seat's gas only.
import {
  batchShareReceipts,
  bytesVar,
  decode,
  deliveryDeadlines,
  encode,
  encodeShareReceiptBatch,
  list,
  RECEIPT_BATCH_MAX,
} from "@abolishus/crypto";
import type { ApprovedElection } from "./ceremony.ts";
import { receiptedShareHash } from "./intake.ts";
import { decideObligation, type ObligationOptions } from "./obligation.ts";
import { RELEASE_WINDOWS } from "./stub.ts";

/** The board contract's receipt-batch call, as the deployment reaches it. */
export interface ReceiptPath {
  /**
   * Submits a share-receipt batch to the board contract, through the
   * sequencer or forced through L1 when the sequencer doesn't take it in
   * time, and by `cutoff` (`c_D`) whatever it did; resolves once it is sent,
   * not once it is recorded. Throws if it can't be sent now.
   */
  send(record: Uint8Array, cutoff: bigint): Promise<void>;
  /**
   * Every share-receipt batch the board contract recorded for the definition
   * and seat, as the seat's own L2 node derives it from finalized L1, never a
   * sequencer's soft confirmation.
   */
  recorded(definitionHash: Uint8Array, seat: number): Promise<readonly Uint8Array[]>;
}

export interface ReceiptDutyOptions extends ObligationOptions {
  readonly election: ApprovedElection;
  readonly contract: ReceiptPath;
}

/** Where the receipt duty stands after a step. */
export type ReceiptDutyStatus =
  /** Intake is open until `until` (`c_I`): nothing is owed yet. */
  | { readonly state: "open"; readonly until: bigint }
  /** Finalized L1 doesn't reach past `closes_at` yet, so the obligation waits. */
  | { readonly state: "waiting-l1" }
  /** `batches` were sent (or resent) this step; `recorded` of `total` are recorded. */
  | {
      readonly state: "sent";
      readonly batches: number;
      readonly recorded: number;
      readonly total: number;
    }
  /** Every batch is recorded, or the seat owes no receipt: the duty is done. */
  | { readonly state: "recorded"; readonly total: number }
  /**
   * `t_D` has passed and `missing` of the stored batches were never
   * recorded: they can't deliver any more, so the seat stops sending them.
   * An alarm for the node's operator (a refused call, a censored path it
   * couldn't force).
   */
  | { readonly state: "unrecorded"; readonly missing: number; readonly total: number };

// The node's own storage, not protocol bytes: the encoded batches, each at
// most `104 + 64 · RECEIPT_BATCH_MAX` bytes.
const BATCHES = list(bytesVar(104 + 64 * RECEIPT_BATCH_MAX), 2 ** 32 - 1);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The receipt duty of one seat for one election it approved. `step` is
 * idempotent: the node calls it on a schedule until it returns `recorded`
 * or `unrecorded`.
 */
export class ReceiptDuty {
  readonly #o: ReceiptDutyOptions;

  constructor(options: ReceiptDutyOptions) {
    this.#o = options;
  }

  /** `t_D`: a contract-path receipt delivers only if submitted by then. */
  get deadline(): bigint {
    const { closesAt, l1InclusionBound } = this.#o.election;
    return deliveryDeadlines(closesAt, l1InclusionBound).delivery;
  }

  /** `c_D = t_D − F`: the last moment a receipt is sure to land in time, even forced through L1. */
  get cutoff(): bigint {
    return this.deadline - RELEASE_WINDOWS.forcedInclusion;
  }

  async step(): Promise<ReceiptDutyStatus> {
    const o = this.#o;
    const batches = await this.#batches();
    if (!Array.isArray(batches)) return batches;
    const total = batches.length;
    if (total === 0) return { state: "recorded", total };
    const recorded = new Set(
      (await o.contract.recorded(o.election.definitionHash, o.election.index)).map(hex),
    );
    const missing = batches.filter((b) => !recorded.has(hex(b)));
    if (missing.length === 0) return { state: "recorded", total };
    // Past `t_D` no submission delivers, so nothing is sent again.
    if (o.now() > this.deadline) return { state: "unrecorded", missing: missing.length, total };
    for (const batch of missing) await o.contract.send(batch, this.cutoff);
    return { state: "sent", batches: missing.length, recorded: total - missing.length, total };
  }

  /**
   * The stored batches, or, the first time the obligation is decided, the
   * batches signed over its receipts and stored before any is sent.
   */
  async #batches(): Promise<Uint8Array[] | ReceiptDutyStatus> {
    const o = this.#o;
    const { election } = o;
    const key = `deliveries/${hex(election.stubHash)}/receipts`;
    const stored = await o.store.get(key);
    if (stored !== undefined) return [...decode(BATCHES, stored)];
    const status = await decideObligation(o, election);
    if (status.state !== "decided") return status;
    const pairs = [];
    for (const ballotHash of status.receipts)
      pairs.push({
        ballot_hash: ballotHash,
        share_hash: await receiptedShareHash(o.store, election.stubHash, ballotHash),
      });
    const batches = batchShareReceipts(
      election.signingSecret,
      election.definitionHash,
      election.index,
      pairs,
    ).map(encodeShareReceiptBatch);
    // Written once: a concurrent or earlier step's batches win, and are what's sent.
    return [...decode(BATCHES, (await o.store.putOnce(key, encode(BATCHES, batches))).value)];
  }
}
