// The production record schema, and the encode, decode, hash and check
// functions for the records specified so far: the election definition
// (docs/spec/election-definition.md) and display text
// (docs/spec/display-text.md).

import { randomBytes } from "@noble/hashes/utils.js";
import { DecodeError, EncodeError } from "./codec.ts";
import {
  DISPLAY_TEXT,
  DISPLAY_TEXT_V2_LIMITS,
  type DisplayText,
  type DisplayTextRule,
  displayTextShapeRule,
  type DisplayTextV2,
  type DisplayTextV2Rule,
  displayTextV2ShapeRule,
} from "./display-text.ts";
import { BOARD_ENTRY, type BoardEntryVersion, boardPayloadTypes } from "./board.ts";
import { ds } from "./domain-separation.ts";
import {
  ELECTION_DEFINITION,
  type ElectionDefinition,
  type ElectionDefinitionV3,
  type ElectionDefinitionV4,
  type ElectionDefinitionV5,
  type ElectionDefinitionV5Failure,
  type ElectionDefinitionV6,
  electionDefinitionRule,
  type ElectionDefinitionRule,
  electionDefinitionV5Rule,
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

export function encodeElectionDefinitionV4(d: ElectionDefinitionV4): Uint8Array {
  return PROTOCOL_SCHEMA.encode(ELECTION_DEFINITION, 4, d);
}

export function encodeElectionDefinitionV5(d: ElectionDefinitionV5): Uint8Array {
  return PROTOCOL_SCHEMA.encode(ELECTION_DEFINITION, 5, d);
}

export function encodeElectionDefinitionV6(d: ElectionDefinitionV6): Uint8Array {
  return PROTOCOL_SCHEMA.encode(ELECTION_DEFINITION, 6, d);
}

/** A decoded definition of any version the verifier reads (1, 3 and 4). */
export type ElectionDefinitionRecord =
  | { readonly version: 1; readonly value: ElectionDefinition }
  | { readonly version: 3; readonly value: ElectionDefinitionV3 }
  | { readonly version: 4; readonly value: ElectionDefinitionV4 };

/** A decoded definition of any version this package reads. */
export type AnyElectionDefinitionRecord =
  | ElectionDefinitionRecord
  | { readonly version: 5; readonly value: ElectionDefinitionV5 }
  | { readonly version: 6; readonly value: ElectionDefinitionV6 };

/**
 * Strictly decodes an election definition of any version, then checks it
 * against its own profile: the pin for 0x0001 must exist and equal the
 * record's version, or the result is `profile-mismatch`
 * (docs/spec/election-definition.md, Decoding). Otherwise a new election
 * could be created under a retired layout by labelling it with an older
 * version byte (T-34, T-31).
 */
function decodeAnyElectionDefinition(bytes: Uint8Array): AnyElectionDefinitionRecord {
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
 * `decodeAnyElectionDefinition` for definition versions 1, 3 and 4: a
 * version-5 or version-6 definition is `unknown-version` at its version
 * byte, read before any field as it was before those versions had layouts.
 * The verifier reads version 5 with `decodeElectionDefinitionV5` beside it
 * (P2-14 part 5a), and leaves version 6 unverifiable (2.3) until it reads
 * author panels (P2-16 part 4; T-36).
 */
export function decodeElectionDefinitionRecord(bytes: Uint8Array): ElectionDefinitionRecord {
  if (
    bytes instanceof Uint8Array &&
    bytes.length >= 3 &&
    bytes[0] === 0 &&
    bytes[1] === RECORD_TYPES.electionDefinition &&
    (bytes[2] === 5 || bytes[2] === 6)
  )
    throw new DecodeError("unknown-version", 2);
  const record = decodeAnyElectionDefinition(bytes);
  // Unreachable: the version byte was read above.
  if (record.version === 5 || record.version === 6) throw new DecodeError("unknown-version", 2);
  return record;
}

// The versions a deployed election registry decodes (docs/spec/contracts.md,
// Election registry, Registration, rule 2), fixed with it.
const REGISTRABLE_VERSIONS: ReadonlySet<number> = new Set([1, 3, 4, 5, 6]);

/**
 * `decodeAnyElectionDefinition` restricted to the versions the election
 * registry decodes, 1 and 3 to 6: any other is `unknown-version`, even once
 * this package reads it, so the contract-event record's check of
 * `DefinitionRegistered` never changes with a later definition version.
 */
export function decodeRegistrableElectionDefinition(
  bytes: Uint8Array,
): AnyElectionDefinitionRecord {
  const record = decodeAnyElectionDefinition(bytes);
  if (!REGISTRABLE_VERSIONS.has(record.version)) throw new DecodeError("unknown-version", 2);
  return record;
}

/**
 * `decodeAnyElectionDefinition` for callers that read only version 5
 * (questions): a definition of any other version is `unknown-version` to
 * them, after it has decoded under its own layout and pin.
 */
export function decodeElectionDefinitionV5(bytes: Uint8Array): ElectionDefinitionV5 {
  const record = decodeAnyElectionDefinition(bytes);
  if (record.version !== 5) throw new DecodeError("unknown-version", 2);
  return record.value;
}

/**
 * `decodeAnyElectionDefinition` for callers that read only version 6 (the
 * poll class, results mode and author panel): a definition of any other
 * version is `unknown-version` to them, after it has decoded under its own
 * layout and pin.
 */
export function decodeElectionDefinitionV6(bytes: Uint8Array): ElectionDefinitionV6 {
  const record = decodeAnyElectionDefinition(bytes);
  if (record.version !== 6) throw new DecodeError("unknown-version", 2);
  return record.value;
}

/**
 * `decodeElectionDefinitionRecord` for callers that read only version 1: a
 * definition of any other version is `unknown-version` to them, as it was
 * before version 3 existed, so each refuses it until it reads regional cells
 * (the verifier reads every version through `decodeElectionDefinitionRecord`).
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

/** `electionDefinitionHash` for version 4: the same tag over the version-4 encoding. */
export function electionDefinitionV4Hash(d: ElectionDefinitionV4): Uint8Array {
  return H(ds("abolish/v1/election-definition", encodeElectionDefinitionV4(d)));
}

/** `electionDefinitionHash` for version 5: the same tag over the version-5 encoding. */
export function electionDefinitionV5Hash(d: ElectionDefinitionV5): Uint8Array {
  return H(ds("abolish/v1/election-definition", encodeElectionDefinitionV5(d)));
}

/** `electionDefinitionHash` for version 6: the same tag over the version-6 encoding. */
export function electionDefinitionV6Hash(d: ElectionDefinitionV6): Uint8Array {
  return H(ds("abolish/v1/election-definition", encodeElectionDefinitionV6(d)));
}

/**
 * `electionStubHash` for version 6, the stub the default panel's ceremony
 * binds: `ceremony_transcript_hash` zeroed and `author_transcript_hash`
 * kept, so the default seats' registration binds the author panel's
 * transcript, and once they approve no one can register the definition with
 * another (docs/spec/election-definition.md, Stub hash and the ceremony;
 * T-17, T-34, T-37). The poll class, results mode and author panel are in
 * it, fixed before either ceremony.
 */
export function electionStubV6Hash(d: ElectionDefinitionV6): Uint8Array {
  const stub = { ...d, ceremony_transcript_hash: new Uint8Array(32) };
  return H(ds("abolish/v1/election-stub", encodeElectionDefinitionV6(stub)));
}

/**
 * `author_stub_hash`, the stub the author panel's ceremony binds, run before
 * the default panel's: both transcript hashes zeroed. With no author panel
 * it equals `electionStubV6Hash`, and only the default ceremony runs.
 */
export function electionAuthorStubV6Hash(d: ElectionDefinitionV6): Uint8Array {
  const stub = {
    ...d,
    ceremony_transcript_hash: new Uint8Array(32),
    author_transcript_hash: new Uint8Array(32),
  };
  return H(ds("abolish/v1/election-stub", encodeElectionDefinitionV6(stub)));
}

/** `electionStubHash` for version 5: the questions are in the stub, fixed before the ceremony (T-34). */
export function electionStubV5Hash(d: ElectionDefinitionV5): Uint8Array {
  const stub = { ...d, ceremony_transcript_hash: new Uint8Array(32) };
  return H(ds("abolish/v1/election-stub", encodeElectionDefinitionV5(stub)));
}

/** `electionStubHash` for version 4: the receipt keys are in the stub, fixed before the ceremony (T-26). */
export function electionStubV4Hash(d: ElectionDefinitionV4): Uint8Array {
  const stub = { ...d, ceremony_transcript_hash: new Uint8Array(32) };
  return H(ds("abolish/v1/election-stub", encodeElectionDefinitionV4(stub)));
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

// The ballot version each definition version pins, and only it: regional
// cells need a ballot that names its cell, a ballot naming a cell needs a
// partition of cells, and questions need a ballot with one range proof per
// question (docs/spec/election-definition.md, Notes; verifier 2.3; T-16,
// T-28, T-34). Definition version 1 pins ballot version 1.
const DEFINITION_BALLOT: ReadonlyMap<number, number> = new Map([
  [3, 2],
  [4, 2],
  [5, 3],
]);
// Ballot versions whose delivery records reach the board as share receipts
// and complaints (docs/spec/delivery.md, Versions).
const DELIVERED_BALLOT_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3, 4]);
// The spoiled-ballot opening version that opens each ballot version's cores
// (docs/spec/challenge.md, Versions): opening version 1 opens version 1's,
// opening version 2 those of versions 2 and 3, which name a cell, and
// opening version 3 those of version 4, both halves. A profile
// pinning another beside them is refused: a ballot that can't be challenged
// can't be checked as cast-as-intended (T-42, T-47).
const CORE_OPENING: ReadonlyMap<number, number> = new Map([
  [1, 1],
  [2, 2],
  [3, 2],
  [4, 3],
]);
// The spoiled-ballot opening versions this package reads (challenge.ts's
// SPOILED_BALLOT_OPENING), written out because importing it here would be an
// import cycle; a test ties the two.
export const SPOILED_OPENING_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3]);
// The ballot versions this package reads (ballot.ts's BALLOT), written out
// for the same reason. Version 4 pairs only with definition version 6, which
// this function doesn't take yet, so under every definition version it does
// take a profile pinning ballot version 4 fails.
export const BALLOT_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3, 4]);
// The contract-event versions this package reads (contract-event.ts's
// CONTRACT_EVENT), written out for the same reason; a test ties the two.
// Only version 6's tables name every board event (the close rule's, the
// batches' and the obligation root's) and the group registry's Tier 1
// addition, which lands in the sequence every election shares, so 2.3 fails
// a profile pinning version 1 to 5 ([[close]], Version; [[contracts]],
// Contract-event record; T-35, T-50, T-25, T-53).
export const CONTRACT_EVENT_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3, 4, 5, 6]);
const EVENT_VERSION = 6;

/** Why 2.3's profile combination refuses a definition's pins. */
export type ProfileCombinationRule = "profile-combination" | "unsupported-version";

/**
 * 2.3's `profile-combination` (docs/spec/verifier.md, 2.3), for the verifier
 * and for any client that must refuse an election bound to fail it
 * (docs/spec/delivery.md, Versions): definition versions 1, 3 and 4 pin
 * display-text version 1 and version 5 display-text version 2; definition
 * version 1 pins ballot version 1, versions 3 and 4 ballot version 2 and
 * version 5 ballot version 3, and each of those ballot versions pairs with
 * those definition versions only; ballot version 4 pairs with definition
 * version 6 only, which this function doesn't take, so it fails under every
 * definition version here; ballot versions 1 to 4 need a board-entry
 * version that carries share receipts and complaints (3, 4 or 5) and the
 * spoiled-ballot opening version that opens their cores (1 for version 1, 2
 * for versions 2 and 3, 3 for version 4); and tally-opening version 1 needs one that carries
 * destruction statements (4 or 5, docs/spec/tally.md, Destruction), so an
 * election's creator can't leave delivery, challenge or destruction off the
 * board (T-34, T-42). Every profile also needs a board-entry version that
 * carries close statements (5) and contract-event version 6, which archives
 * every board event (the close rule's, the batches' and the obligation
 * root's) and the group registry's Tier 1 additions, so a seat can always
 * state the close and force what it owes, and the verifier read all of it
 * ([[close]], Version; T-35, T-50, T-25, T-53): board-entry version 1, 3 or
 * 4 and contract-event version 1 to 5 fail, as
 * does board-entry version 6, which carries running openings and only a
 * live definition pins (docs/spec/tally.md, Tally-opening version 2), and
 * version 7, which is only for a definition with an author panel; a contract-event
 * version this package doesn't read is `unsupported-version` when the
 * profile fails on no other ground. A board-entry version this package doesn't read is
 * `unsupported-version`, never a failure: a later version may add itself to
 * the rule (T-36), but a client that must refuse such an election treats
 * any result but `undefined` as a refusal: it can't cast to a board it
 * can't read. So are, when the profile fails on no other ground, a ballot
 * version this package doesn't know under definition version 3, 4 or 5
 * (a later release may define it to name a cell or carry questions), and a
 * spoiled-ballot opening version it doesn't read beside ballot version 2 or
 * 3 (a later release may read it to open their cores); one this package
 * reads that doesn't open their cores fails. A ballot, tally-opening or
 * contract-event type pinned twice or not at all is `profile-combination` too, and a board-entry
 * type pinned twice or not at all `unsupported-version`, so in those cases a
 * caller that skipped `electionDefinitionRule` still refuses (T-34). It
 * doesn't replace that rule: run it first.
 */
export function profileCombinationRule(
  d: ElectionDefinition | ElectionDefinitionV3 | ElectionDefinitionV4 | ElectionDefinitionV5,
): ProfileCombinationRule | undefined {
  const board = pinnedVersion(d, RECORD_TYPES.boardEntry);
  if (!isBoardEntryVersion(board)) return "unsupported-version";
  const ballot = pinnedVersion(d, RECORD_TYPES.ballot);
  const opening = pinnedVersion(d, RECORD_TYPES.tallyOpening);
  if (ballot === undefined || opening === undefined) return "profile-combination";
  const definition = pinnedVersion(d, RECORD_TYPES.electionDefinition);
  // A definition version this function doesn't know the pairings of (6 and 7
  // until their ballot versions are specified, every version-6 and version-7
  // profile fails 2.3) never falls back to another version's rules.
  if (definition === undefined || ![1, 3, 4, 5].includes(definition)) return "profile-combination";
  // Board-entry version 7 carries an author panel's approvals, and these
  // definition versions have no author panel, so it is never theirs
  // (verifier 2.3; T-17: no approvals record on a board that has no use for it).
  if (board === 7) return "profile-combination";
  // Definition versions 1, 3 and 4 have one question, so display-text
  // version 1; version 2 carries questions and pairs with definition version
  // 5 (or 6, which this package doesn't decode). A display-text version this
  // package doesn't know fails rather than being unsupported: a later one
  // comes with a later definition version that pins it, so releases never
  // split on it (T-34, T-36, T-41).
  const displayText = definition === 5 ? 2 : 1;
  if (pinnedVersion(d, RECORD_TYPES.displayText) !== displayText) return "profile-combination";
  // A ballot version this package doesn't know may be one a later release
  // reads as naming its cell or carrying questions, so under definition
  // version 3, 4 or 5 it is judged last, as unsupported (T-36). Under
  // version 1 it isn't judged here: verifier 5.x refuses its records.
  const wanted = DEFINITION_BALLOT.get(definition) ?? 1;
  const unknownBallot = !BALLOT_VERSIONS.has(ballot);
  if (!unknownBallot && ballot !== wanted) return "profile-combination";
  const spoiled = pinnedVersion(d, RECORD_TYPES.spoiledBallotOpening);
  const coreOpening = CORE_OPENING.get(ballot);
  if (coreOpening !== undefined && spoiled === undefined) return "profile-combination";
  // Ballot version 1's cores are opened by opening version 1 only. Ballot
  // versions 2 and 3's by opening version 2, and one this package doesn't
  // read is judged last, below.
  if (ballot === 1 && spoiled !== 1) return "profile-combination";
  const allowed = boardPayloadTypes(board);
  // Running openings belong to live polls only, definition version 6 or 7
  // with `results_mode` 2, which this function doesn't take: a sealed
  // poll's board never carries one (board-entry version 6; T-16, T-31).
  if (allowed.includes(RECORD_TYPES.runningOpening)) return "profile-combination";
  const carriesDelivery =
    allowed.includes(RECORD_TYPES.shareReceipt) && allowed.includes(RECORD_TYPES.shareComplaint);
  const carriesDestruction = allowed.includes(RECORD_TYPES.destructionStatement);
  // Every profile needs the close statement on the board (board-entry
  // version 5) and every event archived (contract-event version 6),
  // whatever its definition version, or its seats have no way
  // to state the close and 5.5 and 6.3 can't be checked ([[close]],
  // Version; T-35, T-50). A contract-event version this package doesn't
  // read is judged last, below, as a later release's.
  const carriesClose = allowed.includes(RECORD_TYPES.closeStatement);
  const events = pinnedVersion(d, RECORD_TYPES.contractEvent);
  if (events === undefined) return "profile-combination";
  const knownEvents = CONTRACT_EVENT_VERSIONS.has(events);
  const fits =
    (!DELIVERED_BALLOT_VERSIONS.has(ballot) || carriesDelivery) &&
    (opening !== 1 || carriesDestruction) &&
    carriesClose &&
    (!knownEvents || events === EVENT_VERSION);
  if (!fits) return "profile-combination";
  if (unknownBallot && wanted !== 1) return "unsupported-version";
  if (coreOpening !== undefined && spoiled !== undefined && spoiled !== coreOpening)
    // An opening version this package doesn't read may be one a later
    // release reads; one it reads opens other cores, so the profile fails
    // (T-36, T-42, T-47). Checked last, so a profile that fails whatever the
    // opening fails here too.
    return SPOILED_OPENING_VERSIONS.has(spoiled) ? "profile-combination" : "unsupported-version";
  // An opening version this package doesn't read, beside a ballot version
  // whose cores it doesn't know the opening of: unverifiable here, since
  // 6.2 can't be checked, never a failure (T-36).
  if (spoiled !== undefined && !SPOILED_OPENING_VERSIONS.has(spoiled)) return "unsupported-version";
  if (!knownEvents) return "unsupported-version";
  return undefined;
}

export function encodeDisplayText(t: DisplayText): Uint8Array {
  return PROTOCOL_SCHEMA.encode(DISPLAY_TEXT, 1, t);
}

/**
 * Encodes a version-2 display-text record, refusing one longer than
 * `MAX_DISPLAY_TEXT` (docs/spec/display-text.md, Size): every decoder rejects
 * it, so a definition committed to it would register a poll no one could be
 * shown, and so vote in through our client (T-52, T-53). Creation commits
 * through `displayTextV2Commitment`, which encodes here, so it can't commit
 * to such a record either.
 */
export function encodeDisplayTextV2(t: DisplayTextV2): Uint8Array {
  const bytes = PROTOCOL_SCHEMA.encode(DISPLAY_TEXT, 2, t);
  if (bytes.length > DISPLAY_TEXT_V2_LIMITS.maxRecord)
    throw new EncodeError(
      `display text is ${bytes.length} bytes, over MAX_DISPLAY_TEXT (${DISPLAY_TEXT_V2_LIMITS.maxRecord})`,
    );
  return bytes;
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
  const record = PROTOCOL_SCHEMA.decode(DISPLAY_TEXT, bytes, pinned);
  // Unreachable: the pin is 1, so any other version is profile-mismatch.
  if (record.version !== 1) throw new DecodeError("profile-mismatch", 2);
  return record.value;
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
 * Strictly decodes a version-2 display-text record for a version-5
 * definition, which must pin display-text version 2 ([[verifier]] 2.3);
 * another pin is `UnsupportedVersionError`, as for `decodeDisplayText`. An
 * input longer than `MAX_DISPLAY_TEXT` is `length-over-max` at offset 0
 * before its header is read, so a hostile record is rejected on its length
 * alone (docs/spec/display-text.md, Size; T-52).
 */
export function decodeDisplayTextV2(
  bytes: Uint8Array,
  definition: ElectionDefinitionV5,
): DisplayTextV2 {
  const pinned = pinnedVersion(definition, RECORD_TYPES.displayText);
  if (pinned !== 2) throw new UnsupportedVersionError(RECORD_TYPES.displayText, pinned);
  if (!(bytes instanceof Uint8Array)) throw new TypeError("decode: input must be a Uint8Array");
  if (bytes.length > DISPLAY_TEXT_V2_LIMITS.maxRecord) throw new DecodeError("length-over-max", 0);
  const record = PROTOCOL_SCHEMA.decode(DISPLAY_TEXT, bytes, pinned);
  // Unreachable: the pin is 2, so any other version is profile-mismatch.
  if (record.version !== 2) throw new DecodeError("profile-mismatch", 2);
  return record.value;
}

/** `displayTextCommitment` for version 2: the same tag over the version-2 encoding. */
export function displayTextV2Commitment(t: DisplayTextV2): Uint8Array {
  return H(ds("abolish/v1/display-text", encodeDisplayTextV2(t)));
}

/**
 * `displayTextRule` for version 2: the first rule a record breaks for a
 * version-5 definition, commitment first, or `undefined` if a client may show
 * it: exactly the definition's questions, each with exactly its options
 * (docs/spec/display-text.md, Checks; T-34, T-41).
 */
export function displayTextV2Rule(
  t: DisplayTextV2,
  definition: ElectionDefinitionV5,
): DisplayTextV2Rule | undefined {
  // Not secret, so no constant-time comparison is needed.
  if (!sameBytes(displayTextV2Commitment(t), definition.display_text_commitment))
    return "commitment";
  return displayTextV2ShapeRule(
    t,
    definition.questions.map((q) => q.option_count),
  );
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

/** Why `checkElectionRecordToShow` refuses: `ShowRefusal`, with version 5's rules. */
export type ShowRecordRefusal =
  | Exclude<ShowRefusal, { readonly problem: "definition-ill-formed" | "display-text-ill-formed" }>
  | ({ readonly problem: "definition-ill-formed" } & (
      | { readonly rule: ElectionDefinitionRule }
      | ElectionDefinitionV5Failure
    ))
  | {
      readonly problem: "display-text-ill-formed";
      readonly rule: DisplayTextRule | DisplayTextV2Rule;
    };

export type ShowRecordCheck =
  | {
      readonly ok: true;
      readonly version: 1;
      readonly definition: ElectionDefinition;
      readonly displayText: DisplayText;
    }
  | {
      readonly ok: true;
      readonly version: 5;
      readonly definition: ElectionDefinitionV5;
      readonly displayText: DisplayTextV2;
    }
  | ({ readonly ok: false } & ShowRecordRefusal);

/**
 * `checkElectionToShow` for definition versions 1 and 5: the same checks in
 * the same order, under the definition's own version, with version 5's
 * questions read against display-text version 2 (docs/spec/display-text.md,
 * Checks): every question, each with exactly its options, commitment first.
 * A version-5 refusal for `option-count` or `selections` names the first
 * failing question. Definition versions 3 and 4 are refused as
 * `definition-undecodable`, as `checkElectionToShow` refuses them, until a
 * client checks regional cells before showing one (T-34, T-41, G-6).
 */
export function checkElectionRecordToShow(
  electionId: Uint8Array,
  registeredHash: Uint8Array,
  definitionBytes: Uint8Array,
  displayTextBytes: Uint8Array,
): ShowRecordCheck {
  if (!(electionId instanceof Uint8Array) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  if (!(registeredHash instanceof Uint8Array) || registeredHash.length !== 32)
    throw new TypeError("registeredHash must be 32 bytes");
  let record;
  try {
    record = decodeAnyElectionDefinition(definitionBytes);
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, problem: "definition-undecodable" };
    throw error;
  }
  if (record.version !== 5) {
    const checked = checkElectionToShow(
      electionId,
      registeredHash,
      definitionBytes,
      displayTextBytes,
    );
    return checked.ok ? { ...checked, version: 1 } : checked;
  }
  const definition = record.value;
  // Not secret, so no constant-time comparison is needed.
  if (!sameBytes(definition.election_id, electionId))
    return { ok: false, problem: "another-election" };
  if (!sameBytes(electionDefinitionV5Hash(definition), registeredHash))
    return { ok: false, problem: "unregistered-definition" };
  const definitionFailure = electionDefinitionV5Rule(definition);
  if (definitionFailure !== undefined)
    return { ok: false, problem: "definition-ill-formed", ...definitionFailure };
  let displayText;
  try {
    displayText = decodeDisplayTextV2(displayTextBytes, definition);
  } catch (error) {
    // A well-formed definition may pin a display-text version other than 2,
    // which 2.3 fails; that is refused like bytes that don't decode.
    if (error instanceof DecodeError || error instanceof UnsupportedVersionError)
      return { ok: false, problem: "display-text-undecodable" };
    throw error;
  }
  const textRule = displayTextV2Rule(displayText, definition);
  if (textRule !== undefined)
    return { ok: false, problem: "display-text-ill-formed", rule: textRule };
  return { ok: true, version: 5, definition, displayText };
}

/** A fresh display-text salt, from the platform CSPRNG (docs/spec/display-text.md; T-39). */
export function newDisplayTextSalt(): Uint8Array {
  return randomBytes(PARAMETERS.DISPLAY_TEXT_SALT_LEN);
}
