// A seat's contract-path obligation, decided once at the intake cutoff `c_I`
// (docs/spec/delivery.md, What a node owes): over the view it then holds (the
// ballots it receipted, less those it can show absent, and every copy it
// holds from the anchored board or the contract's records), the receipts it
// owes and its complaint scope, from @abolishus/crypto's `owedReceipts` and
// `complaintScope`. The decision is written once, before anything is sent
// from it, and every later call returns the written one: deciding again as
// the view changed would make the obligation the union of every decision,
// which an operator releasing data at chosen times could grow without bound
// (T-52, T-54, T-25).
import {
  bytesFixed,
  complaintScope,
  decode,
  encode,
  type FinalizedL1,
  intakeCutoff,
  l1RefMin,
  list,
  owedReceipts,
  struct,
  type ViewBallot,
} from "@abolishus/crypto";
import type { ApprovedElection } from "./ceremony.ts";
import { heldIntake } from "./intake.ts";
import type { SeatStore } from "./store.ts";
import { RELEASE_WINDOWS } from "./stub.ts";

/** What the seat reads besides its own intake, through sources it chose itself. */
export interface ObligationView {
  /** Finalized L1, never a server's claim, with every block from `low` to `head`. */
  readonly l1: FinalizedL1;
  /** Block 0 or a finalized block before `opens_at − L1_REF_MARGIN`: where `l1_ref_min` is searched from. */
  readonly low: bigint;
  /**
   * Every copy the seat holds from the anchored board or the contract's
   * records, each passed the admission checks (verifier 5.1 to 5.4), with
   * the entry the close rule judges.
   */
  readonly board: readonly ViewBallot[];
  /** `s_A` (`boardBallotSegment`), needed when `board` has a copy. */
  readonly boardSegment?: bigint;
  /**
   * Ballot hashes of receipted ballots the seat shows absent: it holds every
   * timely checkpoint's data up to `s_A`, matching the anchored roots, none
   * carries the ballot, and the contract hasn't recorded it.
   */
  readonly absent: readonly Uint8Array[];
}

/** Where the decision stands. */
export type ObligationStatus =
  /** Intake is open until `until` (`c_I`, by the node's clock): nothing is decided before it closes. */
  | { readonly state: "open"; readonly until: bigint }
  /** Finalized L1 doesn't reach past `closes_at` yet, so some reference could still be pending. */
  | { readonly state: "waiting-l1" }
  | ({ readonly state: "decided" } & Obligation);

/** What the seat owes for the election, sorted by ballot hash. */
export interface Obligation {
  /** Ballot hashes whose receipts it sends through the contract path by `c_D`. */
  readonly receipts: readonly Uint8Array[];
  /** Its complaint scope: ballot hashes whose failing postings it owes complaints about by `c_K`. */
  readonly complaints: readonly Uint8Array[];
  /**
   * Every ballot hash of the view it decided over. The selection over them
   * put each one a complaint can matter for into the scope, so the
   * complaints it makes outside the scope skip them (`ComplaintDuty`).
   */
  readonly viewed: readonly Uint8Array[];
}

export interface ObligationOptions {
  readonly store: SeatStore;
  /** Read only when the seat decides, so after `c_I` and only until the decision is written. */
  readonly view: (election: ApprovedElection) => Promise<ObligationView>;
  /** The node's clock, in Unix seconds: intake closes at `c_I` by the same clock. */
  readonly now: () => bigint;
}

const HASH = bytesFixed(32);
// The node's own storage, not protocol bytes. The bound is the codec's
// largest; what a seat may owe, `2M`, is checked before the write.
const DECIDED = struct([
  ["receipts", list(HASH, 2 ** 32 - 1)],
  ["complaints", list(HASH, 2 ** 32 - 1)],
  ["viewed", list(HASH, 2 ** 32 - 1)],
] as const);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Decides the seat's obligation for `election` once, from `c_I` on, or
 * returns the decision it wrote earlier. Throws when the view breaks a rule
 * no honest source breaks (a board copy of a ballot shown absent) or the
 * decision exceeds `2M`, which only a copy that skipped the admission checks
 * could cause: an alarm for the node's operator, never a decision.
 */
export async function decideObligation(
  options: ObligationOptions,
  election: ApprovedElection,
): Promise<ObligationStatus> {
  // A rolling election has no `M`: it commits roots whatever its size, which
  // no seat sends yet ([[P1-12f]] part 3c), and stub check 4 refuses it.
  if (election.rolling === true)
    throw new Error("trustee node: a rolling election's obligation is its roots, not batches");
  const key = `obligations/${hex(election.stubHash)}`;
  const written = await options.store.get(key);
  if (written !== undefined) return decided(written);
  const cutoff = intakeCutoff(election.closesAt, election.l1InclusionBound, RELEASE_WINDOWS);
  // Intake re-checks the clock after its records are durable, so every
  // receipt it gave was written before this reads the store (T-54).
  if (options.now() < cutoff) return { state: "open", until: cutoff };
  const view = await options.view(election);
  const { l1 } = view;
  // A block after the close finalized, so no reference is pending and every
  // node reaches the same verdicts (docs/spec/revoting.md, Admission).
  if (l1.block(l1.head).timestamp <= election.closesAt) return { state: "waiting-l1" };
  const min = l1RefMin(l1, view.low, election.opensAt);
  if (min === undefined) return { state: "waiting-l1" };
  const held = await heldIntake(options.store, election.stubHash, election.definitionHash);
  const absent = new Set(view.absent.map(hex));
  for (const b of view.board)
    if (absent.has(hex(b.ballotHash)))
      throw new Error("trustee node: a ballot shown absent is held from the board");
  // A receipt stays owed-able after its copy is shown absent: the selection
  // may pick the same ballot hash cast again (What a node owes).
  const ballots = [...held.copies.filter((c) => !absent.has(hex(c.ballotHash))), ...view.board];
  const window = {
    l1RefMin: min,
    closesAt: election.closesAt,
    opensAt: election.opensAt,
    ...(view.boardSegment === undefined ? {} : { boardSegment: view.boardSegment }),
  };
  const obligation = {
    receipts: owedReceipts(ballots, held.receipts, l1, window),
    complaints: complaintScope(ballots, l1, window),
    viewed: [...new Map(ballots.map((b) => [hex(b.ballotHash), b.ballotHash])).values()].sort(
      (a, b) => (hex(a) < hex(b) ? -1 : 1),
    ),
  };
  // ADR 0002, Decision, 2026-10-12: membership-checked intake bounds both at
  // two per member of each tier, whatever anyone delivers or withholds.
  const bound = 2n * election.members;
  if (BigInt(obligation.receipts.length) > bound || BigInt(obligation.complaints.length) > bound)
    throw new Error("trustee node: the obligation is over its bound of 2M");
  // Written once: a concurrent or earlier decision wins, and is what's returned.
  return decided((await options.store.putOnce(key, encode(DECIDED, obligation))).value);
}

function decided(bytes: Uint8Array): ObligationStatus {
  const { receipts, complaints, viewed } = decode(DECIDED, bytes);
  return { state: "decided", receipts, complaints, viewed };
}
