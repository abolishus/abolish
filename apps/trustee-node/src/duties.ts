// The availability duty in a deployment: one `AvailabilitySeat` for each
// election the seat approved, built once its sources can be set up, stepped
// on a schedule until it settles (docs/spec/availability.md, What a seat
// does; T-24, T-54). This file only schedules: what the seat signs, stores
// and sends is `AvailabilitySeat`'s, so a crash, a restart or a step that
// fails midway resends the stored record and never signs another.
import { setTimeout as sleep } from "node:timers/promises";
import { L2Error, RpcError } from "@abolishus/node";
import { L1Error } from "@abolishus/verifier";
import type { AvailabilitySeat, AvailabilityStatus } from "./availability.ts";
import type { ApprovedElection, CeremonySeat } from "./ceremony.ts";
import { L1AnchorError } from "./l1.ts";
import { SendError } from "./send.ts";

/**
 * What the duties report: each election's status when it changes, and why a
 * step failed. Never a secret: stub hashes, states and error codes only, and
 * an RPC error's message, which names the method and never the node's URL.
 */
export type DutyEvent =
  | ({ readonly event: "availability"; readonly stubHash: string } & StatusFields)
  | {
      readonly event: "availability-error";
      readonly stubHash: string;
      readonly error: string;
      readonly message: string;
    };

// A status as logged: its times as decimal strings, so the line is JSON.
type Logged<S> = S extends unknown
  ? { readonly [K in keyof S]: S[K] extends bigint ? string : S[K] }
  : never;
type StatusFields = Logged<AvailabilityStatus>;

export interface DutyOptions {
  readonly seat: Pick<CeremonySeat, "approvedStubs" | "approvedElection">;
  /**
   * The election's duty over the deployment's sources. Throws
   * `L1AnchorError` when the election can never be read (the registry
   * registered another definition, the anchor's clock isn't the pinned
   * one), and an RPC or L2 error while it can't be read yet.
   */
  readonly build: (election: ApprovedElection) => Promise<Duty>;
  /** The node's wall clock, in seconds. */
  readonly clock: () => bigint;
  readonly log: (event: DutyEvent) => void;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Failures a later step can get past: a node that didn't answer or answered
// what can't be read or proven, an election not registered or not final
// yet, a record neither path took now. Anything else (a store that can't
// be read, a bug) ends the loop, as it ends the ceremony's: the node acts
// on nothing it can't read.
const RETRIED = [RpcError, L1Error, L2Error, SendError] as const;

/** What the schedule needs of an election's duty: `AvailabilitySeat`. */
export type Duty = Pick<AvailabilitySeat, "step" | "deadline">;

export class AvailabilityDuties {
  readonly #o: DutyOptions;
  readonly #duties = new Map<string, { readonly seat: Duty; readonly deadline: bigint }>();
  // Elections whose duty is over, or that can never be read: never stepped again.
  readonly #settled = new Set<string>();
  // The last line logged per election, so a status or a failure that repeats
  // every step is reported once.
  readonly #last = new Map<string, string>();

  constructor(options: DutyOptions) {
    this.#o = options;
  }

  /** One step of every unsettled election's duty, one election at a time. */
  async step(): Promise<void> {
    for (const stubHash of await this.#o.seat.approvedStubs()) {
      const name = hex(stubHash);
      if (this.#settled.has(name)) continue;
      try {
        const duty = this.#duties.get(name) ?? (await this.#build(stubHash, name));
        if (duty === undefined) continue;
        const status = await duty.seat.step();
        this.#report(name, status);
        if (settles(status, this.#o.clock(), duty.deadline)) this.#settle(name);
      } catch (e) {
        if (!RETRIED.some((type) => e instanceof type)) throw e;
        this.#failed(name, e as Error);
      }
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
  ): Promise<{ readonly seat: Duty; readonly deadline: bigint } | undefined> {
    const election = await this.#o.seat.approvedElection(stubHash);
    // Listed as approved, so its records exist; approvedElection throws if they don't.
    if (election === undefined) throw new Error(`trustee node: approval ${name} has no election`);
    let seat: Duty;
    try {
      seat = await this.#o.build(election);
    } catch (e) {
      if (!(e instanceof L1AnchorError)) throw e;
      // None of these changes on a retry: the seat can never attest this
      // board under this deployment, and the operator must look (T-53).
      this.#failed(name, e);
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

  #report(name: string, status: AvailabilityStatus): void {
    const fields = Object.fromEntries(
      Object.entries(status).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
    ) as StatusFields;
    this.#once(name, { event: "availability", stubHash: name, ...fields });
  }

  #failed(name: string, e: Error): void {
    this.#once(name, {
      event: "availability-error",
      stubHash: name,
      error: e.name,
      message: e.message,
    });
  }

  #once(name: string, event: DutyEvent): void {
    const line = JSON.stringify(event);
    if (this.#last.get(name) === line) return;
    this.#last.set(name, line);
    this.#o.log(event);
  }
}

/**
 * Whether the duty is over (AvailabilitySeat's `step`): the attestation is
 * recorded, an alarm no step can clear, or `c_I` has passed with nothing
 * left that can count, once `t_A` is behind the node.
 */
function settles(status: AvailabilityStatus, wall: bigint, deadline: bigint): boolean {
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
}
