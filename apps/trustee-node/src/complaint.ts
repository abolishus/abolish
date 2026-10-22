// A seat's complaint duty on the contract path (docs/spec/delivery.md, What
// a node owes in complaints): over the complaint scope decided once at `c_I`,
// the seat owes one complaint for each ballot hash in it whose contract-path
// posting for its seat, in time for the delivery deadline `t_D`, passes the
// public check and opens to shares that fail. It decides them once, from
// `t_D + W_C`, by when every posting submitted by `t_D` is in finalized L2
// history, signs them as share-complaint batches of at most
// `COMPLAINT_BATCH_MAX` entries and writes them once before anything is sent,
// so a crash, a restart or a later posting resends the stored bytes and the
// seat never reveals another DH value. Each batch is sent through the board's
// `submitComplaintBatch`, forced through L1 when the sequencer doesn't take
// it, until the seat's own L2 node shows it in finalized history, and by
// `c_K = t_K − F` at the latest, so a deposit lands by the end of the
// complaint window `t_K` (T-29, T-52, T-54).
//
// The scope comes from the ballots the seat held at `c_I`, never from
// postings, which anyone holding a member's proof can make up against ballots
// never cast: a posting outside the scope costs the seat nothing but its
// decoding (T-52). A seat sends every complaint it owes, even one whose
// proven complaint is anchored already, which the spec lets it skip: the
// contract takes the batch beside it, at the cost of the seat's gas only.
import {
  ballotHash,
  ballotHashV3,
  type BallotRecord,
  type BallotRecordV3,
  batchShareComplaints,
  bytesVar,
  COMPLAINT_BATCH_MAX,
  type ComplaintEntry,
  decode,
  decodeBallot,
  DecodeError,
  decodeSharePosting,
  deliveryDeadlines,
  encode,
  encodeShareComplaintBatch,
  list,
  openShares,
  type Posting,
  checkPosting,
  proveComplaint,
  SHARE_CIPHERTEXT,
} from "@abolishus/crypto";
import type { ApprovedElection } from "./ceremony.ts";
import { decideObligation, type ObligationOptions } from "./obligation.ts";
import { RELEASE_WINDOWS } from "./stub.ts";

/** A share posting the board contract recorded, with its submission time. */
export interface RecordedPosting {
  /** The share-posting record (`0x000d`), as the contract event carries it. */
  readonly record: Uint8Array;
  /** Its submission time: the L2 block's timestamp, by which its window is judged. */
  readonly submittedAt: bigint;
}

/** The board contract's postings and complaint-batch call, as the deployment reaches them. */
export interface ComplaintPath {
  /**
   * Every share posting the board contract recorded for the definition and
   * seat, as the seat's own L2 node derives it from finalized L1, never a
   * sequencer's soft confirmation, with the timestamp of that history's last
   * block.
   */
  postings(
    definitionHash: Uint8Array,
    seat: number,
  ): Promise<{ readonly finalizedAt: bigint; readonly postings: readonly RecordedPosting[] }>;
  /**
   * Submits a share-complaint batch to the board contract, through the
   * sequencer or forced through L1 when the sequencer doesn't take it in
   * time, and by `cutoff` (`c_K`) whatever it did; resolves once it is sent,
   * not once it is recorded. Throws if it can't be sent now.
   */
  send(record: Uint8Array, cutoff: bigint): Promise<void>;
  /** Every share-complaint batch the board contract recorded for the definition and seat, as `postings` reads. */
  recorded(definitionHash: Uint8Array, seat: number): Promise<readonly Uint8Array[]>;
}

export interface ComplaintDutyOptions extends ObligationOptions {
  readonly election: ApprovedElection;
  readonly contract: ComplaintPath;
  /**
   * The ballot records (version 1) the seat holds from the anchored board or
   * the contract's records for the election. Each is matched to the scope by
   * the ballot hash recomputed from it, never by what the source says, so
   * the source can withhold a ballot but never swap one.
   */
  readonly ballots: (election: ApprovedElection) => Promise<readonly Uint8Array[]>;
}

/** Where the complaint duty stands after a step. */
export type ComplaintDutyStatus =
  /** Intake is open until `until` (`c_I`): nothing is decided yet. */
  | { readonly state: "open"; readonly until: bigint }
  /** Finalized L1 doesn't reach past `closes_at` yet, so the obligation waits. */
  | { readonly state: "waiting-l1" }
  /**
   * The node's clock, or the finalized L2 history it reads postings from,
   * hasn't passed `until` (`t_D + W_C`): a posting in time may not be
   * recorded yet, so the complaints wait.
   */
  | { readonly state: "waiting-postings"; readonly until: bigint }
  /**
   * `missing` ballots of the scope have a posting for the seat but no
   * record from the seat's sources, so their postings can't be checked yet.
   * Nothing is decided until they come, or until `until` (`c_K − R`): then
   * the seat decides without them, giving up only theirs, rather than let
   * one withheld ballot cost every complaint it owes. An alarm for the
   * node's operator.
   */
  | { readonly state: "waiting-ballots"; readonly missing: number; readonly until: bigint }
  /** `batches` were sent (or resent) this step; `recorded` of `total` are recorded. */
  | {
      readonly state: "sent";
      readonly batches: number;
      readonly recorded: number;
      readonly total: number;
    }
  /** Every batch is recorded, or the seat owes no complaint: the duty is done. */
  | { readonly state: "recorded"; readonly total: number }
  /**
   * `t_K` has passed and `missing` of the stored batches were never
   * recorded: they can't exclude anything any more, so the seat stops
   * sending them. An alarm for the node's operator.
   */
  | { readonly state: "unrecorded"; readonly missing: number; readonly total: number };

// The node's own storage, not protocol bytes: the encoded batches, each at
// most `104 + 128 · COMPLAINT_BATCH_MAX` bytes.
const BATCHES = list(bytesVar(104 + 128 * COMPLAINT_BATCH_MAX), 2 ** 32 - 1);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The complaint duty of one seat for one election it approved. `step` is
 * idempotent: the node calls it on a schedule until it returns `recorded`
 * or `unrecorded`.
 */
export class ComplaintDuty {
  readonly #o: ComplaintDutyOptions;

  constructor(options: ComplaintDutyOptions) {
    this.#o = options;
  }

  /** `t_K`: a contract-path complaint excludes its ballot only if submitted by then. */
  get deadline(): bigint {
    const { closesAt, l1InclusionBound } = this.#o.election;
    return deliveryDeadlines(closesAt, l1InclusionBound).complaint;
  }

  /** `c_K = t_K − F`: the last moment a complaint is sure to land in time, even forced through L1. */
  get cutoff(): bigint {
    return this.deadline - RELEASE_WINDOWS.forcedInclusion;
  }

  /** `t_D + W_C`: by then every posting submitted by `t_D` is in an L2 block. */
  get postingsRecorded(): bigint {
    const { closesAt, l1InclusionBound } = this.#o.election;
    return (
      deliveryDeadlines(closesAt, l1InclusionBound).delivery + RELEASE_WINDOWS.contractEventWindow
    );
  }

  async step(): Promise<ComplaintDutyStatus> {
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
    // Past `t_K` no submission excludes anything, so nothing is sent again.
    if (o.now() > this.deadline) return { state: "unrecorded", missing: missing.length, total };
    for (const batch of missing) await o.contract.send(batch, this.cutoff);
    return { state: "sent", batches: missing.length, recorded: total - missing.length, total };
  }

  /**
   * The stored batches, or, the first time every posting in time can be
   * read, the batches signed over the complaints the scope owes and stored
   * before any is sent.
   */
  async #batches(): Promise<Uint8Array[] | ComplaintDutyStatus> {
    const o = this.#o;
    const { election } = o;
    const key = `deliveries/${hex(election.stubHash)}/complaints`;
    const stored = await o.store.get(key);
    if (stored !== undefined) return [...decode(BATCHES, stored)];
    const status = await decideObligation(o, election);
    if (status.state !== "decided") return status;
    const complaints = status.complaints.length === 0 ? [] : await this.#owed(status.complaints);
    if (!Array.isArray(complaints)) return complaints;
    const batches = batchShareComplaints(
      election.signingSecret,
      election.definitionHash,
      election.index,
      complaints,
    ).map(encodeShareComplaintBatch);
    // Written once: a concurrent or earlier step's batches win, and are what's sent.
    return [...decode(BATCHES, (await o.store.putOnce(key, encode(BATCHES, batches))).value)];
  }

  /** The complaints the scope owes, once every posting in time is in the seat's finalized L2 history. */
  async #owed(scope: readonly Uint8Array[]): Promise<ComplaintEntry[] | ComplaintDutyStatus> {
    const o = this.#o;
    const { election } = o;
    const until = this.postingsRecorded;
    if (o.now() <= until) return { state: "waiting-postings", until };
    const read = await o.contract.postings(election.definitionHash, election.index);
    if (read.finalizedAt <= until) return { state: "waiting-postings", until };
    const deliveryDeadline = deliveryDeadlines(
      election.closesAt,
      election.l1InclusionBound,
    ).delivery;
    // A ballot this seat receipted passed its own intake: a posting that
    // passes the public check carries the same `ct_i`, and an `m_i` that
    // re-encapsulates to the same secret, so its shares open again and no
    // complaint about it can be proven (docs/spec/delivery.md, Notes).
    const receipted = new Set(await o.store.list(`intake/${hex(election.stubHash)}`));
    const inScope = new Set(scope.map(hex).filter((h) => !receipted.has(h)));
    const postings = new Map<string, Posting[]>();
    for (const p of read.postings) {
      // Ignored: it delivers and excludes nothing (Windows).
      if (p.submittedAt > deliveryDeadline) continue;
      let r;
      try {
        r = decodeSharePosting(p.record, 1);
      } catch (e) {
        // The event check decoded it, so only a node's error gets here; it
        // carries nothing this seat could complain about.
        if (e instanceof DecodeError) continue;
        throw e;
      }
      const ballot = hex(r.ballot_hash);
      if (
        !equal(r.definition_hash, election.definitionHash) ||
        r.seat !== election.index ||
        !inScope.has(ballot)
      )
        continue;
      const posting = { ciphertext: encode(SHARE_CIPHERTEXT, r.ciphertext), m: r.m };
      const held = postings.get(ballot);
      if (held === undefined) postings.set(ballot, [posting]);
      else held.push(posting);
    }
    if (postings.size === 0) return [];
    const votes = new Map<string, Vote>();
    for (const bytes of await o.ballots(election)) {
      const held = heldVote(bytes, election.definitionHash);
      if (held !== undefined && postings.has(held.hash)) votes.set(held.hash, held.vote);
    }
    const missing = [...postings.keys()].filter((h) => !votes.has(h)).length;
    // Anyone can post against a scope ballot whose record a source withholds,
    // so the wait ends with `R` left to send what the rest owe (T-29, T-54).
    const giveUp = this.cutoff - RELEASE_WINDOWS.margin;
    if (missing > 0 && o.now() < giveUp)
      return { state: "waiting-ballots", missing, until: giveUp };
    const ctx = { definitionHash: election.definitionHash };
    const pair = election.kemKeyPair;
    const owed: ComplaintEntry[] = [];
    for (const [h, posted] of postings) {
      const vote = votes.get(h);
      if (vote === undefined) continue;
      // Every passing posting of a ballot and seat carries the same `ct_i`
      // and `m_i`, so the first one decides (docs/spec/delivery.md, Delivery
      // check); a failing one is ignored and proves nothing.
      const passing = posted.find(
        (p) => checkPosting(ctx, election.index, pair.publicKey, vote.vss, vote.share_hashes, p).ok,
      );
      if (passing === undefined) continue;
      const opened = openShares(ctx, election.index, pair.secretKey, vote.vss, passing.ciphertext);
      // The DH value is revealed only for shares that fail decryption or the
      // share check, never for shares that open (share-encryption.md,
      // Complaints; T-15).
      if (opened.ok || (opened.code !== "share-decrypt" && opened.code !== "share-check")) continue;
      // `proveComplaint` runs both checks again: the duty's own, above, keep a
      // posting whose shares open from ever reaching it.
      owed.push({
        ballot_hash: Uint8Array.from(Buffer.from(h, "hex")),
        proof: proveComplaint(ctx, election.index, pair, vote.vss, vote.share_hashes, passing),
      });
    }
    return owed;
  }
}

// Version 3's vote shares, proves and opens over its flat options as version
// 1's does, so the posting check and the complaint read either the same way
// (docs/spec/share-encryption.md, Ballot versions 2 and 3).
type Vote = BallotRecord["committed_vote"] | BallotRecordV3["committed_vote"];

/**
 * A ballot record's vote and its ballot hash, recomputed, under the
 * definition: ballot version 1 (definition version 1) by its tier, version 3
 * (definition version 5) by its cell. Undefined for a record that doesn't
 * decode under the version its version byte names, or names another
 * definition. T-38: the hash is recomputed, so a source can't pass another
 * ballot's vote under a hash in the scope; it binds the ballot version, so a
 * record read under a layout other than the one the scope's ballot was
 * admitted under never matches it (T-34).
 */
function heldVote(
  bytes: Uint8Array,
  definitionHash: Uint8Array,
): { readonly hash: string; readonly vote: Vote } | undefined {
  try {
    if (bytes[2] === 3) {
      const b = decodeBallot(bytes, 3);
      if (!equal(b.definition_hash, definitionHash)) return undefined;
      const ctx = { definitionHash, cell: b.cell, nullifier: b.nullifier };
      return { hash: hex(ballotHashV3(ctx, b.committed_vote)), vote: b.committed_vote };
    }
    const b = decodeBallot(bytes, 1);
    if (!equal(b.definition_hash, definitionHash)) return undefined;
    const ctx = { definitionHash, tier: b.tier, nullifier: b.nullifier };
    return { hash: hex(ballotHash(ctx, b.committed_vote)), vote: b.committed_vote };
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
}
