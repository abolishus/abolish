// Trustee intake and share receipts (docs/spec/share-encryption.md, Intake
// and receipts): a trustee checks a delivered ballot's validity, that the
// ciphertext is the one the ballot names for its seat, and its shares, and
// only then signs a receipt over the ballot hash with its per-election signing
// key. A receipt counts only for the public part the trustee checked (ADR
// 0002, Delivery; T-41, T-29, T-30).

import {
  ballotHash,
  checkValidity,
  type CommittedVote,
  type Share,
  type ValidityCode,
  type ValidityContext,
} from "./ballot-validity.ts";
import { bytesFixed, type CodecValue, encode, struct, u8 } from "./codec.ts";
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

export type IntakeCode = ValidityCode | "share-hash" | OpenCode;

export type IntakeResult =
  | {
      readonly ok: true;
      readonly ballotHash: Uint8Array;
      readonly shareHash: Uint8Array;
      /** The trustee's shares, to store under the ballot hash until the tally. */
      readonly shares: readonly Share[];
      /** The share receipt: the signature over `shareReceiptStatement`. */
      readonly receipt: Uint8Array;
    }
  | { readonly ok: false; readonly code: IntakeCode; readonly option?: number };

/**
 * Trustee intake of one ballot's ciphertext: the validity checks under the
 * delivered tier and nullifier, then `share-hash`, then decryption. The first
 * failure is the result, and nothing is signed. The caller has run verifier
 * 2.5 for the election (the rules, the panel and its own registered keys).
 */
export function intake(
  ctx: ValidityContext,
  keys: IntakeKeys,
  vote: CommittedVote,
  ciphertext: Uint8Array,
): IntakeResult {
  const { seat } = keys;
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > ctx.panelSize)
    throw new RangeError("intake: seat must be a trustee seat from 1 to n");
  const validity = checkValidity(ctx, vote);
  if (!validity.ok) return validity;
  // validity-shape passed, so the ballot has exactly n share hashes.
  const shareHash = shareCiphertextHash(ciphertext);
  if (!equalBytes(shareHash, vote.share_hashes[seat - 1] as Uint8Array))
    return { ok: false, code: "share-hash" };
  const opened = openShares(ctx, seat, keys.kemSecret, vote.vss, ciphertext);
  if (!opened.ok) return opened;
  const hash = ballotHash(ctx, vote);
  const receipt = signStatement(
    keys.signingSecret,
    TAG,
    shareReceiptStatement({
      definition_hash: ctx.definitionHash,
      ballot_hash: hash,
      seat,
      share_hash: shareHash,
    }),
  );
  return { ok: true, ballotHash: hash, shareHash, shares: opened.shares, receipt };
}

/** A seat's registered per-election signing key, from the checked ceremony transcript. */
export interface ReceiptSigner {
  readonly index: number;
  readonly signingKey: Uint8Array;
}

/**
 * `share-receipt` (docs/spec/share-encryption.md, Intake and receipts): true
 * only if `statement.seat` has registered keys and the signature verifies
 * under that seat's signing key. The caller builds the statement from the
 * election and the ballot (its recomputed ballot hash and its share hash for
 * the seat), never from anything the receipt's carrier supplies.
 */
export function checkShareReceipt(
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
