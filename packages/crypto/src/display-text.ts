// The display-text record, record type 0x0009 versions 1 and 2
// (docs/spec/display-text.md): an election's human-readable text, kept out of
// every result-critical record and the permanent archive (T-17), and bound to
// the definition by a salted commitment so it can't relabel the options of a
// verified result (T-34, T-41).

import { bytesFixed, type CodecValue, list, struct, utf8 } from "./codec.ts";
import { RECORD_TYPES, recordType } from "./record.ts";

const optionText = struct([
  ["label", utf8(512)],
  ["description", utf8(1024)],
] as const);

const translation = struct([
  ["language", utf8(35)],
  ["question", utf8(1024)],
  ["description", utf8(8192)],
  ["options", list(optionText, 64)],
] as const);

const displayTextV1 = struct([
  ["salt", bytesFixed(32)],
  ["translations", list(translation, 32)],
] as const);

/**
 * Version 2's limits (docs/spec/display-text.md, Layout (version 2)), written
 * out so raising a protocol-wide limit can never change what version 2
 * accepts; a test ties them to PARAMETERS. `maxRecord` is `MAX_DISPLAY_TEXT`,
 * the cap on the whole record's encoding.
 */
export const DISPLAY_TEXT_V2_LIMITS = Object.freeze({
  maxQuestions: 32,
  maxOptions: 64,
  maxRecord: 4_194_304,
} as const);

const questionText = struct([
  ["question", utf8(1024)],
  ["description", utf8(8192)],
  ["options", list(optionText, DISPLAY_TEXT_V2_LIMITS.maxOptions)],
] as const);

const translationV2 = struct([
  ["language", utf8(35)],
  ["title", utf8(1024)],
  ["description", utf8(8192)],
  ["questions", list(questionText, DISPLAY_TEXT_V2_LIMITS.maxQuestions)],
] as const);

const displayTextV2 = struct([
  ["salt", bytesFixed(32)],
  ["translations", list(translationV2, 32)],
] as const);

/** Record type 0x0009, versions 1 and 2 (docs/spec/display-text.md). */
export const DISPLAY_TEXT = recordType(RECORD_TYPES.displayText, {
  1: displayTextV1,
  2: displayTextV2,
});

export type DisplayText = CodecValue<typeof displayTextV1>;
export type DisplayTextV2 = CodecValue<typeof displayTextV2>;

/** The well-formedness rule codes of docs/spec/display-text.md, in checking order. */
export type DisplayTextRule =
  | "commitment"
  | "translations"
  | "language-tag"
  | "option-count"
  | "question"
  | "labels";

/** The well-formedness rule codes of version 2, in checking order. */
export type DisplayTextV2Rule =
  | "commitment"
  | "translations"
  | "language-tag"
  | "question-count"
  | "option-count"
  | "question"
  | "labels"
  | "question-texts";

/** Byte order: negative if `a` sorts before `b`. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

// BCP 47's alphabet, lowercase only, so `en` and `EN` can't both appear with
// different labels (T-41). The finer grammar isn't checked: a tag only
// chooses which translation to show.
const isLanguageTag = (b: Uint8Array) =>
  b.length >= 1 &&
  b.length <= 35 &&
  b.every((c) => c === 0x2d || (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a));

const distinct = (xs: readonly Uint8Array[]) =>
  xs.every((a, i) => xs.slice(i + 1).every((b) => compareBytes(a, b) !== 0));

/**
 * Internal: clients call `displayTextRule`, which checks the commitment first
 * (T-34, T-41). The first rule after `commitment` that a decoded display-text record breaks
 * for a definition with `optionCount` options, or `undefined`. The commitment
 * is checked by `displayTextRule`, which hashes the record.
 */
export function displayTextShapeRule(
  t: DisplayText,
  optionCount: number,
): Exclude<DisplayTextRule, "commitment"> | undefined {
  const ts = t.translations;
  const languageFailure = languagesRule(ts);
  if (languageFailure !== undefined) return languageFailure;
  if (!ts.every((x) => x.options.length === optionCount)) return "option-count";
  if (!ts.every((x) => x.question.length > 0 && x.options.every((o) => o.label.length > 0)))
    return "question";
  // Two options with one label can't be told apart by a voter (T-34, T-41).
  if (!ts.every((x) => distinct(x.options.map((o) => o.label)))) return "labels";
  return undefined;
}

// The same in both versions: translations sorted and distinct, tags in BCP
// 47's lowercase alphabet.
function languagesRule(
  ts: readonly { readonly language: Uint8Array }[],
): "translations" | "language-tag" | undefined {
  const languages = ts.map((x) => x.language);
  if (languages.length === 0) return "translations";
  for (let i = 1; i < languages.length; i++)
    if (compareBytes(languages[i - 1] as Uint8Array, languages[i] as Uint8Array) >= 0)
      return "translations";
  if (!ts.every((x) => isLanguageTag(x.language))) return "language-tag";
  return undefined;
}

/**
 * Internal: clients call `displayTextV2Rule`, which checks the commitment
 * first (T-34, T-41). The first rule after `commitment` that a decoded
 * version-2 record breaks for a definition whose questions have
 * `optionCounts` options, in order, or `undefined`. Each rule is checked over
 * every translation before the next, as version 1's are.
 */
export function displayTextV2ShapeRule(
  t: DisplayTextV2,
  optionCounts: readonly number[],
): Exclude<DisplayTextV2Rule, "commitment"> | undefined {
  const ts = t.translations;
  const languageFailure = languagesRule(ts);
  if (languageFailure !== undefined) return languageFailure;
  if (!ts.every((x) => x.questions.length === optionCounts.length)) return "question-count";
  if (!ts.every((x) => x.questions.every((q, i) => q.options.length === optionCounts[i])))
    return "option-count";
  if (
    !ts.every(
      (x) =>
        x.title.length > 0 &&
        x.questions.every(
          (q) => q.question.length > 0 && q.options.every((o) => o.label.length > 0),
        ),
    )
  )
    return "question";
  // Labels repeat across questions (Yes and No under each), since a label is
  // always shown with its question; within one they can't be told apart, and
  // two questions with one text leave a voter unsure which an answer is for
  // (T-34, T-41).
  if (!ts.every((x) => x.questions.every((q) => distinct(q.options.map((o) => o.label)))))
    return "labels";
  if (!ts.every((x) => distinct(x.questions.map((q) => q.question)))) return "question-texts";
  return undefined;
}
