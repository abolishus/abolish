// Trustee intake and share receipts (docs/spec/share-encryption.md, Intake
// and receipts): a trustee checks a delivered ballot record's admission, its
// membership proof included, that the ciphertext is the one the ballot names
// for its seat, and its shares, and only then signs a receipt over the ballot
// hash with its per-election signing key. A receipt counts only for the
// public part the trustee checked (ADR 0002, Delivery and Decision; T-41,
// T-29, T-30, T-52). Under ballot version 4 a seat of either panel does the
// same against its own panel's half and signs a receipt naming its panel
// (Ballot version 4; T-37).

import {
  ballotHash,
  type BallotHashContext,
  type BallotHashContextV3,
  ballotHashV3,
  ballotHashV4,
  checkValidity,
  checkValidityV3,
  type CommittedVote,
  type CommittedVoteV3,
  type CommittedVoteV4,
  type Share,
  type ValidityCode,
  type ValidityContext,
  type ValidityContextV3,
  shapeOk,
  shapeOkV3,
} from "./ballot-validity.ts";
import { bytesFixed, type CodecValue, encode, struct, u8 } from "./codec.ts";
import {
  admitForIntake,
  admitForIntakeV4,
  type BallotElection,
  type BallotV2Code,
  type CellBallotElection,
  type IntakeAdmissionCode,
  type PanelBallotElection,
  type QuestionBallotElection,
  SEAT_PANELS,
  type SeatPanel,
} from "./ballot.ts";
import {
  type KemSecretKey,
  type OpenCode,
  openShares,
  openSharesV4,
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

/**
 * `intakeShares` for ballot version 3 (docs/spec/share-encryption.md, Intake
 * and receipts): on a version-3 committed vote with its cell and nullifier
 * given apart, `validity-shape`, `share-hash`, the option proofs and each
 * question's range proof, then decryption, as `intakeBallot` runs them on a
 * version-3 record once its membership proof has passed, and the same
 * receipt over the version-3 ballot hash. It checks no membership, so a
 * trustee node never receipts with it; it is for simulations whose ballots
 * carry no membership proof. The caller has decoded the vote strictly and
 * run verifier 2.5 for the election.
 */
export function intakeSharesV3(
  ctx: ValidityContextV3,
  keys: IntakeKeys,
  vote: CommittedVoteV3,
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
      readonly code: "validity-shape" | "option-proof" | "sum-proof" | "share-hash" | OpenCode;
      readonly option?: number;
      readonly question?: number;
    } {
  const { seat } = keys;
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > ctx.panelSize)
    throw new RangeError("intake: seat must be a trustee seat from 1 to n");
  if (!shapeOkV3(ctx, vote)) return { ok: false, code: "validity-shape" };
  // As in intakeShares: the shape holds, so the ballot has exactly n share
  // hashes, and this cheap check runs before the proofs.
  const shareHash = shareCiphertextHash(ciphertext);
  if (!equalBytes(shareHash, vote.share_hashes[seat - 1] as Uint8Array))
    return { ok: false, code: "share-hash" };
  const validity = checkValidityV3(ctx, vote);
  if (!validity.ok) return validity;
  const opened = openShares(ctx, seat, keys.kemSecret, vote.vss, ciphertext);
  if (!opened.ok) return opened;
  const hash = ballotHashV3(ctx, vote);
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
 * `share-receipt` for ballot version 3 (docs/spec/share-encryption.md,
 * Intake and receipts): `checkShareReceipt`'s statement, whose layout and tag
 * version 3 keeps, over the version-3 ballot hash recomputed from the ballot.
 * The caller has strictly decoded the ballot.
 */
export function checkShareReceiptV3(
  registered: readonly ReceiptSigner[],
  ctx: BallotHashContextV3,
  vote: CommittedVoteV3,
  seat: number,
  signature: Uint8Array,
): boolean {
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > vote.share_hashes.length) return false;
  return checkReceiptStatement(
    registered,
    {
      definition_hash: ctx.definitionHash,
      ballot_hash: ballotHashV3(ctx, vote),
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

// --- Ballot version 4 (docs/spec/share-encryption.md, Ballot version 4) --------

// A new tag, since the statement's layout names no version: under one tag a
// 97-byte version-1 statement and a 98-byte version-4 one would be two
// layouts (docs/spec/domain-separation.md, Rules).
const TAG_V4 = "abolish/v1/sig/share-receipt-2";

const STATEMENT_V4 = struct([
  ["definition_hash", bytesFixed(32)],
  ["ballot_hash", bytesFixed(32)],
  ["panel", u8],
  ["seat", u8],
  ["share_hash", bytesFixed(32)],
]);

/** What a version-4 share receipt signs: `definition_hash ‖ ballot_hash ‖ u8(panel) ‖ u8(seat) ‖ H(ct_seat)`. */
export type ShareReceiptStatementV4 = CodecValue<typeof STATEMENT_V4>;

/** The 98-byte message `m` a version-4 share receipt's signature is over. */
export function shareReceiptStatementV4(statement: ShareReceiptStatementV4): Uint8Array {
  return encode(STATEMENT_V4, {
    definition_hash: statement.definition_hash,
    ballot_hash: statement.ballot_hash,
    panel: statement.panel,
    seat: statement.seat,
    share_hash: statement.share_hash,
  });
}

/** A seat's keys for one election under ballot version 4: its panel, its seat there, and that panel's KEM and signing secrets for it. */
export interface IntakeKeysV4 extends IntakeKeys {
  readonly panel: SeatPanel;
}

export type IntakeCodeV4 = "delivery-malformed" | BallotV2Code | "share-hash" | OpenCode;

export type IntakeResultV4 =
  | {
      readonly ok: true;
      readonly ballotHash: Uint8Array;
      readonly shareHash: Uint8Array;
      /** The seat's shares of its own panel's half, to store under the ballot hash and the panel until the tally. */
      readonly shares: readonly Share[];
      /** The share receipt: the signature over `shareReceiptStatementV4`. */
      readonly receipt: Uint8Array;
      /** The panel whose half `shares` are: the intake seat's own. */
      readonly panel: SeatPanel;
      readonly tier: number;
      readonly cell: number;
      readonly nullifier: bigint;
      /** `M`, recomputed from the record (T-38). */
      readonly message: Uint8Array;
      readonly l1RefNumber: bigint;
      readonly l1RefHash: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly code: IntakeCodeV4;
      readonly option?: number;
      readonly question?: number;
      /** Under `share-hash-unqualified`, the first unqualified seat's panel and index, never the intake seat's. */
      readonly panel?: SeatPanel;
      readonly seat?: number;
    };

/**
 * Trustee intake of one delivered version-4 ballot at a seat of either panel
 * (docs/spec/share-encryption.md, Decryption and intake (ballot version 4)):
 * strict decoding under version 4, version 4's admission checks in order
 * with `share-hash-unqualified` over both panels and `share-hash` against the
 * seat's own panel's list before the membership proof, then decryption with
 * the seat's panel in the associated data and the proof of knowledge, and its
 * shares checked against its own panel's commitments. Only then does it sign
 * a version-2 receipt naming its panel, so a receipt for one panel's seat `i`
 * is never one for the other's (T-30, T-37, T-41, T-52). `election` is the
 * context `panelBallotElection` made from the definition and key sets the node
 * checked, and `keys.seat` must be a seat of `keys.panel`'s registered key set
 * whose KEM key matches `keys.kemSecret`.
 */
export function intakeBallotV4(
  election: PanelBallotElection,
  keys: IntakeKeysV4,
  record: Uint8Array,
  ciphertext: Uint8Array,
): IntakeResultV4 {
  const { panel, seat } = keys;
  const shareHash = shareCiphertextHash(ciphertext);
  const admitted = admitForIntakeV4(election, record, panel, seat, shareHash);
  if (!admitted.ok) return admitted;
  const { ctx, vote } = admitted;
  const opened = openSharesV4(ctx, panel, seat, keys.kemSecret, vote, ciphertext);
  if (!opened.ok) return opened;
  return {
    ok: true,
    ballotHash: admitted.ballotHash,
    shareHash,
    shares: opened.shares,
    receipt: signStatement(
      keys.signingSecret,
      TAG_V4,
      shareReceiptStatementV4({
        definition_hash: ctx.definitionHash,
        ballot_hash: admitted.ballotHash,
        panel,
        seat,
        share_hash: shareHash,
      }),
    ),
    panel,
    tier: admitted.tier,
    cell: admitted.cell,
    nullifier: admitted.nullifier,
    message: admitted.message,
    l1RefNumber: admitted.l1RefNumber,
    l1RefHash: admitted.l1RefHash,
  };
}

/**
 * Each panel's registered per-election signing keys, from its own checked
 * ceremony transcript: a receipt is checked only against its own panel's.
 */
export interface PanelReceiptSigners {
  readonly default: readonly ReceiptSigner[];
  readonly author: readonly ReceiptSigner[];
}

/**
 * `share-receipt` under ballot version 4 (docs/spec/share-encryption.md,
 * Share receipt (ballot version 4)): true only if `seat` has registered keys
 * in `panel`'s own key set and the signature verifies under that seat's
 * signing key over the statement built from the ballot itself: its
 * recomputed ballot hash and its own panel's share hash for the seat, never
 * values that came with the receipt. The caller has strictly decoded the
 * ballot. `registered.author` must be empty: an author panel's signing keys
 * come from its own ceremony's transcript check, approved by its approvals,
 * which this check doesn't take until P2-16 part 4d-3, and until then none is
 * taken on trust, so an author seat's receipt never checks here (T-37).
 */
export function checkShareReceiptV4(
  registered: PanelReceiptSigners,
  ctx: BallotHashContextV3,
  vote: CommittedVoteV4,
  panel: SeatPanel,
  seat: number,
  signature: Uint8Array,
): boolean {
  if (registered.author.length !== 0)
    throw new RangeError(
      "checkShareReceiptV4: an author panel's signing keys come from its own ceremony (P2-16 part 4d-3)",
    );
  return checkShareReceiptV4With(registered, ctx, vote, panel, seat, signature);
}

/**
 * Internal: `checkShareReceiptV4` with the author panel's signing keys taken
 * as given, so author seats' receipts can be tested before P2-16 part 4d-3,
 * which then replaces this. The package entry point doesn't export it.
 */
export function checkShareReceiptV4With(
  registered: PanelReceiptSigners,
  ctx: BallotHashContextV3,
  vote: CommittedVoteV4,
  panel: SeatPanel,
  seat: number,
  signature: Uint8Array,
): boolean {
  if (panel !== SEAT_PANELS.default && panel !== SEAT_PANELS.author) return false;
  const hashes = panel === SEAT_PANELS.author ? vote.author_share_hashes : vote.share_hashes;
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > hashes.length) return false;
  return checkReceiptStatementV4(
    registered,
    {
      definition_hash: ctx.definitionHash,
      ballot_hash: ballotHashV4(ctx, vote),
      panel,
      seat,
      share_hash: hashes[seat - 1] as Uint8Array,
    },
    signature,
  );
}

/**
 * Internal: the same check over a statement the caller built, for the
 * vectors, which name a statement's hashes directly. The package entry point
 * doesn't export it.
 */
export function checkReceiptStatementV4(
  registered: PanelReceiptSigners,
  statement: ShareReceiptStatementV4,
  signature: Uint8Array,
): boolean {
  const { panel, seat } = statement;
  if (panel !== SEAT_PANELS.default && panel !== SEAT_PANELS.author) return false;
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > MAX_TRUSTEES) return false;
  const own = panel === SEAT_PANELS.author ? registered.author : registered.default;
  const signer = own.find((r) => r.index === seat);
  if (signer === undefined) return false;
  return verifyStatement(signer.signingKey, TAG_V4, shareReceiptStatementV4(statement), signature);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
