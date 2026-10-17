// A local block store (docs/spec/verifier.md, Board by CID): the blocks of a
// CARv1 file, served by CID to `readBoardCopy`. Nothing here is trusted: the
// reader hashes every answer against the CID it asked for and the board
// checks authenticate every entry against the anchored heads and roots, so a
// store can only leave the copy short (T-49, T-53). The roots in the header
// are never read: the CIDs come from L1.

import { type AsyncBlockSource, CHUNK_SIZE } from "@abolishus/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { BundleError } from "./bundle.ts";

/** The blocks of a CAR, by CID, and how much of it couldn't be read as blocks. */
export interface BlockStore {
  readonly source: AsyncBlockSource;
  /** Sections read as blocks, repeats and blocks no read can use included. */
  readonly blocks: number;
  /** Bytes from the first section that couldn't be read, to the end of the file. */
  readonly unreadableBytes: number;
}

// A canonical unsigned LEB128 varint at `at`, below 2^53: its value and end,
// or undefined where the bytes end first or the encoding isn't minimal.
function varint(bytes: Uint8Array, at: number): readonly [number, number] | undefined {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const b = bytes[at + i];
    if (b === undefined) return undefined;
    value += (b & 0x7f) * 2 ** (7 * i);
    if ((b & 0x80) === 0) {
      // A last byte of 0 after others is a longer encoding of a smaller value.
      if (b === 0 && i > 0) return undefined;
      return value > Number.MAX_SAFE_INTEGER ? undefined : [value, at + i + 1];
    }
  }
  return undefined;
}

// The length of the CID that starts a section of `length` bytes at `at`: a
// CIDv0 (a bare sha2-256 multihash, 34 bytes) or a CIDv1 (version, codec,
// then a multihash), or undefined if no CID fits in the section.
function cidLength(bytes: Uint8Array, at: number, length: number): number | undefined {
  const end = at + length;
  if (bytes[at] === 0x12 && bytes[at + 1] === 0x20) return 34 <= length ? 34 : undefined;
  let p = at;
  for (let i = 0; i < 3; i++) {
    const v = varint(bytes, p);
    if (v === undefined || (i === 0 && v[0] !== 1)) return undefined;
    p = v[1];
  }
  const digest = varint(bytes, p);
  if (digest === undefined || digest[1] + digest[0] > end) return undefined;
  return digest[1] + digest[0] - at;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
// dag-cbor `{roots, version: 1}`: a two-member map whose keys sort "roots"
// before "version" (length first), so a CARv1 header starts and ends with
// these bytes whatever its roots. A CARv2's pragma is `{version: 2}`.
const HEADER_START = Uint8Array.from([0xa2, 0x65, ...ascii("roots")]);
const HEADER_END = Uint8Array.from([0x67, ...ascii("version"), 0x01]);

// Whether the `n` bytes at `a` in `x` and at `b` in `y` are equal, and if
// not, which sorts first.
function compare(x: Uint8Array, a: number, y: Uint8Array, b: number, n = 36): number {
  for (let i = 0; i < n; i++) {
    const d = (x[a + i] as number) - (y[b + i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Reads a CARv1 file as a block store. Throws `BundleError` if it doesn't
 * start with a CARv1 header: it is then no store at all. After the header,
 * sections are read in order until the first that isn't a whole
 * varint-length section starting with a CID, and the bytes from there on are
 * counted, never read: a store cut short still serves the blocks before the
 * cut.
 *
 * Only a block a read can use is kept: one under a CID of the layout's form
 * (`0x01 ‖ raw or dag-pb ‖ sha2-256`, 36 bytes), at most `CHUNK_SIZE`
 * bytes, whose SHA-256 is the CID's digest, and of those only the first per
 * CID, which is then its only answer. The reader takes the first answer that
 * hashes to its CID and asks for no other form, so what it reads is the
 * same as from every section, while hashing the file once and holding a few
 * numbers per block kept, never an object per section: a store of tiny or
 * repeated sections can't exhaust the reader's memory or make it hash an
 * answer again and again (T-52). `car` is held, not copied.
 */
export function readBlockStore(car: Uint8Array): BlockStore {
  if (!(car instanceof Uint8Array)) throw new TypeError("car must be a Uint8Array");
  const bytes = car;
  const header = varint(bytes, 0);
  const startsAt = (at: number, expected: Uint8Array) =>
    expected.every((x, i) => bytes[at + i] === x);
  if (
    header === undefined ||
    header[1] + header[0] > bytes.length ||
    header[0] < HEADER_START.length + HEADER_END.length ||
    !startsAt(header[1], HEADER_START) ||
    !startsAt(header[1] + header[0] - HEADER_END.length, HEADER_END)
  )
    throw new BundleError("blocks.car: not a CARv1 file");
  // Where each kept block's CID starts; its block follows it, up to `ends`.
  const starts: number[] = [];
  const ends: number[] = [];
  let at = header[1] + header[0];
  let blocks = 0;
  while (at < bytes.length) {
    const section = varint(bytes, at);
    if (section === undefined || section[1] + section[0] > bytes.length) break;
    const [length, start] = section;
    const cid = cidLength(bytes, start, length);
    if (cid === undefined) break;
    blocks++;
    at = start + length;
    if (
      cid === 36 &&
      bytes[start] === 0x01 &&
      (bytes[start + 1] === 0x55 || bytes[start + 1] === 0x70) &&
      bytes[start + 2] === 0x12 &&
      bytes[start + 3] === 0x20 &&
      length - cid <= CHUNK_SIZE &&
      compare(sha256(bytes.subarray(start + cid, at)), 0, bytes, start + 4, 32) === 0
    ) {
      starts.push(start);
      ends.push(at);
    }
  }
  // Sorted by CID, then file order, so the first of a CID is its first in the file.
  const order = Uint32Array.from(starts.keys()).sort(
    (i, j) => compare(bytes, starts[i] as number, bytes, starts[j] as number) || i - j,
  );
  const find = (cid: Uint8Array): Uint8Array | undefined => {
    if (cid.length !== 36) return undefined;
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(bytes, starts[order[mid] as number] as number, cid, 0) < 0) lo = mid + 1;
      else hi = mid;
    }
    const k = order[lo];
    if (k === undefined || compare(bytes, starts[k] as number, cid, 0) !== 0) return undefined;
    return bytes.subarray((starts[k] as number) + 36, ends[k]);
  };
  return {
    source: (cid, limit) => {
      const b = find(cid);
      return Promise.resolve(b === undefined || b.length > limit ? [] : [b]);
    },
    blocks,
    unreadableBytes: bytes.length - at,
  };
}
