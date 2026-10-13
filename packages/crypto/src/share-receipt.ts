// Trustee intake and share receipts (docs/spec/share-encryption.md, Intake
// and receipts): a trustee checks a delivered ballot record's admission, its
// membership proof included, that the ciphertext is the one the ballot names
// for its seat, and its shares, and only then signs a receipt over the ballot
// hash with its per-election signing key. A receipt counts only for the
// public part the trustee checked (ADR 0002, Delivery and Decision; T-41,
// T-29, T-30, T-52).

import {
  ballotHash,
  type BallotHashContext,
  checkValidity,
  type CommittedVote,
  type Share,
  type ValidityCode,
  type ValidityContext,
  shapeOk,
} from "./ballot-validity.ts";
import { bytesFixed, type CodecValue, encode, struct, u8 } from "./codec.ts";
import {
  admitForIntake,
  type BallotElection,
  type CellBallotElection,
  type IntakeAdmissionCode,
  type QuestionBallotElection,
} from "./ballot.ts";
import {
  type KemSecretKey,
  type OpenCode,
  openShares,
  shareCiphertextHash,
} from "./share-encryption.ts";
import { MAX_TRUSTEES, signStatement, verifyStatement } from "./trustee.ts";

const TAG = "abolish/v1/sig/share-receipt";

const STATEMENT = struct([
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["seat", u8],
  ["share_hash", bytesFixed(32)],
]);

/** What a share receipt signs: `definition_hash ‖ ballot_hash ‖ u8(seat) ‖ H(ct_seat)`. */
export type ShareReceiptStatement = CodecValue<typeof STATEMENT>;

/** The 97-byte message `m` a share receipt's signature is over. */
export function shareReceiptStatement(statement: ShareReceiptStatement): Uint8Array {
  // Through the struct, so only these fields are read, each at its exact width.
  return encode(STATEMENT, {
    definition_hash: statement.definition_hash,
    ballot_hash: statement.ballot_hash,
    seat: statement.seat,
    share_hash: statement.share_hash,
  });
}

/** A trustee node's keys for one election: its seat, KEM secret and per-election signing secret. */
export interface IntakeKeys {
  readonly seat: number;
  readonly kemSecret: KemSecretKey;
  readonly signingSecret: Uint8Array;
}

export type IntakeCode = IntakeAdmissionCode | OpenCode;

export type IntakeResult =
  | {
      readonly ok: true;
      readonly ballotHash: Uint8Array;
      readonly shareHash: Uint8Array;
      /** The trustee's shares, to store under the ballot hash until the tally. */
      readonly shares: readonly Share[];
      /** The share receipt: the signature over `shareReceiptStatement`. */
      readonly receipt: Uint8Array;
      /** What the re-vote rule ranks the ballot by, for the node's receipt obligation (`owedReceipts`). */
      readonly tier: number;
      readonly nullifier: bigint;
      /** `M`, recomputed from the record (T-38). */
      readonly message: Uint8Array;
      readonly l1RefNumber: bigint;
      readonly l1RefHash: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly code: IntakeCode;
      readonly option?: number;
      /** Under ballot version 3's `sum-proof`, the first failing question. */
      readonly question?: number;
    };

/**
 * Trustee intake of one delivered ballot (docs/spec/share-encryption.md,
 * Intake and receipts): the whole ballot record, decoded strictly under the
 * version the election pins, then the admission checks of verifier 5.1 to
 * 5.4 with `share-hash` before the membership proof, then decryption. The
 * first failure is the result, and nothing is signed. So a trustee receipts
 * only a registered member's ballot, and its contract-path obligation is
 * bounded by the electorate (docs/spec/delivery.md, What a node owes; ADR
 * 0002, Decision, 2026-10-12; T-52, T-25, T-54). The L1 reference isn't
 * checked here: the node reads it from finalized L1 when it decides what it
 * owes. `election` is the context `ballotElection`, `cellBallotElection` or
 * `questionBallotElection` made from the definition and key set the node checked (verifier 1.3, 2.4,
 * 2.5, 2.8, 3.2), and `keys.seat` must be a seat of that key set, whose KEM
 * key matches `keys.kemSecret`.
 */
export function intakeBallot(
  election: BallotElection | CellBallotElection | QuestionBallotElection,
  keys: IntakeKeys,
  record: Uint8Array,
  ciphertext: Uint8Array,
): IntakeResult {
  const { seat } = keys;
  const shareHash = shareCiphertextHash(ciphertext);
  const admitted = admitForIntake(election, record, seat, shareHash);
  if (!admitted.ok) return admitted;
  const { ctx } = admitted;
  const opened = openShares(ctx, seat, keys.kemSecret, admitted.vote.vss, ciphertext);
  if (!opened.ok) return opened;
  return {
    ok: true,
    ballotHash: admitted.ballotHash,
    shareHash,
    shares: opened.shares,
    receipt: sign(keys.signingSecret, ctx.definitionHash, admitted.ballotHash, seat, shareHash),
    tier: admitted.tier,
    nullifier: admitted.nullifier,
    message: admitted.message,
    l1RefNumber: admitted.l1RefNumber,
    l1RefHash: admitted.l1RefHash,
  };
}

/**
 * The share half of intake on a committed vote with its tier (ballot version
 * 2: cell) and nullifier given apart: `validity-shape`, `share-hash`, the
 * option and sum proofs, then decryption, as `intakeBallot` runs them once a
 * record's membership proof has passed. It checks no membership, so a
 * trustee node never receipts with it (docs/spec/share-encryption.md, Intake
 * and receipts); it is for simulations whose ballots carry no membership
 * proof, and for the share-level vectors. The caller has decoded the vote
 * strictly and run verifier 2.5 for the election.
 */
export function intakeShares(
  ctx: ValidityContext,
  keys: IntakeKeys,
  vote: CommittedVote,
  ciphertext: Uint8Array,
):
  | {
      readonly ok: true;
      readonly ballotHash: Uint8Array;
      readonly shareHash: Uint8Array;
      readonly shares: readonly Share[];
      readonly receipt: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly code: ValidityCode | "share-hash" | OpenCode;
      readonly option?: number;
    } {
  const { seat } = keys;
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > ctx.panelSize)
    throw new RangeError("intake: seat must be a trustee seat from 1 to n");
  if (!shapeOk(ctx, vote)) return { ok: false, code: "validity-shape" };
  // The shape holds, so the ballot has exactly n share hashes. This cheap
  // check runs before the proofs, the costly part of intake.
  const shareHash = shareCiphertextHash(ciphertext);
  if (!equalBytes(shareHash, vote.share_hashes[seat - 1] as Uint8Array))
    return { ok: false, code: "share-hash" };
  const validity = checkValidity(ctx, vote);
  if (!validity.ok) return validity;
  const opened = openShares(ctx, seat, keys.kemSecret, vote.vss, ciphertext);
  if (!opened.ok) return opened;
  const hash = ballotHash(ctx, vote);
  const receipt = sign(keys.signingSecret, ctx.definitionHash, hash, seat, shareHash);
  return { ok: true, ballotHash: hash, shareHash, shares: opened.shares, receipt };
}

function sign(
  signingSecret: Uint8Array,
  definitionHash: Uint8Array,
  hash: Uint8Array,
  seat: number,
  shareHash: Uint8Array,
): Uint8Array {
  return signStatement(
    signingSecret,
    TAG,
    shareReceiptStatement({
      definition_hash: definitionHash,
      ballot_hash: hash,
      seat,
      share_hash: shareHash,
    }),
  );
}

/** A seat's registered per-election signing key, from the checked ceremony transcript. */
export interface ReceiptSigner {
  readonly index: number;
  readonly signingKey: Uint8Array;
}

/**
 * `share-receipt` (docs/spec/share-encryption.md, Intake and receipts): true
 * only if `seat` has registered keys and the signature verifies under that
 * seat's signing key over the statement built from the ballot itself: its
 * recomputed ballot hash and its share hash for the seat, never values that
 * came with the receipt. The caller has strictly decoded the ballot.
 */
export function checkShareReceipt(
  registered: readonly ReceiptSigner[],
  ctx: BallotHashContext,
  vote: CommittedVote,
  seat: number,
  signature: Uint8Array,
): boolean {
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > vote.share_hashes.length) return false;
  return checkReceiptStatement(
    registered,
    {
      definition_hash: ctx.definitionHash,
      ballot_hash: ballotHash(ctx, vote),
      seat,
      share_hash: vote.share_hashes[seat - 1] as Uint8Array,
    },
    signature,
  );
}

/**
 * The same check over a statement the caller built. Exported internally for
 * the vectors, which name a statement's hashes directly.
 */
export function checkReceiptStatement(
  registered: readonly ReceiptSigner[],
  statement: ShareReceiptStatement,
  signature: Uint8Array,
): boolean {
  if (!Number.isSafeInteger(statement.seat) || statement.seat < 1 || statement.seat > MAX_TRUSTEES)
    return false;
  const signer = registered.find((r) => r.index === statement.seat);
  if (signer === undefined) return false;
  return verifyStatement(signer.signingKey, TAG, shareReceiptStatement(statement), signature);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
