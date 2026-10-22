// The posting worker's checks before it pays (docs/spec/posting-relay.md,
// Queue and Sending; ADR 0042, option A): on each tick it brings the
// route's index up to the L2 node's latest block, then judges every queued
// pair in the spec's order and answers each one it can decide, so the route
// waiting on it gets the outcome. A pair's bytes decode again (step 1), a
// posting already sent is answered with its transaction (step 2), the send
// cutoff is read from the latest block (step 3), and before the simulation
// (step 4) the ballots of each election's pairs pass the verifier's batched
// admission, membership proof included, so a pair made with a ballot record
// no member made leaves the queue on the next tick rather than holding its
// place until a simulation reverts (T-52, T-13). What passes goes to the
// ledger, which applies the caps, signs from the posting key, sends and
// keeps the durable record (steps 5 and 6). The chain is behind
// `PostingChain` and the ledger behind `PostingLedger`, so this file decides
// and they only read, sign and send.
//
// T-11, T-18: nothing here keeps a pair. It leaves the queue in the same
// step its outcome is written, and the outcome expires after
// `POSTING_WAIT`; the only state of this file's own is a count of the ticks
// a still-queued posting went unanswered on, in memory. The report counts
// outcomes and never names a record, ballot hash, nullifier or transaction.

import { deliveryDeadlines } from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION, postingForm } from "@abolishus/verifier";
import type { Sql } from "postgres";
import { type BallotAdmissions, SubmitError } from "./admission.ts";
import {
  parsePostingPair,
  POSTING_MAX_DATA,
  POSTING_SEND_MARGIN,
  POSTING_WAIT,
  POSTING_WORKER_REFUSALS,
  postingCalldataLength,
  postingIndexValue,
  postingKey,
  type PostingKeys,
  postingKeys,
  type PostingOutcome,
  postingOutcomeValue,
  type PostingRedis,
  type PostingSent,
  type PostingWorkerRefusal,
} from "./posting-relay.ts";
import { registeredElection } from "./registrations.ts";

/** Milliseconds between the worker's ticks (docs/spec/posting-relay.md, Queue). */
export const POSTING_TICK_MS = 2_000;
/** The most gas limit any relayed call or deposit is given (Values). */
export const POSTING_GAS_LIMIT_MAX = 10_000_000n;
/** `POSTING_GAS_HEADROOM`, 5/4: a call's gas limit over the gas its simulation used. */
export const POSTING_GAS_HEADROOM = { numerator: 5n, denominator: 4n } as const;
/** Ticks a posting may go unanswered on (a node or ledger failing without a verdict) before it is refused `unavailable`. */
export const POSTING_UNANSWERED_TICKS = 5;
/** Seconds those ticks must span at least, so a burst of failures doesn't refuse a posting a node would take a minute later. */
export const POSTING_UNANSWERED_SPAN = 60;

const U64_MAX = (1n << 64n) - 1n;

/**
 * The gas limit `g` of a relayed call for a simulation that used `gasUsed`
 * and calldata of `calldataLength` bytes (docs/spec/posting-relay.md,
 * Sending, step 4): the larger of `gasUsed · POSTING_GAS_HEADROOM`, rounded
 * up, and the portal's minimum gas limit for a deposit of that calldata,
 * `21,000 + 40 · d`, so the same `g` serves the L2 call and its deposit.
 */
export function postingGasLimit(gasUsed: bigint, calldataLength: number): bigint {
  if (typeof gasUsed !== "bigint" || gasUsed < 0n) throw new RangeError("gasUsed must be ≥ 0");
  if (!Number.isSafeInteger(calldataLength) || calldataLength < 0)
    throw new RangeError("calldataLength must be an integer ≥ 0");
  const { numerator, denominator } = POSTING_GAS_HEADROOM;
  const headroom = (gasUsed * numerator + denominator - 1n) / denominator;
  const floor = 21_000n + 40n * BigInt(calldataLength);
  return headroom > floor ? headroom : floor;
}

/** The L2 node's latest block, as the send cutoff and the route's index read it. */
export interface PostingHead {
  readonly number: bigint;
  /** UNIX seconds. */
  readonly timestamp: bigint;
}

/** A simulation's result: the gas the call used, or a revert. */
export type PostingSimulation =
  | { readonly reverted: false; readonly gasUsed: bigint }
  | { readonly reverted: true };

/**
 * What the worker reads from L2 before it pays. Every read is of public
 * chain data or a call that changes nothing. A call that can't reach the
 * node, or fails without a revert, rejects.
 */
export interface PostingChain {
  latest(): Promise<PostingHead>;
  /**
   * `submitPosting(posting, ballot)` to the board from the posting key,
   * called against the latest block with gas `POSTING_GAS_LIMIT_MAX`: the
   * gas it used, or `reverted` when the board's own checks refuse it.
   */
  simulate(posting: Uint8Array, ballot: Uint8Array): Promise<PostingSimulation>;
}

/** A pair that passed steps 1 to 4, with what the caps and the sending need, each recomputed by the worker. */
export interface PostingToSend {
  /** `keccak256(posting)`, as the queue and the outcome name it. */
  readonly key: string;
  readonly posting: Uint8Array;
  readonly ballot: Uint8Array;
  readonly electionId: Uint8Array;
  readonly definitionHash: Uint8Array;
  readonly ballotHash: Uint8Array;
  /** The ballot's cell's tier and its nullifier: what `POSTING_BALLOT_CAP` counts by. */
  readonly tier: number;
  readonly nullifier: bigint;
  /** The call's gas limit `g`, at most `POSTING_GAS_LIMIT_MAX`. */
  readonly gasLimit: bigint;
  /** The election's `closes_at` and `l1_inclusion_bound`, from which its windows follow (docs/spec/delivery.md, Windows). */
  readonly closesAt: bigint;
  readonly l1InclusionBound: bigint;
}

/**
 * The relay's durable record and the posting key (docs/spec/posting-relay.md,
 * Sending, steps 2, 5 and 6; Caps). A call that fails without an answer
 * rejects, and the pair stays queued for the next tick. So that a posting
 * is never paid for twice (ADR 0042, rule 4), `send` checks `sent(key)`
 * again under the same lock or transaction it records in, writes its
 * record of the transaction before broadcasting it, and never rejects once
 * it has broadcast: a broadcast that fails is the record's to rebroadcast.
 */
export interface PostingLedger {
  /** Step 2: the last transaction that carried this posting, if the relay sent it. */
  sent(key: string): Promise<PostingSent | undefined>;
  /** Steps 5 and 6: the caps, then the signed call, broadcast and recorded, or the cap's refusal. */
  send(posting: PostingToSend): Promise<PostingOutcome>;
}

export interface PostingWorkerOptions {
  readonly sql: Sql;
  readonly redis: PostingRedis;
  readonly chain: PostingChain;
  readonly ledger: PostingLedger;
  /** Ballot admission under the panels this release pins, as the route's. */
  readonly admissions: Pick<BallotAdmissions, "postings">;
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The release's `F`, for `c_D = t_D − F`; the verifier's pinned value by default. */
  readonly forcedInclusion?: bigint;
  /** The first segment of every key, as the route's. */
  readonly prefix?: string;
}

/** A tick's outcomes, as counts only (T-11, T-13). */
export interface PostingTickReport {
  /** False when the L2 node's latest block couldn't be read: the index wasn't brought up and nothing was judged. */
  readonly chain: boolean;
  /** Pairs answered and taken out of the queue, by outcome. */
  readonly answered: Readonly<Record<"sent" | PostingWorkerRefusal, number>>;
  /** Pairs left queued for the next tick, unanswered. */
  readonly kept: number;
}

// The outcome is written and the pair leaves the queue in one step, so a
// pair is never answered twice nor dropped unanswered.
const ANSWER = `
redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]))
redis.call('HDEL', KEYS[1], ARGV[1])
return 1
`;

// A field that can't be a posting's key has no outcome key to answer under:
// it is dropped, as no route writes one.
const DROP = `
redis.call('HDEL', KEYS[1], ARGV[1])
return 1
`;

const WRITE_INDEX = `
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

const READ_ALL = `return redis.call('HGETALL', KEYS[1])`;

const KEY = /^[0-9a-f]{64}$/;

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Pairs from `HGETALL`'s flat answer. */
function fields(flat: unknown): [string, string][] {
  if (!Array.isArray(flat) || flat.length % 2 !== 0) throw new Error("Redis answered out of form");
  const out: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([String(flat[i]), String(flat[i + 1])]);
  return out;
}

type Election = NonNullable<Awaited<ReturnType<BallotAdmissions["postings"]>>>;

/** A pair through step 3, waiting for its election's batched admission. */
interface Judged {
  readonly key: string;
  readonly posting: Uint8Array;
  readonly ballot: Uint8Array;
  readonly definitionHash: Uint8Array;
  readonly ballotHash: Uint8Array;
  readonly nullifier: bigint;
}

/** The posting worker's queue: judges what the route queued and answers it. */
export class PostingWorker {
  readonly #sql: Sql;
  readonly #redis: PostingRedis;
  readonly #chain: PostingChain;
  readonly #ledger: PostingLedger;
  readonly #admissions: Pick<BallotAdmissions, "postings">;
  readonly #now: () => number;
  readonly #forcedInclusion: bigint;
  readonly #keys: PostingKeys;
  // For each queued posting that went unanswered: the first such tick's time
  // and how many there were. Dropped once it leaves the queue.
  readonly #unanswered = new Map<string, { readonly since: number; readonly ticks: number }>();
  // One tick at a time: an overlapping tick would judge the same pairs
  // and could hand the ledger the same posting twice.
  #running = false;

  constructor(options: PostingWorkerOptions) {
    const { forcedInclusion = PINNED_FORCED_INCLUSION } = options;
    if (typeof forcedInclusion !== "bigint" || forcedInclusion < 0n)
      throw new RangeError("forcedInclusion must be a bigint ≥ 0");
    this.#sql = options.sql;
    this.#redis = options.redis;
    this.#chain = options.chain;
    this.#ledger = options.ledger;
    this.#admissions = options.admissions;
    this.#now = options.now;
    this.#forcedInclusion = forcedInclusion;
    this.#keys = postingKeys(options.prefix);
  }

  /**
   * One tick, every `POSTING_TICK_MS`: every queued pair in Redis's hash
   * order, never one the route sets, then the index. Resolves null while
   * another tick of this worker runs. A Redis failure throws, leaving every
   * pair not yet answered queued for the next tick, and the index,
   * unwritten, ages out, so the route answers unavailable rather than queue
   * pairs nothing judges.
   */
  async tick(): Promise<PostingTickReport | null> {
    if (this.#running) return null;
    this.#running = true;
    try {
      return await this.#tick();
    } finally {
      this.#running = false;
    }
  }

  async #tick(): Promise<PostingTickReport> {
    const answered = Object.fromEntries(
      ["sent", ...POSTING_WORKER_REFUSALS].map((c) => [c, 0]),
    ) as Record<"sent" | PostingWorkerRefusal, number>;
    let kept = 0;
    let head: PostingHead;
    try {
      head = await this.#chain.latest();
    } catch {
      // The node's error is dropped: viem's quote the URL, which can carry a
      // provider's key (T-69).
      return { chain: false, answered, kept };
    }
    if (typeof head.timestamp !== "bigint" || head.timestamp < 0n || head.timestamp > U64_MAX)
      return { chain: false, answered, kept };
    const now = this.#now();
    const queued = fields(await this.#eval(READ_ALL, 1, this.#keys.queue));
    const present = new Set(queued.map(([key]) => key));
    for (const key of this.#unanswered.keys()) if (!present.has(key)) this.#unanswered.delete(key);

    const answer = async (key: string, outcome: PostingOutcome) => {
      await this.#eval(
        ANSWER,
        2,
        this.#keys.queue,
        this.#keys.outcome(key),
        key,
        postingOutcomeValue(outcome),
        String(POSTING_WAIT),
      );
      this.#unanswered.delete(key);
      answered[outcome.sent ? "sent" : outcome.code]++;
    };
    const refuse = (key: string, code: PostingWorkerRefusal) => answer(key, { sent: false, code });
    // No verdict this tick: kept, until it has so gone unanswered on
    // `POSTING_UNANSWERED_TICKS` ticks over `POSTING_UNANSWERED_SPAN`, so a
    // pair a node or the ledger keeps failing on can't hold a queue place
    // for good (T-52).
    const unanswered = async (key: string) => {
      const was = this.#unanswered.get(key);
      const since = was?.since ?? now;
      const ticks = (was?.ticks ?? 0) + 1;
      if (ticks >= POSTING_UNANSWERED_TICKS && now - since >= POSTING_UNANSWERED_SPAN)
        return refuse(key, "unavailable");
      this.#unanswered.set(key, { since, ticks });
      kept++;
    };

    const byElection = new Map<
      string,
      { election: Election; electionId: Uint8Array; pairs: Judged[] }
    >();
    for (const [key, value] of queued) {
      if (!KEY.test(key)) {
        await this.#eval(DROP, 1, this.#keys.queue, key);
        continue;
      }
      // Step 1: the worker doesn't take the route's word for the bytes, or
      // for anything it counts by.
      const pair = parsePostingPair(value);
      // The calldata's bound too: a pair past it couldn't be forced through
      // L1, whoever wrote it to the queue.
      if (
        pair === undefined ||
        postingKey(pair.posting) !== key ||
        postingCalldataLength(pair.posting.length, pair.ballot.length) > POSTING_MAX_DATA
      ) {
        await refuse(key, "malformed");
        continue;
      }
      const form = postingForm(pair.posting, pair.ballot);
      if (!form.ok) {
        await refuse(key, "malformed");
        continue;
      }
      // Step 2: a posting the relay already sent is answered with its
      // transaction and never paid for again (ADR 0042, rule 4).
      let sent;
      try {
        sent = await this.#ledger.sent(key);
      } catch {
        await unanswered(key);
        continue;
      }
      if (sent !== undefined) {
        await answer(key, { sent: true, ...sent });
        continue;
      }
      // An election the route judged but this worker can't, under its own
      // pins and our index, is a configuration apart from the route's: the
      // relay can't establish what it would pay for.
      // A database failure leaves this pair unanswered, not the pairs
      // after it in the hash's order.
      let electionId: Uint8Array | undefined;
      let election: Election | undefined;
      try {
        electionId = await registeredElection(this.#sql, form.definitionHash);
        if (electionId !== undefined)
          election = await this.#admissions.postings(this.#sql, electionId);
      } catch (e) {
        if (!(e instanceof SubmitError)) {
          await unanswered(key);
          continue;
        }
      }
      if (electionId === undefined || election === undefined) {
        await refuse(key, "unavailable");
        continue;
      }
      // Step 3: by the latest block, never earlier than the finalized one
      // ADR 0042's rule 3.2 names, so this refuses at least as much.
      const cD =
        deliveryDeadlines(election.closesAt, election.l1InclusionBound).delivery -
        this.#forcedInclusion;
      if (head.timestamp > cD - POSTING_SEND_MARGIN) {
        await refuse(key, "too-late");
        continue;
      }
      const id = toHex(electionId);
      const group = byElection.get(id) ?? { election, electionId, pairs: [] };
      group.pairs.push({
        key,
        posting: pair.posting,
        ballot: pair.ballot,
        definitionHash: form.definitionHash,
        ballotHash: form.ballotHash,
        nullifier: form.nullifier,
      });
      byElection.set(id, group);
    }

    for (const { election, electionId, pairs } of byElection.values()) {
      // Step 4, first the ballot check the board's `submitPosting` runs, here
      // in the worker and batched per election: the route's public check
      // never looked at the ballot's membership proof, so a pair with a
      // ballot record no member made could otherwise hold a queue place
      // until its simulation, one node call per pair (Known-weak, Anyone can
      // fill the queue). A ballot the verifier refuses can't count, and the
      // board's own check would refuse it too, so it is answered as the
      // simulation's revert would be.
      const verdicts = election.admitAll(pairs.map((p) => p.ballot));
      for (const [i, p] of pairs.entries()) {
        const verdict = verdicts[i];
        if (verdict === undefined || !verdict.ok) {
          await refuse(p.key, "simulation");
          continue;
        }
        // Admission recomputes both from the same record as `postingForm`;
        // a disagreement is a fault, never a pair to pay for.
        if (!equalBytes(verdict.ballotHash, p.ballotHash) || verdict.nullifier !== p.nullifier) {
          await refuse(p.key, "malformed");
          continue;
        }
        // Then the board's own checks, before any gas is spent.
        let simulation;
        try {
          simulation = await this.#chain.simulate(p.posting, p.ballot);
        } catch {
          await unanswered(p.key);
          continue;
        }
        if (simulation.reverted) {
          await refuse(p.key, "simulation");
          continue;
        }
        const { gasUsed } = simulation;
        if (typeof gasUsed !== "bigint" || gasUsed < 0n) {
          await unanswered(p.key);
          continue;
        }
        const gasLimit = postingGasLimit(
          gasUsed,
          postingCalldataLength(p.posting.length, p.ballot.length),
        );
        if (gasLimit > POSTING_GAS_LIMIT_MAX) {
          await refuse(p.key, "too-costly");
          continue;
        }
        // Steps 5 and 6 are the ledger's.
        let outcome;
        try {
          outcome = await this.#ledger.send({
            key: p.key,
            posting: p.posting,
            ballot: p.ballot,
            electionId,
            definitionHash: p.definitionHash,
            ballotHash: p.ballotHash,
            tier: verdict.tier,
            nullifier: p.nullifier,
            gasLimit,
            closesAt: election.closesAt,
            l1InclusionBound: election.l1InclusionBound,
          });
        } catch {
          await unanswered(p.key);
          continue;
        }
        await answer(p.key, outcome);
      }
    }
    // Last, so a worker that can't judge stops vouching for the queue.
    await this.#eval(
      WRITE_INDEX,
      1,
      this.#keys.index,
      postingIndexValue({ at: now, l2Time: head.timestamp }),
    );
    return { chain: true, answered, kept };
  }

  /**
   * One script. Its error is dropped, since the client's message can quote
   * the script's arguments, a posting's key or a transaction (T-11, T-18).
   */
  async #eval(script: string, numkeys: number, ...keysThenArgs: string[]): Promise<unknown> {
    try {
      return await this.#redis.eval(script, numkeys, ...keysThenArgs);
    } catch {
      throw new Error("the posting relay's store failed");
    }
  }
}
