// The ballot record, type 0x0002 version 1 (docs/spec/ballot-validity.md,
// Ballot record): a cast ballot's committed vote with its tier, nullifier, L1
// reference and membership proof, and its admission checks (verifier 5.1 to
// 5.4): the election it names, its tier, the committed vote's shape, the
// share hashes of seats outside the registered key set, the membership proof
// over the message the verifier recomputes, then the validity proofs. The L1
// reference (5.8), repeats and ties (5.7, 6.1) and delivery (5.9) are
// checked over the result by `checkL1Reference`, `selectBallots` and
// `checkDelivery`.

import {
  ballotHash,
  checkValidity,
  COMMITTED_VOTE,
  shapeOk,
  type ValidityContext,
  type ValidityRules,
} from "./ballot-validity.ts";
import { checkedTranscriptHash, type RegisteredKeys } from "./ceremony.ts";
import { bytesFixed, type CodecValue, enum8, fieldBn254, struct, u64 } from "./codec.ts";
import { type ElectionDefinition, TIERS } from "./election-definition.ts";
import { membershipScope, semaphoreField } from "./membership.ts";
import {
  type MembershipSignals,
  membershipProof,
  membershipVkHash,
  verifyDecodedMembershipProof,
} from "./membership-proof.ts";
import { electionDefinitionHash, pinnedVersion, UnsupportedVersionError } from "./protocol.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
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

/** Ballot record, version 1: one cast ballot. */
export type BallotRecord = CodecValue<typeof ballotV1>;

/** The fields a ballot's membership proof is made over: every field but the proof. */
export type UnprovenBallot = Omit<BallotRecord, "membership_proof">;

/** Record type `0x0002`. The election's profile pins its version. */
export const BALLOT = recordType(RECORD_TYPES.ballot, { 1: ballotV1 });

const SCHEMA = new RecordSchema([BALLOT]);

export function encodeBallot(record: BallotRecord): Uint8Array {
  return SCHEMA.encode(BALLOT, 1, record);
}

/**
 * Strictly decodes a ballot record against the version the election's profile
 * pins. Decoding doesn't compare the definition hash or tier with the
 * election; `checkBallot` does, so a ballot naming another election is still
 * read, and reported (docs/spec/ballot-validity.md, Ballot record).
 */
export function decodeBallot(bytes: Uint8Array, pinned: 1): BallotRecord {
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
  const transcript = checkedTranscriptHash(registered);
  if (transcript === undefined || !equalBytes(transcript, definition.ceremony_transcript_hash))
    throw new RangeError("ballotElection: not the key set of this definition's ceremony");
  if (!equalBytes(definition.membership_vk_hash, membershipVkHash()))
    throw new RangeError("ballotElection: the definition names another membership key");
  const definitionHash = electionDefinitionHash(definition);
  const election: BallotElection = Object.freeze({
    definitionHash: Uint8Array.from(definitionHash),
    optionCount: definition.option_count,
    minSelections: definition.min_selections,
    maxSelections: definition.max_selections,
    threshold: definition.threshold,
    panelSize: definition.panel_size,
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
  MADE.set(election, definitionHash);
  return election;
}

// Contexts `ballotElection` made, each with its own copy of the definition
// hash: a hand-built context, or one whose exposed hash was overwritten in
// place (a frozen object's byte array isn't frozen), could pair a definition
// hash with another election's roots, scopes or seats.
const MADE = new WeakMap<BallotElection, Uint8Array>();

function definitionHashOf(election: BallotElection): Uint8Array {
  const hash = MADE.get(election);
  if (hash === undefined) throw new TypeError("expected a context made by ballotElection");
  return hash;
}

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
  const definitionHash = definitionHashOf(election);
  const fields = fieldsOf(ballot);
  if (!equalBytes(fields.definitionHash, definitionHash)) return undefined;
  const hash = ballotHash(
    { definitionHash, tier: fields.tier, nullifier: fields.nullifier },
    fields.vote,
  );
  return signalsOf(election, definitionHash, fields, hash)?.signals;
}

type Fields = ReturnType<typeof fieldsOf>;

// Reads each field once, so a record with getters can't show one check one
// value and the next another.
function fieldsOf(ballot: UnprovenBallot) {
  const { definition_hash, tier, nullifier, l1_ref_number, l1_ref_hash, committed_vote } = ballot;
  return {
    definitionHash: definition_hash,
    tier,
    nullifier,
    l1RefNumber: l1_ref_number,
    l1RefHash: Uint8Array.from(l1_ref_hash),
    vote: committed_vote,
  };
}

function signalsOf(
  election: BallotElection,
  definitionHash: Uint8Array,
  fields: Fields,
  hash: Uint8Array,
) {
  const group = election.tiers.find((g) => g.tier === fields.tier);
  if (group === undefined) return undefined;
  // M binds the election, the tier, the ballot hash and the L1 block (T-38, T-45).
  const message = membershipMessage({
    definitionHash,
    tier: fields.tier,
    ballotHash: hash,
    l1RefNumber: fields.l1RefNumber,
    l1RefHash: fields.l1RefHash,
  });
  const signals: MembershipSignals = {
    root: group.root,
    nullifier: fields.nullifier,
    message: semaphoreField(message),
    scope: group.scope,
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

export type BallotCheck =
  | {
      readonly ok: true;
      readonly ballotHash: Uint8Array;
      /** `M`, recomputed: what 5.7 compares, never the proof's bytes (T-38). */
      readonly message: Uint8Array;
      readonly tier: number;
      readonly nullifier: bigint;
      readonly l1RefNumber: bigint;
      readonly l1RefHash: Uint8Array;
    }
  | { readonly ok: false; readonly code: BallotCode; readonly option?: number };

/**
 * The admission checks of a decoded ballot record (docs/spec/ballot-validity.md,
 * Ballot record; verifier 5.1 to 5.4), in order; the first failure is the
 * result, which rejects this entry only. A ballot that passes still needs its
 * L1 reference admitted (5.8) and the close rule (5.5) before selection.
 */
export function checkBallot(election: BallotElection, ballot: BallotRecord): BallotCheck {
  const definitionHash = definitionHashOf(election);
  const proof = ballot.membership_proof;
  const fields = fieldsOf(ballot);
  const { tier, nullifier, vote } = fields;
  if (!equalBytes(fields.definitionHash, definitionHash))
    return { ok: false, code: "ballot-stray" };
  if (!election.tiers.some((g) => g.tier === tier)) return { ok: false, code: "ballot-tier" };
  const ctx: ValidityContext = {
    definitionHash,
    optionCount: election.optionCount,
    minSelections: election.minSelections,
    maxSelections: election.maxSelections,
    threshold: election.threshold,
    panelSize: election.panelSize,
    tier,
    nullifier,
  };
  if (!shapeOk(ctx, vote)) return { ok: false, code: "validity-shape" };
  // A seat outside the registered key set gets no shares, and its hash is
  // fixed, so it carries no chosen bytes into the archive (T-17).
  for (let seat = 1; seat <= election.panelSize; seat++)
    if (
      !election.qualified.includes(seat) &&
      !(vote.share_hashes[seat - 1] as Uint8Array).every((b) => b === 0)
    )
      return { ok: false, code: "share-hash-unqualified" };
  const hash = ballotHash(ctx, vote);
  // The tier was found above, so the signals exist.
  const derived = signalsOf(election, definitionHash, fields, hash) as NonNullable<
    ReturnType<typeof signalsOf>
  >;
  if (!verifyDecodedMembershipProof(proof, derived.signals))
    return { ok: false, code: "membership-proof" };
  const validity = checkValidity(ctx, vote);
  if (!validity.ok) return validity;
  return {
    ok: true,
    ballotHash: hash,
    message: derived.message,
    tier,
    nullifier,
    l1RefNumber: fields.l1RefNumber,
    l1RefHash: fields.l1RefHash,
  };
}

// Public data, so a constant-time comparison isn't needed.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
