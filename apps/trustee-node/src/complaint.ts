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
// never cast: a posting outside the scope costs the seat nothing it owes
// (T-52). A seat sends every complaint it owes, even one whose proven
// complaint is anchored already, which the spec lets it skip: the contract
// takes the batch beside it, at the cost of the seat's gas only.
//
// Once every batch it owes is recorded, and only then, the seat also
// complains, up to a budget, about failing postings in time outside its
// scope whose ballots it can't show absent, as the spec says it SHOULD:
// such a ballot can be counted only where the operator withheld it from the
// seat before `c_I` (delivery.md, Residuals), and a complaint is what keeps
// it from failing the seat's summed shares. Capacity counts none of them,
// so they never compete with an owed complaint for the forced path. The
// budget, not the postings, bounds what they cost in gas (T-52, T-54).
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
  /** The most complaints the seat makes outside its scope for the election: `OUTSIDE_COMPLAINTS` by default. */
  readonly outside?: number;
}

/**
 * The default budget of complaints outside the scope, per election: an
 * eighth of a full batch, about 570,000 gas at the forced path's figure for
 * a complaint inside one.
 */
export const OUTSIDE_COMPLAINTS = 64;

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
  /**
   * Every batch owed is recorded, and `batches` of the `total` outside the
   * scope were sent (or resent) this step; `recorded` of them are recorded.
   */
  | {
      readonly state: "outside-sent";
      readonly batches: number;
      readonly recorded: number;
      readonly total: number;
    }
  /**
   * Every batch owed is recorded, or the seat owes no complaint, and so is
   * every one of the `outside` batches outside the scope, but
   * `outsideMissing` that `t_K` passed before: the duty is done. A batch
   * outside the scope never recorded is no alarm, since the seat owed none
   * of it.
   */
  | {
      readonly state: "recorded";
      readonly total: number;
      readonly outside: number;
      readonly outsideMissing: number;
    }
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
    const recorded = new Set(
      (await o.contract.recorded(o.election.definitionHash, o.election.index)).map(hex),
    );
    const missing = batches.filter((b) => !recorded.has(hex(b)));
    // Past `t_K` no submission excludes anything, so nothing is sent again.
    const past = o.now() > this.deadline;
    if (missing.length > 0) {
      if (past) return { state: "unrecorded", missing: missing.length, total };
      for (const batch of missing) await o.contract.send(batch, this.cutoff);
      return { state: "sent", batches: missing.length, recorded: total - missing.length, total };
    }
    // Only now, with every complaint it owes recorded, the ones outside the
    // scope, which nothing sized the forced path for (delivery.md, What a
    // node owes in complaints).
    const outside = past ? await this.#storedOutside() : await this.#outside();
    if (!Array.isArray(outside)) return outside;
    const unsent = outside.filter((b) => !recorded.has(hex(b)));
    if (past || unsent.length === 0)
      return { state: "recorded", total, outside: outside.length, outsideMissing: unsent.length };
    for (const batch of unsent) await o.contract.send(batch, this.cutoff);
    return {
      state: "outside-sent",
      batches: unsent.length,
      recorded: outside.length - unsent.length,
      total: outside.length,
    };
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
    return this.#store(key, complaints);
  }

  /** The batches outside the scope stored earlier, or none. */
  async #storedOutside(): Promise<Uint8Array[]> {
    const stored = await this.#o.store.get(this.#outsideKey);
    return stored === undefined ? [] : [...decode(BATCHES, stored)];
  }

  get #outsideKey(): string {
    return `deliveries/${hex(this.#o.election.stubHash)}/complaints-outside`;
  }

  /**
   * The stored batches outside the scope, or, the first time every owed
   * batch is recorded, those signed over the failing postings in time of
   * ballots the seat holds a record of, up to the budget, and stored before
   * any is sent, as the owed ones are. Every record comes from the anchored
   * board or the contract's records, so its ballot is one the seat can't
   * show absent. It skips the scope, whose complaints are decided, the
   * ballots the seat receipted, whose postings open, and every ballot of the
   * view at `c_I`, which the selection over that view put into the scope if
   * a complaint can matter for it: what is left are ballots withheld from
   * the seat before `c_I`, the ones the spec means (delivery.md, Residuals).
   */
  async #outside(): Promise<Uint8Array[] | ComplaintDutyStatus> {
    const o = this.#o;
    const { election } = o;
    const stored = await o.store.get(this.#outsideKey);
    if (stored !== undefined) return [...decode(BATCHES, stored)];
    const budget = o.outside ?? OUTSIDE_COMPLAINTS;
    const complaints: ComplaintEntry[] = [];
    if (budget > 0) {
      const status = await decideObligation(o, election);
      // The owed batches are stored, so the decision is too.
      if (status.state !== "decided") return status;
      const until = this.postingsRecorded;
      const read = await o.contract.postings(election.definitionHash, election.index);
      if (read.finalizedAt <= until) return { state: "waiting-postings", until };
      const skipped = new Set(
        [...status.complaints, ...status.viewed].map(hex).concat(await this.#receipted()),
      );
      const postings = this.#inTime(read.postings, (h) => !skipped.has(h));
      const held = new Map<string, Held>();
      if (postings.size > 0)
        for (const bytes of await o.ballots(election)) {
          const h = heldVote(bytes, election.definitionHash);
          if (h !== undefined && postings.has(h.hash)) held.set(h.hash, h);
        }
      // Checked in turn, only until the budget is spent.
      for (const h of byMember([...held.values()])) {
        if (complaints.length >= budget) break;
        const c = this.#complaint(h.hash, h.vote, postings.get(h.hash) ?? []);
        if (c !== undefined) complaints.push(c);
      }
    }
    return this.#store(this.#outsideKey, complaints);
  }

  /** `complaints` signed as batches and written once under `key`: a concurrent or earlier step's batches win, and are what's sent. */
  async #store(key: string, complaints: readonly ComplaintEntry[]): Promise<Uint8Array[]> {
    const { election, store } = this.#o;
    const batches =
      complaints.length === 0
        ? []
        : batchShareComplaints(
            election.signingSecret,
            election.definitionHash,
            election.index,
            complaints,
          ).map(encodeShareComplaintBatch);
    return [...decode(BATCHES, (await store.putOnce(key, encode(BATCHES, batches))).value)];
  }

  // A ballot this seat receipted passed its own intake: a posting that
  // passes the public check carries the same `ct_i`, and an `m_i` that
  // re-encapsulates to the same secret, so its shares open again and no
  // complaint about it can be proven (docs/spec/delivery.md, Notes).
  async #receipted(): Promise<string[]> {
    return this.#o.store.list(`intake/${hex(this.#o.election.stubHash)}`);
  }

  /**
   * The postings for the seat in time for `t_D`, by ballot hash, of the
   * ballots `keep` takes.
   */
  #inTime(read: readonly RecordedPosting[], keep: (ballot: string) => boolean) {
    const { election } = this.#o;
    const deliveryDeadline = deliveryDeadlines(
      election.closesAt,
      election.l1InclusionBound,
    ).delivery;
    const postings = new Map<string, Posting[]>();
    for (const p of read) {
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
        !keep(ballot)
      )
        continue;
      const posting = { ciphertext: encode(SHARE_CIPHERTEXT, r.ciphertext), m: r.m };
      const held = postings.get(ballot);
      if (held === undefined) postings.set(ballot, [posting]);
      else held.push(posting);
    }
    return postings;
  }

  /** The complaint about `vote`'s postings, if one passes and its shares fail. */
  #complaint(hash: string, vote: Vote, posted: readonly Posting[]): ComplaintEntry | undefined {
    const { election } = this.#o;
    const ctx = { definitionHash: election.definitionHash };
    const pair = election.kemKeyPair;
    // Every passing posting of a ballot and seat carries the same `ct_i`
    // and `m_i`, so the first one decides (docs/spec/delivery.md, Delivery
    // check); a failing one is ignored and proves nothing.
    const passing = posted.find(
      (p) => checkPosting(ctx, election.index, pair.publicKey, vote.vss, vote.share_hashes, p).ok,
    );
    if (passing === undefined) return undefined;
    const opened = openShares(ctx, election.index, pair.secretKey, vote.vss, passing.ciphertext);
    // The DH value is revealed only for shares that fail decryption or the
    // share check, never for shares that open (share-encryption.md,
    // Complaints; T-15).
    if (opened.ok || (opened.code !== "share-decrypt" && opened.code !== "share-check"))
      return undefined;
    // `proveComplaint` runs both checks again: the duty's own, above, keep a
    // posting whose shares open from ever reaching it.
    return {
      ballot_hash: Uint8Array.from(Buffer.from(hash, "hex")),
      proof: proveComplaint(ctx, election.index, pair, vote.vss, vote.share_hashes, passing),
    };
  }

  /** The complaints the scope owes, once every posting in time is in the seat's finalized L2 history. */
  async #owed(scope: readonly Uint8Array[]): Promise<ComplaintEntry[] | ComplaintDutyStatus> {
    const o = this.#o;
    const { election } = o;
    const until = this.postingsRecorded;
    if (o.now() <= until) return { state: "waiting-postings", until };
    const read = await o.contract.postings(election.definitionHash, election.index);
    if (read.finalizedAt <= until) return { state: "waiting-postings", until };
    const receipted = new Set(await this.#receipted());
    const inScope = new Set(scope.map(hex).filter((h) => !receipted.has(h)));
    const postings = this.#inTime(read.postings, (h) => inScope.has(h));
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
    const owed: ComplaintEntry[] = [];
    for (const [h, posted] of postings) {
      const vote = votes.get(h);
      if (vote === undefined) continue;
      const c = this.#complaint(h, vote, posted);
      if (c !== undefined) owed.push(c);
    }
    return owed;
  }
}

// Version 3's vote shares, proves and opens over its flat options as version
// 1's does, so the posting check and the complaint read either the same way
// (docs/spec/share-encryption.md, Ballot versions 2 and 3).
type Vote = BallotRecord["committed_vote"] | BallotRecordV3["committed_vote"];

/** A ballot record the seat holds, as the complaints read it. */
interface Held {
  /** Its ballot hash, recomputed, in hex. */
  readonly hash: string;
  readonly vote: Vote;
  /** Its (`tier`, `ν`), or under version 3 its (`cell`, `ν`): one voter's. */
  readonly member: string;
  readonly l1RefNumber: bigint;
}

/**
 * The ballots in the order the complaints outside the scope take them: one
 * per voter a round, each voter's newest L1 reference first (the smaller
 * ballot hash on a tie), as the selection would pick it, and the voters in
 * the order of their first ballot's hash. A member who posts against many
 * ballots of their own takes one complaint a round, so the budget reaches
 * other voters' ballots before a second of theirs (T-52).
 */
function byMember(held: readonly Held[]): Held[] {
  const voters = new Map<string, Held[]>();
  for (const h of held) {
    const ballots = voters.get(h.member);
    if (ballots === undefined) voters.set(h.member, [h]);
    else ballots.push(h);
  }
  const order = [...voters.values()].map((ballots) =>
    ballots.sort((a, b) =>
      a.l1RefNumber !== b.l1RefNumber
        ? a.l1RefNumber > b.l1RefNumber
          ? -1
          : 1
        : a.hash < b.hash
          ? -1
          : 1,
    ),
  );
  order.sort((a, b) => ((a[0] as Held).hash < (b[0] as Held).hash ? -1 : 1));
  const rounds: Held[] = [];
  for (let round = 0; rounds.length < held.length; round++)
    for (const ballots of order) {
      const h = ballots[round];
      if (h !== undefined) rounds.push(h);
    }
  return rounds;
}

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
function heldVote(bytes: Uint8Array, definitionHash: Uint8Array): Held | undefined {
  try {
    if (bytes[2] === 3) {
      const b = decodeBallot(bytes, 3);
      if (!equal(b.definition_hash, definitionHash)) return undefined;
      const ctx = { definitionHash, cell: b.cell, nullifier: b.nullifier };
      return {
        hash: hex(ballotHashV3(ctx, b.committed_vote)),
        vote: b.committed_vote,
        member: `cell ${b.cell} ${b.nullifier}`,
        l1RefNumber: b.l1_ref_number,
      };
    }
    const b = decodeBallot(bytes, 1);
    if (!equal(b.definition_hash, definitionHash)) return undefined;
    const ctx = { definitionHash, tier: b.tier, nullifier: b.nullifier };
    return {
      hash: hex(ballotHash(ctx, b.committed_vote)),
      vote: b.committed_vote,
      member: `tier ${b.tier} ${b.nullifier}`,
      l1RefNumber: b.l1_ref_number,
    };
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
}
