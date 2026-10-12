// The production record schema, and the encode, decode, hash and check
// functions for the records specified so far: the election definition
// (docs/spec/election-definition.md) and display text
// (docs/spec/display-text.md).

import { randomBytes } from "@noble/hashes/utils.js";
import { DecodeError } from "./codec.ts";
import {
  DISPLAY_TEXT,
  type DisplayText,
  type DisplayTextRule,
  displayTextShapeRule,
} from "./display-text.ts";
import { BOARD_ENTRY } from "./board.ts";
import { ds } from "./domain-separation.ts";
import {
  ELECTION_DEFINITION,
  type ElectionDefinition,
  electionDefinitionRule,
  type ElectionDefinitionRule,
} from "./election-definition.ts";
import { H } from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, UNPINNED } from "./record.ts";

/**
 * A definition pins a version of a record type this package can't decode (or
 * pins none). Not a `DecodeError`: the record's bytes weren't read, and the
 * caller reports the definition as unsupported ([[verifier]] 2.3).
 */
export class UnsupportedVersionError extends Error {
  override readonly name = "UnsupportedVersionError";
  constructor(
    readonly recordType: number,
    readonly pinned: number | undefined,
  ) {
    super(`unsupported pin for record type ${recordType}: ${String(pinned)}`);
  }
}

/**
 * Every record type with a specified layout; production decoders know these
 * and no others. Internal: the package entry point doesn't export it or
 * `ELECTION_DEFINITION`, so `decodeElectionDefinition`, with its self-pin
 * check, is the only way to decode a definition (T-34, T-31).
 */
export const PROTOCOL_SCHEMA = new RecordSchema([ELECTION_DEFINITION, BOARD_ENTRY, DISPLAY_TEXT]);

export function encodeElectionDefinition(d: ElectionDefinition): Uint8Array {
  return PROTOCOL_SCHEMA.encode(ELECTION_DEFINITION, 1, d);
}

/**
 * Strictly decodes an election definition, then checks it against its own
 * profile: the pin for 0x0001 must exist and equal the record's version, or
 * the result is `profile-mismatch` (docs/spec/election-definition.md,
 * Decoding). Otherwise a new election could be created under a retired
 * layout by labelling it with an older version byte (T-34, T-31).
 */
export function decodeElectionDefinition(bytes: Uint8Array): ElectionDefinition {
  const { version, value } = PROTOCOL_SCHEMA.decode(ELECTION_DEFINITION, bytes, UNPINNED);
  // Exactly one pin for 0x0001, at the record's own version; a second pin,
  // whatever its order, is a mismatch too, so every decoder agrees.
  const pins = value.profile.pins.filter((p) => p.record_type === RECORD_TYPES.electionDefinition);
  // Offset 2: the version byte, the field that disagrees with the profile.
  if (pins.length !== 1 || pins[0]?.version !== version)
    throw new DecodeError("profile-mismatch", 2);
  return value;
}

/** `H(DS("abolish/v1/election-definition", encode(definition)))`. */
export function electionDefinitionHash(d: ElectionDefinition): Uint8Array {
  return H(ds("abolish/v1/election-definition", encodeElectionDefinition(d)));
}

/**
 * `H(DS("abolish/v1/election-stub", encode(stub)))`, where the stub is `d`
 * with `ceremony_transcript_hash` zeroed: what the key ceremony binds, since
 * it runs before the definition hash exists (T-34, T-37).
 */
export function electionStubHash(d: ElectionDefinition): Uint8Array {
  const stub = { ...d, ceremony_transcript_hash: new Uint8Array(32) };
  return H(ds("abolish/v1/election-stub", encodeElectionDefinition(stub)));
}

/**
 * The version a definition's profile pins for `recordType`: `undefined` unless
 * exactly one pin names it, so the answer never depends on pin order.
 */
export function pinnedVersion(d: ElectionDefinition, recordType: number): number | undefined {
  const pins = d.profile.pins.filter((p) => p.record_type === recordType);
  return pins.length === 1 ? pins[0]?.version : undefined;
}

export function encodeDisplayText(t: DisplayText): Uint8Array {
  return PROTOCOL_SCHEMA.encode(DISPLAY_TEXT, 1, t);
}

/**
 * Strictly decodes a display-text record against the version `definition`'s
 * profile pins. A definition that pins none, or one this package can't
 * decode, is the caller's error: it should have failed well-formedness or
 * the verifier's support check first.
 */
export function decodeDisplayText(bytes: Uint8Array, definition: ElectionDefinition): DisplayText {
  const pinned = pinnedVersion(definition, RECORD_TYPES.displayText);
  if (pinned !== 1) throw new UnsupportedVersionError(RECORD_TYPES.displayText, pinned);
  return PROTOCOL_SCHEMA.decode(DISPLAY_TEXT, bytes, pinned).value;
}

/** `H(DS("abolish/v1/display-text", encode(record)))`, salt included. */
export function displayTextCommitment(t: DisplayText): Uint8Array {
  return H(ds("abolish/v1/display-text", encodeDisplayText(t)));
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The first rule a display-text record breaks for `definition`, or
 * `undefined` if a client may show it. A client that gets a rule refuses to
 * show the ballot (docs/spec/display-text.md, Checks; T-34, T-41).
 */
export function displayTextRule(
  t: DisplayText,
  definition: ElectionDefinition,
): DisplayTextRule | undefined {
  // Not secret, so no constant-time comparison is needed.
  if (!sameBytes(displayTextCommitment(t), definition.display_text_commitment)) return "commitment";
  return displayTextShapeRule(t, definition.option_count);
}

/**
 * Why software that shows an election to a voter (the ballot client, a
 * challenge checker) refuses to show it: the first check that failed.
 */
export type ShowRefusal =
  | { readonly problem: "definition-undecodable" }
  | { readonly problem: "another-election" }
  | { readonly problem: "unregistered-definition" }
  | { readonly problem: "definition-ill-formed"; readonly rule: ElectionDefinitionRule }
  | { readonly problem: "display-text-undecodable" }
  | { readonly problem: "display-text-ill-formed"; readonly rule: DisplayTextRule };

export type ShowCheck =
  | {
      readonly ok: true;
      readonly definition: ElectionDefinition;
      readonly displayText: DisplayText;
    }
  | ({ readonly ok: false } & ShowRefusal);

/**
 * Every check software must pass before it shows an election to a voter or
 * labels a Benaloh opening (docs/spec/display-text.md, Checks): the definition
 * decodes under its own pin, names `electionId` (the election the voter
 * asked for), hashes to `registeredHash` and is well formed; the display text
 * decodes under the version the definition pins and passes `displayTextRule`,
 * commitment first. Kept here, inside the crypto-review gate, so no client
 * composes it differently (T-34, T-41, G-6).
 *
 * `registeredHash` must be the definition hash the L2 election registry holds
 * for `electionId`, read by the caller from the chain (or a proof of its
 * state), never from whoever served the records: without it, a server that
 * serves both records could commit a forged definition to relabelled text
 * (T-34, T-41). The registry and chain are the deployment the caller's own
 * release pins, never the `election_registry` or `l2_chain_id` a definition
 * names, which a forged definition could point at a registry of its own.
 */
export function checkElectionToShow(
  electionId: Uint8Array,
  registeredHash: Uint8Array,
  definitionBytes: Uint8Array,
  displayTextBytes: Uint8Array,
): ShowCheck {
  if (!(electionId instanceof Uint8Array) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  if (!(registeredHash instanceof Uint8Array) || registeredHash.length !== 32)
    throw new TypeError("registeredHash must be 32 bytes");
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
  if (!sameBytes(electionDefinitionHash(definition), registeredHash))
    return { ok: false, problem: "unregistered-definition" };
  const definitionRule = electionDefinitionRule(definition);
  if (definitionRule !== undefined)
    return { ok: false, problem: "definition-ill-formed", rule: definitionRule };
  let displayText;
  try {
    displayText = decodeDisplayText(displayTextBytes, definition);
  } catch (error) {
    // A well-formed definition may pin a display-text version this package
    // can't decode; that is refused like bytes that don't decode.
    if (error instanceof DecodeError || error instanceof UnsupportedVersionError)
      return { ok: false, problem: "display-text-undecodable" };
    throw error;
  }
  const textRule = displayTextRule(displayText, definition);
  if (textRule !== undefined)
    return { ok: false, problem: "display-text-ill-formed", rule: textRule };
  return { ok: true, definition, displayText };
}

/** A fresh display-text salt, from the platform CSPRNG (docs/spec/display-text.md; T-39). */
export function newDisplayTextSalt(): Uint8Array {
  return randomBytes(PARAMETERS.DISPLAY_TEXT_SALT_LEN);
}
