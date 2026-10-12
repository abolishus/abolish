// The voting identity's recovery backup (docs/spec/identity-backup.md,
// record type 0x000a): the identity secret and its encoding, the WebAuthn PRF
// salt, the keys HKDF derives from the PRF output, and the envelope that seals
// the secret (0017-identity-recovery-backup, option A). Only the ballot client
// calls this; nothing here is on the board, the chain or the archive
// (T-18, T-20, T-10).

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesFixed, type CodecValue, struct, Writer } from "./codec.ts";
import { type DsTag, ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { RECORD_TYPES, RecordSchema, recordType, UNPINNED } from "./record.ts";

/** `l`, the order of Baby Jubjub's prime subgroup (EIP-2494; docs/spec/membership.md). */
export const BABYJUBJUB_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/** Bytes in an identity secret's encoding, a PRF output, a locator and a key. */
const LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;

const envelopeV1 = struct([
  ["nonce", bytesFixed(NONCE_LEN)],
  ["sealed", bytesFixed(LEN + TAG_LEN)],
] as const);

/** An identity-backup envelope, version 1. */
export type IdentityBackup = CodecValue<typeof envelopeV1>;

/** Record type `0x000a`. Never on the board, the chain or the archive. */
export const IDENTITY_BACKUP = recordType(RECORD_TYPES.identityBackup, { 1: envelopeV1 });

const SCHEMA = new RecordSchema([IDENTITY_BACKUP]);

/** Why an envelope that decodes doesn't give an identity secret (docs/spec/identity-backup.md, Opening). */
export type IdentityBackupErrorCode = "backup-open" | "backup-secret";

export class IdentityBackupError extends Error {
  override readonly name = "IdentityBackupError";
  constructor(readonly code: IdentityBackupErrorCode) {
    super(code);
  }
}

function bytesOf(b: unknown, length: number, what: string): Uint8Array {
  // A Proxy or another typed array would hand the KDF or AEAD other bytes
  // than the ones checked; copied, so the caller can't change them midway.
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b))
    throw new TypeError(`${what} must be a Uint8Array`);
  const copy = new Uint8Array(b);
  if (copy.length !== length) throw new RangeError(`${what} must be ${length} bytes`);
  return copy;
}

// `l` as 32 bytes, big-endian, so a secret is range-checked byte by byte and
// never becomes a BigInt, which can't be wiped (T-41).
const ORDER_BYTES = Uint8Array.from(
  BABYJUBJUB_ORDER.toString(16)
    .padStart(2 * LEN, "0")
    .match(/../g) ?? [],
  (x) => Number.parseInt(x, 16),
);

/** `1 ≤ b < l` for 32 big-endian bytes, without branching on where they first differ from `l`. */
function inRange(b: Uint8Array): boolean {
  let lt = 0;
  let gt = 0;
  let nonZero = 0;
  for (let i = 0; i < LEN; i++) {
    const x = b[i] as number;
    const y = ORDER_BYTES[i] as number;
    const open = 1 ^ (lt | gt);
    lt |= open & Number(x < y);
    gt |= open & Number(x > y);
    nonZero |= x;
  }
  return lt === 1 && nonZero !== 0;
}

/** Whether `b` encodes an identity secret: 32 bytes, big-endian, `1 ≤ s < l`. */
export function isIdentitySecret(b: Uint8Array): boolean {
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b) || b.length !== LEN) return false;
  const copy = new Uint8Array(b);
  const ok = copy.length === LEN && inRange(copy);
  copy.fill(0);
  return ok;
}

/** Draws before the sampler gives up: each is kept with probability about 0.76, so 128 rejections happen with probability below 2⁻²⁶⁰. */
const MAX_DRAWS = 128;

/**
 * Draws an identity secret uniformly on 1 to `l − 1` by rejection: 251 random
 * bits, kept when in range (about 76% of draws), so no value is likelier than
 * another (T-18). `draw` is the test seam; the entry point doesn't export it.
 */
export function newIdentitySecretWith(draw: (n: number) => Uint8Array): Uint8Array {
  for (let i = 0; i < MAX_DRAWS; i++) {
    const raw = draw(LEN);
    const b = bytesOf(raw, LEN, "draw");
    // The draw is the secret but for its top bits; the copy is all we keep.
    if (raw instanceof Uint8Array) raw.fill(0);
    // 2²⁵⁰ < l < 2²⁵¹: clearing the top 5 bits leaves a value below 2²⁵¹.
    b[0] = (b[0] as number) & 0x07;
    if (isIdentitySecret(b)) return b;
    b.fill(0);
  }
  throw new Error("the random source gave no identity secret in 128 draws");
}

/** A fresh identity secret's 32-byte encoding, from the CSPRNG. */
export function newIdentitySecret(): Uint8Array {
  return newIdentitySecretWith(randomBytes);
}

/** `H(DS("abolish/v1/identity-backup/prf-salt", ""))`: the `prf.eval.first` salt of every backup ceremony. */
export function identityBackupPrfSalt(): Uint8Array {
  return H(ds("abolish/v1/identity-backup/prf-salt", new Uint8Array()));
}

// HKDF-SHA-256 with an empty salt (RFC 5869 §2.2: HashLen zeros); `P` is
// already a uniform HMAC output, and the tags in `info` make the outputs
// independent, so the locator says nothing about the sealing key (T-20).
function derive(prf: Uint8Array, tag: DsTag): Uint8Array {
  return hkdf(sha256, prf, undefined, ds(tag, new Uint8Array()), LEN);
}

function keys(prfOutput: Uint8Array): { wrapKey: Uint8Array; locator: Uint8Array } {
  const prf = bytesOf(prfOutput, LEN, "PRF output");
  const wrapKey = derive(prf, "abolish/v1/identity-backup/wrap-key");
  const locator = derive(prf, "abolish/v1/identity-backup/locator");
  prf.fill(0);
  return { wrapKey, locator };
}

/** The locator a client presents to put, get or delete its envelope. */
export function identityBackupLocator(prfOutput: Uint8Array): Uint8Array {
  const { wrapKey, locator } = keys(prfOutput);
  wrapKey.fill(0);
  return locator;
}

/** `H(DS("abolish/v1/identity-backup/id", locator))`: the server's row key, so a copy of the table addresses no row (T-66). */
export function identityBackupId(locator: Uint8Array): Uint8Array {
  return H(ds("abolish/v1/identity-backup/id", bytesOf(locator, LEN, "locator")));
}

function aad(version: number, locator: Uint8Array): Uint8Array {
  const w = new Writer();
  w.uint(2, RECORD_TYPES.identityBackup);
  w.uint(1, version);
  w.bytes(locator);
  return ds("abolish/v1/identity-backup/aad", w.finish());
}

export function encodeIdentityBackup(envelope: IdentityBackup): Uint8Array {
  return SCHEMA.encode(IDENTITY_BACKUP, 1, envelope);
}

/**
 * Strictly decodes an envelope. It belongs to no election, so no profile pins
 * its version: a version this release doesn't know is `unknown-version`.
 */
export function decodeIdentityBackup(bytes: Uint8Array): IdentityBackup {
  return SCHEMA.decode(IDENTITY_BACKUP, bytes, UNPINNED).value;
}

/**
 * Seals `secret` with an explicit nonce. Internal test seam: the entry point
 * exports only `sealIdentityBackup`, which draws the nonce, so production code
 * can't reuse one.
 */
export function sealIdentityBackupWith(
  prfOutput: Uint8Array,
  secret: Uint8Array,
  nonce: Uint8Array,
): { readonly locator: Uint8Array; readonly envelope: Uint8Array } {
  const s = bytesOf(secret, LEN, "secret");
  if (!isIdentitySecret(s)) throw new RangeError("secret is not an identity secret");
  const n = bytesOf(nonce, NONCE_LEN, "nonce");
  const { wrapKey, locator } = keys(prfOutput);
  try {
    const sealed = chacha20poly1305(wrapKey, n, aad(1, locator)).encrypt(s);
    return { locator, envelope: encodeIdentityBackup({ nonce: n, sealed }) };
  } finally {
    wrapKey.fill(0);
    s.fill(0);
  }
}

/**
 * Seals an identity secret under the key derived from the backup passkey's
 * PRF output, with a fresh nonce. Returns the envelope and the locator to
 * store it under.
 */
export function sealIdentityBackup(
  prfOutput: Uint8Array,
  secret: Uint8Array,
): { readonly locator: Uint8Array; readonly envelope: Uint8Array } {
  return sealIdentityBackupWith(prfOutput, secret, randomBytes(NONCE_LEN));
}

/**
 * Opens an envelope fetched under this PRF output's locator, giving the
 * identity secret's encoding. Throws a `DecodeError` for bytes that aren't an
 * envelope, `backup-open` when the tag doesn't verify (another passkey,
 * another locator, an altered envelope) and `backup-secret` when the
 * plaintext isn't an identity secret.
 */
export function openIdentityBackup(prfOutput: Uint8Array, envelope: Uint8Array): Uint8Array {
  const { version, value } = SCHEMA.decode(IDENTITY_BACKUP, envelope, UNPINNED);
  const { wrapKey, locator } = keys(prfOutput);
  let plain: Uint8Array;
  try {
    plain = chacha20poly1305(wrapKey, value.nonce, aad(version, locator)).decrypt(value.sealed);
  } catch {
    throw new IdentityBackupError("backup-open");
  } finally {
    wrapKey.fill(0);
    locator.fill(0);
  }
  if (!isIdentitySecret(plain)) {
    plain.fill(0);
    throw new IdentityBackupError("backup-secret");
  }
  return plain;
}
