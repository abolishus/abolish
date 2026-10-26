// Ballot record version 5 (docs/spec/ballot-validity.md, Ballot record
// (version 5)), read from the spec for the vector tests: the record is framed
// here over version 4's committed vote and its hashes recomputed from their
// formulas, independently of packages/crypto's own codec (src/ballot.ts).

import {
  bytesFixed,
  COMMITTED_VOTE_V4,
  type CommittedVoteV4,
  ds,
  encode,
  fieldBn254,
  H,
  membershipProof,
  RECORD_TYPES,
  RecordSchema,
  recordType,
  semaphoreField,
  struct,
  u32,
  u64,
  u8,
} from "../src/index.ts";

// Version 4's fields, then `step` after the membership proof, then version
// 4's committed vote.
export const BALLOT_V5 = recordType(RECORD_TYPES.ballot, {
  5: struct([
    ["definition_hash", bytesFixed(32)],
    ["cell", u8],
    ["nullifier", fieldBn254],
    ["l1_ref_number", u64],
    ["l1_ref_hash", bytesFixed(32)],
    ["membership_proof", membershipProof],
    ["step", u32],
    ["committed_vote", COMMITTED_VOTE_V4],
  ] as const),
});
export const SCHEMA = new RecordSchema([BALLOT_V5]);
export const decodeV5 = (bytes: Uint8Array) => SCHEMA.decode(BALLOT_V5, bytes, 5).value;
export type BallotV5 = ReturnType<typeof decodeV5>;

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const head = (b: BallotV5) =>
  concat(b.definition_hash, Uint8Array.of(0x00, 0x02, 5, b.cell), encode(fieldBn254, b.nullifier));

/** Both halves and both share-hash lists: the committed vote's encoding up to its proofs. */
export function halves(vote: CommittedVoteV4): Uint8Array {
  const bytes = encode(COMMITTED_VOTE_V4, { ...vote, option_proofs: [], sum_proofs: [] });
  return bytes.subarray(0, bytes.length - 8); // the two empty lists' counts
}

/** Hashes (version 5): the ballot hash binds the step after the nullifier. */
export const ballotHash = (b: BallotV5) =>
  H(
    ds(
      "abolish/v1/ballot",
      concat(head(b), encode(u32, b.step), encode(COMMITTED_VOTE_V4, b.committed_vote)),
    ),
  );

/** `ŝ_t`, the rolling scope of tier `t` (docs/spec/membership.md, Rolling scope). */
export const rollingScope = (definitionHash: Uint8Array, tier: number) =>
  semaphoreField(
    H(ds("abolish/v1/rolling-nullifier-scope", concat(definitionHash, Uint8Array.of(tier)))),
  );
