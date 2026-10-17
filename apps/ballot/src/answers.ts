// The rules a voter's answers follow on the question screens (P2-20 part 3),
// from [[0026-multi-question-ballots]]: each question carries the limits its
// validity proof enforces, `(min, max)` over its options, and the screens
// derive both the instruction and what a tap may do from those limits alone,
// so what a voter reads can't disagree with what the proof checks (T-34,
// T-41). The proof still refuses an over- or undervote whatever this file
// does (T-28); these rules keep a voter from building a ballot it would
// refuse, and say why in words. Pure, so it's tested without a screen.

import type { CheckedElection, OptionText } from "./election.ts";

/** One question as the voter answers it, in one language. */
export interface BallotQuestion {
  readonly question: string;
  /** May be empty. */
  readonly description: string;
  /** In option order: the index here is the index a ballot encrypts. */
  readonly options: readonly OptionText[];
  /** The fewest options a counted ballot selects: 0 lets the question be left blank. */
  readonly minSelections: number;
  /** The most; at least 1 and at most the option count. */
  readonly maxSelections: number;
}

/** Per question, in order, the chosen option indices in ascending order; empty is a blank. */
export type Answers = readonly (readonly number[])[];

/**
 * The questions of a checked election in the translation tagged `language`.
 * Only text that passed the worker's check is shown, so the language must be
 * one of the election's own translations (T-41).
 */
export function questionsOf(election: CheckedElection, language: string): BallotQuestion[] {
  const translation = election.translations.find((t) => t.language === language);
  if (translation === undefined) throw new RangeError(`no translation "${language}"`);
  return [
    {
      question: translation.question,
      description: translation.description,
      options: translation.options,
      minSelections: election.minSelections,
      maxSelections: election.maxSelections,
    },
  ];
}

/**
 * Which of an election's translations to show, for a reader whose browser
 * prefers `preferred` (`navigator.languages`, most preferred first): the first
 * preference a translation's tag matches exactly, else the first whose
 * primary language matches, else the election's first translation. Only an
 * election's own tags are returned, so `questionsOf` always finds one.
 */
export function pickLanguage(
  translations: readonly { readonly language: string }[],
  preferred: readonly string[],
): string {
  const tags = translations.map((t) => t.language);
  const wanted = preferred.map((p) => p.toLowerCase());
  const primary = (tag: string) => tag.split("-")[0];
  const choice =
    wanted.map((w) => tags.find((tag) => tag === w)).find((tag) => tag !== undefined) ??
    wanted
      .map((w) => tags.find((tag) => primary(tag) === primary(w)))
      .find((tag) => tag !== undefined) ??
    tags[0];
  if (choice === undefined) throw new RangeError("an election has at least one translation");
  return choice;
}

/**
 * The instruction a question's limits give. The owner's four methods are
 * limits, not labels (pick one `(0, 1)`, pick any `(0, m)`, pick up to N
 * `(0, N)`, pick exactly N `(N, N)`); any other range the rules allow is
 * said as at least N or from N to M.
 */
export type Instruction =
  | { readonly kind: "one" }
  | { readonly kind: "any" }
  | { readonly kind: "upTo"; readonly max: number }
  | { readonly kind: "exactly"; readonly count: number }
  | { readonly kind: "atLeast"; readonly min: number }
  | { readonly kind: "between"; readonly min: number; readonly max: number };

export function instructionOf(q: BallotQuestion): Instruction {
  const { minSelections: min, maxSelections: max } = q;
  const all = q.options.length;
  if (min === 0) {
    if (max === 1) return { kind: "one" };
    return max === all ? { kind: "any" } : { kind: "upTo", max };
  }
  if (min === max) return { kind: "exactly", count: min };
  return max === all ? { kind: "atLeast", min } : { kind: "between", min, max };
}

/** One option at a time: the voter changes an answer by choosing another, as with a radio button. */
export const singleChoice = (q: BallotQuestion) => q.maxSelections === 1;

/** Whether the question can be left blank: only where its limits allow no selection. */
export const skippable = (q: BallotQuestion) => q.minSelections === 0;

/** How many more options the voter must choose before going on. */
export const stillNeeded = (q: BallotQuestion, selection: readonly number[]) =>
  Math.max(0, q.minSelections - selection.length);

/**
 * The selection after the voter taps `option`. Under single choice the tap
 * replaces the answer. Otherwise it adds or removes the option, and a tap
 * that would choose more than the question allows changes nothing and is
 * `refused`, so the screen says why rather than dropping an earlier choice
 * the voter didn't ask to drop (the Center for Civic Design's overvote rule).
 */
export function toggle(
  q: BallotQuestion,
  selection: readonly number[],
  option: number,
): { readonly selection: readonly number[]; readonly refused: boolean } {
  if (!Number.isInteger(option) || option < 0 || option >= q.options.length)
    throw new RangeError(`no option ${option}`);
  if (singleChoice(q)) return { selection: [option], refused: false };
  if (selection.includes(option))
    return { selection: selection.filter((o) => o !== option), refused: false };
  if (selection.length >= q.maxSelections) return { selection, refused: true };
  return { selection: [...selection, option].sort((a, b) => a - b), refused: false };
}

/** Whether `selection` is an answer the question's validity proof accepts. */
export function fits(q: BallotQuestion, selection: readonly number[]): boolean {
  if (selection.length < q.minSelections || selection.length > q.maxSelections) return false;
  return selection.every(
    (o, i) =>
      Number.isInteger(o) &&
      o >= 0 &&
      o < q.options.length &&
      (i === 0 || o > (selection[i - 1] ?? o)),
  );
}

/** The first question whose answer doesn't fit it, or `undefined` once every answer does. */
export function firstUnfit(
  questions: readonly BallotQuestion[],
  answers: Answers,
): number | undefined {
  const index = questions.findIndex((q, i) => !fits(q, answers[i] ?? []));
  return index === -1 ? undefined : index;
}
