// The poll form's model (P2-22 part 6b): what the author edits, how it
// becomes a draft for the drafts handler and back, and the problems the page
// names field by field. The field checks restate the definition's own rules
// (display text version 2 and definition version 5) where they can point at
// a field; `pollDraftProblem`, the rules the handler itself applies, has the
// last word, so a draft the handler would refuse is never sent (T-34, T-72).

import { DEFINITION_V5_LIMITS } from "@abolishus/crypto";
import {
  MAX_CLOSE_SECONDS,
  MIN_OPEN_SECONDS,
  type PollDraft,
  pollDraftProblem,
  SETUP_SECONDS,
} from "@abolishus/core/poll-draft-rules";

/** How an answer picks options; each is one selection range of the definition. */
export type AnswerRule = "one" | "any" | "upTo" | "exactly" | "between";

export const ANSWER_RULES: readonly AnswerRule[] = ["one", "any", "upTo", "exactly", "between"];

export interface FormOption {
  /** The list's own key for React; never sent. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
}

export interface FormQuestion {
  readonly key: string;
  readonly question: string;
  readonly description: string;
  readonly rule: AnswerRule;
  /** Whether an answer may leave the question blank (`one`, `any`, `upTo`). */
  readonly optional: boolean;
  /** The fewest picks, for `between`. */
  readonly min: number;
  /** The most picks, for `upTo`, `exactly` and `between`. */
  readonly max: number;
  readonly options: readonly FormOption[];
}

export interface PollForm {
  /** Kept as the draft has it: the form writes one translation. */
  readonly language: string;
  readonly title: string;
  readonly description: string;
  readonly questions: readonly FormQuestion[];
  /** The tiers that can answer, ascending. */
  readonly tiers: readonly number[];
  /** `yyyy-mm-dd`, UTC; empty until chosen. */
  readonly closesDate: string;
  /** `hh:mm`, UTC; empty until chosen. */
  readonly closesTime: string;
}

/** Display text version 2's field bounds, in UTF-8 bytes (docs/spec/display-text.md). */
export const TEXT_BYTES = {
  title: 1024,
  description: 8192,
  question: 1024,
  questionDescription: 8192,
  label: 512,
  optionDescription: 1024,
} as const;

/** Definition version 5's limits (docs/spec/election-definition.md, Questions). */
export const MAX_QUESTIONS = DEFINITION_V5_LIMITS.maxQuestions;
/** Options across every question of a poll. */
export const MAX_OPTIONS = DEFINITION_V5_LIMITS.maxOptions;

/** The tiers a poll can be offered to today: only Tier 0 has groups (part 2, Known-weak). */
export const OFFERED_TIERS: readonly number[] = [0];

/** The language the form writes in: apps/web's messages are English only. */
const LANGUAGE = "en";

let keys = 0;
/** A key for a new list item; unique within the page. */
export const newKey = () => `k${++keys}`;

export const newOption = (): FormOption => ({ key: newKey(), label: "", description: "" });

export const newQuestion = (): FormQuestion => ({
  key: newKey(),
  question: "",
  description: "",
  rule: "one",
  optional: false,
  min: 1,
  max: 2,
  options: [newOption(), newOption()],
});

export const newPollForm = (): PollForm => ({
  language: LANGUAGE,
  title: "",
  description: "",
  questions: [newQuestion()],
  tiers: OFFERED_TIERS,
  closesDate: "",
  closesTime: "",
});

/** A question's selection range for its rule. */
export function selectionRange(q: FormQuestion): { min: number; max: number } {
  const floor = q.optional ? 0 : 1;
  switch (q.rule) {
    case "one":
      return { min: floor, max: 1 };
    case "any":
      return { min: floor, max: q.options.length };
    case "upTo":
      return { min: floor, max: q.max };
    case "exactly":
      return { min: q.max, max: q.max };
    case "between":
      return { min: q.min, max: q.max };
  }
}

/**
 * The rule that states `[min, max]` over `m` options, so a draft read back
 * shows the range it holds. `selectionRange` of the result is `[min, max]`
 * again, whatever the numbers.
 */
function ruleOf(min: number, max: number, m: number): Pick<FormQuestion, "rule" | "optional"> {
  const optional = min === 0;
  if (max === 1 && min <= 1) return { rule: "one", optional };
  if (min === max) return { rule: "exactly", optional: false };
  if (min <= 1 && max === m) return { rule: "any", optional };
  if (min <= 1) return { rule: "upTo", optional };
  return { rule: "between", optional: false };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The draft's closing time as the form's UTC date and time; empty if no date can show it. */
function closesFields(closesAt: bigint): Pick<PollForm, "closesDate" | "closesTime"> {
  const date = new Date(Number(closesAt) * 1000);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999)
    return { closesDate: "", closesTime: "" };
  return {
    closesDate: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    closesTime: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
  };
}

/** The form for a saved draft. A closing time is shown to the minute. */
export function formOf(draft: PollDraft): PollForm {
  return {
    language: draft.language,
    title: draft.title,
    description: draft.description,
    questions: draft.questions.map((q) => {
      const { rule, optional } = ruleOf(q.minSelections, q.maxSelections, q.options.length);
      return {
        key: newKey(),
        question: q.question,
        description: q.description,
        rule,
        optional,
        min: q.minSelections,
        max: q.maxSelections,
        options: q.options.map((o) => ({ key: newKey(), ...o })),
      };
    }),
    tiers: draft.tiers,
    ...closesFields(draft.closesAt),
  };
}

/** The closing time as UNIX seconds, or `undefined` while the date or time isn't one. */
export function closesAtOf(form: Pick<PollForm, "closesDate" | "closesTime">): bigint | undefined {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(form.closesDate);
  const time = /^(\d{2}):(\d{2})$/.exec(form.closesTime);
  if (date === null || time === null) return undefined;
  const [y, mo, d, h, mi] = [date[1], date[2], date[3], time[1], time[2]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  // Date.UTC rolls 31 February over into March: only a real date is one.
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    ms < 0
  )
    return undefined;
  return BigInt(ms / 1000);
}

/** The draft the form says, or `undefined` while it has no closing time. */
export function draftOf(form: PollForm): PollDraft | undefined {
  const closesAt = closesAtOf(form);
  if (closesAt === undefined) return undefined;
  return {
    language: form.language,
    title: form.title,
    description: form.description,
    questions: form.questions.map((q) => {
      const { min, max } = selectionRange(q);
      return {
        question: q.question,
        description: q.description,
        options: q.options.map(({ label, description }) => ({ label, description })),
        minSelections: min,
        maxSelections: max,
      };
    }),
    tiers: form.tiers,
    closesAt,
  };
}

/** Each field's ID on the page, so a problem links to its field. */
export const fieldId = {
  title: "poll-title",
  description: "poll-description",
  question: (q: string) => `${q}-question`,
  questionDescription: (q: string) => `${q}-description`,
  min: (q: string) => `${q}-min`,
  max: (q: string) => `${q}-max`,
  addOption: (q: string) => `${q}-add-option`,
  label: (q: string, o: string) => `${q}-${o}-label`,
  optionDescription: (q: string, o: string) => `${q}-${o}-description`,
  addQuestion: "poll-add-question",
  closes: "poll-closes-date",
  form: "poll-form",
};

/** What is wrong, in the words the page has for it (`pollForm_<problem>` in src/messages.ts). */
export type FormProblem =
  | "titleMissing"
  | "tooLong"
  | "unstorable"
  | "questionMissing"
  | "questionRepeated"
  | "labelMissing"
  | "labelRepeated"
  | "tooFewOptions"
  | "tooManyOptions"
  | "tooManyQuestions"
  | "rangeInvalid"
  | "closesMissing"
  | "closesTooSoon"
  | "closesTooLate"
  | "draftTooLong"
  | "draftRefused";

export interface FieldError {
  /** The field it is about (`fieldId`). */
  readonly id: string;
  readonly problem: FormProblem;
  /** The question it is in, counting from 1, so the summary can say. */
  readonly question?: number;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

// As the handler's own check: a lone surrogate half would be registered as
// U+FFFD, so differ from what the author saw (T-34); jsonb can't hold U+0000.
const UNSTORABLE = /[\p{Cs}\0]/u;

/** The problem with one text field, if any. */
function textProblem(value: string, limit: number, required: FormProblem | undefined) {
  if (UNSTORABLE.test(value)) return "unstorable";
  if (required !== undefined && value.length === 0) return required;
  if (bytes(value) > limit) return "tooLong";
  return undefined;
}

/**
 * Every problem with the form's text and questions, in page order, each on
 * its field. The closing time is `closesErrors`'s, since only submission
 * holds a draft to it.
 */
export function fieldErrors(form: PollForm): FieldError[] {
  const errors: FieldError[] = [];
  const add = (id: string, problem: FormProblem | undefined, question?: number) => {
    if (problem !== undefined)
      errors.push(question === undefined ? { id, problem } : { id, problem, question });
  };
  add(fieldId.title, textProblem(form.title, TEXT_BYTES.title, "titleMissing"));
  add(fieldId.description, textProblem(form.description, TEXT_BYTES.description, undefined));
  let options = 0;
  form.questions.forEach((q, i) => {
    const n = i + 1;
    const repeated =
      q.question.length > 0 && form.questions.slice(0, i).some((p) => p.question === q.question);
    add(
      fieldId.question(q.key),
      textProblem(q.question, TEXT_BYTES.question, "questionMissing") ??
        (repeated ? "questionRepeated" : undefined),
      n,
    );
    add(
      fieldId.questionDescription(q.key),
      textProblem(q.description, TEXT_BYTES.questionDescription, undefined),
      n,
    );
    const m = q.options.length;
    options += m;
    const { min, max } = selectionRange(q);
    if (m >= 2 && (min > max || max > m || max < 1))
      add(fieldId[q.rule === "between" ? "min" : "max"](q.key), "rangeInvalid", n);
    q.options.forEach((o, j) => {
      const label = o.label;
      const again = label.length > 0 && q.options.slice(0, j).some((p) => p.label === label);
      add(
        fieldId.label(q.key, o.key),
        textProblem(label, TEXT_BYTES.label, "labelMissing") ??
          (again ? "labelRepeated" : undefined),
        n,
      );
      add(
        fieldId.optionDescription(q.key, o.key),
        textProblem(o.description, TEXT_BYTES.optionDescription, undefined),
        n,
      );
    });
    if (m < 2) add(fieldId.addOption(q.key), "tooFewOptions", n);
    else if (options > MAX_OPTIONS) add(fieldId.addOption(q.key), "tooManyOptions", n);
  });
  if (form.questions.length === 0) add(fieldId.addQuestion, "questionMissing");
  else if (form.questions.length > MAX_QUESTIONS) add(fieldId.addQuestion, "tooManyQuestions");
  return errors;
}

/**
 * The closing time's problem at `now` (UNIX seconds): the window submission
 * holds a draft to, at least `SETUP_SECONDS` of setup and `MIN_OPEN_SECONDS`
 * open and at most `MAX_CLOSE_SECONDS` ahead (ADR 0032, rule 10). Checked at
 * every save, so a draft the author leaves is one they can submit.
 */
export function closesErrors(form: PollForm, now: bigint): FieldError[] {
  const closesAt = closesAtOf(form);
  const at = (problem: FormProblem) => [{ id: fieldId.closes, problem }];
  if (closesAt === undefined) return at("closesMissing");
  if (closesAt < now + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS)) return at("closesTooSoon");
  if (closesAt > now + BigInt(MAX_CLOSE_SECONDS)) return at("closesTooLate");
  return [];
}

/** The earliest closing time a draft can be submitted with at `now` (UNIX seconds). */
export const earliestClose = (now: bigint) => now + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS);

/**
 * The draft to save at `now`, or every problem keeping it from being saved.
 * Past the field checks, the handler's own rules decide: a draft they refuse
 * is refused here too, as a whole (its encoding over the size cap, or a rule
 * the field checks missed), so nothing the handler would refuse is sent.
 */
export function checkForm(
  form: PollForm,
  now: bigint,
): { draft: PollDraft; errors: [] } | { draft: undefined; errors: FieldError[] } {
  const errors = [...fieldErrors(form), ...closesErrors(form, now)];
  const draft = draftOf(form);
  if (errors.length > 0 || draft === undefined) return { draft: undefined, errors };
  const problem = pollDraftProblem(draft);
  if (problem === undefined) return { draft, errors: [] };
  return {
    draft: undefined,
    errors: [
      { id: fieldId.form, problem: problem.rule === "too-long" ? "draftTooLong" : "draftRefused" },
    ],
  };
}
