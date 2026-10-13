// Trustee identity keys, signatures and the panel identifier
// (docs/spec/trustee-identity.md, ADR 0012): ECDSA over P-256 with SHA-256 on
// `DS(tag, m)`, SEC 1 compressed keys, `r ‖ s` signatures with the low-s rule.
// The curve arithmetic, ECDSA and RFC 6979 are @noble/curves'; this module
// only fixes the encodings and the checks around them.

import { p256 } from "@noble/curves/nist.js";
import {
  bytesFixed,
  type Codec,
  DecodeError,
  encode,
  EncodeError,
  struct,
  u64,
  u8,
} from "./codec.ts";
import { ds, dsSignature, type SpecifiedTagOf } from "./domain-separation.ts";
import { H } from "./group.ts";

const Point = p256.Point;
const P = Point.Fp.ORDER;
const N = Point.Fn.ORDER;
const HALF_N = (N - 1n) / 2n;

/** `MAX_TRUSTEES` of docs/spec/parameters.md: the largest panel. */
export const MAX_TRUSTEES = 16;

/** A tag registered with the primitive Signature. */
export type SignatureTag = SpecifiedTagOf<"signature">;

function bigEndian(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

// Copies before checking the length: a Uint8Array subclass could report a
// false `length` while holding another number of bytes (codec.ts, copyBytes).
function bytesOf(x: unknown, length: number, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected ${length} bytes`);
  const copy = new Uint8Array(x);
  if (copy.length !== length) throw new TypeError(`${what}: expected ${length} bytes`);
  return copy;
}

/** Whether `b` (33 bytes) is a canonical compressed P-256 point. */
function isCanonicalKey(b: Uint8Array): boolean {
  // Only the compressed forms: the identity (0x00), uncompressed (0x04) and
  // hybrid (0x06, 0x07) encodings would give a key a second spelling (T-31).
  if (b[0] !== 0x02 && b[0] !== 0x03) return false;
  // x ≥ p would alias x − p; checked here rather than trusting the library's
  // decoder to reject it.
  if (bigEndian(b.subarray(1)) >= P) return false;
  try {
    // Rejects an x with no point on the curve. The cofactor is 1, so every
    // point but the identity has prime order: no subgroup check exists.
    Point.fromBytes(b);
  } catch {
    return false;
  }
  return true;
}

/**
 * `p256-key`: an identity key as its 33-byte SEC 1 compressed encoding. The
 * value is the encoding itself, so keys compare, hash and deduplicate as
 * bytes; every point but the identity has exactly one.
 */
export const p256Key: Codec<Uint8Array> = {
  minLength: 33,
  write(w, value) {
    const b =
      value instanceof Uint8Array && ArrayBuffer.isView(value) ? new Uint8Array(value) : null;
    if (b?.length !== 33 || !isCanonicalKey(b))
      throw new EncodeError("p256-key: expected a canonical compressed P-256 point");
    w.bytes(b);
  },
  read(r) {
    const at = r.offset;
    const b = new Uint8Array(r.take(33));
    if (!isCanonicalKey(b)) throw new DecodeError("non-canonical", at);
    return b;
  },
};

function isCanonicalSignature(b: Uint8Array): boolean {
  const r = bigEndian(b.subarray(0, 32));
  const s = bigEndian(b.subarray(32));
  // The low-s rule: (r, n − s) verifies whenever (r, s) does, so without it
  // anyone could re-encode a signature and the record that carries it (T-31).
  return r >= 1n && r < N && s >= 1n && s <= HALF_N;
}

/** `p256-sig`: `r ‖ s`, 32 bytes each big-endian, `1 ≤ r < n`, `1 ≤ s ≤ (n − 1) / 2`. */
export const p256Sig: Codec<Uint8Array> = {
  minLength: 64,
  write(w, value) {
    const b =
      value instanceof Uint8Array && ArrayBuffer.isView(value) ? new Uint8Array(value) : null;
    if (b?.length !== 64 || !isCanonicalSignature(b))
      throw new EncodeError("p256-sig: expected r ‖ s with 1 ≤ r < n and 1 ≤ s ≤ (n − 1) / 2");
    w.bytes(b);
  },
  read(r) {
    const at = r.offset;
    const b = new Uint8Array(r.take(64));
    if (!isCanonicalSignature(b)) throw new DecodeError("non-canonical", at);
    return b;
  },
};

function secretScalar(secretKey: unknown): Uint8Array {
  const d = bytesOf(secretKey, 32, "secretKey");
  const v = bigEndian(d);
  if (v < 1n || v >= N) throw new RangeError("secretKey: must be from 1 to n − 1");
  return d;
}

/** The identity key of a 32-byte big-endian secret scalar, for nodes and test ceremonies. */
export function identityKey(secretKey: Uint8Array): Uint8Array {
  return p256.getPublicKey(secretScalar(secretKey), true);
}

/**
 * Signs `m` under `tag`: ECDSA P-256 over `DS(tag, m)` with SHA-256, an RFC
 * 6979 deterministic nonce (no RNG at signing time, so no nonce reuse from a
 * broken one) and `s` normalised to the low half.
 */
export function signStatement(secretKey: Uint8Array, tag: SignatureTag, m: Uint8Array): Uint8Array {
  return signMessage(secretKey, dsSignature(tag, m));
}

/**
 * `Verify(Q, tag, m, sig)` of docs/spec/trustee-identity.md. False for any
 * key or signature that doesn't decode strictly (wrong length and high-s
 * included); a conforming verifier accepts exactly what this accepts.
 */
export function verifyStatement(
  key: Uint8Array,
  tag: SignatureTag,
  m: Uint8Array,
  sig: Uint8Array,
): boolean {
  return verifyMessage(key, dsSignature(tag, m), sig);
}

/**
 * ECDSA P-256/SHA-256 over the complete message `M`, low-s. Exported for the
 * published-vector tests (RFC 6979, NIST CAVP SigVer), which use raw messages;
 * the protocol signs only through `signStatement`, which frames `M` as
 * `DS(tag, m)`.
 */
export function signMessage(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  const sig = p256.sign(copyOf(message, "message"), secretScalar(secretKey), {
    prehash: true,
    lowS: true,
    format: "compact",
  });
  // The library's own guarantee, checked rather than assumed: only an
  // encoding the verifier accepts ever leaves this function.
  return encode(p256Sig, sig);
}

/** The verification rule over the complete message `M`; see `signMessage`. */
export function verifyMessage(key: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  const q = copyOf(key, "key");
  const s = copyOf(sig, "sig");
  const m = copyOf(message, "message");
  // Decoded by our own rules first: the library accepts uncompressed keys and
  // high s, which would give a key or signature a second encoding (T-31).
  if (q.length !== 33 || s.length !== 64 || !isCanonicalKey(q) || !isCanonicalSignature(s))
    return false;
  return p256.verify(s, m, q, { prehash: true, lowS: true, format: "compact" });
}

function copyOf(x: unknown, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected a Uint8Array`);
  return new Uint8Array(x);
}

/** A trustee panel: `k` and the seats' identity keys, seat 1 first. */
export interface Panel {
  readonly threshold: number;
  readonly keys: readonly Uint8Array[];
}

/** Why a panel is invalid, with the codes of docs/spec/vectors/trustee.json. */
export type PanelErrorCode = "threshold" | "size" | "duplicate-key" | "key";

/** A panel that docs/spec/trustee-identity.md, Panel identifier, rejects. */
export class PanelError extends RangeError {
  override readonly name = "PanelError";
  constructor(
    readonly code: PanelErrorCode,
    message: string,
  ) {
    super(`panel: ${message}`);
  }
}

function checkedPanel(panel: Panel, minThreshold = 2): { threshold: number; keys: Uint8Array[] } {
  if (panel === null || typeof panel !== "object") throw new TypeError("panel: expected an object");
  const { threshold } = panel;
  // Copied once, so the keys checked are the keys hashed.
  const keys = Array.isArray(panel.keys)
    ? panel.keys.map((k: unknown, i) => copyOf(k, `panel key ${i + 1}`))
    : null;
  if (keys === null) throw new TypeError("panel: keys must be an array");
  const n = keys.length;
  if (n > MAX_TRUSTEES) throw new PanelError("size", `n must be at most ${MAX_TRUSTEES}`);
  // T-14: k = 1 would let one trustee open every sharing alone. An author
  // panel passes 1: its half of an opening is worthless without the default
  // half, so one author trustee holding it lowers nothing.
  if (!Number.isSafeInteger(threshold) || threshold < minThreshold || threshold > n)
    throw new PanelError("threshold", `need ${minThreshold} ≤ k ≤ n`);
  const seen = new Set<string>();
  for (const [i, key] of keys.entries()) {
    if (key.length !== 33 || !isCanonicalKey(key))
      throw new PanelError("key", `key ${i + 1} is not a p256-key`);
    // Encodings are canonical, so equal points have equal bytes. T-14: one
    // key in two seats gives its holder two shares of every ballot.
    const hex = Array.from(key, (x) => x.toString(16).padStart(2, "0")).join("");
    if (seen.has(hex)) throw new PanelError("duplicate-key", `key ${i + 1} sits in two seats`);
    seen.add(hex);
  }
  return { threshold, keys };
}

/**
 * `panel_id = H(DS("abolish/v1/panel", u8(k) ‖ u8(n) ‖ Q_1 ‖ … ‖ Q_n))`.
 * Binds k, n, every key and its seat, so no definition can name a known
 * panel with a lower threshold, another order or a substituted key (T-37).
 */
export function panelId(panel: Panel): Uint8Array {
  return panelIdOf(checkedPanel(panel));
}

function panelIdOf({ threshold, keys }: { threshold: number; keys: Uint8Array[] }): Uint8Array {
  return H(ds("abolish/v1/panel", panelIdInput(threshold, keys)));
}

// `u8(k) ‖ u8(n) ‖ Q_1 ‖ … ‖ Q_n`, the same for both panel identifiers.
function panelIdInput(threshold: number, keys: readonly Uint8Array[]): Uint8Array {
  const input = new Uint8Array(2 + 33 * keys.length);
  input[0] = threshold;
  input[1] = keys.length;
  for (const [i, key] of keys.entries()) input.set(key, 2 + 33 * i);
  return input;
}

/** Why an author panel is invalid: a panel's codes, and `default-seat` against the default panel. */
export type AuthorPanelRule = PanelErrorCode | "default-seat";

/**
 * The first rule of docs/spec/trustee-identity.md (Author panel identifier)
 * an author panel breaks, in the spec's order: `size`, `threshold`
 * (`1 ≤ k_A ≤ n_A`), then per seat `key` and `duplicate-key`; with
 * `defaultKeys`, then `default-seat`. Rules 1 to 3 are the definition's
 * `author-panel` well-formedness rule; rule 4 needs the pinned default panel
 * and is [[verifier]] 2.5's. A key in both panels would let the default
 * trustees holding it stand in for author trustees, so the author panel would
 * add nothing against them (T-14, T-37).
 */
export function authorPanelRule(
  panel: Panel,
  defaultKeys?: readonly Uint8Array[],
): AuthorPanelRule | undefined {
  let keys: Uint8Array[];
  try {
    ({ keys } = checkedPanel(panel, 1));
  } catch (e) {
    if (e instanceof PanelError) return e.code;
    throw e;
  }
  if (defaultKeys === undefined) return undefined;
  const defaults = defaultKeys.map((k, i) => copyOf(k, `default key ${i + 1}`));
  if (keys.some((k) => defaults.some((d) => equalBytes(k, d)))) return "default-seat";
  return undefined;
}

/**
 * `author_panel_id = H(DS("abolish/v1/author-panel", u8(k_A) ‖ u8(n_A) ‖ Q_1 ‖ … ‖ Q_{n_A}))`,
 * for an author panel valid under rules 1 to 3 (`PanelError` otherwise).
 * Its own tag keeps it from ever equalling a default panel's identifier over
 * the same keys, so a statement bound to one can't stand for the other
 * (T-37). Never stored: every reader recomputes it from the definition.
 */
export function authorPanelId(panel: Panel): Uint8Array {
  const { threshold, keys } = checkedPanel(panel, 1);
  return H(ds("abolish/v1/author-panel", panelIdInput(threshold, keys)));
}

/** The fields of a ceremony registration a signer supplies; the panel fixes the rest. */
export interface CeremonyRegistration {
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  readonly index: number;
  readonly stubHash: Uint8Array;
  readonly ceremonyTranscriptHash: Uint8Array;
  /** `key_set_hash` of the key set the signer's own transcript check returned. */
  readonly keySetHash: Uint8Array;
}

const CEREMONY_REGISTRATION = struct([
  ["l2_chain_id", u64],
  ["trustee_registry", bytesFixed(20)],
  ["panel_id", bytesFixed(32)],
  ["index", u8],
  ["stub_hash", bytesFixed(32)],
  ["ceremony_transcript_hash", bytesFixed(32)],
  ["key_set_hash", bytesFixed(32)],
] as const);

/**
 * The 157-byte statement `abolish/v1/sig/ceremony-registration-2` signs. The
 * panel identifier is computed from `panel`, never taken from the caller, and
 * the seat must be one of its seats.
 */
export function ceremonyRegistrationMessage(panel: Panel, reg: CeremonyRegistration): Uint8Array {
  return registration(checkedPanel(panel), reg).message;
}

// The statement and the key of its seat, both from one checked copy of the
// panel, so the key verified against is the key the identifier hashed.
// Each field read once, so a getter can't show the checks one value and the
// encoder another.
function snapshot(reg: CeremonyRegistration): CeremonyRegistration {
  if (reg === null || typeof reg !== "object")
    throw new TypeError("ceremony registration: expected an object");
  const { l2ChainId, trusteeRegistry, index, stubHash, ceremonyTranscriptHash, keySetHash } = reg;
  return { l2ChainId, trusteeRegistry, index, stubHash, ceremonyTranscriptHash, keySetHash };
}

function registration(
  checked: { threshold: number; keys: Uint8Array[] },
  input: CeremonyRegistration,
): { message: Uint8Array; key: Uint8Array } {
  const reg = snapshot(input);
  const key = Number.isSafeInteger(reg.index) ? checked.keys[reg.index - 1] : undefined;
  if (key === undefined || reg.index < 1)
    throw new RangeError("ceremony registration: index must be a seat of the panel");
  const message = encode(CEREMONY_REGISTRATION, {
    l2_chain_id: reg.l2ChainId,
    trustee_registry: reg.trusteeRegistry,
    panel_id: panelIdOf(checked),
    index: reg.index,
    stub_hash: reg.stubHash,
    ceremony_transcript_hash: reg.ceremonyTranscriptHash,
    key_set_hash: reg.keySetHash,
  });
  return { message, key };
}

/** Seat `reg.index`'s signature on a ceremony registration. */
export function signCeremonyRegistration(
  secretKey: Uint8Array,
  panel: Panel,
  reg: CeremonyRegistration,
): Uint8Array {
  const { message, key } = registration(checkedPanel(panel), reg);
  // A key outside its seat would sign a statement no verifier attributes to it.
  if (!equalBytes(identityKey(secretKey), key))
    throw new RangeError("ceremony registration: secretKey is not the key of seat index");
  return signStatement(secretKey, "abolish/v1/sig/ceremony-registration-2", message);
}

/**
 * Whether `sig` is seat `reg.index`'s signature on the registration, checked
 * against the key the pinned `panel` puts in that seat (T-37, T-71).
 */
export function verifyCeremonyRegistration(
  panel: Panel,
  reg: CeremonyRegistration,
  sig: Uint8Array,
): boolean {
  // The panel is pinned, so a bad one throws; the registration comes from
  // untrusted data, so a seat outside the panel or a field with no encoding
  // is a statement no seat signed, and fails like a bad signature.
  const checked = checkedPanel(panel);
  reg = snapshot(reg);
  if (!Number.isSafeInteger(reg.index) || reg.index < 1 || reg.index > checked.keys.length)
    return false;
  let statement: { message: Uint8Array; key: Uint8Array };
  try {
    statement = registration(checked, reg);
  } catch (e) {
    if (e instanceof EncodeError) return false;
    throw e;
  }
  return verifyStatement(
    statement.key,
    "abolish/v1/sig/ceremony-registration-2",
    statement.message,
    sig,
  );
}

// Public keys, so timing doesn't matter; written without early exit anyway.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}
