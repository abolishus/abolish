// The key ceremony's coordinator ([[0032-poll-creation-operations]], rules 5
// to 7; P2-22 part 4c): one run per stub the stub step recorded, its four
// rounds relayed between the default panel's seats and their approvals
// collected, with its state in Postgres so the API that serves the seats
// and the worker that closes rounds at their deadlines share it.
//
// The coordinator is trusted for liveness only (docs/spec/ceremony.md,
// Parties and keys): it holds nothing secret, every message it relays is
// signed by its seat, and every seat and the verifier check the transcript
// again (T-37, T-54). Seats don't authenticate to it otherwise, so it keeps
// a seat's message only when crypto's `ceremonyMessageFits` takes it (the
// seat's signature over the closed rounds, and a shape that can't make the
// whole transcript fail), and only the first per seat and round; an
// approval only when it verifies under the seat's pinned key. Anyone else's
// post changes nothing (T-54).
//
// A round closes when every seat has sent, or at its deadline
// (`closeCeremonyRounds`, the worker's), with the messages it holds in seat
// order. A round that closes with fewer than rule 7's `max(k, n − 1)`
// messages, or a transcript with fewer qualified seats, can never be
// approved by an honest seat (docs/spec/ceremony.md, Approval), so the run
// ends there rather than at its last deadline.
//
// T-10: operational, as the stubs are; nothing here names an account, a
// poll or a voter, and the reports are counts.

import {
  type CeremonyTranscript,
  ceremonyMessageFits,
  checkCeremonyTranscript,
  DecodeError,
  decodeCeremonyTranscript,
  decodeElectionDefinitionV5,
  encodeCeremonyTranscript,
  keySetEntry,
  keySetHash,
  type Panel,
  panelId,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import { and, asc, eq, isNull, lt, lte, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  accountPolls,
  ceremonyApprovals,
  ceremonyMessages,
  ceremonyRuns,
  ceremonyStubs,
} from "./db/schema/index.ts";
import type { PollStubDeployment } from "./poll-stubs.ts";

/** What the coordinator takes from the deployment: the default panel and where it is pinned. */
export type CoordinatorDeployment = Pick<
  PollStubDeployment,
  "l2ChainId" | "trusteeRegistry" | "panel"
>;

/** What the coordinator asks of a seat: the stub and the run's transcript so far. */
export interface CoordinatorRequest {
  readonly stub: Uint8Array;
  readonly transcript: Uint8Array;
}

/** Most requests one poll returns, as the seats' transport bounds them. */
export const MAX_COORDINATOR_REQUESTS = 16;

/** Why a post was refused, or `accepted`; a refused post changes nothing. */
export type PostOutcome =
  | "accepted"
  /** No run of this stub is in a round that takes the post. */
  | "not-open"
  /** The body isn't a version-1 transcript. */
  | "malformed"
  /** It doesn't fit the open round as this seat's message, or doesn't verify. */
  | "refused"
  /** The seat already has a message in this round, or an approval. */
  | "already-sent";

const FIELDS = ["keys", "challenges", "answers", "reveals"] as const;
const EMPTY = { keys: [], challenges: [], answers: [], reveals: [] } as const;

/** Rule 7's quorum: the qualified seats every honest seat requires before it approves. */
const quorum = (panel: Panel) => Math.max(panel.threshold, panel.keys.length - 1);

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One run's outcome counts (T-10, T-67). */
export interface OpenRunsReport {
  opened: number;
  /** Stubs whose panel, L2 or trustee registry isn't the deployment's: left unopened. */
  mismatched: number;
  /** Stubs whose `opens_at` has passed: left for the retry under rule 10. */
  expired: number;
}

/**
 * Opens a run, with a fresh `run_id` from the CSPRNG, for every poll in
 * `ceremony` whose current stub has none, asking every seat for round 1. A
 * stub whose panel identifier, L2 chain or trustee registry isn't the
 * deployment's, or whose election identifier isn't the one recorded beside
 * it, is left unopened: no seat of this panel could approve it. Safe to
 * rerun: one run per stub.
 */
export async function openCeremonyRuns(
  client: Sql,
  deployment: CoordinatorDeployment,
  options: { readonly now: Date },
): Promise<OpenRunsReport> {
  const db = drizzle({ client });
  const report: OpenRunsReport = { opened: 0, mismatched: 0, expired: 0 };
  const stubs = await db
    .select({
      stubHash: ceremonyStubs.stubHash,
      stub: ceremonyStubs.stub,
      electionId: ceremonyStubs.electionId,
      opensAt: ceremonyStubs.opensAt,
    })
    .from(accountPolls)
    .innerJoin(ceremonyStubs, eq(ceremonyStubs.stubHash, accountPolls.stubHash))
    .leftJoin(ceremonyRuns, eq(ceremonyRuns.stubHash, ceremonyStubs.stubHash))
    .where(and(eq(accountPolls.state, "ceremony"), isNull(ceremonyRuns.runId)))
    .orderBy(asc(ceremonyStubs.createdAt), asc(ceremonyStubs.stubHash));
  const id = panelId(deployment.panel);
  const now = BigInt(Math.floor(options.now.getTime() / 1000));
  for (const s of stubs) {
    let stub;
    try {
      stub = decodeElectionDefinitionV5(s.stub);
    } catch (e) {
      // The table holds only version-5 records the stub step built; one that
      // doesn't decode is left, rather than stopping every run behind it.
      if (!(e instanceof DecodeError)) throw e;
      report.mismatched++;
      continue;
    }
    if (
      !equal(stub.election_id, s.electionId) ||
      !equal(stub.panel_id, id) ||
      stub.l2_chain_id !== deployment.l2ChainId ||
      !equal(stub.trustee_registry, deployment.trusteeRegistry)
    ) {
      report.mismatched++;
      continue;
    }
    if (s.opensAt <= now) {
      report.expired++;
      continue;
    }
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const opened = await db
      .insert(ceremonyRuns)
      .values({
        runId,
        stubHash: s.stubHash,
        round: 1,
        roundOpenedAt: options.now,
        eligible: deployment.panel.keys.map((_, i) => i + 1),
        transcript: encodeCeremonyTranscript({ run_id: runId, ...EMPTY }),
        createdAt: options.now,
      })
      .onConflictDoNothing({ target: ceremonyRuns.stubHash })
      .returning({ runId: ceremonyRuns.runId });
    report.opened += opened.length;
  }
  return report;
}

const validSeat = (deployment: CoordinatorDeployment, seat: number) =>
  Number.isSafeInteger(seat) && seat >= 1 && seat <= deployment.panel.keys.length;

/**
 * What the coordinator asks of `seat` now, oldest run first, for polls still
 * in `ceremony`: the open round of every run where the seat can still send
 * (every seat in round 1, round 1's senders in rounds 2 and 3, round 2's in
 * round 4) and hasn't, and, once a run's transcript checks, its approval if
 * the seat qualified and hasn't approved.
 */
export async function coordinatorRequests(
  client: Sql,
  deployment: CoordinatorDeployment,
  seat: number,
): Promise<CoordinatorRequest[]> {
  if (!validSeat(deployment, seat)) return [];
  const db = drizzle({ client });
  const rows = await db
    .select({ stub: ceremonyStubs.stub, transcript: ceremonyRuns.transcript })
    .from(ceremonyRuns)
    .innerJoin(ceremonyStubs, eq(ceremonyStubs.stubHash, ceremonyRuns.stubHash))
    .where(
      sql`EXISTS (SELECT 1 FROM ${accountPolls} WHERE ${accountPolls.stubHash} = ${ceremonyRuns.stubHash}
          AND ${accountPolls.state} = 'ceremony')
        AND ${seat} = ANY(${ceremonyRuns.eligible}) AND ((${ceremonyRuns.round} <= 4 AND NOT EXISTS (
          SELECT 1 FROM ${ceremonyMessages} WHERE ${ceremonyMessages.runId} = ${ceremonyRuns.runId}
            AND ${ceremonyMessages.round} = ${ceremonyRuns.round} AND ${ceremonyMessages.seat} = ${seat}))
        OR (${ceremonyRuns.round} = 5 AND NOT EXISTS (
          SELECT 1 FROM ${ceremonyApprovals} WHERE ${ceremonyApprovals.runId} = ${ceremonyRuns.runId}
            AND ${ceremonyApprovals.seat} = ${seat})))`,
    )
    .orderBy(asc(ceremonyRuns.createdAt), asc(ceremonyRuns.runId))
    .limit(MAX_COORDINATOR_REQUESTS);
  return rows.map((r) => ({
    stub: Uint8Array.from(r.stub),
    transcript: Uint8Array.from(r.transcript),
  }));
}

interface LockedRun {
  readonly runId: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly electionId: Uint8Array;
  readonly round: number;
  readonly transcript: Uint8Array;
  readonly eligible: number[];
  readonly transcriptHash: Uint8Array | null;
  readonly keySetHash: Uint8Array | null;
  readonly qualified: number[] | null;
}

// The run's row, locked until the transaction ends when `lock` is set, so
// a post and a close never interleave.
async function readRun(
  tx: Db | Tx,
  where: SQL | undefined,
  lock: boolean,
): Promise<LockedRun | undefined> {
  const query = tx
    .select({
      runId: ceremonyRuns.runId,
      stubHash: ceremonyRuns.stubHash,
      electionId: ceremonyStubs.electionId,
      round: ceremonyRuns.round,
      transcript: ceremonyRuns.transcript,
      eligible: ceremonyRuns.eligible,
      transcriptHash: ceremonyRuns.transcriptHash,
      keySetHash: ceremonyRuns.keySetHash,
      qualified: ceremonyRuns.qualified,
    })
    .from(ceremonyRuns)
    .innerJoin(ceremonyStubs, eq(ceremonyStubs.stubHash, ceremonyRuns.stubHash))
    .where(where);
  const [run] = await (lock ? query.for("update", { of: ceremonyRuns }) : query);
  return run;
}

const lockRun = (tx: Tx, where: SQL | undefined) => readRun(tx, where, true);

const params = (d: CoordinatorDeployment, run: LockedRun) => ({
  l2ChainId: d.l2ChainId,
  trusteeRegistry: d.trusteeRegistry,
  electionId: run.electionId,
  stubHash: run.stubHash,
  panel: d.panel,
});

/**
 * Seat `seat`'s message for the open round of the run of `stubHash`: a
 * version-1 transcript of the run holding only that message. Kept if it is
 * the seat's first for the round and fits (`ceremonyMessageFits`); the
 * round closes at once when every seat that can send in it has.
 *
 * The fit check, which verifies every closed message's signature, runs
 * before the run's lock, against the run as read; under the lock the post
 * is kept only if the run is still in that round, whose closed rounds are
 * then the ones it was checked against (rounds only move forward). So a
 * flood of refused posts never holds the lock honest posts and the
 * worker's close wait on (T-54).
 */
export async function postCeremonyMessage(
  client: Sql,
  deployment: CoordinatorDeployment,
  seat: number,
  post: { readonly stubHash: Uint8Array; readonly transcript: Uint8Array },
  options: { readonly now: Date },
): Promise<PostOutcome> {
  if (!validSeat(deployment, seat)) return "refused";
  let message: CeremonyTranscript;
  try {
    message = decodeCeremonyTranscript(post.transcript, 1);
  } catch (e) {
    if (e instanceof DecodeError) return "malformed";
    throw e;
  }
  const db = drizzle({ client });
  const read = await readRun(db, eq(ceremonyRuns.stubHash, post.stubHash), false);
  if (read === undefined || read.round > 4) return "not-open";
  const field = FIELDS[read.round - 1] as (typeof FIELDS)[number];
  if (message[field][0]?.index !== seat || !read.eligible.includes(seat)) return "refused";
  const closed = decodeCeremonyTranscript(read.transcript, 1);
  if (!ceremonyMessageFits(params(deployment, read), closed, message)) return "refused";
  return db.transaction(async (tx) => {
    const run = await lockRun(
      tx,
      and(eq(ceremonyRuns.runId, read.runId), eq(ceremonyRuns.round, read.round)),
    );
    // The round closed meanwhile: the message was for rounds that moved on.
    if (run === undefined) return "not-open";
    const kept = await tx
      .insert(ceremonyMessages)
      .values({
        runId: run.runId,
        round: run.round,
        seat,
        message: encodeCeremonyTranscript(message),
        receivedAt: options.now,
      })
      .onConflictDoNothing()
      .returning({ seat: ceremonyMessages.seat });
    if (kept.length === 0) return "already-sent";
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(ceremonyMessages)
      .where(and(eq(ceremonyMessages.runId, run.runId), eq(ceremonyMessages.round, run.round)));
    if (count === run.eligible.length) await closeRound(tx, deployment, run, options.now);
    return "accepted";
  });
}

/**
 * Seat `seat`'s ceremony registration signature for the run of `stubHash`,
 * once its transcript checked: kept if the seat qualified, the hashes are
 * the run's own and the signature verifies under the seat's pinned key. The
 * approvals close at once when every qualified seat has approved.
 */
export async function postCeremonyApproval(
  client: Sql,
  deployment: CoordinatorDeployment,
  seat: number,
  post: {
    readonly stubHash: Uint8Array;
    readonly ceremonyTranscriptHash: Uint8Array;
    readonly keySetHash: Uint8Array;
    readonly signature: Uint8Array;
  },
  options: { readonly now: Date },
): Promise<PostOutcome> {
  if (!validSeat(deployment, seat)) return "refused";
  const db = drizzle({ client });
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, eq(ceremonyRuns.stubHash, post.stubHash));
    if (run === undefined || run.round !== 5) return "not-open";
    // The table holds all three from round 5 on.
    const qualified = run.qualified as number[];
    if (
      !qualified.includes(seat) ||
      !equal(post.ceremonyTranscriptHash, run.transcriptHash as Uint8Array) ||
      !equal(post.keySetHash, run.keySetHash as Uint8Array) ||
      !verifyCeremonyRegistration(
        deployment.panel,
        {
          l2ChainId: deployment.l2ChainId,
          trusteeRegistry: deployment.trusteeRegistry,
          index: seat,
          stubHash: run.stubHash,
          ceremonyTranscriptHash: post.ceremonyTranscriptHash,
          keySetHash: post.keySetHash,
        },
        post.signature,
      )
    )
      return "refused";
    const kept = await tx
      .insert(ceremonyApprovals)
      .values({ runId: run.runId, seat, signature: post.signature, receivedAt: options.now })
      .onConflictDoNothing()
      .returning({ seat: ceremonyApprovals.seat });
    if (kept.length === 0) return "already-sent";
    const approved = await approvalCount(tx, run.runId);
    if (approved === qualified.length)
      await tx
        .update(ceremonyRuns)
        .set({ round: 6, outcome: "approved" })
        .where(eq(ceremonyRuns.runId, run.runId));
    return "accepted";
  });
}

async function approvalCount(tx: Tx, runId: Uint8Array): Promise<number> {
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(ceremonyApprovals)
    .where(eq(ceremonyApprovals.runId, runId));
  return count;
}

// Closes the locked run's open round (1 to 4) with the messages it holds,
// in seat order, and opens the next, or the approvals once round 4 closes
// with a transcript that checks; ends the run when rule 7's quorum can no
// longer be met.
async function closeRound(
  tx: Tx,
  deployment: CoordinatorDeployment,
  run: LockedRun,
  now: Date,
): Promise<void> {
  const rows = await tx
    .select({ message: ceremonyMessages.message })
    .from(ceremonyMessages)
    .where(and(eq(ceremonyMessages.runId, run.runId), eq(ceremonyMessages.round, run.round)))
    .orderBy(asc(ceremonyMessages.seat));
  const field = FIELDS[run.round - 1] as (typeof FIELDS)[number];
  const closed = decodeCeremonyTranscript(run.transcript, 1);
  const messages = rows.map((r) => decodeCeremonyTranscript(r.message, 1)[field][0]);
  const transcript = encodeCeremonyTranscript({ ...closed, [field]: messages });
  const set = (values: Partial<typeof ceremonyRuns.$inferInsert>) =>
    tx.update(ceremonyRuns).set(values).where(eq(ceremonyRuns.runId, run.runId));
  if (messages.length < quorum(deployment.panel))
    return void (await set({ transcript, round: 6, outcome: "too-few-messages" }));
  // Round 1's senders answer in rounds 2 and 3; only round 2's reveal (the
  // transcript check's order rule).
  if (run.round < 4) {
    // Round 1's senders can send in rounds 2 and 3, and only round 2's in
    // round 4 (the transcript check's order rule): no one else is asked, and
    // the next round closes once they have all sent.
    const next = decodeCeremonyTranscript(transcript, 1)[run.round < 3 ? "keys" : "challenges"];
    return void (await set({
      transcript,
      round: run.round + 1,
      roundOpenedAt: now,
      eligible: next.map((m) => m.index),
    }));
  }
  const check = checkCeremonyTranscript(params(deployment, run), transcript, 1);
  if (!check.ok || check.registered.length < quorum(deployment.panel))
    return void (await set({ transcript, round: 6, outcome: "transcript-refused" }));
  await set({
    transcript,
    round: 5,
    roundOpenedAt: now,
    transcriptHash: check.hash,
    keySetHash: keySetHash(check.registered.map(keySetEntry)),
    qualified: check.registered.map((k) => k.index),
    eligible: check.registered.map((k) => k.index),
  });
}

/** One close run's counts. */
export interface CloseRoundsReport {
  /** Rounds 1 to 4 closed at their deadline. */
  closed: number;
  /** Runs that ended, by outcome. */
  ended: Partial<
    Record<"approved" | "too-few-messages" | "transcript-refused" | "too-few-approvals", number>
  >;
}

/**
 * The worker's half: closes every round, and every run's approvals, open
 * for `roundSeconds` or longer. Approvals that close with at least rule 7's
 * quorum end the run `approved`; fewer, `too-few-approvals`. Safe to rerun
 * and to race with posts: each run is closed under its row's lock, and only
 * if it is still in the round that was read.
 */
export async function closeCeremonyRounds(
  client: Sql,
  deployment: CoordinatorDeployment,
  options: { readonly now: Date; readonly roundSeconds: number },
): Promise<CloseRoundsReport> {
  const db = drizzle({ client });
  const report: CloseRoundsReport = { closed: 0, ended: {} };
  const deadline = new Date(options.now.getTime() - options.roundSeconds * 1000);
  const due = await db
    .select({ runId: ceremonyRuns.runId, round: ceremonyRuns.round })
    .from(ceremonyRuns)
    .where(and(lt(ceremonyRuns.round, 6), lte(ceremonyRuns.roundOpenedAt, deadline)))
    .orderBy(asc(ceremonyRuns.roundOpenedAt), asc(ceremonyRuns.runId));
  for (const d of due) {
    const outcome = await db.transaction(async (tx) => {
      const run = await lockRun(
        tx,
        and(eq(ceremonyRuns.runId, d.runId), eq(ceremonyRuns.round, d.round)),
      );
      if (run === undefined) return undefined;
      if (run.round <= 4) {
        await closeRound(tx, deployment, run, options.now);
        const [after] = await tx
          .select({ outcome: ceremonyRuns.outcome })
          .from(ceremonyRuns)
          .where(eq(ceremonyRuns.runId, run.runId));
        report.closed++;
        return after?.outcome ?? undefined;
      }
      const outcome =
        (await approvalCount(tx, run.runId)) >= quorum(deployment.panel)
          ? "approved"
          : "too-few-approvals";
      await tx
        .update(ceremonyRuns)
        .set({ round: 6, outcome })
        .where(eq(ceremonyRuns.runId, run.runId));
      return outcome;
    });
    if (outcome !== undefined && outcome !== null) {
      const o = outcome as keyof CloseRoundsReport["ended"];
      report.ended[o] = (report.ended[o] ?? 0) + 1;
    }
  }
  return report;
}

/** An approved run, as registration needs it. */
export interface ApprovedCeremony {
  readonly transcript: Uint8Array;
  readonly transcriptHash: Uint8Array;
  readonly keySetHash: Uint8Array;
  /** The approvals, in seat order. */
  readonly approvals: readonly { readonly seat: number; readonly signature: Uint8Array }[];
}

/** The approved run of `stubHash`, or `undefined` while it has none. */
export async function approvedCeremony(
  client: Sql,
  stubHash: Uint8Array,
): Promise<ApprovedCeremony | undefined> {
  const db = drizzle({ client });
  const [run] = await db
    .select()
    .from(ceremonyRuns)
    .where(and(eq(ceremonyRuns.stubHash, stubHash), eq(ceremonyRuns.outcome, "approved")));
  if (run === undefined) return undefined;
  const approvals = await db
    .select({ seat: ceremonyApprovals.seat, signature: ceremonyApprovals.signature })
    .from(ceremonyApprovals)
    .where(eq(ceremonyApprovals.runId, run.runId))
    .orderBy(asc(ceremonyApprovals.seat));
  return {
    transcript: Uint8Array.from(run.transcript),
    // The table holds both on every approved run.
    transcriptHash: Uint8Array.from(run.transcriptHash as Uint8Array),
    keySetHash: Uint8Array.from(run.keySetHash as Uint8Array),
    approvals: approvals.map((a) => ({ seat: a.seat, signature: Uint8Array.from(a.signature) })),
  };
}
