// The posting relay's ledger (docs/spec/posting-relay.md, Sending, steps 2, 5
// and 6, Caps and In flight; ADR 0042, rules 4 and 5): the durable record of
// what the posting worker sent, its caps, and the first send of each posting
// from the posting key. The worker (posting-worker.ts) decides steps 1 to 4
// and hands each pair that passes them here.
//
// Never paid for twice (ADR 0042, rule 4): every send runs in one database
// transaction under one lock that every send takes, so two workers (a
// deploy's overlap) are serialised; it reads `posting_sent` again under that
// lock, reads the key's nonce, signs, writes the record of the transaction
// and commits before it broadcasts, and never rejects once it has: a
// broadcast that fails is the in-flight record's to rebroadcast (T-52).
//
// T-11, T-18: the record names postings, ballot hashes and nullifiers, all
// public on the chain once sent, and never an account, an address or a
// request. The in-flight entry holds the posting, `m_i` included, until the
// chain holds it or never can; nothing else outlives the request.

import { deliveryDeadlines, intakeCutoff } from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION, PINNED_MARGIN } from "@abolishus/verifier";
import { and, eq, max, ne, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { postingBallots, postingInFlight, postingSent, postingSpend } from "./db/schema/index.ts";
import type { PostingOutcome, PostingSent } from "./posting-relay.ts";
import { POSTING_GAS_LIMIT_MAX, type PostingLedger, type PostingToSend } from "./posting-worker.ts";

/** The most ballot hashes the relay posts for, per election and (`tier`, `ν`) (Values). */
export const POSTING_BALLOT_CAP = 2;
/** Seconds before `c_D` at which the client stops relying on the relay: `c_P = c_D − POSTING_CLIENT_MARGIN` (Values). */
export const POSTING_CLIENT_MARGIN = 3_600n;
/** Seconds the relay's cutoffs allow for an L2 block to reach the finalized head (Values). */
export const POSTING_FINALITY = 1_800n;
/** Seconds a sent transaction may stay out of every L2 block before its posting is forced through L1 (Values). */
export const POSTING_FORCE_AFTER = 600n;

/** Milliseconds the ledger waits on any one call to the posting key's node before it gives up. */
export const POSTING_CHAIN_TIMEOUT_MS = 10_000;

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

/** A signed `submitPosting` call, as the posting key signed it. */
export interface PostingSigned {
  /** The signed transaction's bytes, as broadcast. */
  readonly tx: Uint8Array;
  /** Its hash, 32 bytes. */
  readonly hash: Uint8Array;
  /** The fees it was signed with, in wei per L2 gas: at most the fee cap, the priority fee at most the max fee. */
  readonly maxFee: bigint;
  readonly priorityFee: bigint;
}

/** The most a call costs beside its L2 execution, in wei (Caps, Spend). */
export interface PostingCosts {
  /** The L1 data fee the L2's fee oracle gives for the call's calldata. */
  readonly l1DataFee: bigint;
  /** The most an L1 deposit of the call, with the same gas limit and calldata, costs on L1. */
  readonly deposit: bigint;
}

/**
 * The posting key and what the ledger reads about it from the chain
 * (Sending, step 6). A call that can't reach the node rejects; nothing but
 * `broadcast` sends anything.
 */
export interface PostingKeyChain {
  /** The posting key's transaction count at the L2 node's latest block. */
  nonce(): Promise<bigint>;
  /** The call's costs beside `gasLimit` at the fee cap. */
  costs(posting: Uint8Array, ballot: Uint8Array, gasLimit: bigint): Promise<PostingCosts>;
  /**
   * Signs `submitPosting(posting, ballot)` to the board at `nonce`, with gas
   * limit `gasLimit` and fees at most `feeCap`, sending nothing.
   */
  sign(
    posting: Uint8Array,
    ballot: Uint8Array,
    options: { readonly nonce: bigint; readonly gasLimit: bigint; readonly feeCap: bigint },
  ): Promise<PostingSigned>;
  /** Sends a signed transaction: "sent" if the node took it or already had it, "refused" if it refused it. */
  broadcast(tx: Uint8Array): Promise<"sent" | "refused">;
}

export interface PostgresPostingLedgerOptions {
  readonly sql: Sql;
  readonly chain: PostingKeyChain;
  /** The election budget: the most wei the relay spends on one election's postings (Values). */
  readonly budget: bigint;
  /** The fee cap: the most wei per L2 gas any relayed call is signed to pay (Values). */
  readonly feeCap: bigint;
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The release's `F` and `R`; the verifier's pinned values by default. */
  readonly forcedInclusion?: bigint;
  readonly margin?: bigint;
  /** Milliseconds to wait on any one call to the node; `POSTING_CHAIN_TIMEOUT_MS` by default. */
  readonly chainTimeoutMs?: number;
}

/** An election's windows, from its `closes_at` and `l1_inclusion_bound`, under the release's `F` and `R`. */
export interface PostingWindows {
  /** `t_D`, the delivery deadline. */
  readonly delivery: bigint;
  /** `c_D = t_D − F`. */
  readonly contract: bigint;
  /** `c_I = t_D − F − R`. */
  readonly intake: bigint;
  /** The deposit cutoff `c_F = min(c_I, c_P − F − POSTING_FINALITY)`, `c_P = c_D − POSTING_CLIENT_MARGIN` (Forced through L1). */
  readonly deposit: bigint;
}

/** An election's windows (docs/spec/delivery.md, Windows; docs/spec/posting-relay.md, Forced through L1). */
export function postingWindows(
  closesAt: bigint,
  l1InclusionBound: bigint,
  constants: { readonly forcedInclusion: bigint; readonly margin: bigint },
): PostingWindows {
  const { forcedInclusion, margin } = constants;
  const delivery = deliveryDeadlines(closesAt, l1InclusionBound).delivery;
  const contract = delivery - forcedInclusion;
  const intake = intakeCutoff(closesAt, l1InclusionBound, { forcedInclusion, margin });
  const client = contract - POSTING_CLIENT_MARGIN;
  const late = client - forcedInclusion - POSTING_FINALITY;
  return { delivery, contract, intake, deposit: intake < late ? intake : late };
}

/**
 * The most a call can cost (Caps, Spend): `g` at the fee cap, its L1 data
 * fee, and a deposit's L1 cost if it may yet be forced: if
 * `POSTING_FORCE_AFTER` from `now` is still by the deposit cutoff.
 */
export function postingMostCost(
  gasLimit: bigint,
  feeCap: bigint,
  costs: PostingCosts,
  forceable: boolean,
): bigint {
  return gasLimit * feeCap + costs.l1DataFee + (forceable ? costs.deposit : 0n);
}

const isWei = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n;

function isHash(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array && v.length === 32;
}

/** `ν` as the 32 big-endian bytes the table keeps. */
function nullifierBytes(nullifier: bigint): Uint8Array {
  if (typeof nullifier !== "bigint" || nullifier < 0n || nullifier >= 1n << 256n)
    throw new RangeError("nullifier must be a 256-bit integer");
  return Uint8Array.from(Buffer.from(nullifier.toString(16).padStart(64, "0"), "hex"));
}

const keyBytes = (key: string) => {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new RangeError("key must be 64 lowercase hex digits");
  return Uint8Array.from(Buffer.from(key, "hex"));
};

/**
 * A send that failed without an answer. Its message never quotes the pair,
 * a nullifier, a transaction or the node: a database error's message can
 * carry its query's parameters, the posting's `m_i` among them, and a
 * node's its URL (T-11, T-18, T-69), so neither is passed on.
 */
export class PostingLedgerError extends Error {
  override readonly name = "PostingLedgerError";
}

/** A call to the posting key's node, bounded in time, its error replaced. */
async function call<T>(f: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      f(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } catch {
    throw new PostingLedgerError("the posting key's node failed");
  } finally {
    clearTimeout(timer);
  }
}

/** The ledger's own errors as they are; any other, the store's, replaced. */
function scrubbed(e: unknown): PostingLedgerError {
  return e instanceof PostingLedgerError
    ? e
    : new PostingLedgerError("the posting ledger's store failed");
}

// One lock for every send, so the nonce, the caps and the spend are read
// and written by one send at a time, whichever worker runs it.
const LOCK = q`SELECT pg_advisory_xact_lock(hashtextextended('posting_ledger', 0))`;

/** `PostingLedger` over Postgres and the posting key. */
export class PostgresPostingLedger implements PostingLedger {
  readonly #sql: Sql;
  readonly #chain: PostingKeyChain;
  readonly #budget: bigint;
  readonly #feeCap: bigint;
  readonly #now: () => number;
  readonly #constants: { readonly forcedInclusion: bigint; readonly margin: bigint };
  readonly #chainTimeoutMs: number;

  constructor(options: PostgresPostingLedgerOptions) {
    const {
      forcedInclusion = PINNED_FORCED_INCLUSION,
      margin = PINNED_MARGIN,
      chainTimeoutMs = POSTING_CHAIN_TIMEOUT_MS,
    } = options;
    if (!Number.isSafeInteger(chainTimeoutMs) || chainTimeoutMs <= 0)
      throw new RangeError("chainTimeoutMs must be an integer > 0");
    if (!isWei(options.budget)) throw new RangeError("budget must be a bigint ≥ 0");
    if (!isWei(options.feeCap) || options.feeCap === 0n)
      throw new RangeError("feeCap must be a bigint > 0");
    if (!isWei(forcedInclusion) || !isWei(margin))
      throw new RangeError("forcedInclusion and margin must be bigints ≥ 0");
    this.#sql = options.sql;
    this.#chain = options.chain;
    this.#budget = options.budget;
    this.#feeCap = options.feeCap;
    this.#now = options.now;
    this.#constants = { forcedInclusion, margin };
    this.#chainTimeoutMs = chainTimeoutMs;
  }

  #call<T>(f: () => Promise<T>): Promise<T> {
    return call(f, this.#chainTimeoutMs);
  }

  /** Step 2: the last transaction that carried the posting `key` names, if the relay sent it. */
  async sent(key: string): Promise<PostingSent | undefined> {
    const k = keyBytes(key);
    try {
      return await sentIn(drizzle({ client: this.#sql }), k);
    } catch (e) {
      throw scrubbed(e);
    }
  }

  /** Steps 5 and 6, under the ledger's lock. */
  async send(p: PostingToSend): Promise<PostingOutcome> {
    const key = keyBytes(p.key);
    for (const v of [p.electionId, p.ballotHash])
      if (!isHash(v)) throw new TypeError("electionId and ballotHash must be 32 bytes");
    if (!Number.isInteger(p.tier) || p.tier < 0 || p.tier > 255)
      throw new RangeError("tier must be a u8");
    const nullifier = nullifierBytes(p.nullifier);
    if (typeof p.gasLimit !== "bigint" || p.gasLimit <= 0n || p.gasLimit > POSTING_GAS_LIMIT_MAX)
      throw new RangeError("gasLimit must be in (0, POSTING_GAS_LIMIT_MAX]");
    const windows = postingWindows(p.closesAt, p.l1InclusionBound, this.#constants);
    if (windows.intake < 0n || windows.delivery > I64_MAX)
      throw new RangeError("the election's windows must fit the record");
    // Before the lock, so a slow fee oracle holds no other send. The costs
    // depend only on the call, never on what another send records.
    const costs = await this.#call(() => this.#chain.costs(p.posting, p.ballot, p.gasLimit));
    if (!isWei(costs.l1DataFee) || !isWei(costs.deposit))
      throw new PostingLedgerError("the chain answered a cost out of form");

    let signed: PostingSigned | undefined;
    let outcome: PostingOutcome;
    try {
      outcome = await this.#record(p, { key, nullifier, windows, costs }, (s) => {
        signed = s;
      });
    } catch (e) {
      throw scrubbed(e);
    }
    if (signed !== undefined) {
      // Recorded and committed: from here nothing rejects, and a broadcast
      // the node refused or never got is rebroadcast from the record.
      const tx = signed.tx;
      try {
        await this.#call(() => this.#chain.broadcast(tx));
      } catch {
        // Dropped: the record answers for it.
      }
    }
    return outcome;
  }

  /** The caps, the nonce, the signature and the record, in one transaction under the ledger's lock. */
  async #record(
    p: PostingToSend,
    c: {
      readonly key: Uint8Array;
      readonly nullifier: Uint8Array;
      readonly windows: PostingWindows;
      readonly costs: PostingCosts;
    },
    signedWith: (s: PostingSigned) => void,
  ): Promise<PostingOutcome> {
    const { key, nullifier, windows, costs } = c;
    return drizzle({ client: this.#sql }).transaction(
      async (tx): Promise<PostingOutcome> => {
        await tx.execute(LOCK);
        // A node that never answers can't hold the lock for good: the
        // database ends a transaction left idle this long, and its commit
        // then fails (T-52).
        await tx.execute(q`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
        // After the lock, which may have waited on another send: the deposit
        // condition and the first send's time are this send's.
        const now = this.#now();
        if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("now must be a UNIX time");
        // Again under the lock: a second worker may have sent it since the
        // first worker's step 2.
        const already = await sentIn(tx, key);
        if (already !== undefined) return { sent: true, ...already };

        // Caps, Ballots: other ballot hashes already paid for under this
        // election and (`tier`, `ν`); this ballot's own other seats don't count.
        const others = await tx.$count(
          postingBallots,
          and(
            eq(postingBallots.electionId, p.electionId),
            eq(postingBallots.tier, p.tier),
            eq(postingBallots.nullifier, nullifier),
            ne(postingBallots.ballotHash, p.ballotHash),
          ),
        );
        if (others >= POSTING_BALLOT_CAP) return { sent: false, code: "ballot-cap" };

        // Caps, Spend: the call's most cost against what is left of the
        // election's budget.
        const forceable = BigInt(now) + POSTING_FORCE_AFTER <= windows.deposit;
        const cost = postingMostCost(p.gasLimit, this.#feeCap, costs, forceable);
        const [spend] = await tx
          .select({ spent: postingSpend.spent })
          .from(postingSpend)
          .where(eq(postingSpend.electionId, p.electionId))
          .for("update");
        const spent = spend === undefined ? 0n : BigInt(spend.spent);
        if (spent + cost > this.#budget) return { sent: false, code: "budget" };

        // The next nonce: past what the chain has taken and past every
        // transaction still in flight, which may not be in a block yet.
        const count = await this.#call(() => this.#chain.nonce());
        if (!isWei(count) || count > U64_MAX)
          throw new PostingLedgerError("the chain answered a nonce out of form");
        const [highest] = await tx
          .select({ nonce: max(postingInFlight.nonce) })
          .from(postingInFlight);
        const next =
          highest?.nonce == null ? count : highest.nonce + 1n > count ? highest.nonce + 1n : count;
        if (next > I64_MAX) throw new PostingLedgerError("the posting key's nonce is out of range");

        const s = await this.#call(() =>
          this.#chain.sign(p.posting, p.ballot, {
            nonce: next,
            gasLimit: p.gasLimit,
            feeCap: this.#feeCap,
          }),
        );
        if (
          !(s.tx instanceof Uint8Array) ||
          s.tx.length === 0 ||
          !isHash(s.hash) ||
          !isWei(s.maxFee) ||
          !isWei(s.priorityFee) ||
          s.maxFee > this.#feeCap ||
          s.priorityFee > s.maxFee
        )
          throw new PostingLedgerError("the posting key signed out of form");

        // Step 6's record, before anything is broadcast.
        await tx.insert(postingSent).values({
          postingKey: key,
          electionId: p.electionId,
          transaction: s.hash,
          layer: "l2",
          deliveryEnds: windows.delivery,
        });
        await tx
          .insert(postingBallots)
          .values({
            electionId: p.electionId,
            tier: p.tier,
            nullifier,
            ballotHash: p.ballotHash,
            deliveryEnds: windows.delivery,
          })
          .onConflictDoNothing();
        await tx
          .insert(postingSpend)
          .values({
            electionId: p.electionId,
            spent: cost.toString(),
            deliveryEnds: windows.delivery,
          })
          .onConflictDoUpdate({
            target: postingSpend.electionId,
            set: { spent: q`${postingSpend.spent} + ${cost.toString()}::numeric` },
          });
        await tx.insert(postingInFlight).values({
          postingKey: key,
          posting: p.posting,
          ballot: p.ballot,
          electionId: p.electionId,
          intakeCutoff: windows.intake,
          contractCutoff: windows.contract,
          deliveryEnds: windows.delivery,
          firstSent: BigInt(now),
          nonce: next,
          gasLimit: p.gasLimit,
          maxFee: s.maxFee.toString(),
          priorityFee: s.priorityFee.toString(),
          cost: cost.toString(),
          signed: s.tx,
          transactions: s.hash,
        });
        // Seen by `send` only once this transaction has committed: a commit
        // that fails rejects before anything is broadcast.
        signedWith(s);
        return { sent: true, transaction: s.hash, layer: "l2" };
      },
      // Each statement after the lock sees what the send before it
      // committed; a deployment's default of repeatable read would let two
      // sends both pass the ballot cap.
      { isolationLevel: "read committed" },
    );
  }
}

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function sentIn(db: Db | Tx, key: Uint8Array): Promise<PostingSent | undefined> {
  const [row] = await db
    .select({ transaction: postingSent.transaction, layer: postingSent.layer })
    .from(postingSent)
    .where(eq(postingSent.postingKey, key))
    .limit(1);
  if (row === undefined) return undefined;
  if (row.layer !== "l1" && row.layer !== "l2")
    throw new Error("the ledger holds a layer out of form");
  return { transaction: new Uint8Array(row.transaction), layer: row.layer };
}
