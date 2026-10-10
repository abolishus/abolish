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
import { ds } from "./domain-separation.ts";
import { ELECTION_DEFINITION, type ElectionDefinition } from "./election-definition.ts";
import { H } from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, UNPINNED } from "./record.ts";

/** Every record type with a specified layout; production decoders know these and no others. */
export const PROTOCOL_SCHEMA = new RecordSchema([ELECTION_DEFINITION, DISPLAY_TEXT]);

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

/**
 * Record versions the registry marks draft (docs/spec/versioning.md, Draft
 * layouts). A verifier reports an election whose profile pins any of them
 * unverifiable, never verified; the PR that freezes a version removes it here.
 */
export const DRAFT_VERSIONS: readonly Readonly<{ record_type: number; version: number }>[] =
  Object.freeze([
    Object.freeze({ record_type: RECORD_TYPES.electionDefinition, version: 1 }),
    Object.freeze({ record_type: RECORD_TYPES.displayText, version: 1 }),
  ]);

/** Whether `d`'s profile pins a draft version, which no real election may use. */
export function pinsDraftVersion(d: ElectionDefinition): boolean {
  return d.profile.pins.some((p) =>
    DRAFT_VERSIONS.some((x) => x.record_type === p.record_type && x.version === p.version),
  );
}

/** `H(DS("abolish/v1/election-definition", encode(definition)))`. */
export function electionDefinitionHash(d: ElectionDefinition): Uint8Array {
  return H(ds("abolish/v1/election-definition", encodeElectionDefinition(d)));
}

/** The version a definition's profile pins for `recordType`, if any. */
export function pinnedVersion(d: ElectionDefinition, recordType: number): number | undefined {
  return d.profile.pins.find((p) => p.record_type === recordType)?.version;
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
  if (pinned !== 1)
    throw new RangeError("the definition doesn't pin a supported display-text version");
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

/** A fresh `election_id`, from the platform CSPRNG (docs/spec/election-definition.md). */
export function newElectionId(): Uint8Array {
  return randomBytes(32);
}
