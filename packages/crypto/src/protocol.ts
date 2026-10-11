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
import { ELECTION_DEFINITION, type ElectionDefinition } from "./election-definition.ts";
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

/** A fresh display-text salt, from the platform CSPRNG (docs/spec/display-text.md; T-39). */
export function newDisplayTextSalt(): Uint8Array {
  return randomBytes(PARAMETERS.DISPLAY_TEXT_SALT_LEN);
}
