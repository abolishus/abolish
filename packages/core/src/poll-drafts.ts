// An author's polls before setup ([[0032-poll-creation-operations]]; P2-22
// part 2): drafts an account writes, edits and submits, and the creator
// record each becomes. The worker (part 3 on) takes a submitted poll through
// creation, roots, the ceremony and registration; this module writes drafts,
// moves them to `submitted`, and lets the author retry or discard a poll that
// failed in setup (part 5d-2).
//
// A draft is checked by the definition's own rules from @abolishus/crypto
// (display text version 2's shape rules and version 5's question rules), so a
// poll the registry would refuse is refused at the form, with the rule it
// broke, before it costs a Turnstile solve or any gas (T-28, T-34, T-72).
//
// T-10: the record is in the account class. It holds the author's account and
// their own text, never anything about who answers. T-52, T-72: an account
// keeps at most `MAX_DRAFTS` unsubmitted drafts, has at most
// `MAX_POLLS_IN_SETUP` polls in setup and submits at most
// `MAX_SUBMISSIONS_PER_DAY` in any 24 hours, each submission paid for with a
// Turnstile solve for `poll-create`. These are starting values (ADR 0032,
// rule 18). Every submission is counted in `account_poll_submissions`, kept
// whatever becomes of its poll, so a retried or discarded poll's submission
// still counts for its 24 hours, and each retry is a submission of its own.

import { and, asc, desc, eq, gt, inArray, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { newAccountId } from "./accounts.ts";
import { accountPolls, accountPollSubmissions, electionRegistrations } from "./db/schema/index.ts";
import {
  type PollDraft,
  type PollDraftProblem,
  pollDraftProblem,
  type PollState,
} from "./poll-draft-rules.ts";
import { type PollFailure, retryableFailure } from "./poll-failures.ts";
import type { Turnstile } from "./turnstile.ts";

export * from "./poll-draft-rules.ts";

/** Unsubmitted drafts one account may keep. */
export const MAX_DRAFTS = 20;
/** Polls of one account between `submitted` and `open` at once (ADR 0032, rule 18). */
export const MAX_POLLS_IN_SETUP = 3;
/** Polls one account may submit in any 24 hours (ADR 0032, rule 18). */
export const MAX_SUBMISSIONS_PER_DAY = 10;
/** The newest polls `listAccountPolls` returns. */
export const MAX_LISTED_POLLS = 100;

/** The states a submitted poll holds setup capacity in. */
const IN_SETUP: readonly PollState[] = ["submitted", "created", "rooted", "ceremony", "registered"];

export type PollDraftErrorCode =
  /** No poll with this ID belongs to this account. */
  | "not-found"
  /** The poll was submitted: only a draft can be edited, deleted or submitted. */
  | "not-editable"
  /** The poll isn't `failed`: only a failed poll can be retried or discarded. */
  | "not-failed"
  /**
   * The poll failed with its election registered on chain
   * (`REGISTERED_FAILURES`, or the registry sync has its registration): its
   * row stays as the election's creator record, never retried or discarded.
   */
  | "registered"
  /** The draft breaks a rule: `problem` says which. */
  | "refused"
  | "too-many-drafts"
  | "too-many-in-setup"
  | "too-many-today"
  | "challenge-refused"
  | "challenge-unavailable";

export class PollDraftError extends Error {
  override readonly name = "PollDraftError";
  readonly code: PollDraftErrorCode;
  readonly problem: PollDraftProblem | undefined;
  constructor(code: PollDraftErrorCode, problem?: PollDraftProblem) {
    super(problem === undefined ? `poll draft: ${code}` : `poll draft: ${code} (${problem.rule})`);
    this.code = code;
    this.problem = problem;
  }
}

function check(draft: PollDraft, now?: bigint) {
  const problem = pollDraftProblem(draft, now);
  if (problem !== undefined) throw new PollDraftError("refused", problem);
}

/** A draft as the table stores it: JSON, with `closesAt` a decimal string. */
interface StoredDraft extends Omit<PollDraft, "closesAt"> {
  readonly closesAt: string;
}

const store = (d: PollDraft): StoredDraft => ({
  language: d.language,
  title: d.title,
  description: d.description,
  questions: d.questions.map((q) => ({
    question: q.question,
    description: q.description,
    options: q.options.map((o) => ({ label: o.label, description: o.description })),
    minSelections: q.minSelections,
    maxSelections: q.maxSelections,
  })),
  tiers: [...d.tiers],
  closesAt: d.closesAt.toString(),
});

const load = (d: StoredDraft): PollDraft => ({ ...d, closesAt: BigInt(d.closesAt) });

const seconds = (now: Date) => BigInt(Math.floor(now.getTime() / 1000));

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One account's lock on its polls, so two requests can't both pass a limit. */
const lock = (tx: Tx, accountId: string) =>
  tx.execute(q`SELECT pg_advisory_xact_lock(hashtextextended(${`account_polls:${accountId}`}, 0))`);

const owned = (accountId: string, id: string) =>
  and(eq(accountPolls.id, id), eq(accountPolls.userId, accountId));

/**
 * Saves `draft` as a new poll of `accountId`, returning its ID. Refused, with
 * nothing written: a draft that breaks a rule (`refused`) and an account
 * already holding `MAX_DRAFTS` drafts (`too-many-drafts`).
 */
export async function createPollDraft(
  client: Sql,
  accountId: string,
  draft: PollDraft,
  now: Date,
): Promise<string> {
  check(draft);
  const id = newAccountId();
  await drizzle({ client }).transaction(async (tx) => {
    await lock(tx, accountId);
    const drafts = await tx.$count(
      accountPolls,
      and(eq(accountPolls.userId, accountId), eq(accountPolls.state, "drafted")),
    );
    if (drafts >= MAX_DRAFTS) throw new PollDraftError("too-many-drafts");
    await tx.insert(accountPolls).values({
      id,
      userId: accountId,
      state: "drafted",
      draft: store(draft),
      createdAt: now,
      updatedAt: now,
    });
  });
  return id;
}

/**
 * The draft of `accountId`'s poll `id`, its row locked for this transaction:
 * `not-found` if the account has no such poll, `not-editable` once submitted.
 */
async function editable(tx: Tx, accountId: string, id: string): Promise<PollDraft> {
  const [row] = await tx
    .select({ state: accountPolls.state, draft: accountPolls.draft })
    .from(accountPolls)
    .where(owned(accountId, id))
    .for("update");
  if (row === undefined) throw new PollDraftError("not-found");
  if (row.state !== "drafted") throw new PollDraftError("not-editable");
  return load(row.draft as StoredDraft);
}

/** Replaces the draft of `accountId`'s poll `id`, which must still be a draft. */
export async function updatePollDraft(
  client: Sql,
  accountId: string,
  id: string,
  draft: PollDraft,
  now: Date,
): Promise<void> {
  check(draft);
  await drizzle({ client }).transaction(async (tx) => {
    await editable(tx, accountId, id);
    await tx
      .update(accountPolls)
      .set({ draft: store(draft), updatedAt: now })
      .where(eq(accountPolls.id, id));
  });
}

/** Deletes `accountId`'s poll `id`, which must still be a draft. */
export async function deletePollDraft(client: Sql, accountId: string, id: string): Promise<void> {
  await drizzle({ client }).transaction(async (tx) => {
    await editable(tx, accountId, id);
    await tx.delete(accountPolls).where(eq(accountPolls.id, id));
  });
}

/** One of an account's polls. */
export interface AccountPoll {
  readonly id: string;
  readonly state: PollState;
  readonly draft: PollDraft;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The current submission's time; none for a draft. */
  readonly submittedAt: Date | undefined;
  /** Why setup failed, for a `failed` poll: apps/web words it. */
  readonly failure: PollFailure | undefined;
}

const poll = (r: typeof accountPolls.$inferSelect): AccountPoll => ({
  id: r.id,
  // The migration's check admits only these.
  state: r.state as PollState,
  draft: load(r.draft as StoredDraft),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  submittedAt: r.submittedAt ?? undefined,
  // The migrations' check admits only these, and only on a failed poll.
  failure: (r.failure as PollFailure | null) ?? undefined,
});

/** `accountId`'s poll `id`, or `undefined` if it has none by that ID. */
export async function readAccountPoll(
  client: Sql,
  accountId: string,
  id: string,
): Promise<AccountPoll | undefined> {
  const [row] = await drizzle({ client }).select().from(accountPolls).where(owned(accountId, id));
  return row === undefined ? undefined : poll(row);
}

/** `accountId`'s newest `MAX_LISTED_POLLS` polls, newest first. */
export async function listAccountPolls(client: Sql, accountId: string): Promise<AccountPoll[]> {
  const rows = await drizzle({ client })
    .select()
    .from(accountPolls)
    .where(eq(accountPolls.userId, accountId))
    .orderBy(desc(accountPolls.createdAt), asc(accountPolls.id))
    .limit(MAX_LISTED_POLLS);
  return rows.map(poll);
}

export interface SubmitPollOptions {
  readonly turnstile: Turnstile;
  /** The token the form's widget solved for `poll-create`, if any. */
  readonly token: string | null;
  readonly now: Date;
}

/** The limit `accountId` is at, if any, as of `now`. */
async function limitReached(
  db: Db | Tx,
  accountId: string,
  now: Date,
): Promise<PollDraftErrorCode | undefined> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const setup = await db.$count(
    accountPolls,
    and(eq(accountPolls.userId, accountId), inArray(accountPolls.state, [...IN_SETUP])),
  );
  if (setup >= MAX_POLLS_IN_SETUP) return "too-many-in-setup";
  // T-72: counted from the submissions, not the polls, so neither a retry
  // (which clears the poll's `submitted_at`) nor a discard (which deletes
  // the poll) gives a submission back before its 24 hours are up.
  const today = await db.$count(
    accountPollSubmissions,
    and(
      eq(accountPollSubmissions.userId, accountId),
      gt(accountPollSubmissions.submittedAt, dayAgo),
    ),
  );
  if (today >= MAX_SUBMISSIONS_PER_DAY) return "too-many-today";
  return undefined;
}

/**
 * Submits `accountId`'s draft `id` for setup. Checked in order, cheapest
 * first, so a refused submission never spends the author's solve: the poll
 * (`not-found`, `not-editable`), its draft at `now` (`refused`), the account's
 * limits (`too-many-in-setup`, `too-many-today`), then the Turnstile token.
 * The state, the draft and the limits are checked again under the account's
 * lock before the write, since the token's round trip lets an edit or a
 * second submission land in between.
 */
export async function submitPollDraft(
  client: Sql,
  accountId: string,
  id: string,
  { turnstile, token, now }: SubmitPollOptions,
): Promise<void> {
  const current = await readAccountPoll(client, accountId, id);
  if (current === undefined) throw new PollDraftError("not-found");
  if (current.state !== "drafted") throw new PollDraftError("not-editable");
  check(current.draft, seconds(now));
  const db = drizzle({ client });
  const limit = await limitReached(db, accountId, now);
  if (limit !== undefined) throw new PollDraftError(limit);
  const verdict = await turnstile.verify(token, "poll-create");
  if (verdict === "unavailable") throw new PollDraftError("challenge-unavailable");
  if (verdict !== "passed") throw new PollDraftError("challenge-refused");
  await db.transaction(async (tx) => {
    await lock(tx, accountId);
    check(await editable(tx, accountId, id), seconds(now));
    const again = await limitReached(tx, accountId, now);
    if (again !== undefined) throw new PollDraftError(again);
    await tx
      .update(accountPolls)
      .set({ state: "submitted", submittedAt: now, updatedAt: now })
      .where(eq(accountPolls.id, id));
    await tx.insert(accountPollSubmissions).values({ userId: accountId, submittedAt: now });
  });
}

/**
 * `accountId`'s failed poll `id`, its row locked for this transaction:
 * `not-found` if the account has no such poll, `not-failed` unless it
 * failed, and `registered` if its election is registered on chain, by its
 * failure or by the registry sync's record of a registration under its
 * identifier (a step's verdict and the chain could disagree only through a
 * bug or a stolen key; either way the creator record stays, T-68).
 */
async function lockFailed(tx: Tx, accountId: string, id: string): Promise<void> {
  const [row] = await tx
    .select({
      state: accountPolls.state,
      failure: accountPolls.failure,
      electionId: accountPolls.electionId,
    })
    .from(accountPolls)
    .where(owned(accountId, id))
    .for("update");
  if (row === undefined) throw new PollDraftError("not-found");
  // The migrations' check gives every failed poll a failure.
  if (row.state !== "failed" || row.failure === null) throw new PollDraftError("not-failed");
  if (!retryableFailure(row.failure as PollFailure)) throw new PollDraftError("registered");
  if (row.electionId === null) return;
  const registered = await tx.$count(
    electionRegistrations,
    eq(electionRegistrations.electionId, row.electionId),
  );
  if (registered > 0) throw new PollDraftError("registered");
}

/**
 * Everything setup wrote on a poll, as a draft has it. A retried poll is a
 * draft again: its next submission is created afresh, under a new election
 * identifier, so nothing of the old one may carry over (the migrations'
 * checks refuse most of it on a draft anyway): the old creation, which could
 * otherwise become the new draft's (0013), the identifier's L1 origin and
 * per-slot check (0015), the electorate (0016), the stub (0017) and the
 * registration transactions (0019). `abandoned_ids` restarts: it bounds the
 * identifiers one submission abandons, and the next submission is counted
 * and paid for again (T-69, T-72).
 */
const DRAFTED = {
  state: "drafted",
  failure: null,
  submittedAt: null,
  creatorAddress: null,
  createTxHash: null,
  electionId: null,
  createdBlock: null,
  l1OriginTimestamp: null,
  anchorsCheckedBlock: null,
  abandonedIds: 0,
  electorate: null,
  stubHash: null,
  ceremonyTxHash: null,
  registerTxHash: null,
  registeredBlock: null,
} as const satisfies Partial<typeof accountPolls.$inferInsert>;

/**
 * Returns `accountId`'s failed poll `id` to its draft (ADR 0032, rule 14),
 * for the author to edit and submit again: setup starts over, from a new
 * creation, only through `submitPollDraft`, so a retry passes every check a
 * first submission does (the draft and its closing time against the setup
 * still ahead, the limits and a Turnstile solve) and counts as a submission
 * of its own (T-72). Refused, with nothing written: `not-found`,
 * `not-failed`, `registered`, and `too-many-drafts` for an account already
 * holding `MAX_DRAFTS` drafts. The old election identifier is left unused,
 * as an abandoned one is (rule 16).
 */
export async function retryFailedPoll(
  client: Sql,
  accountId: string,
  id: string,
  now: Date,
): Promise<void> {
  await drizzle({ client }).transaction(async (tx) => {
    await lock(tx, accountId);
    await lockFailed(tx, accountId, id);
    const drafts = await tx.$count(
      accountPolls,
      and(eq(accountPolls.userId, accountId), eq(accountPolls.state, "drafted")),
    );
    if (drafts >= MAX_DRAFTS) throw new PollDraftError("too-many-drafts");
    await tx
      .update(accountPolls)
      .set({ ...DRAFTED, updatedAt: now })
      .where(eq(accountPolls.id, id));
  });
}

/**
 * Deletes `accountId`'s failed poll `id` (ADR 0032, rule 14). Its
 * submission stays counted for its 24 hours, in `account_poll_submissions`
 * (T-72). Refused, with nothing written: `not-found`, `not-failed` and
 * `registered`.
 */
export async function discardFailedPoll(client: Sql, accountId: string, id: string): Promise<void> {
  await drizzle({ client }).transaction(async (tx) => {
    await lockFailed(tx, accountId, id);
    await tx.delete(accountPolls).where(eq(accountPolls.id, id));
  });
}
