// The ballot record, type 0x0002 versions 1 and 2 (docs/spec/ballot-validity.md,
// Ballot record): a cast ballot's committed vote with its tier (version 2: its
// cell), nullifier, L1 reference and membership proof, and its admission
// checks (verifier 5.1 to 5.4): the election it names, its tier or cell, the
// committed vote's shape, the share hashes of seats outside the registered
// key set, the membership proof over the message the verifier recomputes,
// then the validity proofs. The L1 reference (5.8), repeats and ties (5.7,
// 6.1) and delivery (5.9) are checked over the result by `checkL1Reference`,
// `selectBallots` and `checkDelivery`.

import {
  ballotHash,
  type BallotHashContext,
  checkValidity,
  COMMITTED_VOTE,
  type CommittedVote,
  shapeOk,
  type ValidityContext,
  type ValidityRules,
} from "./ballot-validity.ts";
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
  TIERS,
} from "./election-definition.ts";
import { membershipScope, semaphoreField } from "./membership.ts";
import {
  type MembershipSignals,
  membershipProof,
  membershipVkHash,
  verifyDecodedMembershipProof,
} from "./membership-proof.ts";
import {
  electionDefinitionHash,
  electionDefinitionV3Hash,
  electionDefinitionV4Hash,
  pinnedVersion,
  UnsupportedVersionError,
} from "./protocol.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { KEM_PUBLIC_KEY } from "./share-encryption.ts";
import { membershipMessage } from "./revoting.ts";

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

/** Ballot record, version 1: one cast ballot, naming its tier. */
export type BallotRecord = CodecValue<typeof ballotV1>;

/** Ballot record, version 2: one cast ballot, naming its cell (definition version 3). */
export type BallotRecordV2 = CodecValue<typeof ballotV2>;

/** The fields a ballot's membership proof is made over: every field but the proof. */
export type UnprovenBallot = Omit<BallotRecord, "membership_proof">;

/** The fields a version-2 ballot's membership proof is made over. */
export type UnprovenBallotV2 = Omit<BallotRecordV2, "membership_proof">;

/** Record type `0x0002`. The election's profile pins its version. */
export const BALLOT = recordType(RECORD_TYPES.ballot, { 1: ballotV1, 2: ballotV2 });

const SCHEMA = new RecordSchema([BALLOT]);

export function encodeBallot(record: BallotRecord): Uint8Array {
  return SCHEMA.encode(BALLOT, 1, record);
}

export function encodeBallotV2(record: BallotRecordV2): Uint8Array {
  return SCHEMA.encode(BALLOT, 2, record);
}

/**
 * Strictly decodes a ballot record against the version the election's profile
 * pins. Decoding doesn't compare the definition hash, tier or cell with the
 * election; `checkBallot` and `checkBallotV2` do, so a ballot naming another
 * election is still read, and reported (docs/spec/ballot-validity.md, Ballot
 * record).
 */
export function decodeBallot(bytes: Uint8Array, pinned: 1): BallotRecord;
export function decodeBallot(bytes: Uint8Array, pinned: 2): BallotRecordV2;
export function decodeBallot(bytes: Uint8Array, pinned: 1 | 2): BallotRecord | BallotRecordV2 {
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
  readonly cells: readonly {
    readonly cell: number;
    readonly tier: number;
    readonly root: bigint;
    readonly scope: bigint;
  }[];
  readonly qualified: readonly number[];
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
  KEYS.set(
    election,
    Object.freeze(
      registered.map((k) =>
        Object.freeze({
          index: k.index,
          kemKey: decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, k.kemKey)),
          signingKey: Uint8Array.from(k.signingKey),
        }),
      ),
    ),
  );
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
  const cells = definition.electorate.flatMap((t) =>
    t.cells.map((c) => ({ tier: t.tier, root: c.root })),
  );
  // The u8 a ballot names; the definition's `cells` rule caps it at 256 too.
  if (cells.length > 256) throw new RangeError("cellBallotElection: more than 256 cells");
  const election: CellBallotElection = Object.freeze({
    definitionHash: Uint8Array.from(definitionHash),
    ...rulesOf(definition),
    cells: Object.freeze(
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
    ),
    qualified: Object.freeze(registered.map((k) => k.index)),
  });
  MADE.set(election, { definitionHash, version: 2 });
  return election;
}

type AnyDefinition = ElectionDefinition | ElectionDefinitionV3 | ElectionDefinitionV4;

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

function rulesOf(definition: AnyDefinition): ValidityRules {
  return {
    optionCount: definition.option_count,
    minSelections: definition.min_selections,
    maxSelections: definition.max_selections,
    threshold: definition.threshold,
    panelSize: definition.panel_size,
  };
}

// Contexts `ballotElection` and `cellBallotElection` made, each with its own
// copy of the definition hash and the ballot version it checks: a hand-built
// context, or one whose exposed hash was overwritten in place (a frozen
// object's byte array isn't frozen), could pair a definition hash with
// another election's roots, scopes or seats, and a context of one version
// must never check the other's records.
const MADE = new WeakMap<
  object,
  { readonly definitionHash: Uint8Array; readonly version: 1 | 2 }
>();

function madeHashOf(election: object, version: 1 | 2): Uint8Array {
  const made = MADE.get(election);
  if (made === undefined || made.version !== version)
    throw new TypeError(
      `expected a context made by ${version === 1 ? "ballotElection" : "cellBallotElection"}`,
    );
  return made.definitionHash;
}

// The registered key set of each version-1 context, copied when it was made,
// for checks that rebuild ciphertexts (docs/spec/challenge.md, Checks).
const KEYS = new WeakMap<BallotElection, readonly RegisteredKeys[]>();

/** Internal: the registered key set `ballotElection` made this context from. */
export function registeredKeysOf(election: BallotElection): readonly RegisteredKeys[] {
  const keys = KEYS.get(election);
  if (keys === undefined) throw new TypeError("expected a context made by ballotElection");
  return keys;
}

/** Internal: the definition hash `ballotElection` made this context from. */
export function definitionHashOf(election: BallotElection): Uint8Array {
  return madeHashOf(election, 1);
}

/** The root and scope a ballot proves against, and the tier its message and re-vote rule use. */
interface Target {
  readonly tier: number;
  readonly root: bigint;
  readonly scope: bigint;
}

const tierTarget = (election: BallotElection, tier: number): Target | undefined =>
  election.tiers.find((g) => g.tier === tier);

const cellTarget = (election: CellBallotElection, cell: number): Target | undefined =>
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

type Fields = ReturnType<typeof fieldsOf>;

// Reads each common field once, so a record with getters can't show one
// check one value and the next another. The tier or cell is read once by
// the caller.
function fieldsOf(ballot: Omit<UnprovenBallot, "tier"> | Omit<UnprovenBallotV2, "cell">) {
  const { definition_hash, nullifier, l1_ref_number, l1_ref_hash, committed_vote } = ballot;
  return {
    definitionHash: definition_hash,
    nullifier,
    l1RefNumber: l1_ref_number,
    l1RefHash: Uint8Array.from(l1_ref_hash),
    vote: committed_vote,
  };
}

function signalsOf(definitionHash: Uint8Array, target: Target, fields: Fields, hash: Uint8Array) {
  // M binds the election, the tier, the ballot hash (and through it a
  // version-2 ballot's cell) and the L1 block (T-38, T-45).
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

/** Version 2's admission codes: `ballot-cell` in place of `ballot-tier`. */
export type BallotV2Code = Exclude<BallotCode, "ballot-tier"> | "ballot-cell";

type Admitted = {
  readonly ok: true;
  readonly ballotHash: Uint8Array;
  /** `M`, recomputed: what 5.7 compares, never the proof's bytes (T-38). */
  readonly message: Uint8Array;
  /** The tier the re-vote rule ranks by (version 2: the cell's tier). */
  readonly tier: number;
  readonly nullifier: bigint;
  readonly l1RefNumber: bigint;
  readonly l1RefHash: Uint8Array;
};

type Rejected<C> = { readonly ok: false; readonly code: C; readonly option?: number };

export type BallotCheck = Admitted | Rejected<BallotCode>;

export type BallotCheckV2 = (Admitted & { readonly cell: number }) | Rejected<BallotV2Code>;

/**
 * The admission checks of a decoded ballot record (docs/spec/ballot-validity.md,
 * Ballot record; verifier 5.1 to 5.4), in order; the first failure is the
 * result, which rejects this entry only. A ballot that passes still needs its
 * L1 reference admitted (5.8) and the close rule (5.5) before selection.
 */
export function checkBallot(election: BallotElection, ballot: BallotRecord): BallotCheck {
  const definitionHash = madeHashOf(election, 1);
  const proof = ballot.membership_proof;
  const fields = fieldsOf(ballot);
  const { tier } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash))
    return { ok: false, code: "ballot-stray" };
  const target = tierTarget(election, tier);
  if (target === undefined) return { ok: false, code: "ballot-tier" };
  return admit(
    election,
    { definitionHash, tier, nullifier: fields.nullifier },
    target,
    fields,
    proof,
  );
}

/**
 * The admission checks of a decoded version-2 ballot (docs/spec/ballot-validity.md,
 * Ballot record (version 2)): `ballot-cell` refuses a cell the partition
 * doesn't have, and the membership proof is checked against the cell's root
 * and scope, never a root or scope the ballot chooses (verifier 2.8, 5.1,
 * 5.2; T-16). A ballot that passes is ranked by the cell's tier.
 */
export function checkBallotV2(election: CellBallotElection, ballot: BallotRecordV2): BallotCheckV2 {
  const definitionHash = madeHashOf(election, 2);
  const proof = ballot.membership_proof;
  const fields = fieldsOf(ballot);
  const { cell } = ballot;
  if (!equalBytes(fields.definitionHash, definitionHash))
    return { ok: false, code: "ballot-stray" };
  const target = cellTarget(election, cell);
  if (target === undefined) return { ok: false, code: "ballot-cell" };
  const result = admit(
    election,
    { definitionHash, ballotVersion: 2, cell, nullifier: fields.nullifier },
    target,
    fields,
    proof,
  );
  return result.ok ? { ...result, cell } : result;
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

// A trustee's own seat and the hash of the ciphertext delivered for it,
// checked against the ballot's share hash after the cheap admission checks
// and before the proofs (docs/spec/share-encryption.md, Intake and receipts).
interface SeatCiphertext {
  readonly seat: number;
  readonly shareHash: Uint8Array;
}

// 5.1 to 5.4 once the election and the tier or cell are known, shared by
// both versions: they differ only in what the ballot names, and so in where
// the root and scope come from.
function admit(
  election: ValidityRules & { readonly qualified: readonly number[] },
  named: BallotHashContext,
  target: Target,
  fields: Fields,
  proof: BallotRecord["membership_proof"],
): Admitted | Rejected<AdmitCode>;
function admit(
  election: ValidityRules & { readonly qualified: readonly number[] },
  named: BallotHashContext,
  target: Target,
  fields: Fields,
  proof: BallotRecord["membership_proof"],
  delivered: SeatCiphertext,
): Admitted | Rejected<AdmitCode | "share-hash">;
function admit(
  election: ValidityRules & { readonly qualified: readonly number[] },
  named: BallotHashContext,
  target: Target,
  fields: Fields,
  proof: BallotRecord["membership_proof"],
  delivered?: SeatCiphertext,
): Admitted | Rejected<AdmitCode | "share-hash"> {
  const { vote } = fields;
  const ctx = contextOf(election, named);
  if (!shapeOk(ctx, vote)) return { ok: false, code: "validity-shape" };
  // A seat outside the registered key set gets no shares, and its hash is
  // fixed, so it carries no chosen bytes into the archive (T-17).
  for (let seat = 1; seat <= election.panelSize; seat++)
    if (
      !election.qualified.includes(seat) &&
      !(vote.share_hashes[seat - 1] as Uint8Array).every((b) => b === 0)
    )
      return { ok: false, code: "share-hash-unqualified" };
  // The shape holds, so the ballot has exactly n share hashes.
  if (
    delivered !== undefined &&
    !equalBytes(delivered.shareHash, vote.share_hashes[delivered.seat - 1] as Uint8Array)
  )
    return { ok: false, code: "share-hash" };
  const hash = ballotHash(ctx, vote);
  const derived = signalsOf(named.definitionHash, target, fields, hash);
  if (!verifyDecodedMembershipProof(proof, derived.signals))
    return { ok: false, code: "membership-proof" };
  const validity = checkValidity(ctx, vote);
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
}

/** A trustee's intake admission codes, in checking order: `share-hash` sits before the membership proof. */
export type IntakeAdmissionCode = "delivery-malformed" | BallotCode | BallotV2Code | "share-hash";

export type IntakeAdmission =
  | (Admitted & {
      /** What the trustee's decryption and the ballot hash run under. */
      readonly ctx: ValidityContext;
      /** The decoded committed vote, whose `vss` the trustee's shares are checked against. */
      readonly vote: CommittedVote;
      /** The ballot's cell, under ballot version 2. */
      readonly cell?: number;
    })
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
  election: BallotElection | CellBallotElection,
  record: Uint8Array,
  seat: number,
  shareHash: Uint8Array,
): IntakeAdmission {
  const made = MADE.get(election);
  if (made === undefined)
    throw new TypeError("expected a context made by ballotElection or cellBallotElection");
  if (!Number.isSafeInteger(seat) || !election.qualified.includes(seat))
    throw new RangeError("admitForIntake: seat must be a seat of the registered key set");
  if (!(shareHash instanceof Uint8Array) || shareHash.length !== 32)
    throw new RangeError("admitForIntake: shareHash must be 32 bytes");
  const delivered = { seat, shareHash: Uint8Array.from(shareHash) };
  const { definitionHash, version } = made;
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
  const result = admit(election, named, target, fields, ballot.membership_proof, delivered);
  if (!result.ok) return result;
  const ctx = contextOf(election, named);
  const vote = fields.vote;
  return named.ballotVersion === 2
    ? { ...result, ctx, vote, cell: named.cell }
    : { ...result, ctx, vote };
}

// Public data, so a constant-time comparison isn't needed.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
