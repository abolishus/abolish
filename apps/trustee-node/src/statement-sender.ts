// The seat's destruction statement sent to the board operator
// (docs/spec/tally.md, Destruction, What; Destruction window): once the seat
// has destroyed an election's material and holds its signed statement, it
// sends the statement to the operator's destruction route and keeps
// resending it until the destruction window ends, `t_D +
// DESTRUCTION_WINDOW`, by when a statement must be on the board (T-14,
// T-40, T-69).
//
// The seat can't read the board for its statement: the tally duty that
// reads it is dropped at destruction. So the operator's answer only paces
// the sending, as it does the openings' (`OpeningSender`): an entry that
// carries the statement, or a refusal, waits `resendAfter` before the
// statement goes again; a claimed entry that doesn't carry it is ignored.
// Resending after an entry is claimed costs one request per `resendAfter`
// and covers an operator that answered an entry it never anchored (a board
// rebuilt from chain and archive loses what no checkpoint carried). Sending
// the same signed bytes again is safe at any time: the operator boards at
// most one statement per seat and answers a resend with the entry already
// boarded (`destruction-repeat`). An operator that refuses or withholds the
// statement makes the seat `destruction-missing` in the verifier's report,
// which fails nothing (Residuals; T-54).
import {
  type BoardEntryVersion,
  boardPayloadTypes,
  DecodeError,
  decodeBoardEntry,
  decodeDestructionStatement,
  destructionStatementMessage,
  RECORD_TYPES,
} from "@abolishus/crypto";
import type { ApprovedElectionInfo } from "./ceremony.ts";
import { RESEND_AFTER } from "./opening-sender.ts";
import type { DestructionOperator, OperatorAnswer } from "./operator.ts";

export interface StatementSenderOptions {
  readonly election: ApprovedElectionInfo;
  /** The board-entry version the registered definition pins, which an answered entry must decode under. */
  readonly boardVersion: BoardEntryVersion;
  /** The seat's signed statement once destruction has finished (`CeremonySeat.destructionStatement`). */
  readonly statement: () => Promise<Uint8Array | undefined>;
  readonly operator: DestructionOperator;
  /** The node's wall clock, in seconds. */
  readonly clock: () => bigint;
  /** Seconds before an answered statement is sent again; `RESEND_AFTER` by default. */
  readonly resendAfter?: bigint;
}

/** What became of one send of the statement. */
export type StatementSend =
  /** The operator answered with an entry carrying it (its bytes, or `earlier` the same signed message). */
  | { readonly state: "boarded"; readonly earlier: boolean }
  /** The operator answered with an entry that doesn't carry it, or doesn't decode: sent again next step. */
  | { readonly state: "misanswered" }
  /** The operator refused it with this code: an alarm, since the seat signs only a statement that passes. */
  | { readonly state: "rejected"; readonly code: string }
  /** The segment can't take it yet, the operator boards no statement of the election, or couldn't be reached. */
  | { readonly state: "not-ready" | "not-open" }
  | { readonly state: "unavailable"; readonly reason: string };

export type StatementSenderStatus =
  /** The seat hasn't finished destroying, so holds no statement to send. */
  | { readonly state: "none" }
  /**
   * The pinned board-entry version doesn't allow `0x000f`: no statement can
   * reach the board, and the verifier reports 8.5 not applicable
   * (Destruction window).
   */
  | { readonly state: "unboardable" }
  /** The statement's last send, as the operator answered it. */
  | { readonly state: "sending"; readonly send: StatementSend };

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** One election's destruction statement, sent to the operator until the destruction window ends. */
export class StatementSender {
  readonly #o: StatementSenderOptions;
  // The last send's outcome, and the wall time before which it isn't sent again.
  #last: { readonly send: StatementSend; readonly until: bigint } | undefined;

  constructor(options: StatementSenderOptions) {
    this.#o = options;
  }

  /** Sends the statement, if the seat holds it and the last answer's wait is over: one request at most. */
  async step(): Promise<StatementSenderStatus> {
    if (!boardPayloadTypes(this.#o.boardVersion).includes(RECORD_TYPES.destructionStatement))
      return { state: "unboardable" };
    const statement = await this.#o.statement();
    if (statement === undefined) return { state: "none" };
    const wall = this.#o.clock();
    if (this.#last !== undefined && wall < this.#last.until)
      return { state: "sending", send: this.#last.send };
    const send = this.#judge(
      statement,
      await this.#o.operator.submitDestruction(this.#o.election.electionId, statement),
    );
    const answered = send.state === "boarded" || send.state === "rejected";
    this.#last = { send, until: answered ? wall + (this.#o.resendAfter ?? RESEND_AFTER) : wall };
    return { state: "sending", send };
  }

  #judge(statement: Uint8Array, answer: OperatorAnswer): StatementSend {
    switch (answer.state) {
      case "boarded":
        return this.#carries(statement, answer.entry, answer.earlier)
          ? { state: "boarded", earlier: answer.earlier }
          : { state: "misanswered" };
      case "rejected":
        return { state: "rejected", code: answer.code };
      case "unavailable":
        return { state: "unavailable", reason: answer.reason };
      default:
        return { state: answer.state };
    }
  }

  /**
   * Whether `entry`, decoded under the pinned board-entry version, carries
   * `statement`: its bytes, or with `earlier` a version-1 statement over the
   * same signed message in other bytes (another signature nonce), as the
   * operator answers a resend of a message it boarded in other bytes.
   */
  #carries(statement: Uint8Array, entry: Uint8Array, earlier: boolean): boolean {
    let payload: Uint8Array;
    try {
      payload = decodeBoardEntry(entry, this.#o.boardVersion).payload;
    } catch (e) {
      if (e instanceof DecodeError) return false;
      throw e;
    }
    if (!earlier) return sameBytes(payload, statement);
    if (sameBytes(payload, statement)) return false;
    // The seat signs version 1 only (`CeremonySeat.destroy`), so its own statement decodes under it.
    try {
      return sameBytes(
        destructionStatementMessage(decodeDestructionStatement(payload, 1)),
        destructionStatementMessage(decodeDestructionStatement(statement, 1)),
      );
    } catch (e) {
      if (e instanceof DecodeError) return false;
      throw e;
    }
  }
}
