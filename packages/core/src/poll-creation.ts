// The creation step of a poll's setup ([[0032-poll-creation-operations]],
// rules 4, 12, 14 and 18; P2-22 part 3a): each submitted poll gets its own
// `createElection()` from the creation key, and moves to `created` once that
// transaction's `ElectionCreated` event is in finalized L2 history, with the
// identifier the event gave. The chain adapter signs, sends and reads; this
// module decides what to send and when a poll moves on.
//
// Write before send (rule 12): a creation is signed, recorded (the key, the
// nonce, the signed bytes and their hash in `poll_creation_txs`, the hash on
// the poll's row) and committed before it is broadcast. A run after a crash
// at any point finds the record and sends the same bytes again, or reads
// their receipt, and never signs a second creation for a poll. Nonces come
// from the record as well as the node, under one lock, so two runs never
// sign at one nonce. The transactions outlive their polls and authors, so
// deleting an account frees no ceiling slot and leaves no nonce unsent.
//
// T-10: only the creation key's public transactions, and on the author's own
// record which one is theirs and the identifier it gave; nothing about a
// voter.
// T-25: `created` means finalized, so a reorganisation can't hand the
// identifier the ceremony will name to someone else. T-52, T-72: at most
// `dailyCeiling` creations are sent in any 24 hours, whoever submitted them.

import { and, asc, count, eq, gt, gte, isNull, max, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { accountPolls, pollCreationTxs } from "./db/schema/index.ts";
import { MIN_OPEN_SECONDS, type PollDraft, SETUP_SECONDS } from "./poll-drafts.ts";

/** A creation signed and not yet sent. */
export interface SignedCreation {
  /** The signed transaction's bytes, as `eth_sendRawTransaction` takes them. */
  readonly tx: Uint8Array;
  /** Its hash. */
  readonly hash: Uint8Array;
}

/** What the chain says of one recorded creation, judged at the node's finalized block. */
export type CreationStatus =
  /** The node knows nothing of it: not sent yet, dropped, or replaced. */
  | { readonly state: "unknown" }
  /** Known to the node, and not yet final. */
  | { readonly state: "included" }
  /** Final, and reverted. */
  | { readonly state: "reverted" }
  /** Final, with the creation key's `ElectionCreated` event. */
  | { readonly state: "created"; readonly electionId: Uint8Array; readonly block: bigint };

/** The creation key on L2, as the creation step uses it (the worker's `ViemPollCreationChain`). */
export interface PollCreationChain {
  /** The creation key's address, 20 bytes. */
  readonly creator: Uint8Array;
  /**
   * The key's transaction counts at the node's finalized and latest blocks
   * and with its pending ones: every nonce below `finalized` is spent for good.
   */
  nonces(): Promise<{
    readonly finalized: bigint;
    readonly latest: bigint;
    readonly pending: bigint;
  }>;
  /** Signs `createElection()` at `nonce`, sending nothing. */
  signCreation(nonce: bigint): Promise<SignedCreation>;
  /** Sends a signed creation; resolves if the node took it or already had it. */
  broadcast(tx: Uint8Array): Promise<void>;
  /** The creation whose transaction hash is `hash`, at the node's finalized block. */
  creation(hash: Uint8Array): Promise<CreationStatus>;
}

/**
 * How long a creation may take, from its recording to finality, before its
 * poll fails with `creation-timeout`: L2 finality is tens of minutes, so two
 * hours is a node or a fee that isn't moving (rule 14).
 */
export const CREATION_DEADLINE_MS = 2 * 60 * 60_000;

/** Creations sent in any 24 hours, as the starting value of rule 18 on staging. */
export const CREATE_DAILY_CEILING = 200;

/** Most new creations one run signs; the next run takes the rest. */
export const CREATIONS_PER_RUN = 20;

/** Why the creation step fails a poll (the `failure` column's codes it writes). */
export type CreationFailure =
  /** The draft closes too soon for setup, judged again before any gas is spent. */
  | "closes-too-soon"
  /** The creation reverted in finalized history. */
  | "creation-reverted"
  /** Another transaction of the key took the creation's nonce in finalized history. */
  | "creation-replaced"
  /** Not created within `CREATION_DEADLINE_MS` of its recording. */
  | "creation-timeout";

/** One run's outcome, in counts only (T-10, T-67). */
export interface PollCreationReport {
  /** Creations signed, recorded and sent for the first time. */
  sent: number;
  /** Recorded creations sent again, not yet included. */
  resent: number;
  /** Sends the node refused; the next run sends them again. */
  sendFailed: number;
  /** Polls moved to `created`. */
  created: number;
  /** Polls moved to `failed`, by reason. */
  failed: Partial<Record<CreationFailure, number>>;
  /** Whether the daily ceiling held back a submitted poll. */
  ceilingReached: boolean;
}

export interface PollCreationOptions {
  readonly now: Date;
  /** `CREATE_DAILY_CEILING` unless the deployment sets another. */
  readonly dailyCeiling?: number;
  /** `CREATION_DEADLINE_MS` unless a test says otherwise. */
  readonly deadlineMs?: number;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * One run of the creation step for `chain`'s key: sends again every recorded
 * creation not yet included, moves each creation that finalized (to
 * `created`, or `failed` if it reverted or its nonce went to another
 * transaction), fails those past the deadline, then signs, records and sends
 * a creation for each submitted poll that has none, oldest first, while the
 * daily ceiling allows. Each step is safe to rerun after a crash at any point.
 */
export async function advancePollCreations(
  client: Sql,
  chain: PollCreationChain,
  options: PollCreationOptions,
): Promise<PollCreationReport> {
  if (chain.creator.length !== 20) throw new RangeError("the creator must be a 20-byte address");
  const ceiling = options.dailyCeiling ?? CREATE_DAILY_CEILING;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0)
    throw new RangeError("the daily ceiling must be a whole number");
  const deadline = options.deadlineMs ?? CREATION_DEADLINE_MS;
  const { now } = options;
  const db = drizzle({ client });
  const creator = chain.creator.slice();
  const report: PollCreationReport = {
    sent: 0,
    resent: 0,
    sendFailed: 0,
    created: 0,
    failed: {},
    ceilingReached: false,
  };
  const fail = async (id: string, failure: CreationFailure) => {
    // Only from `submitted`: a poll another run already moved keeps its state.
    const moved = await db
      .update(accountPolls)
      .set({ state: "failed", failure, updatedAt: now })
      .where(and(eq(accountPolls.id, id), eq(accountPolls.state, "submitted")))
      .returning({ id: accountPolls.id });
    if (moved.length > 0) report.failed[failure] = (report.failed[failure] ?? 0) + 1;
  };
  const send = async (tx: Uint8Array) => {
    try {
      await chain.broadcast(tx);
      return true;
    } catch {
      // The node's answer can quote the transaction; the count is enough,
      // and the record makes the next run send it again.
      report.sendFailed++;
      return false;
    }
  };
  const late = (sentAt: Date) => now.getTime() - sentAt.getTime() > deadline;

  // 1. Every recorded transaction of this key whose nonce the node hasn't
  // seen included, whatever became of its poll or its author: a later nonce
  // can't land before it, so it is sent until it lands or is replaced.
  const nonces = await chain.nonces();
  const open = await db
    .select({ tx: pollCreationTxs.tx })
    .from(pollCreationTxs)
    .where(
      and(eq(pollCreationTxs.creatorAddress, creator), gte(pollCreationTxs.nonce, nonces.latest)),
    )
    .orderBy(asc(pollCreationTxs.nonce));
  for (const r of open) if (await send(r.tx)) report.resent++;

  // 2. Each submitted poll with a creation: whether it finalized, and as what.
  const recorded = await db
    .select({
      id: accountPolls.id,
      hash: pollCreationTxs.txHash,
      nonce: pollCreationTxs.nonce,
      sentAt: pollCreationTxs.sentAt,
    })
    .from(accountPolls)
    .leftJoin(pollCreationTxs, eq(pollCreationTxs.txHash, accountPolls.createTxHash))
    .where(and(eq(accountPolls.state, "submitted"), eq(accountPolls.creatorAddress, creator)))
    .orderBy(asc(pollCreationTxs.nonce));
  for (const r of recorded) {
    // A poll whose transaction isn't in the ledger (a partial wipe by hand)
    // can't be followed: failed, so it doesn't sit in setup for good.
    if (r.hash === null || r.nonce === null || r.sentAt === null) {
      await fail(r.id, "creation-timeout");
      continue;
    }
    if (r.nonce >= nonces.latest) {
      if (late(r.sentAt)) await fail(r.id, "creation-timeout");
      continue;
    }
    const status = await chain.creation(r.hash);
    if (status.state === "created") {
      if (status.electionId.length !== 32) throw new Error("the chain gave a malformed identifier");
      const moved = await db
        .update(accountPolls)
        .set({
          state: "created",
          electionId: status.electionId.slice(),
          createdBlock: status.block,
          updatedAt: now,
        })
        .where(and(eq(accountPolls.id, r.id), eq(accountPolls.state, "submitted")))
        .returning({ id: accountPolls.id });
      report.created += moved.length;
    } else if (status.state === "reverted") await fail(r.id, "creation-reverted");
    // The node knows nothing of the transaction, and its nonce is spent in
    // finalized history: another transaction of the key took it, which only
    // a key used elsewhere does (the runbook's sign of compromise).
    else if (status.state === "unknown" && r.nonce < nonces.finalized)
      await fail(r.id, "creation-replaced");
    else if (late(r.sentAt)) await fail(r.id, "creation-timeout");
  }

  // 3. New creations, oldest submission first.
  const waiting = await db
    .select({ id: accountPolls.id, draft: accountPolls.draft })
    .from(accountPolls)
    .where(and(eq(accountPolls.state, "submitted"), isNull(accountPolls.createTxHash)))
    .orderBy(asc(accountPolls.submittedAt), asc(accountPolls.id))
    .limit(CREATIONS_PER_RUN);
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  for (const w of waiting) {
    // Submission allowed for setup from then; this is now, before any gas.
    const { closesAt } = w.draft as { closesAt: string } & Omit<PollDraft, "closesAt">;
    if (BigInt(closesAt) < seconds + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS)) {
      await fail(w.id, "closes-too-soon");
      continue;
    }
    const signed = await db.transaction(async (tx) => {
      // One signer at a time, across runs, processes and keys, so the
      // ceiling, which is global, is never passed by two at once.
      await tx.execute(q`SELECT pg_advisory_xact_lock(hashtextextended('poll-creation', 0))`);
      const [sentToday] = await tx
        .select({ n: count() })
        .from(pollCreationTxs)
        .where(gt(pollCreationTxs.sentAt, new Date(now.getTime() - DAY_MS)));
      if (sentToday!.n >= ceiling) {
        report.ceilingReached = true;
        return "ceiling";
      }
      const [row] = await tx
        .select({ state: accountPolls.state, recorded: accountPolls.createTxHash })
        .from(accountPolls)
        .where(eq(accountPolls.id, w.id))
        .for("update");
      if (row === undefined || row.state !== "submitted" || row.recorded !== null) return undefined;
      const [last] = await tx
        .select({ nonce: max(pollCreationTxs.nonce) })
        .from(pollCreationTxs)
        .where(eq(pollCreationTxs.creatorAddress, creator));
      // The record covers a transaction the node dropped (step 1 sends it
      // again); the node's pending count, one sent by the key elsewhere.
      const { pending } = await chain.nonces();
      const recordedNext = last?.nonce == null ? 0n : last.nonce + 1n;
      const nonce = pending > recordedNext ? pending : recordedNext;
      const creation = await chain.signCreation(nonce);
      if (creation.hash.length !== 32 || creation.tx.length === 0)
        throw new Error("the chain signed a malformed creation");
      await tx.insert(pollCreationTxs).values({
        creatorAddress: creator,
        nonce,
        tx: creation.tx.slice(),
        txHash: creation.hash.slice(),
        sentAt: now,
      });
      await tx
        .update(accountPolls)
        .set({ creatorAddress: creator, createTxHash: creation.hash.slice(), updatedAt: now })
        .where(eq(accountPolls.id, w.id));
      return creation;
    });
    if (signed === "ceiling") break;
    if (signed === undefined) continue;
    // Committed: only now is it sent (rule 12).
    if (await send(signed.tx)) report.sent++;
  }
  return report;
}
