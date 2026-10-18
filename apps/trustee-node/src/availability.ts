// A seat's availability duty at the ballot extent (docs/spec/availability.md,
// What a seat does; 0029-board-data-availability, option D): once the
// ballot-extent checkpoint `C_A` is fixed on finalized L1, read the board
// through it by the CIDs its counted checkpoints name, from any sources, and
// attest it if the copy passes the board checks; complain, naming the first
// object it couldn't read, if it can't by the intake cutoff `c_I`. Each
// record is written once before it is sent, so the seat signs at most one
// attestation and one complaint per point, and every retry resends the
// stored bytes until the board contract has recorded them (T-24, T-25,
// T-53, T-54, T-71).
//
// The counted extent (point 2) needs `t_S`, which needs the contract-event
// windows the verifier doesn't read yet (P1-18), and its roots need the leaf
// objects the node doesn't fetch yet (P1-12f part 3c): it is a later part's.
import {
  type Anchor,
  type AnchorClock,
  AVAILABILITY_POINTS,
  type AsyncBlockSource,
  availabilityWindows,
  BoardError,
  type BoardErrorCode,
  type BoardEntryVersion,
  type Checkpoint,
  checkpointHash,
  countedCheckpoints,
  encodeAvailabilityAttestation,
  encodeAvailabilityComplaint,
  readBoardCopy,
  SEAT_PANELS,
  signAvailabilityAttestation,
  signAvailabilityComplaint,
  verifyBoard,
} from "@abolishus/crypto";
import type { ApprovedElection } from "./ceremony.ts";
import type { SeatStore } from "./store.ts";
import { RELEASE_WINDOWS } from "./stub.ts";

export type AvailabilityKind = "attestation" | "complaint";

/** What the seat reads from finalized L1, through sources it chose itself. */
export interface FinalizedBoardAnchors {
  /**
   * Every anchor for the election from the pinned anchor contract, the
   * anchoring clock, and `now`, the time of the finalized L1 block they were
   * read at (docs/spec/board.md, Board checks).
   */
  read(electionId: Uint8Array): Promise<{
    readonly anchors: readonly Anchor[];
    readonly clock: AnchorClock;
    readonly now: bigint;
  }>;
}

/** The board contract's availability call, as the deployment reaches it (docs/spec/availability.md, Contract path). */
export interface ContractPath {
  /**
   * Submits a record to the board contract, through the sequencer or forced
   * through L1 when the sequencer doesn't take it in time, and by `cutoff`
   * (the point's, `c_I`) whatever it did; resolves once it is sent, not once
   * it is recorded. Throws if it can't be sent now.
   */
  send(record: Uint8Array, cutoff: bigint): Promise<void>;
  /**
   * The record of this kind the board contract recorded for the seat and
   * point, as the seat's own L2 node derives it from finalized L1, never a
   * sequencer's soft confirmation; undefined if there is none yet.
   */
  recorded(
    kind: AvailabilityKind,
    definitionHash: Uint8Array,
    panel: number,
    seat: number,
    point: number,
  ): Promise<Uint8Array | undefined>;
}

export interface AvailabilityOptions {
  readonly store: SeatStore;
  readonly election: ApprovedElection;
  /** The board-entry version the election's profile pins. */
  readonly boardVersion: BoardEntryVersion;
  readonly l1: FinalizedBoardAnchors;
  /** Any sources of the board's blocks: IPFS, the archive, the operator, other seats. Untrusted. */
  readonly blocks: AsyncBlockSource;
  readonly contract: ContractPath;
  /** The node's wall clock, in seconds. */
  readonly clock: () => bigint;
  /** Seconds before `c_I` at which a seat that doesn't hold the extent complains, so the complaint is sent by `c_I`. */
  readonly sendMargin: bigint;
  /** The most the seat reads of the board's segment objects (readBoardCopy's `maxBytes`). */
  readonly maxBytes: number;
}

/** Where the ballot-extent duty stands after a step. */
export type AvailabilityStatus =
  /** `C_A` isn't fixed on finalized L1 before `until` (finalized L1 time). */
  | { readonly state: "waiting"; readonly until: bigint }
  /** No counted checkpoint is at or before `s_A`: no record can name one. */
  | { readonly state: "no-checkpoint" }
  /** The board fails a check no attestation can settle; the election fails at 4.2. */
  | { readonly state: "board-failed"; readonly code: BoardErrorCode }
  /** The copy doesn't reach `C_A` yet, and it isn't time to complain. */
  | { readonly state: "fetching" }
  /** The seat's record was sent (or resent), and isn't recorded yet. */
  | { readonly state: "sent"; readonly kind: AvailabilityKind }
  /** The seat's complaint is recorded; it keeps fetching, to attest if it can by `c_I`. */
  | { readonly state: "complained" }
  /** The seat's attestation is recorded: the duty is done. */
  | { readonly state: "recorded" }
  /** `c_I` has passed with no attestation; a complaint, if the seat signed one, was resent. */
  | { readonly state: "past-cutoff"; readonly complained: boolean }
  /**
   * `t_A` has passed and the contract never recorded the seat's stored
   * record: it can't count, so the seat stops sending it. An alarm for the
   * operator of the node (a refused call, a censored path it couldn't force).
   */
  | { readonly state: "unrecorded"; readonly kind: AvailabilityKind }
  /**
   * The contract recorded another record of this kind for the seat's slot:
   * its per-election key signed bytes this node didn't store (a key leak, or
   * a store rolled back). An alarm, never a step the node retries past.
   */
  | { readonly state: "foreign-record"; readonly kind: AvailabilityKind };

const POINT = AVAILABILITY_POINTS.ballotExtent;
const PANEL = SEAT_PANELS.default;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// Failures of the board checks that say this copy, from these sources, isn't
// the anchored board through `C_A`: a reason to keep fetching, and to name
// the run in a complaint, never a verdict (docs/spec/board.md, Board checks).
const NOT_HELD: ReadonlySet<BoardErrorCode> = new Set<BoardErrorCode>([
  "checkpoint-missing",
  "copy-mismatch",
]);
// Step 6 judges segments and the seal past what the seat restricts its
// anchors to, never the extent's availability.
const PAST_EXTENT: ReadonlySet<BoardErrorCode> = new Set<BoardErrorCode>([
  "unanchored",
  "unsealed",
]);

/**
 * The ballot-extent duty of one seat of the default panel for one election
 * it approved. `step` is idempotent: the node calls it on a schedule until it
 * returns `recorded`, `unrecorded` or `foreign-record`, or `past-cutoff`
 * once `t_A` is behind it.
 */
export class AvailabilitySeat {
  readonly #o: AvailabilityOptions;
  readonly #prefix: string;

  constructor(options: AvailabilityOptions) {
    if (typeof options.sendMargin !== "bigint" || options.sendMargin < 0n)
      throw new RangeError("availability: sendMargin must be a bigint ≥ 0");
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
      throw new RangeError("availability: maxBytes must be a positive integer");
    this.#o = options;
    this.#prefix = `availability/${hex(options.election.definitionHash)}/ballot`;
  }

  /** `c_I`: the seat sends its ballot-extent record by then (docs/spec/availability.md, Windows). */
  get cutoff(): bigint {
    const { closesAt, l1InclusionBound } = this.#o.election;
    // `countedDue` doesn't enter the ballot extent's moments.
    return availabilityWindows(closesAt, l1InclusionBound, 0n, RELEASE_WINDOWS).ballotCutoff;
  }

  /** `t_A`: a ballot-extent record counts only if submitted by then. */
  get deadline(): bigint {
    const { closesAt, l1InclusionBound } = this.#o.election;
    return availabilityWindows(closesAt, l1InclusionBound, 0n, RELEASE_WINDOWS).ballotDeadline;
  }

  async step(): Promise<AvailabilityStatus> {
    const o = this.#o;
    const cutoff = this.cutoff;
    const wall = o.clock();
    const stored = await o.store.get(`${this.#prefix}/attestation`);
    if (stored !== undefined) return this.#deliver("attestation", stored, wall);
    // A record signed after `c_I` may not be in time for `t_A`, and the
    // seat's view at `c_I` is what it decides what it owes by (docs/spec/
    // availability.md, The ballot extent and what a node owes).
    if (wall > cutoff) {
      const complaint = await o.store.get(`${this.#prefix}/complaint`);
      if (complaint === undefined) return { state: "past-cutoff", complained: false };
      const delivered = await this.#deliver("complaint", complaint, wall);
      return delivered.state === "foreign-record" || delivered.state === "unrecorded"
        ? delivered
        : { state: "past-cutoff", complained: true };
    }
    const { anchors, clock, now } = await o.l1.read(o.election.electionId);
    const extent = this.#extent(anchors, clock, now);
    if ("state" in extent) return extent;
    const held = await this.#held(extent.through, clock, now);
    if (held === true) {
      const record = encodeAvailabilityAttestation(
        signAvailabilityAttestation(o.election.signingSecret, {
          definition_hash: o.election.definitionHash,
          panel: PANEL,
          seat: o.election.index,
          point: POINT,
          checkpoint_hash: checkpointHash(extent.checkpoint),
          roots: [],
        }),
      );
      // Stored before it is sent, so a crash or a retry resends these bytes
      // and the seat never signs a second attestation of the point.
      const kept = await o.store.putOnce(`${this.#prefix}/attestation`, record);
      return this.#deliver("attestation", kept.value, wall);
    }
    if ("state" in held) return held;
    if (wall < cutoff - o.sendMargin) return { state: "fetching" };
    const complaint =
      (await o.store.get(`${this.#prefix}/complaint`)) ??
      (
        await o.store.putOnce(
          `${this.#prefix}/complaint`,
          encodeAvailabilityComplaint(
            signAvailabilityComplaint(o.election.signingSecret, {
              definition_hash: o.election.definitionHash,
              panel: PANEL,
              seat: o.election.index,
              point: POINT,
              checkpoint_hash: checkpointHash(extent.checkpoint),
              cid: held.cid,
            }),
          ),
        )
      ).value;
    return this.#deliver("complaint", complaint, wall);
  }

  /**
   * `C_A` and the anchors through it, once it is fixed: the counted
   * checkpoint with the largest segment at or before `s_A = period(closes_at)
   * + 1`, fixed once `s_A`'s anchoring deadline has passed on finalized L1,
   * since no anchor for a segment at or before it counts after that
   * (docs/spec/availability.md, Terms).
   */
  #extent(
    anchors: readonly Anchor[],
    clock: AnchorClock,
    now: bigint,
  ): AvailabilityStatus | { readonly checkpoint: Checkpoint; readonly through: Anchor[] } {
    const { electionId, closesAt } = this.#o.election;
    // A board failing from L1 alone is reported first, as the verifier does.
    if (closesAt < clock.epoch) {
      try {
        countedCheckpoints(electionId, anchors, clock, now);
      } catch (e) {
        if (e instanceof BoardError) return { state: "board-failed", code: e.code };
        throw e;
      }
      return { state: "no-checkpoint" };
    }
    const sA = (closesAt - clock.epoch) / clock.period + 1n;
    const fixedAt = clock.epoch + (sA + 1n) * clock.period + clock.deadline;
    // L1 timestamps increase, so at a finalized time at or past the deadline
    // every block up to it is final.
    if (now < fixedAt) return { state: "waiting", until: fixedAt };
    let counted: Checkpoint[];
    try {
      counted = countedCheckpoints(electionId, anchors, clock, now);
    } catch (e) {
      if (e instanceof BoardError) return { state: "board-failed", code: e.code };
      throw e;
    }
    let cA: Checkpoint | undefined;
    for (const cp of counted)
      if (BigInt(cp.segment) <= sA && (cA === undefined || cp.segment > cA.segment)) cA = cp;
    if (cA === undefined) return { state: "no-checkpoint" };
    const last = cA.segment;
    return { checkpoint: cA, through: anchors.filter((a) => a.checkpoint.segment <= last) };
  }

  /**
   * Whether the seat's copy, read by the anchored CIDs, reaches `C_A` and
   * passes the board checks through it (steps 1 to 5, `checkpoint-cid`
   * among them); if it doesn't from these sources, the CID of the first run
   * it couldn't read, for a complaint.
   */
  async #held(
    through: readonly Anchor[],
    clock: AnchorClock,
    now: bigint,
  ): Promise<true | AvailabilityStatus | { readonly cid: Uint8Array }> {
    const o = this.#o;
    const runCid = (j: number) => (through[j] as Anchor).checkpoint.object_cid;
    const copy = await readBoardCopy(
      o.election.electionId,
      through,
      clock,
      now,
      o.blocks,
      o.maxBytes,
    );
    if (copy.stopped !== undefined) return { cid: runCid(copy.stopped.checkpoint) };
    try {
      verifyBoard(o.election.electionId, copy.encodedEntries, o.boardVersion, through, clock, now);
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      if (PAST_EXTENT.has(e.code)) return true;
      if (NOT_HELD.has(e.code) && "checkpoint" in e.at) return { cid: runCid(e.at.checkpoint) };
      return { state: "board-failed", code: e.code };
    }
    return true;
  }

  /**
   * Sends a stored record unless the contract has recorded it; a retry
   * resends the same bytes. Past `t_A` no submission can count, so a record
   * still unrecorded then is reported once and never sent again.
   */
  async #deliver(
    kind: AvailabilityKind,
    record: Uint8Array,
    wall: bigint,
  ): Promise<AvailabilityStatus> {
    const o = this.#o;
    const recorded = await o.contract.recorded(
      kind,
      o.election.definitionHash,
      PANEL,
      o.election.index,
      POINT,
    );
    if (recorded !== undefined) {
      if (!equal(recorded, record)) return { state: "foreign-record", kind };
      // A recorded complaint leaves the attestation still to do.
      return kind === "attestation" ? { state: "recorded" } : { state: "complained" };
    }
    if (wall > this.deadline) return { state: "unrecorded", kind };
    await o.contract.send(record, this.cutoff);
    return { state: "sent", kind };
  }
}
