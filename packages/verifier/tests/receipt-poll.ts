// Test only: a version-5 election whose key ceremony this file runs, so its
// seats' signing keys are known and share receipts can be signed for its
// ballots (docs/spec/delivery.md, Boarding). The definition is
// verifier-ballots-v3.json's `admitted` one (from an independent
// implementation) under this file's panel and transcript, and its ballots
// are that case's admitted ballots with the definition hash replaced: they
// decode as version-3 ballots of this election, but their membership proofs
// were made for the vector's, so they are boarded here without admission.
// Each receipt is signed by the seat's own key over the statement the spec
// gives, with @abolishus/crypto's signing, never with the check under test.
// Postings (`postedBallot`) need each seat's ML-KEM message, which the
// vector's ballots don't come with: such a ballot is a vector ballot with its
// VSS commitments and share hashes replaced by a fresh sharing's, encrypted
// here to the seats' registered keys with @abolishus/crypto's encryption.
// Its proofs are the vector's, so it decodes but isn't admitted, which the
// posting judge doesn't check (the board's simulation does).
// For tests/receipt-admission.test.ts, tests/posting-admission.test.ts and
// packages/core's receipt and posting tests.

import { readFileSync } from "node:fs";
import {
  answersMessage,
  ballotHashV3,
  ceremonyKeygen,
  ceremonyTranscriptHash,
  challengesMessage,
  checkCeremonyTranscript,
  decodeBallot,
  decodeBoardEntry,
  decode,
  decodeElectionDefinitionV5,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionStubV5Hash,
  encodeBallotV3,
  encodeBoardEntry,
  encodeCeremonyTranscript,
  encodeElectionDefinitionV5,
  encodeSharePosting,
  encodeShareReceipt,
  encryptShares,
  identityKey,
  keysMessage,
  type Panel,
  panelId,
  RECORD_TYPES,
  revealsMessage,
  SHARE_CIPHERTEXT,
  shareReceiptStatement,
  shareVote,
  signStatement,
} from "@abolishus/crypto";
import { splitEntries } from "../src/index.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/verifier-ballots-v3.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: readonly { id: string; definition: string; board: string }[] };
const admitted = vectors.cases.find((c) => c.id === "admitted");
if (admitted === undefined) throw new Error("no admitted case");
const base = decodeElectionDefinitionV5(hex(admitted.definition));

// Every seat of the panel runs the ceremony, so every seat is registered.
const identities = Array.from({ length: base.panel_size }, () =>
  crypto.getRandomValues(new Uint8Array(32)),
);
export const panel: Panel = {
  threshold: base.threshold,
  keys: identities.map((s) => identityKey(s)),
};
const stub: ElectionDefinitionV5 = { ...base, panel_id: panelId(panel) };
const run = {
  l2ChainId: stub.l2_chain_id,
  trusteeRegistry: stub.trustee_registry,
  electionId: stub.election_id,
  stubHash: electionStubV5Hash(stub),
  panel,
  runId: crypto.getRandomValues(new Uint8Array(32)),
};
const seats = identities.map((s, i) => ceremonyKeygen(i + 1, s));
const keys = seats.map((s) => keysMessage(run, s));
const challenges = seats.map((s) => challengesMessage(run, s, keys));
const round2 = challenges.map((c) => c.message);
const answers = seats.map((s) => answersMessage(run, s, keys, round2));
const reveals = seats.map((s, i) =>
  revealsMessage(run, s, { keys, challenges: round2, answers }, challenges[i]?.secrets ?? []),
);
/** The ceremony's transcript, as the board's first entry carries it. */
export const transcript = encodeCeremonyTranscript({
  run_id: run.runId,
  keys,
  challenges: round2,
  answers,
  reveals,
});
{
  const { runId: _, ...params } = run;
  const checked = checkCeremonyTranscript(params, transcript, 1);
  if (!checked.ok) throw new Error(`ceremony: ${checked.code}`);
}

export const definition: ElectionDefinitionV5 = {
  ...stub,
  ceremony_transcript_hash: ceremonyTranscriptHash(transcript),
};
export const definitionBytes = encodeElectionDefinitionV5(definition);
export const definitionHash = electionDefinitionV5Hash(definition);
export const electionId = definition.election_id;

/** The board's first entry: the transcript, under board-entry version 5, which the definition pins. */
export const transcriptEntry = encodeBoardEntry(
  { election_id: electionId, index: 0n, segment: 0, payload: transcript },
  5,
);

export interface Ballot {
  /** The record's bytes, as a ballot entry carries them. */
  readonly payload: Uint8Array;
  /** Its ballot hash, as the spec computes it from the record. */
  readonly hash: Uint8Array;
  readonly cell: number;
  readonly nullifier: bigint;
  readonly shareHashes: readonly Uint8Array[];
}

/** The vector's admitted ballots, as ballots of this election, in board order. */
export const ballots: readonly Ballot[] = splitEntries(hex(admitted.board)).entries.flatMap(
  (encoded) => {
    const { payload } = decodeBoardEntry(encoded, 5);
    if (((payload[0] as number) << 8) + (payload[1] as number) !== RECORD_TYPES.ballot) return [];
    // The case holds only admitted ballots after the transcript, so every one decodes.
    const record = decodeBallot(payload, 3);
    const own = { ...record, definition_hash: definitionHash };
    const ctx = { definitionHash, cell: own.cell, nullifier: own.nullifier };
    return [
      {
        payload: encodeBallotV3(own),
        hash: ballotHashV3(ctx, own.committed_vote),
        cell: own.cell,
        nullifier: own.nullifier,
        shareHashes: own.committed_vote.share_hashes,
      },
    ];
  },
);

/** A share receipt's fields, each defaulting to what `seat`'s honest receipt of `ballot` names. */
export interface ReceiptFields {
  readonly definitionHash?: Uint8Array;
  readonly ballotHash?: Uint8Array;
  readonly seat?: number;
  readonly shareHash?: Uint8Array;
  /** The seat whose signing key signs; by default the seat the record names. */
  readonly signer?: number;
}

/** The share receipt record (`0x000c` version 1) a seat's intake gives for `ballot`. */
export function receiptFor(ballot: Ballot, seat: number, fields: ReceiptFields = {}): Uint8Array {
  const statement = {
    definition_hash: fields.definitionHash ?? definitionHash,
    ballot_hash: fields.ballotHash ?? ballot.hash,
    seat: fields.seat ?? seat,
    share_hash: fields.shareHash ?? (ballot.shareHashes[seat - 1] as Uint8Array),
  };
  const signer = seats[(fields.signer ?? seat) - 1];
  if (signer === undefined) throw new Error(`no seat ${fields.signer ?? seat}`);
  return encodeShareReceipt({
    ...statement,
    signature: signStatement(
      signer.signingSecret,
      "abolish/v1/sig/share-receipt",
      shareReceiptStatement(statement),
    ),
  });
}

/** A ballot of this election with every seat's ciphertext and ML-KEM message, as the client keeps them. */
export interface PostedBallot extends Ballot {
  readonly ciphertexts: readonly Uint8Array[];
  readonly messages: readonly Uint8Array[];
}

/** `ballot` re-encrypted to this election's seats: a ballot whose postings can pass the public check. */
export function postedBallot(ballot: Ballot): PostedBallot {
  const record = decodeBallot(ballot.payload, 3);
  const optionCount = record.committed_vote.vss.length;
  const sharing = shareVote(
    {
      optionCount,
      minSelections: 0,
      maxSelections: optionCount,
      threshold: definition.threshold,
      panelSize: definition.panel_size,
    },
    Array.from({ length: optionCount }, () => 0),
  );
  const encrypted = encryptShares(
    { definitionHash },
    sharing,
    seats.map((s) => s.kem.publicKey),
  );
  const vote = { ...record.committed_vote, vss: sharing.vss, share_hashes: encrypted.hashes };
  const own = { ...record, committed_vote: vote };
  return {
    payload: encodeBallotV3(own),
    hash: ballotHashV3({ definitionHash, cell: own.cell, nullifier: own.nullifier }, vote),
    cell: own.cell,
    nullifier: own.nullifier,
    shareHashes: encrypted.hashes,
    ciphertexts: encrypted.ciphertexts,
    messages: encrypted.randomness.map((r) => r.m),
  };
}

/** A share posting's fields, each defaulting to what `seat`'s honest posting of `ballot` names. */
export interface PostingFields {
  readonly definitionHash?: Uint8Array;
  readonly ballotHash?: Uint8Array;
  readonly seat?: number;
  readonly m?: Uint8Array;
  /** The seat whose ciphertext is posted; by default the seat the record names. */
  readonly ciphertextOf?: number;
}

/** The share posting record (`0x000d` version 1) a client makes for `seat` of `ballot`. */
export function postingFor(
  ballot: PostedBallot,
  seat: number,
  fields: PostingFields = {},
): Uint8Array {
  const ciphertext = ballot.ciphertexts[(fields.ciphertextOf ?? seat) - 1];
  const m = fields.m ?? ballot.messages[seat - 1];
  if (ciphertext === undefined || m === undefined) throw new Error(`no seat ${seat}`);
  return encodeSharePosting({
    definition_hash: fields.definitionHash ?? definitionHash,
    ballot_hash: fields.ballotHash ?? ballot.hash,
    seat: fields.seat ?? seat,
    m,
    ciphertext: decode(SHARE_CIPHERTEXT, ciphertext),
  });
}
