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
  type CommittedVote,
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
 * seats (T-37). The caller has decoded the definition and run verifier 2.4
 * for it (no tier root is 0).
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
  const definitionHash = electionDefinitionHash(definition);
  const election: BallotElection = Object.freeze({
    definitionHash,
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
          scope: membershipScope(definitionHash, g.tier, g.root),
        }),
      ),
    ),
    qualified: Object.freeze(registered.map((k) => k.index)),
  });
  MADE.add(election);
  return election;
}

// Contexts `ballotElection` made: a hand-built one could pair a definition
// hash with another election's roots, scopes or seats.
const MADE = new WeakSet<BallotElection>();

function checkMade(election: BallotElection): void {
  if (!MADE.has(election)) throw new TypeError("expected a context made by ballotElection");
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
  checkMade(election);
  if (!equalBytes(ballot.definition_hash, election.definitionHash)) return undefined;
  const hash = ballotHash(
    { definitionHash: election.definitionHash, tier: ballot.tier, nullifier: ballot.nullifier },
    ballot.committed_vote,
  );
  return signalsOf(election, ballot, hash)?.signals;
}

function signalsOf(election: BallotElection, ballot: UnprovenBallot, hash: Uint8Array) {
  const group = election.tiers.find((g) => g.tier === ballot.tier);
  if (group === undefined) return undefined;
  // M binds the election, the tier, the ballot hash and the L1 block (T-38, T-45).
  const message = membershipMessage({
    definitionHash: election.definitionHash,
    tier: ballot.tier,
    ballotHash: hash,
    l1RefNumber: ballot.l1_ref_number,
    l1RefHash: ballot.l1_ref_hash,
  });
  const signals: MembershipSignals = {
    root: group.root,
    nullifier: ballot.nullifier,
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
  checkMade(election);
  if (!equalBytes(ballot.definition_hash, election.definitionHash))
    return { ok: false, code: "ballot-stray" };
  if (!election.tiers.some((g) => g.tier === ballot.tier))
    return { ok: false, code: "ballot-tier" };
  const ctx: ValidityContext = {
    definitionHash: election.definitionHash,
    optionCount: election.optionCount,
    minSelections: election.minSelections,
    maxSelections: election.maxSelections,
    threshold: election.threshold,
    panelSize: election.panelSize,
    tier: ballot.tier,
    nullifier: ballot.nullifier,
  };
  const vote: CommittedVote = ballot.committed_vote;
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
  const derived = signalsOf(election, ballot, hash) as NonNullable<ReturnType<typeof signalsOf>>;
  if (!verifyDecodedMembershipProof(ballot.membership_proof, derived.signals))
    return { ok: false, code: "membership-proof" };
  const validity = checkValidity(ctx, vote);
  if (!validity.ok) return validity;
  return {
    ok: true,
    ballotHash: hash,
    message: derived.message,
    tier: ballot.tier,
    nullifier: ballot.nullifier,
    l1RefNumber: ballot.l1_ref_number,
    l1RefHash: Uint8Array.from(ballot.l1_ref_hash),
  };
}

// Public data, so a constant-time comparison isn't needed.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
