// The check the ballot client runs before it shows an election: decode the
// definition and its display text with @abolishus/crypto, the verifier's own
// code, and refuse anything that doesn't decode, names another election, is
// ill-formed, or whose text doesn't match the definition's commitment
// (docs/spec/display-text.md, Checks). Otherwise whoever serves the text could
// swap option labels for one voter, who would then honestly encrypt the index
// they picked under a false label (T-34, T-41, G-6). It runs in the Web
// Worker, beside the code that will encrypt the ballot (worker/worker.ts).
//
// Not checked here: that the definition's hash is the one registered on L2.
// The client can't read the chain yet (P2-8 part 2b), so it shows the hash for
// a voter or the verifier to compare (T-34).

import {
  DecodeError,
  decodeDisplayText,
  decodeElectionDefinition,
  type DisplayTextRule,
  displayTextRule,
  ELECTION_TYPES,
  electionDefinitionHash,
  electionDefinitionRule,
  type ElectionDefinitionRule,
  UnsupportedVersionError,
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

/** Why the client refuses to show an election. */
export type Refusal =
  | { readonly problem: "definition-undecodable" }
  | { readonly problem: "another-election" }
  | { readonly problem: "definition-ill-formed"; readonly rule: ElectionDefinitionRule }
  | { readonly problem: "display-text-undecodable" }
  | { readonly problem: "display-text-ill-formed"; readonly rule: DisplayTextRule };

export type ElectionCheck =
  | { readonly ok: true; readonly election: CheckedElection }
  | ({ readonly ok: false } & Refusal);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// The codec already rejects ill-formed UTF-8, so this never throws on a
// decoded record; `fatal` keeps a replacement character from ever being shown
// in place of bytes we didn't check.
const utf8 = new TextDecoder("utf-8", { fatal: true });
const text = (bytes: Uint8Array) => utf8.decode(bytes);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

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
  let definition;
  try {
    definition = decodeElectionDefinition(definitionBytes);
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, problem: "definition-undecodable" };
    throw error;
  }
  // Not secret, so no constant-time comparison is needed.
  if (!sameBytes(definition.election_id, electionId))
    return { ok: false, problem: "another-election" };
  const definitionRule = electionDefinitionRule(definition);
  if (definitionRule !== undefined)
    return { ok: false, problem: "definition-ill-formed", rule: definitionRule };

  let displayText;
  try {
    displayText = decodeDisplayText(displayTextBytes, definition);
  } catch (error) {
    // A well-formed definition pins display text version 1, which this
    // package decodes; an unsupported pin is refused all the same.
    if (error instanceof DecodeError || error instanceof UnsupportedVersionError)
      return { ok: false, problem: "display-text-undecodable" };
    throw error;
  }
  const textRule = displayTextRule(displayText, definition);
  if (textRule !== undefined)
    return { ok: false, problem: "display-text-ill-formed", rule: textRule };

  return {
    ok: true,
    election: {
      electionId: toHex(definition.election_id),
      definitionHash: toHex(electionDefinitionHash(definition)),
      electionType: definition.election_type === ELECTION_TYPES.approval ? "approval" : "plurality",
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
