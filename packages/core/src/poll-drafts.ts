// An author's polls before setup ([[0032-poll-creation-operations]]; P2-22
// part 2): drafts an account writes, edits and submits, and the creator
// record each becomes. The worker (part 3 on) takes a submitted poll through
// creation, roots, the ceremony and registration; this module only writes
// drafts and moves them to `submitted`.
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
// rule 18).

import {
  definitionQuestionsRule,
  DISPLAY_TEXT_V2_LIMITS,
  type DisplayTextV2Rule,
  displayTextV2ShapeRule,
  EncodeError,
  encodeDisplayTextV2,
  PARAMETERS,
  QUESTION_METHODS,
  TIERS,
} from "@abolishus/crypto";
import { and, asc, desc, eq, gt, inArray, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { newAccountId } from "./accounts.ts";
import { accountPolls } from "./db/schema/index.ts";
import type { Turnstile } from "./turnstile.ts";

/** One option of a question, in the author's words. */
export interface DraftOption {
  readonly label: string;
  readonly description: string;
}

/** One question: its text, its options and how many of them an answer picks. */
export interface DraftQuestion {
  readonly question: string;
  readonly description: string;
  readonly options: readonly DraftOption[];
  /** The fewest options an answer picks; 0 lets a voter leave the question blank. */
  readonly minSelections: number;
  readonly maxSelections: number;
}

/**
 * What an author writes: one translation of display text version 2, who can
 * answer and when the poll closes. Everything else in the definition (the
 * election identifier, the electorate's roots, the panel, `opens_at`) is the
 * worker's, set during setup (ADR 0032, rules 8 to 11).
 */
export interface PollDraft {
  /** A BCP 47 tag in lower case, as display text requires. */
  readonly language: string;
  readonly title: string;
  readonly description: string;
  readonly questions: readonly DraftQuestion[];
  /** The identity tiers that can answer, ascending. */
  readonly tiers: readonly number[];
  /** UNIX time in seconds. */
  readonly closesAt: bigint;
}

/**
 * Most bytes a draft's display text may encode to: well under the protocol's
 * `MAX_DISPLAY_TEXT`, which is for every translation of a poll, and room
 * enough for 32 questions with short options. Bounds what a cheap account
 * stores (T-52).
 */
export const MAX_DRAFT_TEXT = 32 * 1024;

/** Unsubmitted drafts one account may keep. */
export const MAX_DRAFTS = 20;
/** Polls of one account between `submitted` and `open` at once (ADR 0032, rule 18). */
export const MAX_POLLS_IN_SETUP = 3;
/** Polls one account may submit in any 24 hours (ADR 0032, rule 18). */
export const MAX_SUBMISSIONS_PER_DAY = 10;
/** The newest polls `listAccountPolls` returns. */
export const MAX_LISTED_POLLS = 100;

/**
 * Seconds from submission to the earliest `opens_at` the worker sets: the
 * ceremony and registration need it (ADR 0032, rule 10).
 */
export const SETUP_SECONDS = 30 * 60;
/** The shortest a poll can be open, from that earliest `opens_at`. */
export const MIN_OPEN_SECONDS = 60 * 60;
/** The furthest ahead of submission a poll can close. */
export const MAX_CLOSE_SECONDS = 366 * 24 * 60 * 60;

/** A poll's states (ADR 0032, rule 12). Only `drafted` is editable. */
export const POLL_STATES = [
  "drafted",
  "submitted",
  "created",
  "rooted",
  "ceremony",
  "registered",
  "open",
  "failed",
] as const;
export type PollState = (typeof POLL_STATES)[number];

/** The states a submitted poll holds setup capacity in. */
const IN_SETUP: readonly PollState[] = ["submitted", "created", "rooted", "ceremony", "registered"];

/**
 * Why a draft is refused, in checking order: `text` (a string that isn't
 * well-formed Unicode, or holds U+0000), the question rules of definition version 5
 * (`questions`, `option-count`, `selections`, the last two naming the first
 * failing question), `too-long` (a field over its codec bound, or the whole
 * text over `MAX_DRAFT_TEXT`), display text version 2's shape rules
 * (`language-tag`, `question`, `labels`, `question-texts`), `tiers`, and at
 * submission only, `closes-at`.
 */
export type PollDraftRule =
  | "text"
  | "questions"
  | "option-count"
  | "selections"
  | "too-long"
  | Exclude<DisplayTextV2Rule, "commitment" | "translations" | "question-count">
  | "tiers"
  | "closes-at";

export interface PollDraftProblem {
  readonly rule: PollDraftRule;
  /** For `option-count` and `selections`: the first failing question. */
  readonly question?: number;
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * A lone surrogate half (with the `u` flag a pair is one code point, so only
 * a lone half matches), or U+0000, which a jsonb column can't hold.
 */
const UNSTORABLE = /[\p{Cs}\0]/u;

const strings = (d: PollDraft) => [
  d.language,
  d.title,
  d.description,
  ...d.questions.flatMap((q) => [
    q.question,
    q.description,
    ...q.options.flatMap((o) => [o.label, o.description]),
  ]),
];

/**
 * The first rule `draft` breaks, or `undefined`. With `now` (UNIX seconds),
 * also whether it can be submitted then: it must close at least
 * `MIN_OPEN_SECONDS` after the earliest opening, `SETUP_SECONDS` away, and
 * within `MAX_CLOSE_SECONDS`.
 */
export function pollDraftProblem(draft: PollDraft, now?: bigint): PollDraftProblem | undefined {
  // A lone surrogate would be encoded as U+FFFD, so the text registered
  // would differ from the draft the author saw (T-34); U+0000 couldn't be
  // stored at all.
  if (strings(draft).some((s) => UNSTORABLE.test(s))) return { rule: "text" };
  // The codec bounds the list; past it, the rule's own message is clearer.
  if (draft.questions.length > DISPLAY_TEXT_V2_LIMITS.maxQuestions) return { rule: "questions" };
  const questions = draft.questions.map((q) => ({
    method: QUESTION_METHODS.selection,
    option_count: q.options.length,
    min_selections: q.minSelections,
    max_selections: q.maxSelections,
  }));
  const failure = definitionQuestionsRule(questions);
  if (failure !== undefined) return failure;
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const text = {
    salt: new Uint8Array(PARAMETERS.DISPLAY_TEXT_SALT_LEN),
    translations: [
      {
        language: utf8(draft.language),
        title: utf8(draft.title),
        description: utf8(draft.description),
        questions: draft.questions.map((q) => ({
          question: utf8(q.question),
          description: utf8(q.description),
          options: q.options.map((o) => ({
            label: utf8(o.label),
            description: utf8(o.description),
          })),
        })),
      },
    ],
  };
  try {
    if (encodeDisplayTextV2(text).length > MAX_DRAFT_TEXT) return { rule: "too-long" };
  } catch (e) {
    // The selection counts were checked above, so what's left is a string
    // over its field's bound.
    if (e instanceof EncodeError) return { rule: "too-long" };
    throw e;
  }
  const shape = displayTextV2ShapeRule(
    text,
    questions.map((q) => q.option_count),
  );
  // `translations`, `question-count` and `option-count` can't fail: there is
  // one translation, built from the questions just checked.
  if (shape !== undefined) return { rule: shape as PollDraftRule };
  const tiers = draft.tiers;
  if (
    tiers.length === 0 ||
    !tiers.every(
      (t, i) => (TIERS as readonly number[]).includes(t) && (i === 0 || tiers[i - 1]! < t),
    )
  )
    return { rule: "tiers" };
  if (draft.closesAt < 0n || draft.closesAt > U64_MAX) return { rule: "closes-at" };
  if (
    now !== undefined &&
    (draft.closesAt < now + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS) ||
      draft.closesAt > now + BigInt(MAX_CLOSE_SECONDS))
  )
    return { rule: "closes-at" };
  return undefined;
}

export type PollDraftErrorCode =
  /** No poll with this ID belongs to this account. */
  | "not-found"
  /** The poll was submitted: only a draft can be edited, deleted or submitted. */
  | "not-editable"
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
  readonly submittedAt: Date | undefined;
}

const poll = (r: typeof accountPolls.$inferSelect): AccountPoll => ({
  id: r.id,
  // The migration's check admits only these.
  state: r.state as PollState,
  draft: load(r.draft as StoredDraft),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  submittedAt: r.submittedAt ?? undefined,
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
  const [row] = await db
    .select({
      setup: q`count(*) FILTER (WHERE ${inArray(accountPolls.state, [...IN_SETUP])})`.mapWith(
        Number,
      ),
      today: q`count(*) FILTER (WHERE ${gt(accountPolls.submittedAt, dayAgo)})`.mapWith(Number),
    })
    .from(accountPolls)
    .where(eq(accountPolls.userId, accountId));
  if (row!.setup >= MAX_POLLS_IN_SETUP) return "too-many-in-setup";
  if (row!.today >= MAX_SUBMISSIONS_PER_DAY) return "too-many-today";
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
  });
}
