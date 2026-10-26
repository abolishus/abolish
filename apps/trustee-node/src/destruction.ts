// A seat's destruction duty (docs/spec/tally.md, Destruction): at the earlier
// of the moment the anchored board carries a passing opening of every cell
// and `t_D`, the seat destroys what would let it, or anyone who later seizes
// or compels it, open ballots, and signs its destruction statement with the
// per-election signing key as that key's last use (`CeremonySeat.destroy`;
// T-14, T-40, T-69).
//
// Both moments are read as the spec reads them, never on the node's clock:
// the first from the tally duty's own read of the anchored board, each
// opening checked against its own aggregate under a counted checkpoint its
// own finalized L1 node shows anchored (`PublishedReads`); the second from
// the time of the finalized L1 block its own L1 node gives, so a node
// whose clock runs fast destroys nothing early, and one whose L1 view lags
// destroys late, never early (When). The statement is held for sending; a
// seat that never reaches either moment, its L1 node down, keeps its
// material until it does.
import type { DeadlineClock } from "@abolishus/crypto";
import type { ApprovedElectionInfo, CeremonySeat } from "./ceremony.ts";
import {
  afterDestruction,
  DestructionDuties,
  type DestructionEvent,
  tallyDeadline,
} from "./duties.ts";
import type { PublishedCells, PublishedReads } from "./opening-sender.ts";

export interface DestructionDutyOptions {
  readonly election: ApprovedElectionInfo;
  readonly seat: Pick<CeremonySeat, "destroy" | "destroying">;
  /** The seat's own read of the anchored board (`TallyDuty`'s `published` cells). */
  readonly published: () => PublishedCells;
  /**
   * The time of the latest finalized L1 block at the seat's own L1 node.
   * Throws an `RpcError` while the node can't answer, and the step is
   * retried.
   */
  readonly finalizedTime: () => Promise<bigint>;
  /** `t_D` (`tallyDeadline`). */
  readonly deadline: bigint;
}

export type DestructionStatus =
  /** Neither moment has come: the anchored board lacks a passing opening of some cell, and finalized L1 is before `t_D`. */
  | { readonly state: "holding"; readonly finalized: bigint }
  /**
   * The election's material is destroyed and the seat holds its statement:
   * at `published`, every cell's passing opening, at `deadline`, `t_D`, or
   * `resumed`, a destruction begun before (a restart, or a step cut short).
   */
  | { readonly state: "destroyed"; readonly at: "published" | "deadline" | "resumed" };

/** One election's destruction, at the earlier of its two moments. */
export class DestructionDuty {
  readonly #o: DestructionDutyOptions;

  constructor(options: DestructionDutyOptions) {
    this.#o = options;
  }

  async step(): Promise<DestructionStatus> {
    const { seat, election } = this.#o;
    if (await seat.destroying(election.stubHash)) return this.#destroy("resumed");
    if (this.#o.published().complete) return this.#destroy("published");
    const finalized = await this.#o.finalizedTime();
    if (finalized >= this.#o.deadline) return this.#destroy("deadline");
    return { state: "holding", finalized };
  }

  async #destroy(at: "published" | "deadline" | "resumed"): Promise<DestructionStatus> {
    // The statement stays in the store (`destruction/<stub hash>`) for sending.
    if ((await this.#o.seat.destroy(this.#o.election.stubHash)) === undefined)
      throw new Error("trustee node: destruction of an election the seat didn't approve");
    return { state: "destroyed", at };
  }
}

export interface DestructionWiring {
  readonly seat: Pick<
    CeremonySeat,
    "approvedStubs" | "approvedElectionInfo" | "destroy" | "destroying"
  >;
  /** Fed by the tally duty's steps, when it runs; empty without it, so the seat destroys at `t_D`. */
  readonly published: PublishedReads;
  /** The time of the latest finalized L1 block at the seat's own L1 node, never the node's clock. */
  readonly finalizedL1Time: () => Promise<bigint>;
  /** The deployment's pinned anchoring clock, which `t_D` is read under. */
  readonly anchorClock: DeadlineClock;
  /** The node's wall clock, in seconds: the schedule's, never the moment's. */
  readonly clock: () => bigint;
  readonly log: (event: DestructionEvent) => void;
}

/**
 * Every approved election's destruction in a deployment. Its schedule reads
 * the seat without secrets (`afterDestruction`), so the `destroying` record
 * that drops every other duty never drops this one: a destruction a crash
 * cut short is finished on the next step, after a restart included.
 */
export function destructionDuties(w: DestructionWiring): DestructionDuties {
  return new DestructionDuties(
    {
      seat: afterDestruction(w.seat),
      clock: w.clock,
      log: w.log,
      build: async (election) => {
        const deadline = tallyDeadline(election, w.anchorClock);
        const duty = new DestructionDuty({
          election,
          seat: w.seat,
          published: () => w.published.of(election.stubHash),
          finalizedTime: w.finalizedL1Time,
          deadline,
        });
        return { step: () => duty.step(), deadline };
      },
    },
    w.anchorClock,
  );
}
