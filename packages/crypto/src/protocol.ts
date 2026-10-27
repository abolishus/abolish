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
  type ElectionDefinitionV7,
  electionDefinitionRule,
  type ElectionDefinitionRule,
  electionDefinitionV5Rule,
  electionDefinitionV6Rule,
  electionDefinitionV7Rule,
  ELECTORATE_MODES,
  RESULTS_MODES,
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

export function encodeElectionDefinitionV7(d: ElectionDefinitionV7): Uint8Array {
  return PROTOCOL_SCHEMA.encode(ELECTION_DEFINITION, 7, d);
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
function decodeAnyElectionDefinition(
  bytes: Uint8Array,
): AnyElectionDefinitionRecord | ElectionDefinitionV7Record {
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
 * version-5, version-6 or version-7 definition is `unknown-version` at its
 * version byte, read before any field as it was before those versions had
 * layouts. The verifier reads version 5 with `decodeElectionDefinitionV5`
 * beside it (P2-14 part 5a), leaves version 6 unverifiable (2.3) until it
 * reads author panels (P2-16 part 4; T-36), and version 7 until it reads
 * rolling electorates (P2-17 part 4).
 */
export function decodeElectionDefinitionRecord(bytes: Uint8Array): ElectionDefinitionRecord {
  if (
    bytes instanceof Uint8Array &&
    bytes.length >= 3 &&
    bytes[0] === 0 &&
    bytes[1] === RECORD_TYPES.electionDefinition &&
    (bytes[2] === 5 || bytes[2] === 6 || bytes[2] === 7)
  )
    throw new DecodeError("unknown-version", 2);
  const record = decodeAnyElectionDefinition(bytes);
  // Unreachable: the version byte was read above.
  if (record.version === 5 || record.version === 6 || record.version === 7)
    throw new DecodeError("unknown-version", 2);
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
  // The set excludes 7; the comparison narrows the record's type.
  if (!REGISTRABLE_VERSIONS.has(record.version) || record.version === 7)
    throw new DecodeError("unknown-version", 2);
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
 * `decodeAnyElectionDefinition` for callers that read only version 7 (the
 * electorate mode and rolling electorates): a definition of any other
 * version is `unknown-version` to them, after it has decoded under its own
 * layout and pin.
 */
export function decodeElectionDefinitionV7(bytes: Uint8Array): ElectionDefinitionV7 {
  const record = decodeAnyElectionDefinition(bytes);
  if (record.version !== 7) throw new DecodeError("unknown-version", 2);
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

/** `electionDefinitionHash` for version 7: the same tag over the version-7 encoding. */
export function electionDefinitionV7Hash(d: ElectionDefinitionV7): Uint8Array {
  return H(ds("abolish/v1/election-definition", encodeElectionDefinitionV7(d)));
}

/**
 * `electionStubV6Hash` for version 7: `ceremony_transcript_hash` zeroed and
 * `author_transcript_hash` kept. The electorate mode, the rolling tiers,
 * their groups and the opening state are in it, so the creator fixes them
 * before either ceremony (docs/spec/election-definition.md, Rolling
 * electorates; T-34, T-37).
 */
export function electionStubV7Hash(d: ElectionDefinitionV7): Uint8Array {
  const stub = { ...d, ceremony_transcript_hash: new Uint8Array(32) };
  return H(ds("abolish/v1/election-stub", encodeElectionDefinitionV7(stub)));
}

/** `electionAuthorStubV6Hash` for version 7: both transcript hashes zeroed. */
export function electionAuthorStubV7Hash(d: ElectionDefinitionV7): Uint8Array {
  const stub = {
    ...d,
    ceremony_transcript_hash: new Uint8Array(32),
    author_transcript_hash: new Uint8Array(32),
  };
  return H(ds("abolish/v1/election-stub", encodeElectionDefinitionV7(stub)));
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

/** A definition version 6's per-election checks read: version 6, or version 7 under a fixed electorate. */
export type PanelledDefinition = ElectionDefinitionV6 | ElectionDefinitionV7;

/** A decoded version-7 definition. */
export type ElectionDefinitionV7Record = {
  readonly version: 7;
  readonly value: ElectionDefinitionV7;
};

/** `panelledFacts`'s answer: the decoded copy, labelled with its version, and what is read from it. */
export type PanelledFacts = (
  | { readonly version: 6; readonly value: ElectionDefinitionV6 }
  | ElectionDefinitionV7Record
) & {
  readonly hash: Uint8Array;
  readonly authorStubHash: Uint8Array;
  readonly wellFormed: boolean;
};

/**
 * What version 6's per-election checks take from a definition, under its own
 * version's encoding: one decoded copy of it, its hash, its author stub hash
 * and whether it is well formed. Version 7 under a fixed electorate is read
 * as version 6 is, with version 7's hashes and rules ([[verifier]] 2.3: what
 * holds of version 6's poll class, results mode and author panel holds for
 * version 7, and a fixed version 7 pins ballot version 4). The copy is
 * decoded from the value's encoding under the layout its fields have, and the
 * decoder refuses one whose own pin is another version, so no value is hashed
 * under another version's layout, and every check reads the copy, whatever
 * the caller's object returns on a later read. Any other version, and a
 * rolling version 7, whose ballots are version 5 and whose roots are its
 * steps', is `UnsupportedVersionError` (T-36). The package entry point
 * doesn't export it.
 */
export function panelledFacts(given: PanelledDefinition): PanelledFacts {
  // Another version is refused as unsupported before decoding, as it was
  // before version 7 was read; the decoder then holds the copy to the pin.
  const own = pinnedVersion(given, RECORD_TYPES.electionDefinition);
  if (own !== 6 && own !== 7)
    throw new UnsupportedVersionError(RECORD_TYPES.electionDefinition, own);
  if (!("electorate_mode" in given)) {
    const d = decodeElectionDefinitionV6(encodeElectionDefinitionV6(given));
    return {
      version: 6,
      value: d,
      hash: electionDefinitionV6Hash(d),
      authorStubHash: electionAuthorStubV6Hash(d),
      wellFormed: electionDefinitionV6Rule(d) === undefined,
    };
  }
  const d = decodeElectionDefinitionV7(encodeElectionDefinitionV7(given));
  if (d.electorate_mode !== ELECTORATE_MODES.fixed)
    throw new UnsupportedVersionError(RECORD_TYPES.electionDefinition, 7);
  return {
    version: 7,
    value: d,
    hash: electionDefinitionV7Hash(d),
    authorStubHash: electionAuthorStubV7Hash(d),
    wellFormed: electionDefinitionV7Rule(d) === undefined,
  };
}

/**
 * The version-5 stub's bytes: the definition with `ceremony_transcript_hash`
 * replaced by 32 zero bytes, header included, as a seat's intake takes it
 * beside the transcript (docs/spec/election-definition.md, Stub hash and the
 * ceremony).
 */
export function encodeElectionStubV5(d: ElectionDefinitionV5): Uint8Array {
  return encodeElectionDefinitionV5({ ...d, ceremony_transcript_hash: new Uint8Array(32) });
}

/** `electionStubHash` for version 5: the questions are in the stub, fixed before the ceremony (T-34). */
export function electionStubV5Hash(d: ElectionDefinitionV5): Uint8Array {
  return H(ds("abolish/v1/election-stub", encodeElectionStubV5(d)));
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
// question, and an author half needs a ballot that carries both sharings
// (docs/spec/election-definition.md, Notes; verifier 2.3; T-14, T-16, T-28,
// T-34). Definition version 1 pins ballot version 1, and version 7 ballot
// version 4 under a fixed electorate and version 5, which names its step,
// under a rolling one (`ballotFor`).
const DEFINITION_BALLOT: ReadonlyMap<number, number> = new Map([
  [3, 2],
  [4, 2],
  [5, 3],
  [6, 4],
]);
// Ballot versions whose delivery records reach the board as share receipts
// and complaints (docs/spec/delivery.md, Versions).
const DELIVERED_BALLOT_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3, 4, 5]);
// The spoiled-ballot opening version that opens each ballot version's cores
// (docs/spec/challenge.md, Versions): opening version 1 opens version 1's,
// opening version 2 those of versions 2 and 3, which name a cell, and
// opening version 3 those of versions 4 and 5, both halves. A profile
// pinning another beside them is refused: a ballot that can't be challenged
// can't be checked as cast-as-intended (T-42, T-47).
const CORE_OPENING: ReadonlyMap<number, number> = new Map([
  [1, 1],
  [2, 2],
  [3, 2],
  [4, 3],
  [5, 3],
]);
// The spoiled-ballot opening versions this package reads (challenge.ts's
// SPOILED_BALLOT_OPENING), written out because importing it here would be an
// import cycle; a test ties the two.
export const SPOILED_OPENING_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3]);
// The ballot versions this package reads (ballot.ts's BALLOT), written out
// for the same reason. Version 4 pairs only with definition version 6 and
// version 7's fixed electorate. Ballot.ts reads version 5 too, which only
// version 7's rolling electorate pins: 2.3 reads it beside version 7 alone
// (`profileCombinationRule`), and it joins this set when the verifier
// admits it (P2-17 part 4); until then a version-5 pin beside an earlier
// definition is judged as unknown, unsupported where nothing else fails, as
// the verifier's 2.3 vectors, written before version 5 had a layout, expect.
export const BALLOT_VERSIONS: ReadonlySet<number> = new Set<number>([1, 2, 3, 4]);
// The contract-event versions this package reads (contract-event.ts's
// CONTRACT_EVENT), written out for the same reason; a test ties the two.
// Only versions 8 to 12 name every board event (the close rule's, the
// batches', the obligation root's and the availability records') and every
// group-registry event (the Tier 1 addition and the self-paid group and
// addition), which land in the sequence every election shares, so 2.3 fails
// a profile pinning version 1 to 7 ([[close]], Version; [[contracts]],
// Contract-event record; [[availability]]; T-35, T-50, T-25, T-53, T-24).
// Each of versions 9 to 11 reads every record the one before passes as it
// does, so each fits wherever version 8 does ([[contracts]], Event tables
// (versions 9 to 11)). Version 12 reads every record version 11 passes as
// it does but version 1's `PanelPinned`, which it replaces with the one
// that logs each panel's kind: a trustee registry logs one or the other,
// never both, so it fits wherever version 11 does, and is the only one that
// fits beside a registry that logs the kind ([[contracts]], Event tables
// (version 12); [[P2-16]] part 5e-4).
// Version 8 frames no version-4 ballot or version-2 delivery record, so a
// profile pinning it beside ballot version 4 fails 4.4 at the first one
// boarded through the contract path; failing it here instead waits on
// verifier-ballots-v4.json and its kin moving to version 9 ([[P2-16]] part
// 5e, before rule 9 serves version 6).
export const CONTRACT_EVENT_VERSIONS: ReadonlySet<number> = new Set<number>([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
]);
// The versions 2.3 passes: those whose tables name every event.
const WHOLE_EVENTS: ReadonlySet<number> = new Set([8, 9, 10, 11, 12]);
// The contract-event versions whose tables name no relayed rolling ballot:
// beside ballot version 5 they leave a rolling poll's voters no direct
// submission the board's events archive (8 and 9) or none forced through L1
// (10), so 2.3 fails such a profile, whether or not this package reads the
// version ([[contracts]], Event tables (version 10) and (version 11); T-25,
// T-50, T-53). A later version this package doesn't know isn't listed: it
// may name the event, so it is unsupported, never a failure (T-36).
const NO_RELAYED_ROLLING: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

/**
 * The ballot version a definition version pins, under its electorate mode
 * for version 7; undefined for a mode version 7 doesn't have, which only an
 * untyped caller can pass (the decoder refuses it).
 */
function ballotFor(definition: number, d: object): number | undefined {
  if (definition !== 7) return DEFINITION_BALLOT.get(definition) ?? 1;
  const mode = "electorate_mode" in d ? d.electorate_mode : undefined;
  return mode === ELECTORATE_MODES.fixed ? 4 : mode === ELECTORATE_MODES.rolling ? 5 : undefined;
}

/** Why 2.3's profile combination refuses a definition's pins. */
export type ProfileCombinationRule = "profile-combination" | "unsupported-version";

/**
 * 2.3's `profile-combination` (docs/spec/verifier.md, 2.3), for the verifier
 * and for any client that must refuse an election bound to fail it
 * (docs/spec/delivery.md, Versions): definition versions 1, 3 and 4 pin
 * display-text version 1 and versions 5 to 7 display-text version 2;
 * definition version 1 pins ballot version 1, versions 3 and 4 ballot
 * version 2, version 5 ballot version 3, version 6 ballot version 4 and
 * version 7 ballot version 4 under `electorate_mode` 1 (fixed) and ballot
 * version 5 under 2 (rolling), and each of those ballot versions pairs with
 * those definitions only (ballot version 5 beside a definition before
 * version 7 is still a version this package doesn't know, below, until the
 * verifier admits it: P2-17 part 4, and a rolling profile that fits is
 * `unsupported-version` until then); ballot version 5 also needs
 * contract-event version 11 or 12, the only ones whose tables name the
 * relayed rolling ballot, and fails beside version 8, 9 or 10 (T-25, T-50, T-53); what follows of version 6
 * holds for version 7 under either mode (docs/spec/verifier.md, 2.3);
 * a version-6 definition with an author panel fails, as does tally-opening
 * version 3, which only it pins, until the author transcript's chosen-byte
 * channel is closed or accepted (T-17); a live version-6 definition fails
 * unless `oursSeats`, the number of its default panel's seats the caller's
 * release pins as ours, is at least its threshold (the live restriction,
 * until a tally-opening version fixes the nodes' withholding check: T-16,
 * T-45, docs/spec/tally.md, Live results, What a node does), and must pin
 * tally-opening version 2 and board-entry version 6, which no sealed
 * definition may pin; ballot versions 1 to 5 need a board-entry
 * version that carries share receipts and complaints (3, 4 or 5) and the
 * spoiled-ballot opening version that opens their cores (1 for version 1, 2
 * for versions 2 and 3, 3 for versions 4 and 5); and tally-opening version 1 needs one that carries
 * destruction statements (4 or 5, docs/spec/tally.md, Destruction), so an
 * election's creator can't leave delivery, challenge or destruction off the
 * board (T-34, T-42). Every profile also needs a board-entry version that
 * carries close statements (5) and contract-event version 8, which archives
 * every board event (the close rule's, the batches', the obligation root's
 * and the availability records') and the group registry's Tier 1 and
 * self-paid additions, so a seat can always state the close, force what it
 * owes and attest what it fetched, and the verifier read all of it
 * ([[close]], Version; T-35, T-50, T-25, T-53, T-24): board-entry version 1,
 * 3 or 4 and contract-event version 1 to 7 fail, as
 * does board-entry version 7, which is only for a definition with an author
 * panel; a contract-event
 * version this package doesn't read is `unsupported-version` when the
 * profile fails on no other ground. A board-entry version this package doesn't read is
 * `unsupported-version`, never a failure: a later version may add itself to
 * the rule (T-36), but a client that must refuse such an election treats
 * any result but `undefined` as a refusal: it can't cast to a board it
 * can't read. So are, when the profile fails on no other ground, a ballot
 * version this package doesn't know under definition version 3 to 7
 * (a later release may define it to name a cell or carry questions), and a
 * spoiled-ballot opening version it doesn't read beside ballot version 2 to
 * 5 (a later release may read it to open their cores); one this package
 * reads that doesn't open their cores fails. A ballot, tally-opening or
 * contract-event type pinned twice or not at all is `profile-combination` too, and a board-entry
 * type pinned twice or not at all `unsupported-version`, so in those cases a
 * caller that skipped `electionDefinitionRule` still refuses (T-34). It
 * doesn't replace that rule: run it first. A caller without the release's
 * panel pins (a client, a node, the sdk) leaves `oursSeats` at 0 and so
 * refuses every live definition, which is the safe side of the restriction.
 */
export function profileCombinationRule(
  d:
    | ElectionDefinition
    | ElectionDefinitionV3
    | ElectionDefinitionV4
    | ElectionDefinitionV5
    | ElectionDefinitionV6
    | ElectionDefinitionV7,
  oursSeats = 0,
): ProfileCombinationRule | undefined {
  const board = pinnedVersion(d, RECORD_TYPES.boardEntry);
  if (!isBoardEntryVersion(board)) return "unsupported-version";
  const ballot = pinnedVersion(d, RECORD_TYPES.ballot);
  const opening = pinnedVersion(d, RECORD_TYPES.tallyOpening);
  if (ballot === undefined || opening === undefined) return "profile-combination";
  const definition = pinnedVersion(d, RECORD_TYPES.electionDefinition);
  // A definition version this function doesn't know the pairings of never
  // falls back to another version's rules, and neither does a version-6 or
  // version-7 pin on a value without that version's fields.
  if (definition === undefined || ![1, 3, 4, 5, 6, 7].includes(definition))
    return "profile-combination";
  // The value's own fields and its pin must agree, either way round: a
  // version-6 value judged by another version's rules would skip its
  // results mode and author panel, and a version-7 value its electorate
  // mode, which picks its ballot version.
  if (definition >= 6 !== "results_mode" in d || (definition === 7) !== "electorate_mode" in d)
    return "profile-combination";
  let live = false;
  if (definition >= 6 && "results_mode" in d) {
    // An author panel fails until the author transcript's chosen-byte
    // channel is closed or accepted ([[ceremony]], Author panel, Residuals;
    // T-17), and so, until the nodes' withholding check exists, does a live
    // poll with one (verifier 2.3).
    if (d.author_keys.length > 0) return "profile-combination";
    live = d.results_mode === RESULTS_MODES.live;
    // The live restriction: until a tally-opening version fixes the nodes'
    // withholding check, a live poll runs only under a default panel of
    // which the release pins at least `k` seats as ours, where the operator
    // can already open any ballot, so withholding ballots or receipts from
    // a snapshot gains it nothing it lacks (docs/spec/tally.md, Live
    // results, What a node does; T-16, T-45). No tally-opening version
    // fixes it yet, so this holds for every live definition.
    // A count that isn't a safe integer (NaN from an untyped caller) never
    // passes it.
    if (live && !(Number.isSafeInteger(oursSeats) && oursSeats >= d.threshold))
      return "profile-combination";
  }
  // Board-entry version 7 carries an author panel's approvals, and no
  // definition that reaches here has an author panel, so it is never theirs
  // (verifier 2.3; T-17: no approvals record on a board that has no use for it).
  if (board === 7) return "profile-combination";
  // Version 3 sums an author panel's half and needs board-entry version 7,
  // so it is no definition's that reaches here (T-17).
  if (opening === 3) return "profile-combination";
  // Definition versions 1, 3 and 4 have one question, so display-text
  // version 1; version 2 carries questions and pairs with definition
  // versions 5 to 7. A display-text version this
  // package doesn't know fails rather than being unsupported: a later one
  // comes with a later definition version that pins it, so releases never
  // split on it (T-34, T-36, T-41).
  const displayText = definition >= 5 ? 2 : 1;
  if (pinnedVersion(d, RECORD_TYPES.displayText) !== displayText) return "profile-combination";
  // A ballot version this package doesn't know may be one a later release
  // reads as naming its cell or carrying questions, so under definition
  // version 3 to 7 it is judged last, as unsupported (T-36). Under
  // version 1 it isn't judged here: verifier 5.x refuses its records.
  const wanted = ballotFor(definition, d);
  if (wanted === undefined) return "profile-combination";
  // Ballot version 5 is read beside version 7, whose rolling electorate
  // pins it, and nowhere else yet (BALLOT_VERSIONS).
  const unknownBallot = !BALLOT_VERSIONS.has(ballot) && !(ballot === 5 && definition === 7);
  if (!unknownBallot && ballot !== wanted) return "profile-combination";
  const spoiled = pinnedVersion(d, RECORD_TYPES.spoiledBallotOpening);
  const coreOpening = unknownBallot ? undefined : CORE_OPENING.get(ballot);
  if (coreOpening !== undefined && spoiled === undefined) return "profile-combination";
  // Ballot version 1's cores are opened by opening version 1 only. Ballot
  // versions 2 and 3's by opening version 2, and one this package doesn't
  // read is judged last, below.
  if (ballot === 1 && spoiled !== 1) return "profile-combination";
  const allowed = boardPayloadTypes(board);
  // Tally-opening version 2 fixes a live poll's running opening, which only
  // a board-entry version carrying running openings (6) can board: a live
  // poll pins both and a sealed one neither, so a sealed poll's board never
  // carries a running opening and a live poll's releases always have a
  // record to be published in (docs/spec/tally.md, Tally-opening version 2;
  // T-16, T-29, T-31).
  if ((opening === 2) !== live || allowed.includes(RECORD_TYPES.runningOpening) !== live)
    return "profile-combination";
  const carriesDelivery =
    allowed.includes(RECORD_TYPES.shareReceipt) && allowed.includes(RECORD_TYPES.shareComplaint);
  const carriesDestruction = allowed.includes(RECORD_TYPES.destructionStatement);
  // Every profile needs the close statement on the board (board-entry
  // version 5) and every event archived (contract-event versions 8 to 12),
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
    (!knownEvents || WHOLE_EVENTS.has(events)) &&
    (unknownBallot || ballot !== 5 || !NO_RELAYED_ROLLING.has(events));
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
  // A rolling profile that fits waits on the verifier's rolling checks
  // (2.4's replay through close, 5.1 and 5.2 against step roots: P2-17
  // parts 4c and 4d), when ballot version 5 joins BALLOT_VERSIONS: until
  // then it is unverifiable, never passed (T-36). Beside definition version
  // 1 an unknown ballot version isn't judged here, as above.
  if (ballot === 5 && !unknownBallot) return "unsupported-version";
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
