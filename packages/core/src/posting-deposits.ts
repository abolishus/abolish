// The posting relay's forced path through L1 (docs/spec/posting-relay.md,
// Forced through L1, Depositing and Pruning; ADR 0042, rule 5; ADR 0004,
// Forced inclusion; T-50, T-54): a posting the sequencer keeps out of the
// L2's safe head for `POSTING_FORCE_AFTER` is deposited on L1 through the
// portal, from the posting key, with the same calldata and gas limit, while
// its landing span is by the deposit cutoff and outside every interval the
// trustees' capacity check counts on; each deposit is priced and its
// reserve counted within the election's budget, rebroadcast, replaced,
// cancelled once it waits too long, and settled from its receipt.
//
// Every step runs under the ledger's lock (posting-ledger.ts), so a send,
// an L2 tend, a prune and this never act on the same entry or spend at
// once, and anything signed is recorded and committed before it is
// broadcast. The key has at most one L1 transaction pending, so a deposit is
// never signed behind a stuck nonce, past the span it was checked for.
//
// T-11, T-18: the record of a deposit names its posting by
// `keccak256(posting)` and holds its signed bytes only while the posting's
// entry does; the report counts and never names anything.

import { CONTRACT_EVENT_WINDOW, deliveryDeadlines, intakeCutoff } from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION, PINNED_MARGIN } from "@abolishus/verifier";
import { and, asc, desc, eq, lte, max, or, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { postingDeposits, postingInFlight, postingSent, postingSpend } from "./db/schema/index.ts";
import {
  call,
  checkSigned,
  hashesOf,
  isHash,
  isWei,
  LOCK,
  POSTING_CHAIN_TIMEOUT_MS,
  POSTING_CLIENT_MARGIN,
  POSTING_DEPOSIT_PATIENCE,
  POSTING_DEPOSIT_SPAN,
  POSTING_FINALITY,
  POSTING_FORCE_AFTER,
  POSTING_RESEND,
  PostingLedgerError,
  type PostingSigned,
  raised,
  scrubbed,
  type Tx,
} from "./posting-ledger.ts";
import { POSTING_GAS_HEADROOM, POSTING_HEAD_AGE } from "./posting-worker.ts";

/** EIP-7825's cap on one transaction's gas limit: a deposit's L1 transaction above it is never sent (Depositing, step 1). */
export const POSTING_L1_GAS_LIMIT_MAX = 1n << 24n;
/** A cancellation's gas limit: a transfer of 0 wei from the posting key to itself. */
export const POSTING_CANCEL_GAS = 21_000n;

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

/** An L1 block as the deposits read it. */
export interface PostingL1Head {
  readonly number: bigint;
  /** UNIX seconds. */
  readonly timestamp: bigint;
}

/** What an L1 transaction's receipt shows. */
export interface PostingL1Receipt {
  /** Whether it succeeded; a deposit that reverted on L1 hasn't landed. */
  readonly success: boolean;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  /** The number of its block. */
  readonly block: bigint;
}

/**
 * The posting key on L1 and what the deposits read from both chains. A call
 * that can't reach a node rejects; nothing but `broadcast` sends anything.
 */
export interface PostingDepositChain {
  /** Whether the L2 transaction `hash` names is in an L2 block at the L2's safe head. */
  includedSafe(hash: Uint8Array): Promise<boolean>;
  /** Whether a `SharePosted` event of the board at the L2's safe head has exactly `posting` as its record. */
  postedSafe(posting: Uint8Array): Promise<boolean>;
  /** The posting key's transaction count at the L1 node's latest block. */
  nonce(): Promise<bigint>;
  /** The posting key's transaction count at the L1 block numbered `block`. */
  nonceAt(block: bigint): Promise<bigint>;
  /**
   * The L1 node's gas estimate, at its latest block, for
   * `depositTransaction(board, 0, gasLimit, false, calldata)` on the portal
   * from the posting key with value 0, `calldata` being `submitPosting`'s
   * for the pair; undefined if the estimate reverts.
   */
  estimate(posting: Uint8Array, ballot: Uint8Array, gasLimit: bigint): Promise<bigint | undefined>;
  /**
   * Signs that deposit at `nonce` with L1 gas limit `l1GasLimit` and fees
   * at most `feeCap`, sending nothing. With `fees`, a replacement at
   * `nonce`: signed with exactly those fees.
   */
  signDeposit(
    posting: Uint8Array,
    ballot: Uint8Array,
    options: {
      readonly nonce: bigint;
      readonly gasLimit: bigint;
      readonly l1GasLimit: bigint;
      readonly feeCap: bigint;
      readonly fees?: { readonly maxFee: bigint; readonly priorityFee: bigint };
    },
  ): Promise<PostingSigned>;
  /** Signs a transfer of 0 wei from the posting key to itself at `nonce`, gas limit `POSTING_CANCEL_GAS`, with exactly `fees`. */
  signCancel(options: {
    readonly nonce: bigint;
    readonly fees: { readonly maxFee: bigint; readonly priorityFee: bigint };
  }): Promise<PostingSigned>;
  /** Sends a signed L1 transaction: "sent" if the node took it or already had it, "refused" if it refused it. */
  broadcast(tx: Uint8Array): Promise<"sent" | "refused">;
  /** The receipt of the L1 transaction `hash` names, if it is in an L1 block at the latest L1 head. */
  receipt(hash: Uint8Array): Promise<PostingL1Receipt | undefined>;
}

/** A registered election's `closes_at` and `l1_inclusion_bound`, read from its definition. */
export interface PostingElectionTimes {
  readonly closesAt: bigint;
  readonly l1InclusionBound: bigint;
}

/**
 * The registered elections, as the index the route judges by holds them
 * (Forced through L1): undefined if any that isn't known to be past its
 * `c_K` can't be read, since its intervals are then unknown (T-54).
 */
export interface PostingRegisteredElections {
  times(): Promise<readonly PostingElectionTimes[] | undefined>;
}

/** What one `tend` of the deposits did, as counts only (T-11, T-13). */
export interface PostingDepositReport {
  /** Postings deposited on L1. */
  readonly deposited: number;
  /** Postings due a deposit that the election's budget leaves unsent. */
  readonly held: number;
  /** Pending deposits or cancellations broadcast again, identical. */
  readonly rebroadcast: number;
  /** Pending deposits or cancellations replaced at their nonce with both fees raised by an eighth. */
  readonly replaced: number;
  /** Pending deposits replaced by a cancellation. */
  readonly cancelled: number;
  /** Nonces settled by a deposit in an L1 block whose receipt shows success. */
  readonly landed: number;
  /** Nonces settled by a reverted deposit or a cancellation. */
  readonly failed: number;
  /** Settled nonces whose block left the latest L1 head, pending again. */
  readonly unsettled: number;
  /** Settled nonces whose block reached the L1's finalized head, their reserve replaced by their receipt. */
  readonly final: number;
  /** Pending nonces the key's count is past at the latest L1 head with no receipt of theirs seen, left pending (Known-weak). */
  readonly unseen: number;
  /** Such nonces the count is past at the L1's finalized head too, settled as landed with their reserve kept (Known-weak). */
  readonly consumed: number;
  /** Postings whose counted reserve was released, as none of their deposits can be sent any more. */
  readonly released: number;
  /** 1 if a posting due a deposit waited because a registered election's times couldn't be read (Known-weak). */
  readonly unjudged: number;
  /** Nonces or postings a node or store failure left for the next tend. */
  readonly errors: number;
}

export interface PostgresPostingDepositsOptions {
  readonly sql: Sql;
  readonly chain: PostingDepositChain;
  readonly elections: PostingRegisteredElections;
  /** The election budget, as the ledger's (Values). */
  readonly budget: bigint;
  /** The L1 fee cap: the most wei per L1 gas any deposit is signed to pay; a cancellation may pay up to twice it (Values). */
  readonly l1FeeCap: bigint;
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The release's `F` and `R`; the verifier's pinned values by default. */
  readonly forcedInclusion?: bigint;
  readonly margin?: bigint;
  /** Milliseconds to wait on any one call to a node; `POSTING_CHAIN_TIMEOUT_MS` by default. */
  readonly chainTimeoutMs?: number;
}

/** A half-open span of L1 time, `[from, to)`. */
export interface PostingInterval {
  readonly from: bigint;
  readonly to: bigint;
}

/**
 * The intervals an election's seats' forced records take (docs/spec/delivery.md,
 * Capacity), each half-open: its receipt interval from `c_I` to `c_D` and
 * its complaint interval from `t_D + W_C` to `c_K = t_K − F`.
 */
export function postingCapacityIntervals(
  times: PostingElectionTimes,
  constants: { readonly forcedInclusion: bigint; readonly margin: bigint },
): readonly [PostingInterval, PostingInterval] {
  const { closesAt, l1InclusionBound } = times;
  const { delivery, complaint } = deliveryDeadlines(closesAt, l1InclusionBound);
  const F = constants.forcedInclusion;
  return [
    { from: intakeCutoff(closesAt, l1InclusionBound, constants), to: delivery - F },
    { from: delivery + CONTRACT_EVENT_WINDOW, to: complaint - F },
  ];
}

/** Whether the landing span `[T, T + POSTING_DEPOSIT_SPAN)` meets none of `intervals`. */
export function postingLandingClear(T: bigint, intervals: readonly PostingInterval[]): boolean {
  const end = T + POSTING_DEPOSIT_SPAN;
  // An empty interval takes no time, so it meets nothing.
  return intervals.every((i) => !(i.from < i.to && T < i.to && i.from < end));
}

/** A deposit's L1 gas limit for an estimate: the estimate times `POSTING_GAS_HEADROOM`, rounded up (Depositing, step 1). */
export function postingDepositGasLimit(estimate: bigint): bigint {
  if (typeof estimate !== "bigint" || estimate < 0n) throw new RangeError("estimate must be ≥ 0");
  const { numerator, denominator } = POSTING_GAS_HEADROOM;
  return (estimate * numerator + denominator - 1n) / denominator;
}

/**
 * A deposit's reserve (Depositing, step 1): its L1 gas limit at the L1 fee
 * cap, plus a cancellation's gas at twice the cap, the most its nonce can
 * cost whichever of them is mined.
 */
export function postingDepositReserve(l1GasLimit: bigint, l1FeeCap: bigint): bigint {
  return l1GasLimit * l1FeeCap + POSTING_CANCEL_GAS * 2n * l1FeeCap;
}

/**
 * The most fee per L1 gas a deposit is first signed with: the largest whose
 * rise by an eighth is still within the L1 fee cap, so it can always be
 * replaced, and cancelled above it (Depositing, step 3).
 */
export function postingDepositFeeCap(l1FeeCap: bigint): bigint {
  if (!isWei(l1FeeCap)) throw new RangeError("l1FeeCap must be ≥ 0");
  let fee = (8n * l1FeeCap) / 9n;
  while (raised(fee + 1n) <= l1FeeCap) fee++;
  while (fee > 0n && raised(fee) > l1FeeCap) fee--;
  return fee;
}

/** An entry's deposit cutoff `c_F = min(c_I, c_P − F − POSTING_FINALITY)`, from its stored windows. */
function depositCutoff(intake: bigint, contract: bigint, forcedInclusion: bigint): bigint {
  const late = contract - POSTING_CLIENT_MARGIN - forcedInclusion - POSTING_FINALITY;
  return intake < late ? intake : late;
}

type Row = typeof postingDeposits.$inferSelect;
type Entry = typeof postingInFlight.$inferSelect;
type Kind = Exclude<keyof PostingDepositReport, "errors" | "unjudged">;
type Tended = { readonly kind: Kind | "none"; readonly broadcast?: Uint8Array };
const NONE: Tended = { kind: "none" };

/** The forced path's deposits over Postgres, beside `PostgresPostingLedger`. */
export class PostgresPostingDeposits {
  readonly #sql: Sql;
  readonly #chain: PostingDepositChain;
  readonly #elections: PostingRegisteredElections;
  readonly #budget: bigint;
  readonly #l1FeeCap: bigint;
  readonly #now: () => number;
  readonly #forcedInclusion: bigint;
  readonly #constants: { readonly forcedInclusion: bigint; readonly margin: bigint };
  readonly #chainTimeoutMs: number;

  constructor(options: PostgresPostingDepositsOptions) {
    const {
      forcedInclusion = PINNED_FORCED_INCLUSION,
      margin = PINNED_MARGIN,
      chainTimeoutMs = POSTING_CHAIN_TIMEOUT_MS,
    } = options;
    if (!Number.isSafeInteger(chainTimeoutMs) || chainTimeoutMs <= 0)
      throw new RangeError("chainTimeoutMs must be an integer > 0");
    if (!isWei(options.budget)) throw new RangeError("budget must be a bigint ≥ 0");
    if (!isWei(options.l1FeeCap) || options.l1FeeCap === 0n)
      throw new RangeError("l1FeeCap must be a bigint > 0");
    if (!isWei(forcedInclusion) || !isWei(margin))
      throw new RangeError("forcedInclusion and margin must be bigints ≥ 0");
    this.#sql = options.sql;
    this.#chain = options.chain;
    this.#elections = options.elections;
    this.#budget = options.budget;
    this.#l1FeeCap = options.l1FeeCap;
    this.#now = options.now;
    this.#forcedInclusion = forcedInclusion;
    this.#constants = { forcedInclusion, margin };
    this.#chainTimeoutMs = chainTimeoutMs;
  }

  #call<T>(f: () => Promise<T>): Promise<T> {
    return call(f, this.#chainTimeoutMs);
  }

  #clock(): bigint {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("now must be a UNIX time");
    return BigInt(now);
  }

  /**
   * One round of the forced path: every nonce a deposit was signed at is
   * tended (settled, rebroadcast, replaced, cancelled or, once final,
   * dropped), then, with no L1 transaction of the key pending, at most one
   * posting is deposited, then reserves no deposit can use any more are
   * released. `latest` and `finalized` are the L1 node's heads. A deposit
   * and a release are judged only on a latest head at most
   * `POSTING_HEAD_AGE` behind the clock and never ahead of it (T-25, T-54).
   */
  async tend(heads: {
    readonly latest: PostingL1Head;
    readonly finalized: PostingL1Head;
  }): Promise<PostingDepositReport> {
    for (const head of [heads.latest, heads.finalized])
      for (const v of [head.number, head.timestamp])
        if (typeof v !== "bigint" || v < 0n || v > U64_MAX)
          throw new RangeError("a head's number and timestamp must be u64s");
    const counts: Record<keyof PostingDepositReport, number> = {
      deposited: 0,
      held: 0,
      rebroadcast: 0,
      replaced: 0,
      cancelled: 0,
      landed: 0,
      failed: 0,
      unsettled: 0,
      final: 0,
      unseen: 0,
      consumed: 0,
      released: 0,
      unjudged: 0,
      errors: 0,
    };
    const send = async (t: Tended) => {
      if (t.kind !== "none") counts[t.kind]++;
      const tx = t.broadcast;
      if (tx === undefined) return;
      try {
        await this.#call(() => this.#chain.broadcast(tx));
      } catch {
        // Dropped: rebroadcast from the record after `POSTING_RESEND`.
      }
    };

    let nonces: bigint[];
    try {
      const rows = await drizzle({ client: this.#sql })
        .select({ nonce: postingDeposits.nonce })
        .from(postingDeposits)
        .orderBy(asc(postingDeposits.nonce));
      nonces = rows.map((r) => r.nonce);
    } catch (e) {
      throw scrubbed(e);
    }
    for (const nonce of nonces) {
      try {
        await send(await this.#tendNonce(nonce, heads));
      } catch {
        counts.errors++;
      }
    }

    const now = this.#clock();
    const T = heads.latest.timestamp;
    // A head from the future would move the landing span off the times the
    // deposit can land at, and release reserves early (T-25, T-54).
    if (T > now || now - T > BigInt(POSTING_HEAD_AGE)) return counts;
    try {
      const d = await this.#depositOne(T, now);
      if (d === "unjudged") counts.unjudged = 1;
      else {
        counts.held += d.held;
        await send(d.tended);
      }
    } catch {
      counts.errors++;
    }
    try {
      const r = await this.#release(T);
      counts.released += r.released;
      counts.errors += r.errors;
    } catch (e) {
      throw scrubbed(e);
    }
    return counts;
  }

  /** The key's L1 count, in form. */
  async #nonce(block?: bigint): Promise<bigint> {
    const n = await this.#call(() =>
      block === undefined ? this.#chain.nonce() : this.#chain.nonceAt(block),
    );
    if (!isWei(n) || n > U64_MAX)
      throw new PostingLedgerError("the L1 node answered a nonce out of form");
    return n;
  }

  async #receipt(hash: Uint8Array): Promise<PostingL1Receipt | undefined> {
    const r = await this.#call(() => this.#chain.receipt(hash));
    if (r === undefined) return undefined;
    if (
      typeof r.success !== "boolean" ||
      !isWei(r.gasUsed) ||
      !isWei(r.effectiveGasPrice) ||
      !isWei(r.block) ||
      r.block > U64_MAX
    )
      throw new PostingLedgerError("the L1 node answered a receipt out of form");
    return r;
  }

  /** One nonce's tend, in one transaction under the ledger's lock. */
  #tendNonce(
    nonce: bigint,
    heads: { readonly latest: PostingL1Head; readonly finalized: PostingL1Head },
  ): Promise<Tended> {
    return drizzle({ client: this.#sql }).transaction(
      async (tx): Promise<Tended> => {
        await tx.execute(LOCK);
        await tx.execute(q`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
        const now = this.#clock();
        const [row] = await tx
          .select()
          .from(postingDeposits)
          .where(eq(postingDeposits.nonce, nonce));
        if (row === undefined) return NONE;
        const [entry] = await tx
          .select()
          .from(postingInFlight)
          .where(eq(postingInFlight.postingKey, row.postingKey));
        const reserve = BigInt(row.reserve);
        // A finalized head past the latest, or ahead of the clock, is a
        // faulty or lying node's: nothing is made final on it, since a final
        // nonce is never judged again (T-25, T-52).
        const finalized =
          heads.finalized.number <= heads.latest.number && heads.finalized.timestamp <= now
            ? heads.finalized.number
            : undefined;

        if (row.final) {
          // Its posting's entry is gone: nothing of it is needed any more.
          if (entry === undefined) await dropNonce(tx, nonce);
          return NONE;
        }

        if (row.settledIn !== null) {
          const r = await this.#receipt(new Uint8Array(row.settledIn));
          if (r === undefined || r.block !== row.settledBlock) {
            // Its block left the latest L1 head: pending again, and named
            // again while it may still land.
            await tx
              .update(postingDeposits)
              .set({ settledIn: null, landed: null, paid: null, settledBlock: null })
              .where(eq(postingDeposits.nonce, nonce));
            await nameDeposit(tx, row.postingKey);
            return { kind: "unsettled" };
          }
          if (finalized === undefined || r.block > finalized) return NONE;
          // Final: the nonce's reserve is replaced by what its receipt shows.
          const paid = r.gasUsed * r.effectiveGasPrice;
          await settleSpend(tx, row, entry, paid - reserve);
          await tx
            .update(postingDeposits)
            .set({ paid: paid.toString(), final: true })
            .where(eq(postingDeposits.nonce, nonce));
          if (entry === undefined) await dropNonce(tx, nonce);
          return { kind: "final" };
        }

        // Pending. The count before the receipts, so a transaction of this
        // nonce that consumed it is seen below on one view of the chain.
        const count = await this.#nonce();
        const deposits = hashesOf(new Uint8Array(row.deposits));
        const cancels = hashesOf(new Uint8Array(row.cancels));
        for (const [hashes, deposit] of [
          [deposits, true],
          [cancels, false],
        ] as const)
          for (const hash of hashes) {
            const r = await this.#receipt(hash);
            if (r === undefined) continue;
            const landed = deposit && r.success;
            await tx
              .update(postingDeposits)
              .set({
                settledIn: hash,
                landed,
                paid: (r.gasUsed * r.effectiveGasPrice).toString(),
                settledBlock: r.block,
              })
              .where(eq(postingDeposits.nonce, nonce));
            // A landed deposit is never sent again and stays the posting's
            // last transaction; otherwise its newest L2 transaction is.
            if (landed) await namedL1(tx, row.postingKey, hash);
            else if (entry !== undefined) await nameNewestL2(tx, entry);
            return { kind: landed ? "landed" : "failed" };
          }
        if (count > nonce) {
          // The count is past the nonce, but no receipt of its transactions
          // is seen: a lagging receipt index or an endpoint behind a
          // balancer, since the key is used for nothing else. One of them
          // may have landed, so the nonce stays pending, holding every other
          // deposit back and its reserve counted, and is never cancelled or
          // replaced. Only once the count is past it at the L1's finalized
          // head too is it settled, as landed, so it is never deposited
          // again, its reserve kept as what it cost (Known-weak).
          if (finalized === undefined || (await this.#nonce(finalized)) <= nonce)
            return { kind: "unseen" };
          await settleSpend(tx, row, entry, 0n);
          await tx
            .update(postingDeposits)
            .set({ landed: true, paid: reserve.toString(), final: true })
            .where(eq(postingDeposits.nonce, nonce));
          if (entry === undefined) await dropNonce(tx, nonce);
          return { kind: "consumed" };
        }

        const maxFee = BigInt(row.maxFee);
        const priorityFee = BigInt(row.priorityFee);
        const cancelling = cancels.length > 0;
        const latest = heads.latest.timestamp > now ? heads.latest.timestamp : now;
        if (
          !cancelling &&
          (row.signed === null ||
            entry === undefined ||
            latest >= row.landingFrom + POSTING_DEPOSIT_PATIENCE)
        ) {
          // Too long out of an L1 block, or its posting's entry gone: raced
          // by a cancellation, so the race is run inside the span it was
          // checked for, the clock as well as the head so a stalled node
          // doesn't hold it back (T-54); or, with the entry gone, so its
          // calldata doesn't stay pending (T-18).
          const fees = { maxFee: raised(maxFee), priorityFee: raised(priorityFee) };
          return this.#cancel(tx, row, fees, now, "cancelled");
        }
        if (now - row.signedAt >= 2n * POSTING_RESEND) {
          const fees = { maxFee: raised(maxFee), priorityFee: raised(priorityFee) };
          if (cancelling) {
            if (fees.maxFee <= 2n * this.#l1FeeCap)
              return this.#cancel(tx, row, fees, now, "replaced");
          } else if (raised(fees.maxFee) <= this.#l1FeeCap && entry !== undefined) {
            // Replaced while it can still be replaced, and cancelled, once
            // more within the cap.
            const s = await this.#call(() =>
              this.#chain.signDeposit(new Uint8Array(entry.posting), new Uint8Array(entry.ballot), {
                nonce,
                gasLimit: entry.gasLimit,
                l1GasLimit: row.l1GasLimit,
                feeCap: this.#l1FeeCap,
                fees,
              }),
            );
            checkSigned(s, this.#l1FeeCap);
            if (s.maxFee !== fees.maxFee || s.priorityFee !== fees.priorityFee)
              throw new PostingLedgerError("the posting key signed other fees");
            await tx
              .update(postingDeposits)
              .set({
                maxFee: s.maxFee.toString(),
                priorityFee: s.priorityFee.toString(),
                signed: s.tx,
                deposits: Buffer.concat([row.deposits, s.hash]),
                signedAt: now,
                broadcastAt: now,
              })
              .where(eq(postingDeposits.nonce, nonce));
            await namedL1(tx, row.postingKey, s.hash);
            return { kind: "replaced", broadcast: s.tx };
          }
        }
        if (row.signed !== null && now - row.broadcastAt >= POSTING_RESEND) {
          await tx
            .update(postingDeposits)
            .set({ broadcastAt: now })
            .where(eq(postingDeposits.nonce, nonce));
          return { kind: "rebroadcast", broadcast: new Uint8Array(row.signed) };
        }
        return NONE;
      },
      { isolationLevel: "read committed" },
    );
  }

  /** Signs and records a cancellation at the row's nonce with exactly `fees`, up to twice the L1 fee cap. */
  async #cancel(
    tx: Tx,
    row: Row,
    fees: { readonly maxFee: bigint; readonly priorityFee: bigint },
    now: bigint,
    kind: "cancelled" | "replaced",
  ): Promise<Tended> {
    const s = await this.#call(() => this.#chain.signCancel({ nonce: row.nonce, fees }));
    checkSigned(s, 2n * this.#l1FeeCap);
    if (s.maxFee !== fees.maxFee || s.priorityFee !== fees.priorityFee)
      throw new PostingLedgerError("the posting key signed other fees");
    await tx
      .update(postingDeposits)
      .set({
        maxFee: s.maxFee.toString(),
        priorityFee: s.priorityFee.toString(),
        signed: s.tx,
        cancels: Buffer.concat([row.cancels, s.hash]),
        signedAt: now,
        broadcastAt: now,
      })
      .where(eq(postingDeposits.nonce, row.nonce));
    return { kind, broadcast: s.tx };
  }

  /**
   * At most one deposit (Depositing), in one transaction under the ledger's
   * lock, on the L1 head `T`: of the postings due one, oldest first sent
   * first, the first that the budget allows and the conditions admit.
   */
  #depositOne(
    T: bigint,
    now: bigint,
  ): Promise<{ readonly tended: Tended; readonly held: number } | "unjudged"> {
    return drizzle({ client: this.#sql }).transaction(
      async (tx) => {
        await tx.execute(LOCK);
        await tx.execute(q`SET LOCAL idle_in_transaction_session_timeout = '30s'`);
        const d = postingDeposits;
        // At most one L1 transaction of the key pending: one signed behind a
        // stuck nonce couldn't be mined, or cancelled, within its span.
        const [pending] = await tx
          .select({ nonce: d.nonce })
          .from(d)
          .where(and(q`${d.settledIn} IS NULL`, eq(d.final, false)))
          .limit(1);
        if (pending !== undefined) return { tended: NONE, held: 0 };
        const due = await tx
          .select()
          .from(postingInFlight)
          .where(lte(postingInFlight.firstSent, now - POSTING_FORCE_AFTER))
          .orderBy(asc(postingInFlight.firstSent), asc(postingInFlight.nonce));
        let intervals: PostingInterval[] | undefined;
        let held = 0;
        for (const entry of due) {
          const cF = depositCutoff(entry.intakeCutoff, entry.contractCutoff, this.#forcedInclusion);
          if (T + POSTING_DEPOSIT_SPAN > cF) continue;
          const rows = await tx.select().from(d).where(eq(d.postingKey, entry.postingKey));
          // A landed deposit is never sent again (Known-weak).
          if (rows.some((r) => r.landed === true)) continue;
          // The pure checks before any node call under the lock: the
          // elections' times are read once a tend, and a posting due inside
          // an interval waits for its end.
          if (intervals === undefined) {
            const times = await this.#call(() => this.#elections.times());
            if (times === undefined) return "unjudged";
            intervals = times.flatMap((t) => [...this.#intervals(t)]);
          }
          if (!postingLandingClear(T, intervals)) continue;
          if (!(await this.#unsafe(entry))) continue;

          const posting = new Uint8Array(entry.posting);
          const ballot = new Uint8Array(entry.ballot);
          const estimate = await this.#call(() =>
            this.#chain.estimate(posting, ballot, entry.gasLimit),
          );
          if (estimate === undefined) continue;
          if (!isWei(estimate))
            throw new PostingLedgerError("the L1 node answered an estimate out of form");
          const l1GasLimit = postingDepositGasLimit(estimate);
          if (l1GasLimit === 0n || l1GasLimit > POSTING_L1_GAS_LIMIT_MAX) continue;

          // Counts it: a first deposit raises the counted reserve to its own
          // if lower, any later one adds its own whole (step 2).
          const reserve = postingDepositReserve(l1GasLimit, this.#l1FeeCap);
          const counted = BigInt(entry.deposit);
          const first = rows.length === 0;
          const raise = first ? (reserve > counted ? reserve - counted : 0n) : reserve;
          const [spend] = await tx
            .select({ spent: postingSpend.spent })
            .from(postingSpend)
            .where(eq(postingSpend.electionId, entry.electionId))
            .for("update");
          if (spend === undefined)
            throw new PostingLedgerError("the posting ledger's spend is missing");
          if (BigInt(spend.spent) + raise > this.#budget) {
            held++;
            continue;
          }

          // Signs and records it (step 3), at the key's next nonce on L1.
          const count = await this.#nonce();
          const [highest] = await tx.select({ nonce: max(d.nonce) }).from(d);
          if (highest?.nonce != null && highest.nonce >= count) return { tended: NONE, held };
          if (count > I64_MAX)
            throw new PostingLedgerError("the posting key's nonce is out of range");
          const feeCap = postingDepositFeeCap(this.#l1FeeCap);
          const s = await this.#call(() =>
            this.#chain.signDeposit(posting, ballot, {
              nonce: count,
              gasLimit: entry.gasLimit,
              l1GasLimit,
              feeCap,
            }),
          );
          checkSigned(s, feeCap);
          if (raise > 0n) {
            await tx
              .update(postingSpend)
              .set({ spent: q`${postingSpend.spent} + ${raise.toString()}::numeric` })
              .where(eq(postingSpend.electionId, entry.electionId));
            await tx
              .update(postingInFlight)
              .set({
                cost: (BigInt(entry.cost) + raise).toString(),
                deposit: (counted + raise).toString(),
              })
              .where(eq(postingInFlight.postingKey, entry.postingKey));
          }
          await tx.insert(d).values({
            nonce: count,
            postingKey: entry.postingKey,
            electionId: entry.electionId,
            l1GasLimit,
            landingFrom: T,
            reserve: (first && counted > reserve ? counted : reserve).toString(),
            maxFee: s.maxFee.toString(),
            priorityFee: s.priorityFee.toString(),
            signed: s.tx,
            deposits: s.hash,
            cancels: new Uint8Array(0),
            signedAt: now,
            broadcastAt: now,
          });
          await namedL1(tx, entry.postingKey, s.hash);
          return { tended: { kind: "deposited", broadcast: s.tx }, held };
        }
        return { tended: NONE, held };
      },
      { isolationLevel: "read committed" },
    );
  }

  /**
   * Whether none of the entry's L2 transactions, and no `SharePosted` event
   * with its exact bytes, is at the L2's safe head: a censoring sequencer
   * can show a call in blocks it never batches, so a soft confirmation
   * never stands in for inclusion (T-50).
   */
  async #unsafe(entry: Entry): Promise<boolean> {
    for (const hash of hashesOf(new Uint8Array(entry.transactions))) {
      const included = await this.#call(() => this.#chain.includedSafe(hash));
      if (typeof included !== "boolean")
        throw new PostingLedgerError("the L2 node answered an inclusion out of form");
      if (included) return false;
    }
    const posted = await this.#call(() => this.#chain.postedSafe(new Uint8Array(entry.posting)));
    if (typeof posted !== "boolean")
      throw new PostingLedgerError("the L2 node answered an event out of form");
    return !posted;
  }

  #intervals(t: PostingElectionTimes): readonly [PostingInterval, PostingInterval] {
    return postingCapacityIntervals(t, this.#constants);
  }

  /**
   * Releases each posting's counted reserve that its deposits' nonces don't
   * hold, once none of them is pending and none can be sent any more: the
   * L1 head `T` has passed its `c_F` (its bytes final is the prune's).
   */
  async #release(T: bigint): Promise<{ released: number; errors: number }> {
    const rows = await drizzle({ client: this.#sql })
      .select({ key: postingInFlight.postingKey })
      .from(postingInFlight)
      .where(q`${postingInFlight.deposit} > 0`);
    let released = 0;
    let errors = 0;
    for (const { key } of rows) {
      try {
        const done = await drizzle({ client: this.#sql }).transaction(
          async (tx) => {
            await tx.execute(LOCK);
            const [entry] = await tx
              .select()
              .from(postingInFlight)
              .where(eq(postingInFlight.postingKey, key));
            if (entry === undefined) return false;
            const cF = depositCutoff(
              entry.intakeCutoff,
              entry.contractCutoff,
              this.#forcedInclusion,
            );
            if (T <= cF) return false;
            const rows = await tx
              .select()
              .from(postingDeposits)
              .where(eq(postingDeposits.postingKey, key));
            if (rows.some((r) => r.settledIn === null && !r.final)) return false;
            const heldByNonces = rows
              .filter((r) => !r.final)
              .reduce((sum, r) => sum + BigInt(r.reserve), 0n);
            const unheld = BigInt(entry.deposit) - heldByNonces;
            if (unheld <= 0n) return false;
            await settleSpend(tx, { electionId: entry.electionId }, entry, -unheld, unheld);
            return true;
          },
          { isolationLevel: "read committed" },
        );
        if (done) released++;
      } catch {
        errors++;
      }
    }
    return { released, errors };
  }
}

/**
 * Moves the election's spend by `delta`, if it still has one (its `t_D` may
 * have passed, deleting it), and takes `reserve` (the nonce's, by default)
 * out of the entry's counted reserve and most cost, if it is still in flight.
 */
async function settleSpend(
  tx: Tx,
  row: { readonly electionId: Uint8Array; readonly reserve?: string },
  entry: Entry | undefined,
  delta: bigint,
  reserve: bigint = BigInt(row.reserve ?? "0"),
): Promise<void> {
  if (delta !== 0n)
    await tx
      .update(postingSpend)
      .set({ spent: q`${postingSpend.spent} + ${delta.toString()}::numeric` })
      .where(eq(postingSpend.electionId, row.electionId));
  if (entry === undefined || reserve === 0n) return;
  const deposit = BigInt(entry.deposit);
  const taken = reserve > deposit ? deposit : reserve;
  await tx
    .update(postingInFlight)
    .set({
      cost: (BigInt(entry.cost) - taken).toString(),
      deposit: (deposit - taken).toString(),
    })
    .where(eq(postingInFlight.postingKey, entry.postingKey));
}

async function dropNonce(tx: Tx, nonce: bigint): Promise<void> {
  await tx.delete(postingDeposits).where(eq(postingDeposits.nonce, nonce));
}

/** Names the L1 deposit `hash` as the posting's last transaction. */
async function namedL1(tx: Tx, key: Uint8Array, hash: Uint8Array): Promise<void> {
  if (!isHash(hash)) throw new PostingLedgerError("the posting key signed out of form");
  await tx
    .update(postingSent)
    .set({ transaction: hash, layer: "l1" })
    .where(eq(postingSent.postingKey, key));
}

/** Names the posting's newest deposit that is pending or landed, once a nonce of it may land again. */
async function nameDeposit(tx: Tx, key: Uint8Array): Promise<void> {
  const d = postingDeposits;
  const [row] = await tx
    .select({ deposits: d.deposits })
    .from(d)
    .where(
      and(
        eq(d.postingKey, key),
        or(and(q`${d.settledIn} IS NULL`, eq(d.final, false)), eq(d.landed, true)),
      ),
    )
    .orderBy(desc(d.nonce))
    .limit(1);
  if (row === undefined) return;
  const newest = hashesOf(new Uint8Array(row.deposits)).at(-1);
  if (newest !== undefined) await namedL1(tx, key, newest);
}

/** Names the entry's newest L2 transaction: its newest in a block, else its newest signed. */
async function nameNewestL2(tx: Tx, entry: Entry): Promise<void> {
  const landed = entry.landedIn === null ? [] : hashesOf(new Uint8Array(entry.landedIn));
  const sent = hashesOf(new Uint8Array(entry.transactions));
  const newest = landed[landed.length - 1] ?? sent[sent.length - 1];
  if (newest === undefined) return;
  await tx
    .update(postingSent)
    .set({ transaction: newest, layer: "l2" })
    .where(eq(postingSent.postingKey, entry.postingKey));
}
