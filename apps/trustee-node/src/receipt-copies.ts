// The seat's own board-path copies of the share receipts it gave at intake
// (docs/spec/delivery.md, Client rules; Boarding): trustee nodes board their
// receipts through the board path, and where that fails send what they owe
// through the contract path, so a receipted seat is delivered even when the
// client goes away; the client's copies are a second route, never the only
// one (T-25). The contract path covers only what the seat owes at `c_I`
// (`ReceiptDuty`); a board-path copy also delivers a receipted ballot the
// decision passed over, such as an older ballot a voter replaced by one that
// never reached the board (Residuals, a newest ballot that never reached the
// board).
//
// Each receipt intake kept goes to the operator's receipts route until the
// operator answers with an entry carrying it, or the delivery deadline `t_D`
// passes. The operator boards a receipt only once its ballot is on the board
// (Boarding, rule 2), and the seat receipts a ballot before its client
// boards it, so a refusal naming the missing ballot (`receipt-ballot`), or an
// election the operator isn't taking receipts for yet, waits `retryAfter`
// before the receipt goes again. The operator's word only paces the
// sending: what delivers is an anchored receipt, which only a reader of the
// anchored board can see, and the contract path doesn't wait on this (T-53).
// Sending the same bytes again is safe at any time: the operator answers a
// resend with the entry already boarded, before reading any ballot (T-52).
import {
  type BoardEntryVersion,
  boardPayloadTypes,
  DecodeError,
  decodeBoardEntry,
  decodeShareReceipt,
  RECORD_TYPES,
} from "@abolishus/crypto";
import type { ApprovedElectionInfo } from "./ceremony.ts";
import { RESEND_AFTER } from "./opening-sender.ts";
import type { OperatorAnswer, ReceiptOperator } from "./operator.ts";

/**
 * Seconds before a receipt whose ballot isn't on the board yet, or for an
 * election the operator isn't taking receipts for, is sent again: a client
 * boards its ballot within moments of its last receipt, so most wait once.
 */
export const RETRY_AFTER = 300n;

/**
 * The most receipts sent in one step. Requests go one at a time, so a slow
 * operator delays only this election's later receipts to the next step, and
 * a seat that took many ballots in at once spreads their copies over steps
 * (T-52).
 */
export const RECEIPTS_PER_STEP = 64;

export interface ReceiptCopySenderOptions {
  readonly election: ApprovedElectionInfo;
  /** The board-entry version the registered definition pins, which an answered entry must decode under. */
  readonly boardVersion: BoardEntryVersion;
  /** Every receipt the seat gave for the election, by ballot hash (`givenReceipts`). */
  readonly receipts: () => Promise<readonly { ballot: string; receipt: Uint8Array }[]>;
  readonly operator: ReceiptOperator;
  /** The node's wall clock, in seconds. */
  readonly clock: () => bigint;
  /** Seconds before a receipt refused for its missing ballot, or an unopened election, goes again; `RETRY_AFTER` by default. */
  readonly retryAfter?: bigint;
  /** Seconds before a receipt refused for anything else goes again; `RESEND_AFTER` by default. */
  readonly resendAfter?: bigint;
  /** `RECEIPTS_PER_STEP` by default. */
  readonly perStep?: number;
}

export type ReceiptCopiesStatus =
  /**
   * The pinned board-entry version doesn't allow `0x000c`: no receipt can
   * reach the board through the board path, and the contract path is the
   * seat's only one (docs/spec/delivery.md, Versions).
   */
  | { readonly state: "unboardable" }
  | {
      readonly state: "sending";
      /** The receipts the seat gave. */
      readonly given: number;
      /** Of those, the ones the operator answered with an entry carrying them. */
      readonly boarded: number;
      /**
       * The ones whose last answer was a refusal for anything but a missing
       * ballot: an alarm, since the seat gives only receipts that pass.
       */
      readonly refused: number;
    };

// One receipt's last answer: boarded, or the wall time before which it isn't sent again.
type Held =
  | { readonly boarded: true }
  | { readonly boarded: false; readonly until: bigint; readonly refused: boolean };

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** One election's board-path receipt copies, sent to the operator until `t_D`. */
export class ReceiptCopySender {
  readonly #o: ReceiptCopySenderOptions;
  readonly #held = new Map<string, Held>();

  constructor(options: ReceiptCopySenderOptions) {
    this.#o = options;
  }

  /**
   * Sends every receipt not yet boarded whose last answer's wait is over, at
   * most `perStep` of them, in ballot-hash order. An operator that can't be
   * reached or can't judge one now ends the step: the rest go next step.
   */
  async step(): Promise<ReceiptCopiesStatus> {
    if (!boardPayloadTypes(this.#o.boardVersion).includes(RECORD_TYPES.shareReceipt))
      return { state: "unboardable" };
    const given = await this.#o.receipts();
    const wall = this.#o.clock();
    const perStep = this.#o.perStep ?? RECEIPTS_PER_STEP;
    let sent = 0;
    for (const { ballot, receipt } of given) {
      if (sent >= perStep) break;
      const held = this.#held.get(ballot);
      if (held !== undefined && (held.boarded || wall < held.until)) continue;
      sent++;
      const answer = await this.#o.operator.submitReceipt(this.#o.election.electionId, receipt);
      const next = this.#judge(receipt, answer, wall);
      this.#held.set(ballot, next);
      if (answer.state === "unavailable") break;
    }
    let boarded = 0;
    let refused = 0;
    for (const { ballot } of given) {
      const held = this.#held.get(ballot);
      if (held?.boarded) boarded++;
      else if (held?.refused) refused++;
    }
    return { state: "sending", given: given.length, boarded, refused };
  }

  #judge(receipt: Uint8Array, answer: OperatorAnswer, wall: bigint): Held {
    const wait = (after: bigint, refused = false): Held => ({
      boarded: false,
      until: wall + after,
      refused,
    });
    switch (answer.state) {
      case "boarded":
        return this.#carries(receipt, answer.entry, answer.earlier) ? { boarded: true } : wait(0n);
      case "rejected":
        // The one refusal an honest operator gives a receipt the seat gave:
        // its client hasn't boarded the ballot yet (Boarding, rule 2).
        return answer.code === "receipt-ballot"
          ? wait(this.#o.retryAfter ?? RETRY_AFTER)
          : wait(this.#o.resendAfter ?? RESEND_AFTER, true);
      case "not-open":
      case "not-ready":
        return wait(this.#o.retryAfter ?? RETRY_AFTER);
      case "unavailable":
        return wait(0n);
    }
  }

  /**
   * Whether `entry`, decoded under the pinned board-entry version, carries
   * `receipt`: its bytes, or with `earlier` a version-1 receipt in other
   * bytes stating the same (definition, ballot hash, seat, share hash), as
   * the operator answers a receipt when it already holds a passing one for
   * that seat of that ballot (Boarding, rule 5). The signature isn't
   * checked: the answer only stops the sending, which the operator can
   * already do by never anchoring the entry.
   */
  #carries(receipt: Uint8Array, entry: Uint8Array, earlier: boolean): boolean {
    let payload: Uint8Array;
    try {
      payload = decodeBoardEntry(entry, this.#o.boardVersion).payload;
    } catch (e) {
      if (e instanceof DecodeError) return false;
      throw e;
    }
    if (!earlier) return sameBytes(payload, receipt);
    if (sameBytes(payload, receipt)) return false;
    // The seat gives version-1 receipts only (definition versions 1 and 5), so its own decodes under it.
    try {
      const theirs = decodeShareReceipt(payload, 1);
      const ours = decodeShareReceipt(receipt, 1);
      return (
        sameBytes(theirs.definition_hash, ours.definition_hash) &&
        sameBytes(theirs.ballot_hash, ours.ballot_hash) &&
        theirs.seat === ours.seat &&
        sameBytes(theirs.share_hash, ours.share_hash)
      );
    } catch (e) {
      if (e instanceof DecodeError) return false;
      throw e;
    }
  }
}
