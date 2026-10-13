// A strict decoder for Ethereum's RLP (yellow paper, Appendix B), for the
// L1 data a receipt commitment's opening carries (docs/spec/receipts.md,
// Opening): the execution header, the transaction trie's nodes and the
// transactions. Only canonical encodings are accepted, so each decoded item
// has one encoding (T-31); a malformed input is refused, never repaired
// (T-36), and every length is checked against the input before it is used
// (T-52).

/** A decoded item, with the exact bytes it was decoded from. */
export type RlpItem =
  | { readonly list: false; readonly bytes: Uint8Array; readonly raw: Uint8Array }
  | { readonly list: true; readonly items: readonly RlpItem[]; readonly raw: Uint8Array };

/**
 * No transaction, header or trie node nests lists more than a few deep (an
 * access list's storage keys are at depth 3), so deeper input is refused
 * before it can exhaust the stack (T-52).
 */
const MAX_DEPTH = 16;

class RlpError extends Error {}

function lengthAt(b: Uint8Array, at: number, n: number): number {
  if (at + n > b.length) throw new RlpError();
  // A long form's length has no leading zero byte.
  if (b[at] === 0) throw new RlpError();
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + (b[at + i] as number);
  // A long form is only for 56 bytes or more.
  if (len < 56) throw new RlpError();
  return len;
}

function item(b: Uint8Array, at: number, depth: number): [RlpItem, number] {
  if (at >= b.length) throw new RlpError();
  const p = b[at] as number;
  if (p < 0x80)
    return [{ list: false, bytes: b.subarray(at, at + 1), raw: b.subarray(at, at + 1) }, at + 1];
  let start: number;
  let len: number;
  if (p <= 0xb7) {
    start = at + 1;
    len = p - 0x80;
    // One byte below 0x80 is its own encoding.
    if (len === 1 && start < b.length && (b[start] as number) < 0x80) throw new RlpError();
  } else if (p <= 0xbf) {
    start = at + 1 + (p - 0xb7);
    len = lengthAt(b, at + 1, p - 0xb7);
  } else if (p <= 0xf7) {
    start = at + 1;
    len = p - 0xc0;
  } else {
    start = at + 1 + (p - 0xf7);
    len = lengthAt(b, at + 1, p - 0xf7);
  }
  const end = start + len;
  if (end > b.length) throw new RlpError();
  const raw = b.subarray(at, end);
  if (p <= 0xbf) return [{ list: false, bytes: b.subarray(start, end), raw }, end];
  if (depth >= MAX_DEPTH) throw new RlpError();
  const items: RlpItem[] = [];
  for (let i = start; i < end;) {
    const [x, next] = item(b, i, depth + 1);
    // An item can't run past its list's payload.
    if (next > end) throw new RlpError();
    items.push(x);
    i = next;
  }
  return [{ list: true, items, raw }, end];
}

/**
 * Decodes `bytes` as exactly one canonical RLP item, or returns undefined.
 * The result's byte arrays are views of one private copy of the input.
 */
export function decodeRlp(bytes: Uint8Array): RlpItem | undefined {
  if (!(bytes instanceof Uint8Array) || !ArrayBuffer.isView(bytes))
    throw new TypeError("decodeRlp: input must be a Uint8Array");
  const b = new Uint8Array(bytes);
  try {
    const [x, end] = item(b, 0, 0);
    return end === b.length ? x : undefined;
  } catch (e) {
    if (e instanceof RlpError) return undefined;
    throw e;
  }
}

/**
 * An RLP string as an unsigned integer of at most `maxBytes` bytes: big-endian
 * with no leading zero byte, and empty for 0. Undefined for a list or any
 * other string.
 */
export function rlpUint(x: RlpItem, maxBytes: number): bigint | undefined {
  if (x.list || x.bytes.length > maxBytes || x.bytes[0] === 0) return undefined;
  let v = 0n;
  for (const byte of x.bytes) v = (v << 8n) | BigInt(byte);
  return v;
}

/** The RLP encoding of `n`, a transaction's key in its block's transaction trie. */
export function rlpEncodeUint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError("rlpEncodeUint: expected a natural number");
  if (n === 0) return Uint8Array.of(0x80);
  if (n < 0x80) return Uint8Array.of(n);
  const be: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) be.unshift(v % 256);
  return Uint8Array.of(0x80 + be.length, ...be);
}
