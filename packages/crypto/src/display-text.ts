// The display-text record, record type 0x0009 version 1
// (docs/spec/display-text.md): an election's human-readable text, kept out of
// every result-critical record and the permanent archive (T-17), and bound to
// the definition by a salted commitment so it can't relabel the options of a
// verified result (T-34, T-41).

import { bytesFixed, type CodecValue, list, struct, utf8 } from "./codec.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, recordType } from "./record.ts";

const optionText = struct([
  ["label", utf8(512)],
  ["description", utf8(1024)],
] as const);

const translation = struct([
  ["language", utf8(35)],
  ["question", utf8(1024)],
  ["description", utf8(8192)],
  ["options", list(optionText, PARAMETERS.MAX_OPTIONS)],
] as const);

const displayTextV1 = struct([
  ["salt", bytesFixed(PARAMETERS.DISPLAY_TEXT_SALT_LEN)],
  ["translations", list(translation, 32)],
] as const);

/** Record type 0x0009. Version 1 is a draft (docs/spec/versioning.md, Draft layouts). */
export const DISPLAY_TEXT = recordType(RECORD_TYPES.displayText, { 1: displayTextV1 });

export type DisplayText = CodecValue<typeof displayTextV1>;

/** The well-formedness rule codes of docs/spec/display-text.md, in checking order. */
export type DisplayTextRule =
  | "commitment"
  | "translations"
  | "language-tag"
  | "option-count"
  | "question"
  | "labels";

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
 * The first rule after `commitment` that a decoded display-text record breaks
 * for a definition with `optionCount` options, or `undefined`. The commitment
 * is checked by `displayTextRule`, which hashes the record.
 */
export function displayTextShapeRule(
  t: DisplayText,
  optionCount: number,
): Exclude<DisplayTextRule, "commitment"> | undefined {
  const ts = t.translations;
  const languages = ts.map((x) => x.language);
  if (languages.length === 0) return "translations";
  for (let i = 1; i < languages.length; i++)
    if (compareBytes(languages[i - 1] as Uint8Array, languages[i] as Uint8Array) >= 0)
      return "translations";
  if (!ts.every((x) => isLanguageTag(x.language))) return "language-tag";
  if (!ts.every((x) => x.options.length === optionCount)) return "option-count";
  if (!ts.every((x) => x.question.length > 0 && x.options.every((o) => o.label.length > 0)))
    return "question";
  // Two options with one label can't be told apart by a voter (T-34, T-41).
  if (!ts.every((x) => distinct(x.options.map((o) => o.label)))) return "labels";
  return undefined;
}
