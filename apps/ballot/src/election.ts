// What the ballot client shows of an election, once @abolishus/crypto's
// `checkElectionToShow` has passed it: the definition decodes, names the
// election in the ballot link and is well formed, and the display text matches
// the definition's commitment and the spec's rules (docs/spec/display-text.md,
// Checks). Otherwise whoever serves the text could swap option labels for one
// voter, who would then honestly encrypt the index they picked under a false
// label (T-34, T-41, G-6). The checks live in the crypto-review gate; this
// file only turns a passed election into what the screens show. It runs in
// the Web Worker, beside the code that will encrypt the ballot.
//
// Not checked here: that the definition's hash is the one registered on L2.
// The client can't read the chain yet (P2-8 part 2b), so it shows the hash for
// a voter or the verifier to compare (T-34).

import {
  checkElectionToShow,
  ELECTION_TYPES,
  electionDefinitionHash,
  type ShowRefusal,
} from "@abolishus/crypto";

export interface OptionText {
  readonly label: string;
  readonly description: string;
}

/** One language's text, as the display-text record holds it. */
export interface Translation {
  /** A lowercase BCP 47 tag, as the record holds it (`en`, `es-419`). */
  readonly language: string;
  readonly question: string;
  readonly description: string;
  /** In option order: the index here is the index a ballot encrypts. */
  readonly options: readonly OptionText[];
}

/** An election that passed every check, in the form the screens show it. */
export interface CheckedElection {
  /** Lowercase hex. */
  readonly electionId: string;
  /** Lowercase hex: what a voter compares with the election registry (T-34). */
  readonly definitionHash: string;
  readonly electionType: "plurality" | "approval";
  readonly minSelections: number;
  readonly maxSelections: number;
  /** Seconds since the Unix epoch. */
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  /** At least one, sorted by language tag, each with exactly the definition's option count. */
  readonly translations: readonly Translation[];
}

export type ElectionCheck =
  | { readonly ok: true; readonly election: CheckedElection }
  | ({ readonly ok: false } & ShowRefusal);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// The codec already rejects ill-formed UTF-8, so this never throws on a
// decoded record; `fatal` keeps a replacement character from ever being shown
// in place of bytes we didn't check.
const utf8 = new TextDecoder("utf-8", { fatal: true });
const text = (bytes: Uint8Array) => utf8.decode(bytes);

/**
 * Checks the election the client was asked to show: `electionId` is the one
 * in the ballot link, `definition` and `displayText` the records served for
 * it. A refusal names the first check that failed.
 */
export function checkElection(
  electionId: Uint8Array,
  definitionBytes: Uint8Array,
  displayTextBytes: Uint8Array,
): ElectionCheck {
  const checked = checkElectionToShow(electionId, definitionBytes, displayTextBytes);
  if (!checked.ok) return checked;
  const { definition, displayText } = checked;
  return {
    ok: true,
    election: {
      electionId: toHex(definition.election_id),
      definitionHash: toHex(electionDefinitionHash(definition)),
      electionType: electionType(definition.election_type),
      minSelections: definition.min_selections,
      maxSelections: definition.max_selections,
      opensAt: definition.opens_at,
      closesAt: definition.closes_at,
      translations: displayText.translations.map((t) => ({
        language: text(t.language),
        question: text(t.question),
        description: text(t.description),
        options: t.options.map((o) => ({ label: text(o.label), description: text(o.description) })),
      })),
    },
  };
}

// Named one by one, so a counting rule a later version adds is an error here
// rather than shown as another.
function electionType(value: number): CheckedElection["electionType"] {
  if (value === ELECTION_TYPES.plurality) return "plurality";
  if (value === ELECTION_TYPES.approval) return "approval";
  throw new RangeError(`unknown election type ${value}`);
}
