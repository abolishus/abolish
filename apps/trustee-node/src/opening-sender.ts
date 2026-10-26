// The seat's tally openings sent to the board operator (docs/spec/tally.md,
// Opening record, Boarding; Destruction, When): each opening the tally duty
// signed and stored is sent to the operator's opening route and sent again
// until the seat reads a passing opening of its cell on the anchored board,
// or the seal. A trustee keeps every opening it signed and resends it until
// the seal, so an operator that withholds openings until the tally window
// ends can't make the seats destroy what would combine new ones, nor keep a
// cell's count off the board while any seat still sends it (T-54, T-29).
//
// Nothing here decides that a cell is published: that is the tally duty's
// own read of the anchored board, checked against its own aggregate
// (`TallyDuty`, `boardOpenings`; T-53, T-24). The operator's answer is a
// claim, and only paces the sending: an entry that carries the opening, or
// a refusal, waits `resendAfter` before the opening goes again; a claimed
// entry that doesn't carry it is ignored. So an operator that lies can slow
// the resending to one request per opening per `resendAfter`, never stop
// it. Sending the same signed bytes again is safe at any time: the
// operator boards at most one opening per cell and seat, and answers a
// resend with the entry already boarded (`tally-repeat`).
import {
  type BoardEntryVersion,
  DecodeError,
  decodeBoardEntry,
  decodeTallyOpening,
  tallyOpeningStatement,
} from "@abolishus/crypto";
import type { ApprovedElection } from "./ceremony.ts";
import type { OpeningOperator, OperatorAnswer } from "./operator.ts";
import type { TallyDutyStatus } from "./tally.ts";

/**
 * Seconds before an opening the operator answered (boarded or refused) is
 * sent again: the operator's own lapse for a refusal resting on one read of
 * the anchor is 10 minutes, so a refusal it would take back is asked again
 * about when it would.
 */
export const RESEND_AFTER = 600n;

/** Which cells the seat has read published on the anchored board, as its tally duty last did. */
export interface PublishedCells {
  /** Each cell with a passing opening on the anchored board. */
  readonly cells: ReadonlySet<number>;
  /** Every cell of the partition is published: nothing is left to send. */
  readonly complete: boolean;
}

/**
 * The cells a tally step read published on the anchored board, by their
 * index in the partition; `undefined` for a step that read no board (the
 * duty hasn't fixed its counted set), which changes nothing the seat knows.
 */
export function publishedOf(status: TallyDutyStatus): PublishedCells | undefined {
  if (status.state !== "tallying") return undefined;
  const cells = new Set<number>();
  status.cells.forEach((c, i) => {
    if (c.state === "published") cells.add(i);
  });
  return { cells, complete: cells.size === status.cells.length };
}

/**
 * Each election's cells as its tally duty last read them published on the
 * anchored board, by stub hash, so the sender stops sending what the seat
 * has seen boarded and anchored, never on the operator's word. Kept in
 * memory, as the duty's own read is: after a restart the duty reads the
 * board again until `t_D`, and past it the sender resends every opening
 * until the seal's tally term.
 */
export class PublishedReads {
  readonly #reads = new Map<string, PublishedCells>();

  /** Records what a tally step of the election approved as `stubHash` read. */
  track(stubHash: Uint8Array, status: TallyDutyStatus): void {
    const read = publishedOf(status);
    if (read !== undefined) this.#reads.set(hex(stubHash), read);
  }

  /** What the election's tally duty last read, or nothing published before it reads the board. */
  of(stubHash: Uint8Array): PublishedCells {
    return this.#reads.get(hex(stubHash)) ?? { cells: new Set(), complete: false };
  }
}

export interface OpeningSenderOptions {
  readonly election: ApprovedElection;
  /** The board-entry version the registered definition pins, which an answered entry must decode under. */
  readonly boardVersion: BoardEntryVersion;
  /** The openings the seat signed, by cell (`signedOpenings`). */
  readonly openings: () => Promise<ReadonlyMap<number, Uint8Array>>;
  /** The seat's own read of the anchored board (`TallyDuty`'s `published` cells). */
  readonly published: () => PublishedCells;
  readonly operator: OpeningOperator;
  /** The node's wall clock, in seconds. */
  readonly clock: () => bigint;
  /** Seconds before an answered opening is sent again; `RESEND_AFTER` by default. */
  readonly resendAfter?: bigint;
}

/** What became of one signed opening. */
export type OpeningSend =
  /** The anchored board carries a passing opening of the cell, as the seat read it: never sent again. */
  | { readonly cell: number; readonly state: "published" }
  /** Not sent yet. */
  | { readonly cell: number; readonly state: "unsent" }
  /** The operator answered with an entry carrying it (its bytes, or `earlier` the same signed message). */
  | { readonly cell: number; readonly state: "boarded"; readonly earlier: boolean }
  /** The operator answered with an entry that doesn't carry it, or doesn't decode: sent again next step. */
  | { readonly cell: number; readonly state: "misanswered" }
  /** The operator refused it with this code: an alarm, since the seat signs only a passing opening. */
  | { readonly cell: number; readonly state: "rejected"; readonly code: string }
  /** The operator hasn't fixed the counted set, boards no opening of the election, or couldn't be reached. */
  | { readonly cell: number; readonly state: "not-ready" | "not-open" }
  | { readonly cell: number; readonly state: "unavailable"; readonly reason: string };

export type OpeningSenderStatus =
  /** The seat has signed no opening yet. */
  | { readonly state: "none" }
  /** Every cell is published on the anchored board: nothing is left to send. */
  | { readonly state: "complete" }
  /** Each signed opening by cell, in cell order. */
  | { readonly state: "sending"; readonly openings: readonly OpeningSend[] };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** One election's signed openings, sent to the operator until the seat reads each cell published. */
export class OpeningSender {
  readonly #o: OpeningSenderOptions;
  // Each cell's last outcome, and the wall time before which it isn't sent again.
  readonly #sent = new Map<number, { readonly send: OpeningSend; readonly until: bigint }>();
  // Where in cell order the next step starts sending.
  #rotation = 0;

  constructor(options: OpeningSenderOptions) {
    this.#o = options;
  }

  /**
   * Sends every signed opening of a cell not yet published whose wait is
   * over, one at a time. An answer that says the operator can't take
   * openings of the election now (not ready, not open, unavailable) ends
   * the step's sending, so a stalled operator costs one request per step
   * (T-52). Each step starts one cell further on, in cell order, so a cell
   * the operator keeps failing on its own can't hold every later one back:
   * within as many steps as the seat has openings, each is sent first once.
   */
  async step(): Promise<OpeningSenderStatus> {
    const published = this.#o.published();
    if (published.complete) return { state: "complete" };
    const openings = [...(await this.#o.openings())].sort(([a], [b]) => a - b);
    if (openings.length === 0) return { state: "none" };
    const wall = this.#o.clock();
    const first = this.#rotation++ % openings.length;
    let halted = false;
    const out = new Map<number, OpeningSend>();
    for (const [cell, opening] of [...openings.slice(first), ...openings.slice(0, first)]) {
      if (published.cells.has(cell)) {
        this.#sent.delete(cell);
        out.set(cell, { cell, state: "published" });
        continue;
      }
      const last = this.#sent.get(cell);
      if (halted || (last !== undefined && wall < last.until)) {
        out.set(cell, last?.send ?? { cell, state: "unsent" });
        continue;
      }
      const send = this.#judge(
        cell,
        opening,
        await this.#o.operator.submit(this.#o.election.electionId, opening),
      );
      const answered = send.state === "boarded" || send.state === "rejected";
      this.#sent.set(cell, {
        send,
        until: answered ? wall + (this.#o.resendAfter ?? RESEND_AFTER) : wall,
      });
      halted =
        send.state === "not-ready" || send.state === "not-open" || send.state === "unavailable";
      out.set(cell, send);
    }
    return { state: "sending", openings: openings.map(([cell]) => out.get(cell) as OpeningSend) };
  }

  #judge(cell: number, opening: Uint8Array, answer: OperatorAnswer): OpeningSend {
    switch (answer.state) {
      case "boarded":
        return this.#carries(opening, answer.entry, answer.earlier)
          ? { cell, state: "boarded", earlier: answer.earlier }
          : { cell, state: "misanswered" };
      case "rejected":
        return { cell, state: "rejected", code: answer.code };
      case "unavailable":
        return { cell, state: "unavailable", reason: answer.reason };
      default:
        return { cell, state: answer.state };
    }
  }

  /**
   * Whether `entry`, decoded under the pinned board-entry version, carries
   * `opening`: its bytes, or with `earlier` a tally opening of the same
   * version over the same signed message, as the operator answers a resend
   * of a message it boarded in other bytes.
   */
  #carries(opening: Uint8Array, entry: Uint8Array, earlier: boolean): boolean {
    let payload: Uint8Array;
    try {
      payload = decodeBoardEntry(entry, this.#o.boardVersion).payload;
    } catch (e) {
      if (e instanceof DecodeError) return false;
      throw e;
    }
    if (!earlier) return sameBytes(payload, opening);
    if (sameBytes(payload, opening)) return false;
    // The seat signs version 1 only (`TallyDuty`), so its own opening decodes under it.
    try {
      return sameBytes(
        tallyOpeningStatement(decodeTallyOpening(payload, 1)),
        tallyOpeningStatement(decodeTallyOpening(opening, 1)),
      );
    } catch (e) {
      if (e instanceof DecodeError) return false;
      throw e;
    }
  }
}
