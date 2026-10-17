// What the ballot client shows of an election, once @abolishus/crypto's
// `checkElectionRecordToShow` has passed it: the definition (version 1, or
// version 5, which every poll P2-22 creates) decodes, names the election in
// the ballot link, hashes to the hash the L2 registry holds for it and is well
// formed, and the display text matches the definition's commitment and the
// spec's rules, every question with exactly its options
// (docs/spec/display-text.md, Checks). Otherwise whoever serves the text could
// swap option labels, or two questions, for one voter, who would then
// honestly encrypt the index they picked under a false label (T-34, T-41,
// G-6). The checks live in the crypto-review gate; this file only turns a
// passed election into what the screens show. It runs in the Web Worker,
// beside the code that will encrypt the ballot.

import {
  checkElectionRecordToShow,
  type SealingElectionCode,
  DecodeError,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  electionDefinitionHash,
  electionDefinitionV5Hash,
  type ShowRecordRefusal,
} from "@abolishus/crypto";

export interface OptionText {
  readonly label: string;
  readonly description: string;
}

/** One question's text in one language. */
export interface QuestionText {
  readonly question: string;
  /** May be empty. */
  readonly description: string;
  /** In option order: the index here is the index a ballot encrypts. */
  readonly options: readonly OptionText[];
}

/** One language's text, as the display-text record holds it. */
export interface Translation {
  /** A lowercase BCP 47 tag, as the record holds it (`en`, `es-419`). */
  readonly language: string;
  /** The poll's title and description; both empty for a version-1 election, whose text has neither. */
  readonly title: string;
  readonly description: string;
  /** In question order, each with exactly its question's option count. */
  readonly questions: readonly QuestionText[];
}

/** A question's limits, as the definition sets them and its validity proof enforces them. */
export interface QuestionRules {
  /** The fewest options a counted ballot selects: 0 lets the question be left blank. */
  readonly minSelections: number;
  /** The most; at least 1 and at most the option count. */
  readonly maxSelections: number;
}

/** An election that passed every check, in the form the screens show it. */
export interface CheckedElection {
  /** Lowercase hex. */
  readonly electionId: string;
  /** Lowercase hex: what a voter compares with the election registry (T-34). */
  readonly definitionHash: string;
  /** The definition's record version: 1, or 5 for a poll of questions. */
  readonly version: 1 | 5;
  /** In question order: one for a version-1 election. */
  readonly questions: readonly QuestionRules[];
  /** Seconds since the Unix epoch. */
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  /** At least one, sorted by language tag, each with exactly the definition's questions and option counts. */
  readonly translations: readonly Translation[];
}

/**
 * Why the client refuses an election: the first check that failed. A
 * definition the registry doesn't hold also carries its own hash, so the
 * refusal can show both fingerprints side by side (T-34).
 */
export type ElectionRefusal =
  | Exclude<ShowRecordRefusal, { readonly problem: "unregistered-definition" }>
  | {
      readonly problem: "unregistered-definition";
      /** Lowercase hex: the hash of the definition that was served. */
      readonly servedHash: string;
    }
  /**
   * A version-5 poll shown by every other check, whose ballots this device
   * can't seal: its panel isn't one this build pins, or its ceremony
   * transcript is missing or fails (`sealingElectionV5`; T-37, T-54).
   */
  | { readonly problem: "ceremony-failed"; readonly code: SealingElectionCode };

export type ElectionCheck =
  | { readonly ok: true; readonly election: CheckedElection }
  | ({ readonly ok: false } & ElectionRefusal);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// The codec already rejects ill-formed UTF-8, so this never throws on a
// decoded record; `fatal` keeps a replacement character from ever being shown
// in place of bytes we didn't check.
const utf8 = new TextDecoder("utf-8", { fatal: true });
const text = (bytes: Uint8Array) => utf8.decode(bytes);

const optionsOf = (options: readonly { label: Uint8Array; description: Uint8Array }[]) =>
  options.map((o) => ({ label: text(o.label), description: text(o.description) }));

/**
 * Checks the election the client was asked to show: `electionId` is the one
 * in the ballot link, `registeredHash` the definition hash the L2 election
 * registry holds for it (read by the page from the chain, never from whoever
 * served the records), `definition` and `displayText` the records served for
 * it. A refusal names the first check that failed.
 */
export function checkElection(
  electionId: Uint8Array,
  registeredHash: Uint8Array,
  definitionBytes: Uint8Array,
  displayTextBytes: Uint8Array,
): ElectionCheck {
  const checked = checkElectionRecordToShow(
    electionId,
    registeredHash,
    definitionBytes,
    displayTextBytes,
  );
  if (!checked.ok) {
    if (checked.problem !== "unregistered-definition") return checked;
    return { ok: false, problem: checked.problem, servedHash: toHex(servedHash(definitionBytes)) };
  }
  if (checked.version === 1) {
    const { definition, displayText } = checked;
    return {
      ok: true,
      election: {
        electionId: toHex(definition.election_id),
        definitionHash: toHex(electionDefinitionHash(definition)),
        version: 1,
        questions: [
          { minSelections: definition.min_selections, maxSelections: definition.max_selections },
        ],
        opensAt: definition.opens_at,
        closesAt: definition.closes_at,
        translations: displayText.translations.map((t) => ({
          language: text(t.language),
          title: "",
          description: "",
          questions: [
            {
              question: text(t.question),
              description: text(t.description),
              options: optionsOf(t.options),
            },
          ],
        })),
      },
    };
  }
  const { definition, displayText } = checked;
  return {
    ok: true,
    election: {
      electionId: toHex(definition.election_id),
      definitionHash: toHex(electionDefinitionV5Hash(definition)),
      version: 5,
      questions: definition.questions.map((q) => ({
        minSelections: q.min_selections,
        maxSelections: q.max_selections,
      })),
      opensAt: definition.opens_at,
      closesAt: definition.closes_at,
      translations: displayText.translations.map((t) => ({
        language: text(t.language),
        title: text(t.title),
        description: text(t.description),
        questions: t.questions.map((q) => ({
          question: text(q.question),
          description: text(q.description),
          options: optionsOf(q.options),
        })),
      })),
    },
  };
}

/**
 * The hash of a definition the check decoded, under its own version, before
 * finding the registry holds another: only versions 1 and 5 get that far.
 */
function servedHash(bytes: Uint8Array): Uint8Array {
  try {
    return electionDefinitionHash(decodeElectionDefinition(bytes));
  } catch (error) {
    if (!(error instanceof DecodeError)) throw error;
    return electionDefinitionV5Hash(decodeElectionDefinitionV5(bytes));
  }
}
