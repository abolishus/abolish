// The board path for destruction statements (docs/spec/tally.md,
// Destruction, Boarding): the operator boards a statement only if
// @abolishus/crypto's Boarding judge passes it: it decodes strictly under
// version 1, names this election's definition, a registered seat's signature
// attributes it, and no statement by that seat is boarded yet, so what the
// operator boards is judged by code inside the gate and never here (AGENTS.md,
// The verifier's trust base; T-17, T-29). A boarded statement carries no
// chosen bytes beyond the seat's signature nonce, at most one per seat. Timing
// is never judged: a statement boarded early is the seat's to explain, and
// the verifier's 8.5 reports it. A seat's node resends its statement until
// it is boarded or the destruction window ends, so a repeat is answered with
// the entry already boarded. Nothing here sees who sent a statement (T-10).

import {
  boardPayloadTypes,
  type DestructionElection,
  destructionBoarding,
  type Panel,
  RECORD_TYPES,
} from "@abolishus/crypto";
import type { Sql } from "postgres";
import {
  appendEntry,
  type AppendedEntry,
  AppendError,
  boardVersion,
  readBoardedDestructions,
} from "./board.ts";
import { isBytes } from "./bytes.ts";
import { OpeningError, openingTargets } from "./tally-boarding.ts";

const MAX_SEGMENT = 2 ** 32 - 1;

/** Elections whose `DestructionElection` is kept: a key set each, a few kilobytes at most. */
const TARGETS_KEPT = 4096;

export type DestructionErrorCode =
  /** No definition is stored for the election. */
  | "unknown-election"
  /** The anchoring clock hasn't started by `now`: try again later. */
  | "not-ready"
  /**
   * This operator never boards a destruction statement of the election: its
   * board-entry version doesn't allow one, it pins no tally-opening version
   * that fixes destruction-statement version 1, or no transcript passes.
   */
  | "not-open"
  /** The Boarding judge refuses the statement. */
  | "rejected";

/**
 * Why a statement was refused: crypto's Boarding codes, but for
 * `destruction-repeat`, which is answered with the entry already boarded.
 */
export type DestructionRejectionCode = "decode" | "destruction-stray" | "destruction-unattributed";

export class DestructionError extends Error {
  override readonly name = "DestructionError";
  readonly code: DestructionErrorCode;
  /** Under `rejected`: why. */
  readonly rejection?: DestructionRejectionCode;
  constructor(code: DestructionErrorCode, rejection?: DestructionRejectionCode) {
    super(
      `destruction statement refused: ${code}${rejection === undefined ? "" : ` (${rejection})`}`,
    );
    this.code = code;
    if (rejection !== undefined) this.rejection = rejection;
  }
}

/**
 * Each election's `DestructionElection` (its definition hash and the
 * registered key set its transcript check returns), read as `openingTargets`
 * reads a tally opening's, or undefined when this release boards no
 * destruction statement of it: the target `openingTargets` gives none (a
 * definition it can't read, a tally-opening pin other than 1 or 2, the
 * versions that fix destruction-statement version 1, or no transcript that
 * passes), or the pinned board-entry version doesn't allow `0x000f`. The
 * result throws `DestructionError` `unknown-election` when no definition is
 * stored.
 */
export function destructionTargets(
  panels: readonly Panel[],
): (client: Sql, electionId: Uint8Array) => Promise<DestructionElection | undefined> {
  const opening = openingTargets(panels);
  return async (client, electionId) => {
    let target;
    try {
      target = await opening(client, electionId);
    } catch (e) {
      if (e instanceof OpeningError && e.code === "unknown-election")
        throw new DestructionError("unknown-election");
      throw e;
    }
    if (target === undefined) return undefined;
    const version = await boardVersion(client, electionId);
    if (
      typeof version === "string" ||
      !boardPayloadTypes(version).includes(RECORD_TYPES.destructionStatement)
    )
      return undefined;
    return { definitionHash: target.definitionHash, registered: target.registered };
  };
}

export interface DestructionBoardingOptions {
  /** Each election's `DestructionElection`: `destructionTargets`' in a deployment. */
  readonly target: (
    client: Sql,
    electionId: Uint8Array,
  ) => Promise<DestructionElection | undefined>;
  /** The anchoring clock: it labels each entry's segment. */
  readonly clock: { readonly epoch: bigint; readonly period: bigint };
}

/**
 * Judges and boards destruction statements. One per process: each election's
 * target is kept, for 4,096 elections, so its transcript is checked once. A
 * statement costs one indexed read of the statements already boarded, at
 * most one per seat, and its signature checks (T-52).
 */
export class DestructionBoardings {
  readonly #target: DestructionBoardingOptions["target"];
  readonly #clock: { readonly epoch: bigint; readonly period: bigint };
  readonly #targets = new Map<string, DestructionElection>();

  constructor({ target, clock }: DestructionBoardingOptions) {
    if (typeof clock.epoch !== "bigint" || clock.epoch < 0n)
      throw new RangeError("clock.epoch must be a bigint ≥ 0");
    if (typeof clock.period !== "bigint" || clock.period < 1n)
      throw new RangeError("clock.period must be a bigint ≥ 1");
    this.#target = target;
    this.#clock = { epoch: clock.epoch, period: clock.period };
  }

  /**
   * Judges `statement` (a destruction statement record's bytes) for
   * `electionId` by the Boarding rule and, if it passes, appends it to the
   * board in the segment current at UNIX time `now` (seconds), or the latest
   * one taken since, and returns its entry. Throws `DestructionError` for a
   * refusal, with nothing written. A repeat, which a seat's node sends until
   * its statement is boarded, returns the entry that carries the seat's
   * statement, writing nothing.
   */
  async submitDestruction(
    client: Sql,
    electionId: Uint8Array,
    statement: Uint8Array,
    now: bigint,
  ): Promise<AppendedEntry> {
    if (!isBytes(electionId) || electionId.length !== 32)
      throw new TypeError("electionId must be 32 bytes");
    if (!isBytes(statement)) throw new TypeError("statement must be bytes");
    if (typeof now !== "bigint" || now < 0n) throw new TypeError("now must be a bigint ≥ 0");
    const id = new Uint8Array(electionId);
    const own = new Uint8Array(statement);
    const election = await this.#targetOf(client, id);
    if (election === undefined) throw new DestructionError("not-open");
    const boarded = await readBoardedDestructions(client, id);
    const verdict = destructionBoarding(
      election,
      boarded.map((b) => b.payload),
      own,
      1,
    );
    if (!verdict.ok) {
      if (verdict.code !== "destruction-repeat")
        throw new DestructionError("rejected", verdict.code);
      // The seat's one signed message: its resend gets the entry that
      // carries it, whatever its signature's bytes.
      const { payload: _, ...entry } = boarded[verdict.of] as (typeof boarded)[number];
      return entry;
    }
    if (now < this.#clock.epoch) throw new DestructionError("not-ready");
    const segment = (now - this.#clock.epoch) / this.#clock.period;
    if (segment > BigInt(MAX_SEGMENT)) throw new DestructionError("not-open");
    try {
      return await appendEntry(client, id, Number(segment), own, {
        raiseToPrevious: true,
        destruction: { seat: verdict.signer },
      });
    } catch (e) {
      // The segment's spoiled-ballot openings came first: the next segment
      // takes it, so the seat's resend boards it.
      if (e instanceof AppendError && e.code === "opening-order")
        throw new DestructionError("not-ready");
      if (
        !(e instanceof AppendError && e.code === "destruction-present" && e.existing !== undefined)
      )
        throw e;
      // The seat's statement was boarded since the judge read the board, in
      // other bytes: the same signed message, so it is this one's entry.
      const { payload, ...entry } = e.existing;
      const again = destructionBoarding(election, [payload], own, 1);
      if (!again.ok && again.code === "destruction-repeat") return entry;
      throw e;
    }
  }

  async #targetOf(client: Sql, id: Uint8Array): Promise<DestructionElection | undefined> {
    const key = Buffer.from(id).toString("hex");
    const known = this.#targets.get(key);
    if (known !== undefined) return known;
    // A definition and the transcript at entry 0 never change once stored,
    // so a target, once read, holds; none yet is asked for again.
    const target = await this.#target(client, id);
    if (target !== undefined) {
      if (this.#targets.size >= TARGETS_KEPT) {
        const oldest = this.#targets.keys().next();
        if (!oldest.done) this.#targets.delete(oldest.value);
      }
      this.#targets.set(key, target);
    }
    return target;
  }
}
