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
import { BOARD_ENTRY, type BoardEntryVersion, boardPayloadTypes } from "./board.ts";
import { ds } from "./domain-separation.ts";
import {
  ELECTION_DEFINITION,
  type ElectionDefinition,
  type ElectionDefinitionV3,
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

export function encodeElectionDefinitionV3(d: ElectionDefinitionV3): Uint8Array {
  return PROTOCOL_SCHEMA.encode(ELECTION_DEFINITION, 3, d);
}

/** A decoded definition of any version this package reads. */
export type ElectionDefinitionRecord =
  | { readonly version: 1; readonly value: ElectionDefinition }
  | { readonly version: 3; readonly value: ElectionDefinitionV3 };

/**
 * Strictly decodes an election definition of any version, then checks it
 * against its own profile: the pin for 0x0001 must exist and equal the
 * record's version, or the result is `profile-mismatch`
 * (docs/spec/election-definition.md, Decoding). Otherwise a new election
 * could be created under a retired layout by labelling it with an older
 * version byte (T-34, T-31).
 */
export function decodeElectionDefinitionRecord(bytes: Uint8Array): ElectionDefinitionRecord {
  const record = PROTOCOL_SCHEMA.decode(ELECTION_DEFINITION, bytes, UNPINNED);
  // Exactly one pin for 0x0001, at the record's own version; a second pin,
  // whatever its order, is a mismatch too, so every decoder agrees.
  const pins = record.value.profile.pins.filter(
    (p) => p.record_type === RECORD_TYPES.electionDefinition,
  );
  // Offset 2: the version byte, the field that disagrees with the profile.
  if (pins.length !== 1 || pins[0]?.version !== record.version)
    throw new DecodeError("profile-mismatch", 2);
  return record;
}

/**
 * `decodeElectionDefinitionRecord` for callers that read only version 1: a
 * definition of any other version is `unknown-version` to them, as it was
 * before version 3 existed, so each refuses it (the verifier as unsupported,
 * 2.3) until it reads regional cells (P1-15 part 4b, part 2).
 */
export function decodeElectionDefinition(bytes: Uint8Array): ElectionDefinition {
  const record = decodeElectionDefinitionRecord(bytes);
  if (record.version !== 1) throw new DecodeError("unknown-version", 2);
  return record.value;
}

/** `H(DS("abolish/v1/election-definition", encode(definition)))`. */
export function electionDefinitionHash(d: ElectionDefinition): Uint8Array {
  return H(ds("abolish/v1/election-definition", encodeElectionDefinition(d)));
}

/** `electionDefinitionHash` for version 3: the same tag over the version-3 encoding. */
export function electionDefinitionV3Hash(d: ElectionDefinitionV3): Uint8Array {
  return H(ds("abolish/v1/election-definition", encodeElectionDefinitionV3(d)));
}

/** `electionStubHash` for version 3. */
export function electionStubV3Hash(d: ElectionDefinitionV3): Uint8Array {
  const stub = { ...d, ceremony_transcript_hash: new Uint8Array(32) };
  return H(ds("abolish/v1/election-stub", encodeElectionDefinitionV3(stub)));
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
export function pinnedVersion(
  d: Pick<ElectionDefinition, "profile">,
  recordType: number,
): number | undefined {
  const pins = d.profile.pins.filter((p) => p.record_type === recordType);
  return pins.length === 1 ? pins[0]?.version : undefined;
}

const isBoardEntryVersion = (v: number | undefined): v is BoardEntryVersion =>
  v !== undefined && Object.hasOwn(BOARD_ENTRY.versions, v);

/** Why 2.3's profile combination refuses a definition's pins. */
export type ProfileCombinationRule = "profile-combination" | "unsupported-version";

/**
 * 2.3's `profile-combination` (docs/spec/verifier.md, 2.3), for the verifier
 * and for any client that must refuse an election bound to fail it
 * (docs/spec/delivery.md, Versions): ballot version 1 needs a board-entry
 * version that carries share receipts and complaints (3 or 4), and
 * tally-opening version 1 one that carries destruction statements (4,
 * docs/spec/tally.md, Destruction), so an election's creator can't leave
 * delivery or destruction off the board (T-34). A board-entry version this
 * package doesn't read is `unsupported-version`, never a failure: a later
 * version may add itself to the rule (T-36), but a client that must refuse
 * such an election treats any result but `undefined` as a refusal: it can't
 * cast to a board it can't read. A ballot or tally-opening type pinned twice
 * or not at all is `profile-combination` too, and a board-entry type pinned
 * twice or not at all `unsupported-version`, so in those cases a caller that
 * skipped `electionDefinitionRule` still refuses (T-34). It doesn't replace
 * that rule: run it first.
 */
export function profileCombinationRule(
  d: ElectionDefinition | ElectionDefinitionV3,
): ProfileCombinationRule | undefined {
  const board = pinnedVersion(d, RECORD_TYPES.boardEntry);
  if (!isBoardEntryVersion(board)) return "unsupported-version";
  const ballot = pinnedVersion(d, RECORD_TYPES.ballot);
  const opening = pinnedVersion(d, RECORD_TYPES.tallyOpening);
  if (ballot === undefined || opening === undefined) return "profile-combination";
  // Regional cells need a ballot that names its cell; ballot version 1 names
  // only a tier, so its ballots couldn't be placed in a split tier's cells
  // (docs/spec/election-definition.md, Notes; T-16, T-34).
  if (pinnedVersion(d, RECORD_TYPES.electionDefinition) === 3 && ballot === 1)
    return "profile-combination";
  const allowed = boardPayloadTypes(board);
  const carriesDelivery =
    allowed.includes(RECORD_TYPES.shareReceipt) && allowed.includes(RECORD_TYPES.shareComplaint);
  const carriesDestruction = allowed.includes(RECORD_TYPES.destructionStatement);
  const fits = (ballot !== 1 || carriesDelivery) && (opening !== 1 || carriesDestruction);
  return fits ? undefined : "profile-combination";
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
