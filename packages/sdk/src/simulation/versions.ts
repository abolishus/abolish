// The two definition versions a simulation registers and the ballot version
// each pins ([[verifier]] 2.3, `profile-combination`): version 4, one
// question, with ballot version 2, and version 5, several questions
// ([[0026-multi-question-ballots]]), with ballot version 3. Both pin
// spoiled-ballot opening version 2, whose cores are either ballot's. Each
// function here picks @abolishus/crypto's own code for the version and calls
// it unchanged, so the rest of the run is written once over both (AGENTS.md,
// Architecture; T-28, T-34).

import {
  type BallotCheckV2,
  type BallotRecordV2,
  type BallotRecordV3,
  ballotHash,
  ballotHashV3,
  type CellBallotElection,
  cellBallotElection,
  checkBallotV2,
  checkBallotV3,
  checkShareReceipt,
  checkShareReceiptV3,
  type CommittedVote,
  type CommittedVoteV3,
  decodeBallot,
  type ElectionDefinitionV4,
  type ElectionDefinitionV5,
  electionDefinitionV4Hash,
  electionDefinitionV4Rule,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  electionStubV4Hash,
  electionStubV5Hash,
  encodeBallotV2,
  encodeBallotV3,
  encodeElectionDefinitionV4,
  encodeElectionDefinitionV5,
  proveValidity,
  proveValidityV3,
  type QuestionBallotElection,
  questionBallotElection,
  type ReceiptSigner,
  type RegisteredKeys,
  shareVote,
  shareVoteV3,
  type ValidityContext,
  type ValidityContextV3,
  type VoteSharing,
} from "@abolishus/crypto";

export type SimulatedDefinition = ElectionDefinitionV4 | ElectionDefinitionV5;

/** A definition as a record of its version, the form crypto's tally and summed-share code take. */
export type SimulatedDefinitionRecord =
  | { readonly version: 4; readonly value: ElectionDefinitionV4 }
  | { readonly version: 5; readonly value: ElectionDefinitionV5 };

export const definitionRecord = (d: SimulatedDefinition): SimulatedDefinitionRecord =>
  "questions" in d ? { version: 5, value: d } : { version: 4, value: d };

export const definitionHashOf = (d: SimulatedDefinition): Uint8Array =>
  "questions" in d ? electionDefinitionV5Hash(d) : electionDefinitionV4Hash(d);

export const stubHashOf = (d: SimulatedDefinition): Uint8Array =>
  "questions" in d ? electionStubV5Hash(d) : electionStubV4Hash(d);

export const encodeDefinition = (d: SimulatedDefinition): Uint8Array =>
  "questions" in d ? encodeElectionDefinitionV5(d) : encodeElectionDefinitionV4(d);

/** The first well-formedness rule `d` breaks, under its own version's rules, or `undefined`. */
export const definitionRuleOf = (d: SimulatedDefinition): string | undefined =>
  "questions" in d ? electionDefinitionV5Rule(d)?.rule : electionDefinitionV4Rule(d);

/** The ballot version a simulated definition pins. */
export type SimulatedBallotVersion = 2 | 3;

export type SimulatedVote = CommittedVote | CommittedVoteV3;
export type SimulatedBallotRecord = BallotRecordV2 | BallotRecordV3;
export type SimulatedBallotElection = CellBallotElection | QuestionBallotElection;
export type SimulatedValidityContext = ValidityContext | ValidityContextV3;

/** What names a ballot beside its committed vote. */
export interface BallotName {
  readonly definitionHash: Uint8Array;
  readonly cell: number;
  readonly nullifier: bigint;
}

/** The ballot hash, `ballotHash` or `ballotHashV3`, which receipts, postings and `M` bind. */
export const ballotHashOf = (
  version: SimulatedBallotVersion,
  name: BallotName,
  vote: SimulatedVote,
): Uint8Array =>
  version === 3
    ? ballotHashV3(name, vote as CommittedVoteV3)
    : ballotHash({ ...name, ballotVersion: 2 }, vote as CommittedVote);

/** `decodeBallot` under the pinned version: throws crypto's `DecodeError`. */
export const decodeSimulatedBallot = (
  bytes: Uint8Array,
  version: SimulatedBallotVersion,
): SimulatedBallotRecord => (version === 3 ? decodeBallot(bytes, 3) : decodeBallot(bytes, 2));

/**
 * One election's ballots under the version its definition pins: the
 * election crypto's admission checks run under, made from the definition and
 * the key set its ceremony check registered, never from a ballot (T-37).
 */
export interface SimulatedBallots {
  readonly version: SimulatedBallotVersion;
  readonly election: SimulatedBallotElection;
  /** The validity context of a ballot in `cell` under `nullifier`. */
  context(cell: number, nullifier: bigint): SimulatedValidityContext;
  /** A fresh sharing of `votes`, every question's options in flat order. */
  share(votes: readonly (0 | 1)[]): VoteSharing;
  /** The validity proofs over `sharing` and the core's share hashes. */
  prove(
    ctx: SimulatedValidityContext,
    sharing: VoteSharing,
    shareHashes: readonly Uint8Array[],
  ): SimulatedVote;
  encode(record: SimulatedBallotRecord): Uint8Array;
  /** Crypto's admission checks (5.1 to 5.4) of a record. */
  admit(record: SimulatedBallotRecord): BallotCheckV2;
  /** The client's check of a seat's share receipt under its registered signing key. */
  checkReceipt(
    registered: readonly ReceiptSigner[],
    name: BallotName,
    vote: SimulatedVote,
    seat: number,
    signature: Uint8Array,
  ): boolean;
}

export function simulatedBallots(
  definition: SimulatedDefinition,
  registered: readonly RegisteredKeys[],
): SimulatedBallots {
  const base = { threshold: definition.threshold, panelSize: definition.panel_size };
  if ("questions" in definition) {
    const election = questionBallotElection(definition, registered);
    const rules = { ...base, questions: election.questions };
    return {
      version: 3,
      election,
      context: (cell, nullifier) => ({
        ...rules,
        definitionHash: election.definitionHash,
        cell,
        nullifier,
      }),
      share: (votes) => shareVoteV3(rules, votes),
      prove: (ctx, sharing, shareHashes) =>
        proveValidityV3(ctx as ValidityContextV3, sharing, shareHashes),
      encode: (record) => encodeBallotV3(record as BallotRecordV3),
      admit: (record) => checkBallotV3(election, record as BallotRecordV3),
      checkReceipt: (keys, name, vote, seat, signature) =>
        checkShareReceiptV3(keys, name, vote as CommittedVoteV3, seat, signature),
    };
  }
  const election = cellBallotElection(definition, registered);
  const rules = {
    ...base,
    optionCount: definition.option_count,
    minSelections: definition.min_selections,
    maxSelections: definition.max_selections,
  };
  return {
    version: 2,
    election,
    context: (cell, nullifier) => ({
      ...rules,
      definitionHash: election.definitionHash,
      ballotVersion: 2,
      cell,
      nullifier,
    }),
    share: (votes) => shareVote(rules, votes),
    prove: (ctx, sharing, shareHashes) =>
      proveValidity(ctx as ValidityContext, sharing, shareHashes),
    encode: (record) => encodeBallotV2(record as BallotRecordV2),
    admit: (record) => checkBallotV2(election, record as BallotRecordV2),
    checkReceipt: (keys, name, vote, seat, signature) =>
      checkShareReceipt(
        keys,
        { ...name, ballotVersion: 2 },
        vote as CommittedVote,
        seat,
        signature,
      ),
  };
}
