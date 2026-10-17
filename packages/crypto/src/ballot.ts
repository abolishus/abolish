// The ballot record, type 0x0002 versions 1 to 4 (docs/spec/ballot-validity.md,
// Ballot record): a cast ballot's committed vote with its tier (versions 2
// to 4: its cell), nullifier, L1 reference and membership proof, and its admission
// checks (verifier 5.1 to 5.4): the election it names, its tier or cell, the
// committed vote's shape, the share hashes of seats outside the registered
// key set, the membership proof over the message the verifier recomputes,
// then the validity proofs. The L1 reference (5.8), repeats and ties (5.7,
// 6.1) and delivery (5.9) are checked over the result by `checkL1Reference`,
// `selectBallots` and `checkDelivery`.

import {
  ballotHash,
  type BallotHashContext,
  type BallotHashContextV3,
  ballotHashV3,
  ballotHashV4,
  checkValidity,
  checkValidityV3,
  checkValidityV4,
  COMMITTED_VOTE,
  COMMITTED_VOTE_V3,
  COMMITTED_VOTE_V4,
  type CommittedVote,
  type CommittedVoteV3,
  type CommittedVoteV4,
  shapeOk,
  shapeOkV3,
  shapeOkV4,
  type ValidityContext,
  type ValidityContextV3,
  type ValidityContextV4,
  type ValidityResult,
  type ValidityResultV3,
  type ValidityRules,
  type ValidityRulesV3,
  type ValidityRulesV4,
} from "./ballot-validity.ts";
import { wasApproved } from "./author-approvals.ts";
import { checkedTranscriptHash, type RegisteredKeys } from "./ceremony.ts";
import {
  bytesFixed,
  type CodecValue,
  decode,
  encode,
  enum8,
  fieldBn254,
  struct,
  u64,
  u8,
} from "./codec.ts";
import {
  type ElectionDefinition,
  type ElectionDefinitionV3,
  type ElectionDefinitionV4,
  type ElectionDefinitionV5,
  type ElectionDefinitionV6,
  electionDefinitionV5Rule,
  electionDefinitionV6Rule,
  TIERS,
} from "./election-definition.ts";
import { membershipScope, semaphoreField } from "./membership.ts";
import {
  type MembershipProofCheck,
  type MembershipSignals,
  membershipProof,
  membershipVkHash,
  verifyDecodedMembershipProof,
  verifyDecodedMembershipProofs,
} from "./membership-proof.ts";
import {
  electionAuthorStubV6Hash,
  electionDefinitionHash,
  electionDefinitionV3Hash,
  electionDefinitionV4Hash,
  electionDefinitionV5Hash,
  electionDefinitionV6Hash,
  pinnedVersion,
  UnsupportedVersionError,
} from "./protocol.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { KEM_PUBLIC_KEY } from "./share-encryption.ts";
import { membershipMessage } from "./revoting.ts";
import { authorPanelId } from "./trustee.ts";

// The fixed-width fields come first, at fixed offsets, so a contract reads
// them without parsing the committed vote (P1-18).
const ballotV1 = struct([
  ["definition_hash", bytesFixed(32)],
  ["tier", enum8(TIERS)],
  ["nullifier", fieldBn254],
  ["l1_ref_number", u64],
  ["l1_ref_hash", bytesFixed(32)],
  ["membership_proof", membershipProof],
  ["committed_vote", COMMITTED_VOTE],
] as const);

// Version 1's layout with the cell's position in the partition where the tier
// was: the same width at the same offset, so every other field keeps its
// offset (0019-regional-cells; docs/spec/ballot-validity.md, Ballot record
// (version 2)). Any u8 decodes; admission refuses a cell the definition
// doesn't have (`ballot-cell`).
const ballotV2 = struct([
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["nullifier", fieldBn254],
  ["l1_ref_number", u64],
  ["l1_ref_hash", bytesFixed(32)],
  ["membership_proof", membershipProof],
  ["committed_vote", COMMITTED_VOTE],
] as const);

// Version 2's fields and offsets with version 3's committed vote, whose last
// field holds one range proof per question (docs/spec/ballot-validity.md,
// Ballot record (version 3); 0026-multi-question-ballots). A contract reads
// the cell where it reads version 2's.
const ballotV3 = struct([
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["nullifier", fieldBn254],
  ["l1_ref_number", u64],
  ["l1_ref_hash", bytesFixed(32)],
  ["membership_proof", membershipProof],
  ["committed_vote", COMMITTED_VOTE_V3],
] as const);

// Version 3's fields and offsets with version 4's committed vote, which
// carries the author half after the default half (docs/spec/ballot-validity.md,
// Ballot record (version 4); 0027-trustee-panels-and-live-results, Part 1).
// A contract reads the cell where it reads version 3's.
const ballotV4 = struct([
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["nullifier", fieldBn254],
  ["l1_ref_number", u64],
  ["l1_ref_hash", bytesFixed(32)],
  ["membership_proof", membershipProof],
  ["committed_vote", COMMITTED_VOTE_V4],
] as const);

/** Ballot record, version 1: one cast ballot, naming its tier. */
export type BallotRecord = CodecValue<typeof ballotV1>;

/** Ballot record, version 2: one cast ballot, naming its cell (definition version 3). */
export type BallotRecordV2 = CodecValue<typeof ballotV2>;

/** Ballot record, version 3: one cast ballot of a poll with questions (definition version 5), naming its cell. */
export type BallotRecordV3 = CodecValue<typeof ballotV3>;

/** Ballot record, version 4: one cast ballot of a poll with two panels (definition version 6), naming its cell. */
export type BallotRecordV4 = CodecValue<typeof ballotV4>;

/** The fields a ballot's membership proof is made over: every field but the proof. */
export type UnprovenBallot = Omit<BallotRecord, "membership_proof">;

/** The fields a version-2 ballot's membership proof is made over. */
export type UnprovenBallotV2 = Omit<BallotRecordV2, "membership_proof">;

/** The fields a version-3 ballot's membership proof is made over. */
export type UnprovenBallotV3 = Omit<BallotRecordV3, "membership_proof">;

/** The fields a version-4 ballot's membership proof is made over. */
export type UnprovenBallotV4 = Omit<BallotRecordV4, "membership_proof">;

/** Record type `0x0002`. The election's profile pins its version. */
export const BALLOT = recordType(RECORD_TYPES.ballot, {
  1: ballotV1,
  2: ballotV2,
  3: ballotV3,
  4: ballotV4,
});

const SCHEMA = new RecordSchema([BALLOT]);

export function encodeBallot(record: BallotRecord): Uint8Array {
  return SCHEMA.encode(BALLOT, 1, record);
}

export function encodeBallotV2(record: BallotRecordV2): Uint8Array {
  return SCHEMA.encode(BALLOT, 2, record);
}

export function encodeBallotV3(record: BallotRecordV3): Uint8Array {
  return SCHEMA.encode(BALLOT, 3, record);
}

export function encodeBallotV4(record: BallotRecordV4): Uint8Array {
  return SCHEMA.encode(BALLOT, 4, record);
}

/**
 * Strictly decodes a ballot record against the version the election's profile
 * pins. Decoding doesn't compare the definition hash, tier or cell with the
 * election, nor a version-4 ballot's author half with its author panel;
 * `checkBallot` to `checkBallotV4` do, so a ballot naming another election,
 * or carrying an author half its poll has no panel for, is still read, and
 * reported (docs/spec/ballot-validity.md, Ballot record; Decoding (version 4)).
 */
export function decodeBallot(bytes: Uint8Array, pinned: 1): BallotRecord;
export function decodeBallot(bytes: Uint8Array, pinned: 2): BallotRecordV2;
export function decodeBallot(bytes: Uint8Array, pinned: 3): BallotRecordV3;
export function decodeBallot(bytes: Uint8Array, pinned: 4): BallotRecordV4;
export function decodeBallot(
  bytes: Uint8Array,
  pinned: 1 | 2 | 3 | 4,
): BallotRecord | BallotRecordV2 | BallotRecordV3 | BallotRecordV4 {
  return SCHEMA.decode(BALLOT, bytes, pinned).value;
}

/**
 * Everything a ballot is checked against, derived from one registered
 * definition and the key set its ceremony transcript check returned, never
 * from the ballot (docs/spec/ballot-validity.md, Context).
 */
export interface BallotElection extends ValidityRules {
  readonly definitionHash: Uint8Array;
  /** Each tier the definition lists, with its root and the scope derived from it. */
  readonly tiers: readonly {
    readonly tier: number;
    readonly root: bigint;
    readonly scope: bigint;
  }[];
  /** Seats of the registered key set; every other seat's share hash is 32 zero bytes. */
  readonly qualified: readonly number[];
}

/**
 * The same for a definition version 3 or 4, whose ballots (version 2) name their
 * cell: each cell of the partition in order, with its tier, cell-tree root
 * and the scope derived from them (docs/spec/membership.md, Scope).
 */
export interface CellBallotElection extends ValidityRules {
  readonly definitionHash: Uint8Array;
  /** The partition's cells; `cells[c]` is cell `c`. */
  readonly cells: readonly BallotCell[];
  readonly qualified: readonly number[];
}

/** One cell of a partition: its position, its tier, its cell-tree root and the scope derived from them. */
export interface BallotCell {
  readonly cell: number;
  readonly tier: number;
  readonly root: bigint;
  readonly scope: bigint;
}

/**
 * The same for a definition version 5, whose ballots (version 3) name their
 * cell and answer its questions: the questions' option counts and limits in
 * place of one option count and one range (docs/spec/ballot-validity.md,
 * Context (version 3)), and version 4's partition.
 */
export interface QuestionBallotElection extends ValidityRulesV3 {
  readonly definitionHash: Uint8Array;
  readonly cells: readonly BallotCell[];
  readonly qualified: readonly number[];
}

/**
 * A seat's panel, which everything naming a seat of a version-4 ballot names
 * beside its index: 1 the default panel, 2 the author panel. Both panels
 * number their seats from 1, so an index alone never says which panel a
 * seat is in (docs/spec/ballot-validity.md, Context (version 4); T-37).
 */
export const SEAT_PANELS = Object.freeze({ default: 1, author: 2 } as const);

export type SeatPanel = (typeof SEAT_PANELS)[keyof typeof SEAT_PANELS];

/**
 * The same for a definition version 6, whose ballots (version 4) carry a
 * default half and, with an author panel, an author half: version 3's
 * questions and cells, the author panel's `k_A` and `n_A` (both 0 without
 * one), and each panel's registered seats (docs/spec/ballot-validity.md,
 * Context (version 4)).
 */
export interface PanelBallotElection extends ValidityRulesV4 {
  readonly definitionHash: Uint8Array;
  readonly cells: readonly BallotCell[];
  /** Default seats of the default panel's registered key set; every other default seat's share hash is 32 zero bytes. */
  readonly qualified: readonly number[];
  /** Author seats of the author panel's registered key set, the same for the author half; empty without an author panel. */
  readonly authorQualified: readonly number[];
}

/**
 * The context `checkBallot` and `ballotSignals` run against. `registered`
 * must be the key set `checkCeremonyTranscript` returned for the transcript
 * this definition names, so no caller can pair one election with another's
 * seats (T-37). The caller has decoded the definition and run verifier 2.x
 * for it; a definition naming another membership key (1.3) or a tier root of
 * 0 (2.4) is refused here too, since no ballot could be checked under it.
 */
export function ballotElection(
  definition: ElectionDefinition,
  registered: readonly RegisteredKeys[],
): BallotElection {
  if (pinnedVersion(definition, RECORD_TYPES.ballot) !== 1)
    throw new UnsupportedVersionError(
      RECORD_TYPES.ballot,
      pinnedVersion(definition, RECORD_TYPES.ballot),
    );
  checkKeys("ballotElection", definition, registered);
  const definitionHash = electionDefinitionHash(definition);
  const election: BallotElection = Object.freeze({
    definitionHash: Uint8Array.from(definitionHash),
    ...rulesOf(definition),
    tiers: Object.freeze(
      definition.electorate.map((g) =>
        Object.freeze({
          tier: g.tier,
          root: g.root,
          // Throws for a root of 0, which anyone can prove membership of (T-04).
          scope: membershipScope(definitionHash, g.tier, g.root),
        }),
      ),
    ),
    qualified: Object.freeze(registered.map((k) => k.index)),
  });
  MADE.set(election, { definitionHash, version: 1 });
  KEYS.set(election, copyKeys(registered));
  return election;
}

/**
 * `ballotElection` for a definition version 3 or 4, which pins ballot
 * version 2 (verifier 2.3, `profile-combination`). Cells are numbered across
 * the tiers in order, as the definition lists them (docs/spec/
 * election-definition.md, Layout (version 3); version 4's partition is
 * version 3's). The caller has run 2.x for the definition, its `cells` rule
 * included; a cell root of 0 is refused here too (T-04).
 */
export function cellBallotElection(
  definition: ElectionDefinitionV3 | ElectionDefinitionV4,
  registered: readonly RegisteredKeys[],
): CellBallotElection {
  const pinned = pinnedVersion(definition, RECORD_TYPES.ballot);
  const own = pinnedVersion(definition, RECORD_TYPES.electionDefinition);
  // The hash follows the layout the value has, which must be the version its
  // own pin names, so a version-4 value can't be hashed as version 3.
  const v4 = "receipt_keys" in definition;
  if (own !== (v4 ? 4 : 3)) throw new UnsupportedVersionError(RECORD_TYPES.electionDefinition, own);
  if (pinned !== 2) throw new UnsupportedVersionError(RECORD_TYPES.ballot, pinned);
  checkKeys("cellBallotElection", definition, registered);
  const definitionHash = v4
    ? electionDefinitionV4Hash(definition)
    : electionDefinitionV3Hash(definition);
  const election: CellBallotElection = Object.freeze({
    definitionHash: Uint8Array.from(definitionHash),
    ...rulesOf(definition),
    cells: cellsOf("cellBallotElection", definition, definitionHash),
    qualified: Object.freeze(registered.map((k) => k.index)),
  });
  MADE.set(election, { definitionHash, version: 2 });
  KEYS.set(election, copyKeys(registered));
  return election;
}

/**
 * `ballotElection` for a definition version 5, which pins ballot version 3
 * (verifier 2.3, `profile-combination`): each question's option count and
 * limits, in order, and version 4's cells. The caller has run 2.x for the
 * definition; one that isn't well-formed is refused here too, since its
 * questions could hold a range no ballot can prove (T-28, T-34), and so is a
 * cell root of 0 (T-04).
 */
export function questionBallotElection(
  definition: ElectionDefinitionV5,
  registered: readonly RegisteredKeys[],
): QuestionBallotElection {
  const own = pinnedVersion(definition, RECORD_TYPES.electionDefinition);
  const pinned = pinnedVersion(definition, RECORD_TYPES.ballot);
  if (own !== 5) throw new UnsupportedVersionError(RECORD_TYPES.electionDefinition, own);
  if (pinned !== 3) throw new UnsupportedVersionError(RECORD_TYPES.ballot, pinned);
  if (electionDefinitionV5Rule(definition) !== undefined)
    throw new RangeError("questionBallotElection: the definition isn't well-formed");
  checkKeys("questionBallotElection", definition, registered);
  const definitionHash = electionDefinitionV5Hash(definition);
  const election: QuestionBallotElection = Object.freeze({
    definitionHash: Uint8Array.from(definitionHash),
    questions: Object.freeze(
      definition.questions.map((q) =>
        Object.freeze({
          optionCount: q.option_count,
          minSelections: q.min_selections,
          maxSelections: q.max_selections,
        }),
      ),
    ),
    threshold: definition.threshold,
    panelSize: definition.panel_size,
    cells: cellsOf("questionBallotElection", definition, definitionHash),
    qualified: Object.freeze(registered.map((k) => k.index)),
  });
  MADE.set(election, { definitionHash, version: 3 });
  KEYS.set(election, copyKeys(registered));
  return election;
}

/**
 * `ballotElection` for a definition version 6, which pins ballot version 4
 * (verifier 2.3, `profile-combination`): version 5's questions and cells, and
 * the author panel's threshold and size. The caller has run 2.x for the
 * definition, 2.5's `panel-kind` and `default-seat` included; one that isn't
 * well-formed is refused here too (T-28, T-34), and so is a cell root of 0
 * (T-04). With an author panel, `authorRegistered` must be the key set
 * `checkCeremonyTranscript` returned for the author transcript and
 * `checkAuthorApprovals` then approved, under this definition's chain,
 * trustee registry, author panel identifier, author stub hash and
 * `author_transcript_hash`: the author panel's registration, which no
 * contract records, so no seat list is taken on trust (T-37, T-17;
 * docs/spec/ballot-validity.md, Admission and Casting (version 4)). Without
 * one it must be empty.
 */
export function panelBallotElection(
  definition: ElectionDefinitionV6,
  registered: readonly RegisteredKeys[],
  authorRegistered: readonly RegisteredKeys[] = [],
): PanelBallotElection {
  return panelElection("panelBallotElection", definition, registered, { keys: authorRegistered });
}

/**
 * Internal: `panelBallotElection` with the author panel's registered seats
 * given, unchecked against the definition's `author_transcript_hash`, so the
 * admission of author halves can be tested against vectors that carry no
 * author run. The package entry point doesn't export it.
 */
export function panelBallotElectionWith(
  definition: ElectionDefinitionV6,
  registered: readonly RegisteredKeys[],
  authorQualified: readonly number[],
): PanelBallotElection {
  return panelElection("panelBallotElectionWith", definition, registered, {
    seats: authorQualified,
  });
}

function panelElection(
  caller: string,
  definition: ElectionDefinitionV6,
  registered: readonly RegisteredKeys[],
  author: { readonly keys: readonly RegisteredKeys[] } | { readonly seats: readonly number[] },
): PanelBallotElection {
  const own = pinnedVersion(definition, RECORD_TYPES.electionDefinition);
  const pinned = pinnedVersion(definition, RECORD_TYPES.ballot);
  if (own !== 6) throw new UnsupportedVersionError(RECORD_TYPES.electionDefinition, own);
  if (pinned !== 4) throw new UnsupportedVersionError(RECORD_TYPES.ballot, pinned);
  if (electionDefinitionV6Rule(definition) !== undefined)
    throw new RangeError(`${caller}: the definition isn't well-formed`);
  checkKeys(caller, definition, registered);
  // Well-formed, so `author_threshold` and `author_keys` are both empty or a
  // panel of 1 ≤ k_A ≤ n_A ≤ MAX_TRUSTEES (author-panel).
  const authorPanelSize = definition.author_keys.length;
  if ("keys" in author && !approvedFor(definition, author.keys))
    throw new RangeError(
      authorPanelSize === 0
        ? `${caller}: the definition has no author panel`
        : `${caller}: not the author panel's approved key set of this definition`,
    );
  const seats = "keys" in author ? author.keys.map((k) => k.index) : [...author.seats];
  if (
    !seats.every((s) => Number.isSafeInteger(s) && s >= 1 && s <= authorPanelSize) ||
    new Set(seats).size !== seats.length
  )
    throw new RangeError(`${caller}: author seats must be distinct seats of the author panel`);
  const definitionHash = electionDefinitionV6Hash(definition);
  const election: PanelBallotElection = Object.freeze({
    definitionHash: Uint8Array.from(definitionHash),
    questions: Object.freeze(
      definition.questions.map((q) =>
        Object.freeze({
          optionCount: q.option_count,
          minSelections: q.min_selections,
          maxSelections: q.max_selections,
        }),
      ),
    ),
    threshold: definition.threshold,
    panelSize: definition.panel_size,
    authorThreshold: definition.author_threshold,
    authorPanelSize,
    cells: cellsOf(caller, definition, definitionHash),
    qualified: Object.freeze(registered.map((k) => k.index)),
    authorQualified: Object.freeze(seats),
  });
  MADE.set(election, { definitionHash, version: 4 });
  KEYS.set(election, copyKeys(registered));
  // Only the approved set, never seats given unchecked: what the opening
  // paths rebuild author seats' ciphertexts under (T-37).
  if ("keys" in author) AUTHOR_KEYS.set(election, copyKeys(author.keys));
  return election;
}

// Without an author panel only the empty set; with one, the set
// `checkAuthorApprovals` approved for this definition's author run.
function approvedFor(definition: ElectionDefinitionV6, keys: readonly RegisteredKeys[]): boolean {
  if (definition.author_keys.length === 0) return Array.isArray(keys) && keys.length === 0;
  return wasApproved(keys, {
    l2ChainId: definition.l2_chain_id,
    trusteeRegistry: definition.trustee_registry,
    authorPanelId: authorPanelId({
      threshold: definition.author_threshold,
      keys: definition.author_keys,
    }),
    authorStubHash: electionAuthorStubV6Hash(definition),
    authorTranscriptHash: definition.author_transcript_hash,
  });
}

// Cells are numbered across the tiers in order, as the definition lists them
// (docs/spec/election-definition.md, Layout (version 3); versions 4 to 6
// keep its partition).
function cellsOf(
  caller: string,
  definition:
    | ElectionDefinitionV3
    | ElectionDefinitionV4
    | ElectionDefinitionV5
    | ElectionDefinitionV6,
  definitionHash: Uint8Array,
): readonly BallotCell[] {
  const cells = definition.electorate.flatMap((t) =>
    t.cells.map((c) => ({ tier: t.tier, root: c.root })),
  );
  // The u8 a ballot names; the definition's `cells` rule caps it at 256 too.
  if (cells.length > 256) throw new RangeError(`${caller}: more than 256 cells`);
  return Object.freeze(
    cells.map((c, cell) =>
      Object.freeze({
        cell,
        tier: c.tier,
        root: c.root,
        // The tier and the cell's root: cells of one tier have distinct
        // roots, so distinct scopes (docs/spec/membership.md, Scope).
        scope: membershipScope(definitionHash, c.tier, c.root),
      }),
    ),
  );
}

type AnyDefinition =
  | ElectionDefinition
  | ElectionDefinitionV3
  | ElectionDefinitionV4
  | ElectionDefinitionV5
  | ElectionDefinitionV6;

function checkKeys(
  caller: string,
  definition: AnyDefinition,
  registered: readonly RegisteredKeys[],
): void {
  const transcript = checkedTranscriptHash(registered);
  if (transcript === undefined || !equalBytes(transcript, definition.ceremony_transcript_hash))
    throw new RangeError(`${caller}: not the key set of this definition's ceremony`);
  if (!equalBytes(definition.membership_vk_hash, membershipVkHash()))
    throw new RangeError(`${caller}: the definition names another membership key`);
}

function rulesOf(
  definition: ElectionDefinition | ElectionDefinitionV3 | ElectionDefinitionV4,
): ValidityRules {
  return {
    optionCount: definition.option_count,
    minSelections: definition.min_selections,
    maxSelections: definition.max_selections,
    threshold: definition.threshold,
    panelSize: definition.panel_size,
  };
}

// Contexts `ballotElection`, `cellBallotElection`, `questionBallotElection` and `panelBallotElection` made, each with its own
// copy of the definition hash and the ballot version it checks: a hand-built
// context, or one whose exposed hash was overwritten in place (a frozen
// object's byte array isn't frozen), could pair a definition hash with
// another election's roots, scopes or seats, and a context of one version
// must never check the other's records.
const MADE = new WeakMap<
  object,
  { readonly definitionHash: Uint8Array; readonly version: 1 | 2 | 3 | 4 }
>();

const MAKERS = {
  1: "ballotElection",
  2: "cellBallotElection",
  3: "questionBallotElection",
  4: "panelBallotElection",
};

function madeHashOf(election: object, version: 1 | 2 | 3 | 4): Uint8Array {
  const made = MADE.get(election);
  if (made === undefined || made.version !== version)
    throw new TypeError(`expected a context made by ${MAKERS[version]}`);
  return made.definitionHash;
}

// The registered key set of each context, copied when it was made, for
// checks that rebuild ciphertexts (docs/spec/challenge.md, Checks).
const KEYS = new WeakMap<object, readonly RegisteredKeys[]>();
// The author panel's approved key set a version-4 context was made with, set
// only by `panelBallotElection` (empty without an author panel).
const AUTHOR_KEYS = new WeakMap<object, readonly RegisteredKeys[]>();

const copyKeys = (registered: readonly RegisteredKeys[]): readonly RegisteredKeys[] =>
  Object.freeze(
    registered.map((k) =>
      Object.freeze({
        index: k.index,
        kemKey: decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, k.kemKey)),
        signingKey: Uint8Array.from(k.signingKey),
      }),
    ),
  );

/** Internal: the registered key set `ballotElection` made this context from. */
export function registeredKeysOf(election: BallotElection): readonly RegisteredKeys[] {
  madeHashOf(election, 1);
  return KEYS.get(election) as readonly RegisteredKeys[];
}

/** Internal: the definition hash `ballotElection` made this context from. */
export function definitionHashOf(election: BallotElection): Uint8Array {
  return madeHashOf(election, 1);
}

/**
 * Internal: what `cellBallotElection` or `questionBallotElection` made this
 * context from (its definition hash and registered key set), with the ballot
 * version it checks, which the core hash of its cores binds
 * (docs/spec/challenge.md, Opening version 2).
 */
export function cellContextOf(election: CellBallotElection | QuestionBallotElection): {
  readonly definitionHash: Uint8Array;
  readonly ballotVersion: 2 | 3;
  readonly keys: readonly RegisteredKeys[];
} {
  const made = MADE.get(election);
  // Exactly versions 2 and 3: a version-4 context's cores carry an author
  // half that opening version 2 never opens (opening version 3, part 2b-4).
  if (made === undefined || (made.version !== 2 && made.version !== 3))
    throw new TypeError("expected a context made by cellBallotElection or questionBallotElection");
  return {
    definitionHash: made.definitionHash,
    ballotVersion: made.version,
    keys: KEYS.get(election) as readonly RegisteredKeys[],
  };
}

/**
 * Internal: what `panelBallotElection` (or `panelBallotElectionWith`) made
 * this context from, its definition hash, the default panel's registered key
 * set and, from `panelBallotElection` only, the author panel's approved one,
 * for opening version 3's rebuild of each seat's ciphertext
 * (docs/spec/challenge.md, Opening version 3). `authorKeys` is undefined
 * for a context `panelBallotElectionWith` made, whose author seats no
 * approvals check vouched for (T-37).
 */
export function panelContextOf(election: PanelBallotElection): {
  readonly definitionHash: Uint8Array;
  readonly keys: readonly RegisteredKeys[];
  readonly authorKeys: readonly RegisteredKeys[] | undefined;
} {
  return {
    definitionHash: madeHashOf(election, 4),
    keys: KEYS.get(election) as readonly RegisteredKeys[],
    authorKeys: AUTHOR_KEYS.get(election),
  };
}

/** The root and scope a ballot proves against, and the tier its message and re-vote rule use. */
interface Target {
  readonly tier: number;
  readonly root: bigint;
  readonly scope: bigint;
}

const tierTarget = (election: BallotElection, tier: number): Target | undefined =>
  election.tiers.find((g) => g.tier === tier);

const cellTarget = (
  election: CellBallotElection | QuestionBallotElection | PanelBallotElection,
  cell: number,
): Target | undefined =>
  Number.isSafeInteger(cell) && cell >= 0 ? election.cells[cell] : undefined;

/**
 * The public signals `[ρ, ν, m̂, ŝ]` a ballot's membership proof must verify
 * against: the tier's root and scope from the definition, the ballot's own
 * nullifier, and `F(M)` over the ballot hash and L1 reference
 * (docs/spec/membership.md, Checks; docs/spec/revoting.md, Message). The
 * ballot client proves over exactly these, and `checkBallot` recomputes them
 * (verifier 5.1 to 5.3). `undefined` if the ballot names another
 * definition, or a tier the definition doesn't list.
 */
export function ballotSignals(
  election: BallotElection,
  ballot: UnprovenBallot,
): MembershipSignals | undefined {
  const definitionHash = madeHashOf(election, 1);
  const fields = fieldsOf(ballot);
  const { tier } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash)) return undefined;
  const target = tierTarget(election, tier);
  if (target === undefined) return undefined;
  const hash = ballotHash({ definitionHash, tier, nullifier: fields.nullifier }, fields.vote);
  return signalsOf(definitionHash, target, fields, hash).signals;
}

/**
 * `ballotSignals` for a version-2 ballot: its cell's root and scope, and `M`
 * under the cell's tier (docs/spec/ballot-validity.md, Ballot record
 * (version 2)). `undefined` if the ballot names another definition, or a
 * cell the partition doesn't have.
 */
export function ballotSignalsV2(
  election: CellBallotElection,
  ballot: UnprovenBallotV2,
): MembershipSignals | undefined {
  const definitionHash = madeHashOf(election, 2);
  const fields = fieldsOf(ballot);
  const { cell } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash)) return undefined;
  const target = cellTarget(election, cell);
  if (target === undefined) return undefined;
  const hash = ballotHash(
    { definitionHash, ballotVersion: 2, cell, nullifier: fields.nullifier },
    fields.vote,
  );
  return signalsOf(definitionHash, target, fields, hash).signals;
}

/**
 * `ballotSignals` for a version-3 ballot: version 2's, with `M` over the
 * version-3 ballot hash (docs/spec/ballot-validity.md, Hashes (version 3)).
 * `undefined` if the ballot names another definition, or a cell the
 * partition doesn't have.
 */
export function ballotSignalsV3(
  election: QuestionBallotElection,
  ballot: UnprovenBallotV3,
): MembershipSignals | undefined {
  const definitionHash = madeHashOf(election, 3);
  const fields = fieldsOf(ballot);
  const { cell } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash)) return undefined;
  const target = cellTarget(election, cell);
  if (target === undefined) return undefined;
  const hash = ballotHashV3({ definitionHash, cell, nullifier: fields.nullifier }, fields.vote);
  return signalsOf(definitionHash, target, fields, hash).signals;
}

/**
 * `ballotSignals` for a version-4 ballot: version 3's, with `M` over the
 * version-4 ballot hash, which binds both halves (docs/spec/ballot-validity.md,
 * Hashes (version 4)). `undefined` if the ballot names another definition, or
 * a cell the partition doesn't have.
 */
export function ballotSignalsV4(
  election: PanelBallotElection,
  ballot: UnprovenBallotV4,
): MembershipSignals | undefined {
  const definitionHash = madeHashOf(election, 4);
  const fields = fieldsOf(ballot);
  const { cell } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash)) return undefined;
  const target = cellTarget(election, cell);
  if (target === undefined) return undefined;
  const hash = ballotHashV4({ definitionHash, cell, nullifier: fields.nullifier }, fields.vote);
  return signalsOf(definitionHash, target, fields, hash).signals;
}

interface Fields<V> {
  readonly definitionHash: Uint8Array;
  readonly nullifier: bigint;
  readonly l1RefNumber: bigint;
  readonly l1RefHash: Uint8Array;
  readonly vote: V;
}

// Reads each common field once, so a record with getters can't show one
// check one value and the next another. The tier or cell is read once by
// the caller.
function fieldsOf<V>(ballot: {
  readonly definition_hash: Uint8Array;
  readonly nullifier: bigint;
  readonly l1_ref_number: bigint;
  readonly l1_ref_hash: Uint8Array;
  readonly committed_vote: V;
}): Fields<V> {
  const { definition_hash, nullifier, l1_ref_number, l1_ref_hash, committed_vote } = ballot;
  return {
    definitionHash: definition_hash,
    nullifier,
    l1RefNumber: l1_ref_number,
    l1RefHash: Uint8Array.from(l1_ref_hash),
    vote: committed_vote,
  };
}

function signalsOf(
  definitionHash: Uint8Array,
  target: Target,
  fields: Fields<unknown>,
  hash: Uint8Array,
) {
  // M binds the election, the tier, the ballot hash (and through it a
  // version-2 or version-3 ballot's cell) and the L1 block (T-38, T-45).
  const message = membershipMessage({
    definitionHash,
    tier: target.tier,
    ballotHash: hash,
    l1RefNumber: fields.l1RefNumber,
    l1RefHash: fields.l1RefHash,
  });
  const signals: MembershipSignals = {
    root: target.root,
    nullifier: fields.nullifier,
    message: semaphoreField(message),
    scope: target.scope,
  };
  return { message, signals };
}

/** The admission codes of docs/spec/ballot-validity.md (Ballot record), in checking order. */
export type BallotCode =
  | "ballot-stray"
  | "ballot-tier"
  | "validity-shape"
  | "share-hash-unqualified"
  | "membership-proof"
  | "option-proof"
  | "sum-proof";

/** Version 2's admission codes, which version 3 keeps: `ballot-cell` in place of `ballot-tier`. */
export type BallotV2Code = Exclude<BallotCode, "ballot-tier"> | "ballot-cell";

type Admitted = {
  readonly ok: true;
  readonly ballotHash: Uint8Array;
  /** `M`, recomputed: what 5.7 compares, never the proof's bytes (T-38). */
  readonly message: Uint8Array;
  /** The tier the re-vote rule ranks by (versions 2 and 3: the cell's tier). */
  readonly tier: number;
  readonly nullifier: bigint;
  readonly l1RefNumber: bigint;
  readonly l1RefHash: Uint8Array;
};

type Rejected<C> = {
  readonly ok: false;
  readonly code: C;
  /** Under `option-proof`, the first failing option (version 3: flat option). */
  readonly option?: number;
  /** Under version 3's `sum-proof`, the first failing question. */
  readonly question?: number;
  /** Under version 4's `share-hash-unqualified`, the first such seat's panel and index. */
  readonly panel?: SeatPanel;
  readonly seat?: number;
};

export type BallotCheck = Admitted | Rejected<BallotCode>;

export type BallotCheckV2 = (Admitted & { readonly cell: number }) | Rejected<BallotV2Code>;

/** A version-3 ballot's admission: version 2's, every question in it. */
export type BallotCheckV3 = BallotCheckV2;

/** A version-4 ballot's admission: version 3's, with `share-hash-unqualified` naming its seat's panel. */
export type BallotCheckV4 = BallotCheckV2;

/**
 * The admission checks of a decoded ballot record (docs/spec/ballot-validity.md,
 * Ballot record; verifier 5.1 to 5.4), in order; the first failure is the
 * result, which rejects this entry only. A ballot that passes still needs its
 * L1 reference admitted (5.8) and the close rule (5.5) before selection.
 */
export function checkBallot(election: BallotElection, ballot: BallotRecord): BallotCheck {
  return finishBallotStep(stepBallot(election, ballot));
}

/**
 * `checkBallot`'s checks run up to the membership proof, whose verdict
 * `finishBallotSteps` supplies, batched with other ballots' (T-52).
 */
export function stepBallot(
  election: BallotElection,
  ballot: BallotRecord,
): BallotStep<BallotCheck> {
  const definitionHash = madeHashOf(election, 1);
  const proof = ballot.membership_proof;
  const fields = fieldsOf(ballot);
  const { tier } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash))
    return stepOf({ done: { ok: false, code: "ballot-stray" } });
  const target = tierTarget(election, tier);
  if (target === undefined) return stepOf({ done: { ok: false, code: "ballot-tier" } });
  const named = { definitionHash, tier, nullifier: fields.nullifier };
  return stepOf(admitStep(election, checksOf(election, named), target, fields, proof));
}

/**
 * The admission checks of a decoded version-2 ballot (docs/spec/ballot-validity.md,
 * Ballot record (version 2)): `ballot-cell` refuses a cell the partition
 * doesn't have, and the membership proof is checked against the cell's root
 * and scope, never a root or scope the ballot chooses (verifier 2.8, 5.1,
 * 5.2; T-16). A ballot that passes is ranked by the cell's tier.
 */
export function checkBallotV2(election: CellBallotElection, ballot: BallotRecordV2): BallotCheckV2 {
  return finishBallotStep(stepBallotV2(election, ballot));
}

/** `checkBallotV2`'s checks run up to the membership proof, for `finishBallotSteps`. */
export function stepBallotV2(
  election: CellBallotElection,
  ballot: BallotRecordV2,
): BallotStep<BallotCheckV2> {
  const definitionHash = madeHashOf(election, 2);
  const proof = ballot.membership_proof;
  const fields = fieldsOf(ballot);
  const { cell } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash))
    return stepOf({ done: { ok: false, code: "ballot-stray" } });
  const target = cellTarget(election, cell);
  if (target === undefined) return stepOf({ done: { ok: false, code: "ballot-cell" } });
  const named = { definitionHash, ballotVersion: 2, cell, nullifier: fields.nullifier } as const;
  const step = admitStep(election, checksOf(election, named), target, fields, proof);
  return stepOf(mapStep(step, (result) => (result.ok ? { ...result, cell } : result)));
}

/**
 * The admission checks of a decoded version-3 ballot (docs/spec/ballot-validity.md,
 * Admission (version 3)): version 2's, in its order, with the shape and
 * proofs over the definition's questions: `option-proof` names the first
 * failing flat option and `sum-proof` the first failing question. The
 * questions and the cell's root and scope come from the definition, never
 * from the ballot (T-16, T-28). A ballot that passes is ranked by the cell's
 * tier, so a re-vote replaces every answer at once.
 */
export function checkBallotV3(
  election: QuestionBallotElection,
  ballot: BallotRecordV3,
): BallotCheckV3 {
  return finishBallotStep(stepBallotV3(election, ballot));
}

/** `checkBallotV3`'s checks run up to the membership proof, for `finishBallotSteps`. */
export function stepBallotV3(
  election: QuestionBallotElection,
  ballot: BallotRecordV3,
): BallotStep<BallotCheckV3> {
  const definitionHash = madeHashOf(election, 3);
  const proof = ballot.membership_proof;
  const fields = fieldsOf(ballot);
  const { cell } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash))
    return stepOf({ done: { ok: false, code: "ballot-stray" } });
  const target = cellTarget(election, cell);
  if (target === undefined) return stepOf({ done: { ok: false, code: "ballot-cell" } });
  const named = { definitionHash, cell, nullifier: fields.nullifier };
  const step = admitStep(election, checksOfV3(election, named), target, fields, proof);
  return stepOf(mapStep(step, (result) => (result.ok ? { ...result, cell } : result)));
}

/**
 * The admission checks of a decoded version-4 ballot (docs/spec/ballot-validity.md,
 * Admission (version 4)): version 3's, in its order, with the shape over both
 * halves and `share-hash-unqualified` over both panels' seats, default seats
 * first, naming the first such seat with its panel. The questions, both
 * panels and the cell's root and scope come from the definition and the
 * registered key sets, never from the ballot (T-16, T-17, T-28, T-37). The
 * proofs are over the computed `C_j`, under the version-4 statement, which
 * binds both halves (T-30, T-31, T-32). A ballot that passes is ranked by the
 * cell's tier, as version 3's.
 */
export function checkBallotV4(
  election: PanelBallotElection,
  ballot: BallotRecordV4,
): BallotCheckV4 {
  return finishBallotStep(stepBallotV4(election, ballot));
}

/** `checkBallotV4`'s checks run up to the membership proof, for `finishBallotSteps`. */
export function stepBallotV4(
  election: PanelBallotElection,
  ballot: BallotRecordV4,
): BallotStep<BallotCheckV4> {
  const definitionHash = madeHashOf(election, 4);
  const proof = ballot.membership_proof;
  const fields = fieldsOf(ballot);
  const { cell } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash))
    return stepOf({ done: { ok: false, code: "ballot-stray" } });
  const target = cellTarget(election, cell);
  if (target === undefined) return stepOf({ done: { ok: false, code: "ballot-cell" } });
  const named = { definitionHash, cell, nullifier: fields.nullifier };
  const step = admitStep(election, checksOfV4(election, named), target, fields, proof);
  return stepOf(mapStep(step, (result) => (result.ok ? { ...result, cell } : result)));
}

type AdmitCode = Exclude<BallotCode, "ballot-stray" | "ballot-tier">;

// The election's rules from the context, never from the ballot's committed vote.
function contextOf(election: ValidityRules, named: BallotHashContext): ValidityContext {
  return {
    optionCount: election.optionCount,
    minSelections: election.minSelections,
    maxSelections: election.maxSelections,
    threshold: election.threshold,
    panelSize: election.panelSize,
    ...named,
  };
}

function contextOfV3(election: ValidityRulesV3, named: BallotHashContextV3): ValidityContextV3 {
  return {
    questions: election.questions,
    threshold: election.threshold,
    panelSize: election.panelSize,
    ...named,
  };
}

function contextOfV4(election: ValidityRulesV4, named: BallotHashContextV3): ValidityContextV4 {
  return {
    questions: election.questions,
    threshold: election.threshold,
    panelSize: election.panelSize,
    authorThreshold: election.authorThreshold,
    authorPanelSize: election.authorPanelSize,
    ...named,
  };
}

// What admission runs on a committed vote of one ballot version, under the
// context the election and the record's named fields give.
interface VoteChecks<V, C extends { readonly definitionHash: Uint8Array }> {
  readonly ctx: C;
  readonly shape: (vote: V) => boolean;
  readonly hash: (vote: V) => Uint8Array;
  readonly validity: (vote: V) => ValidityResult | ValidityResultV3;
}

function checksOf(
  election: ValidityRules,
  named: BallotHashContext,
): VoteChecks<CommittedVote, ValidityContext> {
  const ctx = contextOf(election, named);
  return {
    ctx,
    shape: (vote) => shapeOk(ctx, vote),
    hash: (vote) => ballotHash(ctx, vote),
    validity: (vote) => checkValidity(ctx, vote),
  };
}

function checksOfV3(
  election: ValidityRulesV3,
  named: BallotHashContextV3,
): VoteChecks<CommittedVoteV3, ValidityContextV3> {
  const ctx = contextOfV3(election, named);
  return {
    ctx,
    shape: (vote) => shapeOkV3(ctx, vote),
    hash: (vote) => ballotHashV3(ctx, vote),
    validity: (vote) => checkValidityV3(ctx, vote),
  };
}

function checksOfV4(
  election: ValidityRulesV4,
  named: BallotHashContextV3,
): VoteChecks<CommittedVoteV4, ValidityContextV4> {
  const ctx = contextOfV4(election, named);
  return {
    ctx,
    shape: (vote) => shapeOkV4(ctx, vote),
    hash: (vote) => ballotHashV4(ctx, vote),
    validity: (vote) => checkValidityV4(ctx, vote),
  };
}

// A trustee's own seat, with its panel, and the hash of the ciphertext
// delivered for it, checked against the ballot's share hash for that seat of
// that panel after the cheap admission checks and before the proofs
// (docs/spec/share-encryption.md, Intake and receipts; Ballot version 4).
interface SeatCiphertext {
  readonly panel: SeatPanel;
  readonly seat: number;
  readonly shareHash: Uint8Array;
}

// The seats admission checks the share hashes of: the default panel's, and
// a version-4 context's author panel's too.
interface AdmitPanels {
  readonly panelSize: number;
  readonly qualified: readonly number[];
  readonly authorPanelSize?: number;
  readonly authorQualified?: readonly number[];
}

interface ShareHashLists {
  readonly share_hashes: readonly Uint8Array[];
  readonly author_share_hashes?: readonly Uint8Array[];
}

// A seat outside its panel's registered key set gets no shares, and its hash
// is fixed, so it carries no chosen bytes into the archive (T-17). Default
// seats first, then author seats, each in seat order. The shape holds, so
// each list has exactly its panel's seat count.
function firstUnqualified(
  election: AdmitPanels,
  vote: ShareHashLists,
): { readonly panel: SeatPanel; readonly seat: number } | undefined {
  const lists = [
    [SEAT_PANELS.default, election.panelSize, election.qualified, vote.share_hashes],
    [
      SEAT_PANELS.author,
      election.authorPanelSize ?? 0,
      election.authorQualified ?? [],
      vote.author_share_hashes ?? [],
    ],
  ] as const;
  for (const [panel, size, qualified, hashes] of lists)
    for (let seat = 1; seat <= size; seat++)
      if (!qualified.includes(seat) && !(hashes[seat - 1] as Uint8Array).every((b) => b === 0))
        return { panel, seat };
  return undefined;
}

// A ballot's admission checks up to its membership proof: either decided
// before it, or waiting on the proof's verdict, with the checks after it
// (the validity proofs) run only once the proof passes. Many ballots' proofs
// can then be verified together (docs/spec/vouching.md, Batched
// verification) without changing any verdict or running a validity proof
// for a ballot whose membership proof fails (T-52).
type Step<R> =
  | { readonly done: R }
  | { readonly check: MembershipProofCheck; readonly finish: (verified: boolean) => R };

function mapStep<R, S>(step: Step<R>, f: (result: R) => S): Step<S> {
  if ("done" in step) return { done: f(step.done) };
  const { check, finish } = step;
  return { check, finish: (verified) => f(finish(verified)) };
}

function runStep<R>(step: Step<R>): R {
  if ("done" in step) return step.done;
  return step.finish(verifyDecodedMembershipProof(step.check.proof, step.check.signals));
}

/**
 * A ballot's admission checks run up to its membership proof, by
 * `stepBallot` to `stepBallotV4`. Only `finishBallotStep` and
 * `finishBallotSteps` read it, and only steps this module made are accepted,
 * so no caller can finish one with a verdict it chose (T-05). The step holds
 * the decoded record, whose validity proofs are read when it is finished:
 * the record must not change in between, or the result would cover the
 * hash and signals of one vote and the validity proofs of another.
 */
export interface BallotStep<R> {
  /** Type-only: what finishing the step gives. Never set. */
  readonly result?: R;
}

const STEPS = new WeakMap<BallotStep<unknown>, Step<unknown>>();

function stepOf<R>(step: Step<R>): BallotStep<R> {
  const handle: BallotStep<R> = Object.freeze({});
  STEPS.set(handle, step);
  return handle;
}

function stepFrom<R>(handle: BallotStep<R>): Step<R> {
  const step = STEPS.get(handle);
  if (step === undefined) throw new TypeError("expected a step made by stepBallot to stepBallotV4");
  return step as Step<R>;
}

/** A step's result, its membership proof (if it reaches one) verified alone. */
export function finishBallotStep<R>(step: BallotStep<R>): R {
  return runStep(stepFrom(step));
}

/**
 * Each step's result, exactly as `finishBallotStep` gives it, with the
 * membership proofs of the steps that reach one verified together by
 * `verifyDecodedMembershipProofs` (docs/spec/ballot-validity.md, Batched
 * admission): in batches of at most 64, in order, each batch's coefficients
 * drawn from the CSPRNG once every proof is held, a failed batch split until
 * each proof's own verdict is known. A step whose proof fails is
 * `membership-proof` and runs no validity proof; the others' validity proofs
 * run after the batch. Batching lowers the cost of honest ballots; an
 * invalid proof costs at most its own batch that gain (T-52).
 */
export function finishBallotSteps<R>(steps: readonly BallotStep<R>[]): R[] {
  if (!Array.isArray(steps)) throw new TypeError("steps: expected an array");
  const waiting: { readonly at: number; readonly finish: (verified: boolean) => R }[] = [];
  const checks: MembershipProofCheck[] = [];
  const results: (R | undefined)[] = [];
  // By `entries`, so a hole is refused by `stepFrom` rather than skipped.
  for (const [at, handle] of steps.entries()) {
    const step = stepFrom<R>(handle);
    if ("done" in step) results.push(step.done);
    else {
      results.push(undefined);
      waiting.push({ at, finish: step.finish });
      checks.push(step.check);
    }
  }
  const verdicts = verifyDecodedMembershipProofs(checks);
  for (const [i, { at, finish }] of waiting.entries()) results[at] = finish(verdicts[i] === true);
  return results as R[];
}

// 5.1 to 5.4 once the election and the tier or cell are known, shared by
// every version: they differ in what the ballot names, and so in where the
// root and scope come from, and in the committed vote's checks.
function admit<V extends ShareHashLists>(
  election: AdmitPanels,
  checks: VoteChecks<V, { readonly definitionHash: Uint8Array }>,
  target: Target,
  fields: Fields<V>,
  proof: BallotRecord["membership_proof"],
  delivered: SeatCiphertext,
): Admitted | Rejected<AdmitCode | "share-hash"> {
  return runStep(admitStep(election, checks, target, fields, proof, delivered));
}

// `admit` up to the membership proof.
function admitStep<V extends ShareHashLists>(
  election: AdmitPanels,
  checks: VoteChecks<V, { readonly definitionHash: Uint8Array }>,
  target: Target,
  fields: Fields<V>,
  proof: BallotRecord["membership_proof"],
): Step<Admitted | Rejected<AdmitCode>>;
function admitStep<V extends ShareHashLists>(
  election: AdmitPanels,
  checks: VoteChecks<V, { readonly definitionHash: Uint8Array }>,
  target: Target,
  fields: Fields<V>,
  proof: BallotRecord["membership_proof"],
  delivered: SeatCiphertext,
): Step<Admitted | Rejected<AdmitCode | "share-hash">>;
function admitStep<V extends ShareHashLists>(
  election: AdmitPanels,
  checks: VoteChecks<V, { readonly definitionHash: Uint8Array }>,
  target: Target,
  fields: Fields<V>,
  proof: BallotRecord["membership_proof"],
  delivered?: SeatCiphertext,
): Step<Admitted | Rejected<AdmitCode | "share-hash">> {
  const { vote } = fields;
  if (!checks.shape(vote)) return { done: { ok: false, code: "validity-shape" } };
  const unqualified = firstUnqualified(election, vote);
  if (unqualified !== undefined)
    // Versions 1 to 3 have one panel, and their reports name no seat.
    return {
      done:
        election.authorQualified === undefined
          ? { ok: false, code: "share-hash-unqualified" }
          : { ok: false, code: "share-hash-unqualified", ...unqualified },
    };
  // The shape holds, so each list has exactly its panel's seat count, and
  // the delivered seat is a seat of its panel.
  const hashes =
    delivered?.panel === SEAT_PANELS.author ? vote.author_share_hashes : vote.share_hashes;
  if (
    delivered !== undefined &&
    !equalBytes(
      delivered.shareHash,
      (hashes as readonly Uint8Array[])[delivered.seat - 1] as Uint8Array,
    )
  )
    return { done: { ok: false, code: "share-hash" } };
  const hash = checks.hash(vote);
  const derived = signalsOf(checks.ctx.definitionHash, target, fields, hash);
  return {
    check: { proof, signals: derived.signals },
    finish: (verified) => {
      if (!verified) return { ok: false, code: "membership-proof" };
      const validity = checks.validity(vote);
      if (!validity.ok) return validity;
      return {
        ok: true,
        ballotHash: hash,
        message: derived.message,
        tier: target.tier,
        nullifier: fields.nullifier,
        l1RefNumber: fields.l1RefNumber,
        l1RefHash: fields.l1RefHash,
      };
    },
  };
}

/** A trustee's intake admission codes, in checking order: `share-hash` sits before the membership proof. */
export type IntakeAdmissionCode = "delivery-malformed" | BallotCode | BallotV2Code | "share-hash";

export type IntakeAdmission =
  | (Admitted &
      (
        | {
            /** What the trustee's decryption and the ballot hash run under. */
            readonly ctx: ValidityContext;
            /** The decoded committed vote, whose `vss` the trustee's shares are checked against. */
            readonly vote: CommittedVote;
            /** The ballot's cell, under ballot version 2. */
            readonly cell?: number;
          }
        | {
            readonly ctx: ValidityContextV3;
            readonly vote: CommittedVoteV3;
            /** The ballot's cell, under ballot version 3. */
            readonly cell: number;
          }
      ))
  | Rejected<IntakeAdmissionCode>;

/**
 * Internal: steps 1 to 4 of trustee intake (docs/spec/share-encryption.md,
 * Intake and receipts) on a delivered ballot record: strict decoding under
 * the version the election pins (`delivery-malformed`), then the admission
 * checks of verifier 5.1 to 5.4 in their order with `share-hash` (the
 * delivered ciphertext's hash against the ballot's for `seat`) between
 * `share-hash-unqualified` and `membership-proof`. So a trustee receipts only
 * a ballot whose membership proof verifies against its tier's (or cell's)
 * root in the definition (ADR 0002, Decision, 2026-10-12; T-52, T-25), and
 * the costly checks run only after the cheap ones. `seat` must be a seat of
 * the registered key set.
 */
export function admitForIntake(
  election: BallotElection | CellBallotElection | QuestionBallotElection,
  record: Uint8Array,
  seat: number,
  shareHash: Uint8Array,
): IntakeAdmission {
  const made = MADE.get(election);
  if (made === undefined)
    throw new TypeError(
      "expected a context made by ballotElection, cellBallotElection or questionBallotElection",
    );
  if (!Number.isSafeInteger(seat) || !election.qualified.includes(seat))
    throw new RangeError("admitForIntake: seat must be a seat of the registered key set");
  if (!(shareHash instanceof Uint8Array) || shareHash.length !== 32)
    throw new RangeError("admitForIntake: shareHash must be 32 bytes");
  const delivered = { panel: SEAT_PANELS.default, seat, shareHash: Uint8Array.from(shareHash) };
  const { definitionHash, version } = made;
  // Version 4 has its own entry point, which names the seat's panel.
  if (version === 4)
    throw new TypeError("admitForIntake: use admitForIntakeV4 for ballot version 4");
  // The context's version, from the map, decides which layout the record is
  // read under, never a property the record or the context could fake.
  if (version === 3) {
    let ballot: BallotRecordV3;
    try {
      ballot = decodeBallot(record, 3);
    } catch {
      return { ok: false, code: "delivery-malformed" };
    }
    const questions = election as QuestionBallotElection;
    const fields = fieldsOf(ballot);
    if (!equalBytes(fields.definitionHash, definitionHash))
      return { ok: false, code: "ballot-stray" };
    const { cell } = ballot;
    const target = cellTarget(questions, cell);
    if (target === undefined) return { ok: false, code: "ballot-cell" };
    const checks = checksOfV3(questions, { definitionHash, cell, nullifier: fields.nullifier });
    const result = admit(questions, checks, target, fields, ballot.membership_proof, delivered);
    if (!result.ok) return result;
    return { ...result, ctx: checks.ctx, vote: fields.vote, cell };
  }
  let ballot: BallotRecord | BallotRecordV2;
  try {
    ballot = version === 1 ? decodeBallot(record, 1) : decodeBallot(record, 2);
  } catch {
    return { ok: false, code: "delivery-malformed" };
  }
  const fields = fieldsOf(ballot);
  if (!equalBytes(fields.definitionHash, definitionHash))
    return { ok: false, code: "ballot-stray" };
  let named: BallotHashContext;
  let target: Target | undefined;
  if ("cell" in ballot) {
    const { cell } = ballot;
    target = cellTarget(election as CellBallotElection, cell);
    if (target === undefined) return { ok: false, code: "ballot-cell" };
    named = { definitionHash, ballotVersion: 2, cell, nullifier: fields.nullifier };
  } else {
    const { tier } = ballot;
    target = tierTarget(election as BallotElection, tier);
    if (target === undefined) return { ok: false, code: "ballot-tier" };
    named = { definitionHash, tier, nullifier: fields.nullifier };
  }
  const rules = election as BallotElection | CellBallotElection;
  const checks = checksOf(rules, named);
  const result = admit(rules, checks, target, fields, ballot.membership_proof, delivered);
  if (!result.ok) return result;
  const { ctx } = checks;
  const vote = fields.vote;
  return named.ballotVersion === 2
    ? { ...result, ctx, vote, cell: named.cell }
    : { ...result, ctx, vote };
}

/** A trustee's intake admission of a version-4 ballot: version 3's, with the seat's panel. */
export type IntakeAdmissionV4 =
  | (Admitted & {
      /** What the trustee's decryption and the ballot hash run under. */
      readonly ctx: ValidityContextV4;
      /** The decoded committed vote, whose `vss` or `author_vss` the seat's shares are checked against. */
      readonly vote: CommittedVoteV4;
      readonly cell: number;
      readonly panel: SeatPanel;
    })
  | Rejected<"delivery-malformed" | BallotV2Code | "share-hash">;

/**
 * Internal: `admitForIntake` for ballot version 4 (docs/spec/share-encryption.md,
 * Ballot version 4; docs/spec/ballot-validity.md, Admission (version 4)), at a
 * seat of either panel: strict decoding under version 4
 * (`delivery-malformed`), then version 4's admission checks in order, with
 * `share-hash` (the delivered ciphertext's hash against the ballot's for
 * `seat` of `panel`, never the other panel's list) between
 * `share-hash-unqualified` and `membership-proof`. So a seat of either panel
 * receipts only a ballot whose membership proof verifies against its cell's
 * root (ADR 0002, Decision, 2026-10-12; T-52, T-25), and a seat of one panel
 * can never stand for the same index of the other (T-37). `seat` must be a
 * seat of its panel's registered key set.
 */
export function admitForIntakeV4(
  election: PanelBallotElection,
  record: Uint8Array,
  panel: SeatPanel,
  seat: number,
  shareHash: Uint8Array,
): IntakeAdmissionV4 {
  const definitionHash = madeHashOf(election, 4);
  if (panel !== SEAT_PANELS.default && panel !== SEAT_PANELS.author)
    throw new RangeError("admitForIntakeV4: panel must be 1 (default) or 2 (author)");
  const qualified = panel === SEAT_PANELS.author ? election.authorQualified : election.qualified;
  if (!Number.isSafeInteger(seat) || !qualified.includes(seat))
    throw new RangeError("admitForIntakeV4: seat must be a seat of its panel's registered key set");
  if (!(shareHash instanceof Uint8Array) || shareHash.length !== 32)
    throw new RangeError("admitForIntakeV4: shareHash must be 32 bytes");
  const delivered = { panel, seat, shareHash: Uint8Array.from(shareHash) };
  let ballot: BallotRecordV4;
  try {
    ballot = decodeBallot(record, 4);
  } catch {
    return { ok: false, code: "delivery-malformed" };
  }
  const fields = fieldsOf(ballot);
  if (!equalBytes(fields.definitionHash, definitionHash))
    return { ok: false, code: "ballot-stray" };
  const { cell } = ballot;
  const target = cellTarget(election, cell);
  if (target === undefined) return { ok: false, code: "ballot-cell" };
  const checks = checksOfV4(election, { definitionHash, cell, nullifier: fields.nullifier });
  const result = admit(election, checks, target, fields, ballot.membership_proof, delivered);
  if (!result.ok) return result;
  return { ...result, ctx: checks.ctx, vote: fields.vote, cell, panel };
}

// Public data, so a constant-time comparison isn't needed.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
