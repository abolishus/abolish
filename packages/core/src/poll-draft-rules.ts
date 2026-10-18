// The rules a poll's draft is checked by ([[0032-poll-creation-operations]];
// P2-22 parts 2 and 6b): what an author writes, and the first rule of the
// definition's own (display text version 2's shape rules and version 5's
// question rules, from @abolishus/crypto) that it breaks. No database here,
// so the website's form checks a draft by exactly the rules the drafts
// handler will (`@abolishus/core/poll-draft-rules`), before it is sent
// (T-28, T-34, T-72).

import {
  definitionQuestionsRule,
  DISPLAY_TEXT_V2_LIMITS,
  type DisplayTextV2,
  type DisplayTextV2Rule,
  displayTextV2ShapeRule,
  EncodeError,
  encodeDisplayTextV2,
  PARAMETERS,
  QUESTION_METHODS,
  type Question,
  TIERS,
} from "@abolishus/crypto";

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

/** The draft's questions as definition version 5 states them. */
export function draftQuestions(draft: PollDraft): Question[] {
  return draft.questions.map((q) => ({
    method: QUESTION_METHODS.selection,
    option_count: q.options.length,
    min_selections: q.minSelections,
    max_selections: q.maxSelections,
  }));
}

/**
 * The draft as display text version 2 under `salt`: its one translation,
 * field for field, so what the definition commits to is exactly what the
 * author wrote (T-34).
 */
export function draftDisplayText(draft: PollDraft, salt: Uint8Array): DisplayTextV2 {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  return {
    salt,
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
}

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
  const questions = draftQuestions(draft);
  const failure = definitionQuestionsRule(questions);
  if (failure !== undefined) return failure;
  const text = draftDisplayText(draft, new Uint8Array(PARAMETERS.DISPLAY_TEXT_SALT_LEN));
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
