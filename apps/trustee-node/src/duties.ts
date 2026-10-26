// A seat's duties in a deployment: for each election the seat approved, one
// duty, built once its sources can be set up and stepped on a schedule until
// it settles. Five kinds run so: the availability duty at each point
// (`AvailabilitySeat`, docs/spec/availability.md, What a seat does; T-24,
// T-54), the receipt duty
// (`ReceiptDuty`, docs/spec/delivery.md, What a node owes; T-25, T-52),
// the complaint duty (`ComplaintDuty`, What a node owes in complaints; T-29),
// the tally duty (`TallyDuty`, docs/spec/tally.md; T-29, T-14, T-54),
// which also takes the summed-share messages the channel hands it, and the
// sending of the openings it signed (`OpeningSender`, Destruction, When;
// T-54).
// This file only schedules: what the seat decides, signs, stores and sends is
// the duty's, so a crash, a restart or a step that fails midway resends the
// stored record and never signs another.
import { setTimeout as sleep } from "node:timers/promises";
import {
  availabilityWindows,
  type DeadlineClock,
  deliveryDeadlines,
  PARAMETERS,
} from "@abolishus/crypto";
import { L2Error, RpcError } from "@abolishus/node";
import { L1Error } from "@abolishus/verifier";
import { type AvailabilitySeat, type AvailabilityStatus, countedDue } from "./availability.ts";
import type { ApprovedElection, CeremonySeat } from "./ceremony.ts";
import type { ComplaintDuty, ComplaintDutyStatus } from "./complaint.ts";
import type { ReceiptDuty, ReceiptDutyStatus } from "./delivery.ts";
import { L1AnchorError, tallySegment } from "./l1.ts";
import type { OpeningSender, OpeningSenderStatus } from "./opening-sender.ts";
import { SendError } from "./send.ts";
import { RELEASE_WINDOWS } from "./stub.ts";
import type { TallyDuty, TallyDutyStatus } from "./tally.ts";
import { ViewError } from "./view.ts";

/**
 * What one kind of duty reports: each election's status when it changes,
 * and why a step failed. Never a secret: stub hashes, states, counts and
 * error codes only, and an RPC error's message, which names the method and
 * never the node's URL.
 */
export type KindEvent<K extends string, S> =
  | ({ readonly event: K; readonly stubHash: string } & Logged<S>)
  | {
      readonly event: `${K}-error`;
      readonly stubHash: string;
      readonly error: string;
      readonly message: string;
    }
  /**
   * The duty's deadline (`t_A`, `t_D`) passed before it could be set up
   * (never registered, or never final at the seat's nodes): nothing it sent
   * could count any more, so the node stops trying.
   */
  | { readonly event: `${K}-abandoned`; readonly stubHash: string };

export type AvailabilityEvent = KindEvent<"availability", AvailabilityStatus>;
export type CountedAvailabilityEvent = KindEvent<"counted-availability", AvailabilityStatus>;
export type ReceiptEvent = KindEvent<"receipts", ReceiptDutyStatus>;
export type ComplaintEvent = KindEvent<"complaints", ComplaintDutyStatus>;
export type TallyEvent = KindEvent<"tally", TallyDutyStatus>;
export type OpeningEvent = KindEvent<"openings", OpeningSenderStatus>;
/** What the duties report. */
export type DutyEvent =
  | AvailabilityEvent
  | CountedAvailabilityEvent
  | ReceiptEvent
  | ComplaintEvent
  | TallyEvent
  | OpeningEvent;

// A status as logged: its times as decimal strings, so the line is JSON.
type Logged<S> = S extends unknown
  ? { readonly [K in keyof S]: S[K] extends bigint ? string : S[K] }
  : never;

export interface DutyOptions<D = Duty, E = AvailabilityEvent> {
  readonly seat: Pick<CeremonySeat, "approvedStubs" | "approvedElection">;
  /**
   * The election's duty over the deployment's sources. Throws
   * `L1AnchorError` when the election can never be read (the registry
   * registered another definition, the anchor's clock isn't the pinned
   * one), and an RPC or L2 error while it can't be read yet.
   */
  readonly build: (election: ApprovedElection) => Promise<D>;
  /** The node's wall clock, in seconds. */
  readonly clock: () => bigint;
  readonly log: (event: E) => void;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Failures a later step can get past: a node that didn't answer or answered
// what can't be read or proven, an election not registered or not final
// yet, a record neither path took now. Anything else (a store that can't
// be read, a bug) ends the loop, as it ends the ceremony's: the node acts
// on nothing it can't read.
const RETRIED = [RpcError, L1Error, L2Error, SendError] as const;
// Refusals no retry changes: the seat can never read this election under
// this deployment (another registered definition, a wrong anchor clock, a
// node on another chain, a poll too long to read), so the duty is given up
// and the operator must look (T-53).
const FINAL = [L1AnchorError, ViewError] as const;

/** What the schedule needs of an election's availability duty: `AvailabilitySeat`. */
export type Duty = Pick<AvailabilitySeat, "step" | "deadline">;
/** What the schedule needs of an election's receipt duty: `ReceiptDuty`. */
export type ReceiptStep = Pick<ReceiptDuty, "step" | "deadline">;
/** What the schedule needs of an election's complaint duty: `ComplaintDuty`. */
export type ComplaintStep = Pick<ComplaintDuty, "step" | "deadline">;
/**
 * What the schedule needs of an election's tally duty: `TallyDuty`'s step
 * and receive, with the deadline its builder reads (`tallyDeadline`).
 */
export type TallyStep = Pick<TallyDuty, "step" | "receive"> & { readonly deadline: bigint };

/** What the schedule needs of an election's opening sender: `OpeningSender`, with `openingsDeadline`. */
export type OpeningStep = Pick<OpeningSender, "step"> & { readonly deadline: bigint };

/** What the schedule needs of any duty. */
interface Stepped<S> {
  readonly step: () => Promise<S>;
  /** Past this, a status the duty settles on is final. */
  readonly deadline: bigint;
}

/** What sets one kind of duty apart in the schedule. */
interface Kind<K extends string, S> {
  readonly name: K;
  /** The duty's deadline, from the election alone, so a duty never built can be given up. */
  readonly deadline: (election: ApprovedElection) => bigint;
  /** Whether `status`, from a step begun at `wall`, ends the duty. */
  readonly settles: (status: S, wall: bigint, deadline: bigint) => boolean;
  /**
   * Whether a step begun past the deadline is never taken, rather than
   * taken once more: the tally's, since past `t_D` the seat may combine
   * nothing and send no sum (docs/spec/tally.md, Destruction).
   */
  readonly noStepPast?: boolean;
}

/** One kind of duty for every election the seat approved, each built once and stepped until it settles. */
class ElectionDuties<K extends string, S extends object, D extends Stepped<S> = Stepped<S>> {
  readonly #kind: Kind<K, S>;
  readonly #o: DutyOptions<D, KindEvent<K, S>>;
  // Each built duty, with its deadline read once.
  readonly #duties = new Map<string, { readonly seat: D; readonly deadline: bigint }>();
  // Elections whose duty is over, or that can never be read: never stepped again.
  readonly #settled = new Set<string>();
  // The last line logged per election, so a status or a failure that repeats
  // every step is reported once.
  readonly #last = new Map<string, string>();

  constructor(kind: Kind<K, S>, options: DutyOptions<D, KindEvent<K, S>>) {
    this.#kind = kind;
    this.#o = options;
  }

  /** Every duty built and not yet settled. */
  protected active(): D[] {
    return [...this.#duties.values()].map((d) => d.seat);
  }

  /**
   * One step of every unsettled election's duty, the elections side by
   * side, so one whose sources are slow delays no other's cutoff (T-52).
   * A failure no later step can get past is rethrown once every step ends.
   */
  async step(): Promise<void> {
    const unsettled = (await this.#o.seat.approvedStubs()).filter(
      (stubHash) => !this.#settled.has(hex(stubHash)),
    );
    const outcomes = await Promise.allSettled(unsettled.map((s) => this.#stepOne(s)));
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  }

  async #stepOne(stubHash: Uint8Array): Promise<void> {
    const name = hex(stubHash);
    // Read before the step, so a status settles the duty only by a time the
    // step itself had passed: the availability duty's `past-cutoff` at a wall
    // before `t_A` steps once more, and reports `unrecorded` if its record
    // never was.
    const wall = this.#o.clock();
    let duty = this.#duties.get(name);
    try {
      if (duty === undefined) {
        duty = await this.#build(stubHash, name, wall);
        if (duty === undefined) return;
      }
      if (this.#kind.noStepPast && wall > duty.deadline) return this.#settle(name);
      const status = await duty.seat.step();
      this.#report(name, status);
      if (this.#kind.settles(status, wall, duty.deadline)) this.#settle(name);
    } catch (e) {
      const final = FINAL.some((type) => e instanceof type);
      if (!final && !RETRIED.some((type) => e instanceof type)) throw e;
      this.#failed(name, e as Error);
      if (final) this.#settle(name);
    }
  }

  /**
   * Steps every `intervalMs` until `signal` aborts. A step that throws
   * anything but a failure a later step can get past ends the loop.
   */
  async run(signal: AbortSignal, intervalMs: number): Promise<void> {
    while (!signal.aborted) {
      await this.step();
      await sleep(intervalMs, undefined, { signal }).catch((e: unknown) => {
        if (!signal.aborted) throw e;
      });
    }
  }

  async #build(
    stubHash: Uint8Array,
    name: string,
    wall: bigint,
  ): Promise<{ readonly seat: D; readonly deadline: bigint } | undefined> {
    const election = await this.#o.seat.approvedElection(stubHash);
    // Listed as approved, so its records exist; approvedElection throws if they don't.
    if (election === undefined) throw new Error(`trustee node: approval ${name} has no election`);
    // Not even set up past it: building reads the counted set's sources, and
    // a node restarted past `t_D` steps nothing.
    if (this.#kind.noStepPast && wall > this.#kind.deadline(election)) {
      this.#settle(name);
      this.#o.log({ event: `${this.#kind.name}-abandoned`, stubHash: name } as KindEvent<K, S>);
      return undefined;
    }
    let seat;
    try {
      seat = await this.#o.build(election);
    } catch (e) {
      // A duty set up past its deadline could send nothing that counts, so
      // an election never registered stops costing reads every poll.
      if (wall > this.#kind.deadline(election) && RETRIED.some((type) => e instanceof type)) {
        this.#settle(name);
        this.#o.log({ event: `${this.#kind.name}-abandoned`, stubHash: name } as KindEvent<K, S>);
        return undefined;
      }
      if (!FINAL.some((type) => e instanceof type)) throw e;
      this.#failed(name, e as Error);
      this.#settle(name);
      return undefined;
    }
    const duty = { seat, deadline: seat.deadline };
    this.#duties.set(name, duty);
    return duty;
  }

  #settle(name: string): void {
    this.#settled.add(name);
    this.#duties.delete(name);
    this.#last.delete(name);
  }

  #report(name: string, status: S): void {
    const fields = Object.fromEntries(
      Object.entries(status).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
    );
    this.#once(name, { event: this.#kind.name, stubHash: name, ...fields } as KindEvent<K, S>);
  }

  #failed(name: string, e: Error): void {
    this.#once(name, {
      event: `${this.#kind.name}-error`,
      stubHash: name,
      error: e.name,
      message: e.message,
    } as KindEvent<K, S>);
  }

  #once(name: string, event: KindEvent<K, S>): void {
    const line = JSON.stringify(event);
    if (this.#last.get(name) === line) return;
    this.#last.set(name, line);
    this.#o.log(event);
  }
}

// An availability duty is over once its attestation is recorded, on an
// alarm no step can clear, or past its cutoff with nothing left that can
// count, once its deadline is behind the step.
const availabilitySettles = (status: AvailabilityStatus, wall: bigint, deadline: bigint) => {
  switch (status.state) {
    case "recorded":
    case "unrecorded":
    case "foreign-record":
      return true;
    case "past-cutoff":
      return wall > deadline;
    default:
      return false;
  }
};

/**
 * The ballot-extent availability duty of every election the seat approved:
 * each one's `AvailabilitySeat`, built once its L1 reader can be set up and
 * stepped until its attestation is recorded, an alarm no step can clear, or
 * `c_I` has passed with nothing left that can count, once `t_A` is behind
 * the node.
 */
export class AvailabilityDuties extends ElectionDuties<"availability", AvailabilityStatus> {
  constructor(options: DutyOptions<Duty, AvailabilityEvent>) {
    super(
      {
        name: "availability",
        // `t_A`, as `AvailabilitySeat.deadline` computes it.
        deadline: (e) =>
          availabilityWindows(e.closesAt, e.l1InclusionBound, 0n, RELEASE_WINDOWS).ballotDeadline,
        settles: availabilitySettles,
      },
      options,
    );
  }
}

/**
 * The counted-extent availability duty of every election the seat approved
 * (docs/spec/availability.md, What a seat does, 2, at point 2): each one's
 * `AvailabilitySeat` over the deployment's pinned anchoring clock, settled
 * as the ballot extent's is, by `c_A'` and `t_A'`. The tally rests on it:
 * no summed share is sent before `t_A' + R` and a quorum of these
 * attestations (T-54, T-14).
 */
export class CountedAvailabilityDuties extends ElectionDuties<
  "counted-availability",
  AvailabilityStatus
> {
  constructor(options: DutyOptions<Duty, CountedAvailabilityEvent>, clock: DeadlineClock) {
    super(
      {
        name: "counted-availability",
        // `t_A'`, as `AvailabilitySeat.deadline` computes it under `counted`.
        deadline: (e) =>
          availabilityWindows(e.closesAt, e.l1InclusionBound, countedDue(e, clock), RELEASE_WINDOWS)
            .countedDeadline,
        settles: availabilitySettles,
      },
      options,
    );
  }
}

/**
 * The receipt duty of every election the seat approved: each one's
 * `ReceiptDuty`, stepped from before `c_I` (it decides nothing until then)
 * until every batch the decision owes is recorded, or `t_D` has passed with
 * some never recorded (`unrecorded`, an alarm). A view no retry can read
 * (`ViewError`, `L1AnchorError`) gives the election up, reported: the seat
 * then sends nothing through the contract path for it, and its operator
 * must look (T-25, T-53).
 */
export class ReceiptDuties extends ElectionDuties<"receipts", ReceiptDutyStatus> {
  constructor(options: DutyOptions<ReceiptStep, ReceiptEvent>) {
    super(
      {
        name: "receipts",
        // `t_D`, as `ReceiptDuty.deadline` computes it.
        deadline: (e) => deliveryDeadlines(e.closesAt, e.l1InclusionBound).delivery,
        settles: (status) => status.state === "recorded" || status.state === "unrecorded",
      },
      options,
    );
  }
}

/**
 * The complaint duty of every election the seat approved: each one's
 * `ComplaintDuty`, stepped from before `c_I` (it decides nothing until
 * `t_D + W_C`) until every batch it owes is recorded, or `t_K` has passed
 * with some never recorded (`unrecorded`, an alarm). A ballot source or view
 * no retry can read gives the election up, reported, as the receipt duty's
 * does (T-29, T-53).
 */
export class ComplaintDuties extends ElectionDuties<"complaints", ComplaintDutyStatus> {
  constructor(options: DutyOptions<ComplaintStep, ComplaintEvent>) {
    super(
      {
        name: "complaints",
        // `t_K`, as `ComplaintDuty.deadline` computes it.
        deadline: (e) => deliveryDeadlines(e.closesAt, e.l1InclusionBound).complaint,
        settles: (status) => status.state === "recorded" || status.state === "unrecorded",
      },
      options,
    );
  }
}

/**
 * `t_D` (docs/spec/tally.md, Destruction): the later of the tally window's
 * end, `t_S + TALLY_WINDOW`, and the anchoring deadline of segment `s_T − 1`,
 * `s_T` the period containing the window's end, under the pinned clock.
 * Throws `L1AnchorError` `outside-clock` for a close before its epoch.
 */
export function tallyDeadline(election: ApprovedElection, clock: DeadlineClock): bigint {
  const end = countedDue(election, clock) + BigInt(PARAMETERS.TALLY_WINDOW);
  const sT = tallySegment(clock, election.closesAt, election.l1InclusionBound);
  const anchored = clock.epoch + sT * clock.period + clock.deadline;
  return anchored > end ? anchored : end;
}

/**
 * The tally duty of every election the seat approved: each one's
 * `TallyDuty`, stepped from the approval (it reads nothing before the
 * summed-share rule allows) until the anchored board carries a passing
 * opening of every cell (docs/spec/tally.md, Destruction, When), the election is
 * unavailable, the seat refuses its counted set (for good: a refusal is the
 * operator's to look into, and stepping on could only sum over a set the
 * seat already refused once; T-54), or `t_D` has passed, when the seat may
 * combine nothing more (Destruction): no step begins past `t_D`, nor is a
 * duty set up, so a node restarted then signs and sends nothing. `t_D` is
 * read on the node's clock, not finalized L1's, which destruction will
 * need. `receive` hands a
 * summed-share message to every election's duty built and not settled;
 * each runs crypto's checks, and one of another election fails at its
 * context (T-39).
 */
export class TallyDuties extends ElectionDuties<"tally", TallyDutyStatus, TallyStep> {
  constructor(options: DutyOptions<TallyStep, TallyEvent>, clock: DeadlineClock) {
    super(
      {
        name: "tally",
        deadline: (e) => tallyDeadline(e, clock),
        noStepPast: true,
        settles: (status, wall, deadline) => {
          switch (status.state) {
            case "unavailable":
            case "refused":
              return true;
            case "tallying":
              return status.cells.every((c) => c.state === "published") || wall > deadline;
            default:
              return wall > deadline;
          }
        },
      },
      options,
    );
  }

  /** Hands a summed-share message to every election's duty; never throws for the message's sake. */
  async receive(message: Uint8Array): Promise<void> {
    for (const duty of this.active()) await duty.receive(message);
  }
}

/**
 * The end of the tally term in the seal's `W` (docs/spec/tally.md,
 * Destruction window): `t_D + DESTRUCTION_WINDOW`. No seal is derived from
 * a definition yet ([[election-definition]], The seal), and every seal is
 * at or after the period containing this, so a seat that sends its
 * openings until then sends them until the seal's tally term, whatever the
 * other windows add.
 */
export function openingsDeadline(election: ApprovedElection, clock: DeadlineClock): bigint {
  return tallyDeadline(election, clock) + BigInt(PARAMETERS.DESTRUCTION_WINDOW);
}

/**
 * The opening sender of every election the seat approved: each one's
 * `OpeningSender`, stepped from the approval (it sends nothing until the
 * tally duty has signed an opening) until the seat's own read of the
 * anchored board has every cell published, or `openingsDeadline` has
 * passed: openings boarded after the tally window still count until the
 * seal, so the seat keeps sending them past `t_D`, when the tally duty
 * itself has stopped (docs/spec/tally.md, Destruction, When; T-54). No
 * step begins past the deadline, nor is a sender set up.
 */
export class OpeningSends extends ElectionDuties<"openings", OpeningSenderStatus, OpeningStep> {
  constructor(options: DutyOptions<OpeningStep, OpeningEvent>, clock: DeadlineClock) {
    super(
      {
        name: "openings",
        deadline: (e) => openingsDeadline(e, clock),
        noStepPast: true,
        settles: (status, wall, deadline) => status.state === "complete" || wall > deadline,
      },
      options,
    );
  }
}
