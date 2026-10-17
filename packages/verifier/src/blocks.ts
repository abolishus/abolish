// A local block store (docs/spec/verifier.md, Board by CID): the blocks of a
// CARv1 file, served by CID to `readBoardCopy`. Nothing here is trusted: the
// reader hashes every answer against the CID it asked for and the board
// checks authenticate every entry against the anchored heads and roots, so a
// store can only leave the copy short (T-49, T-53). The roots in the header
// are never read: the CIDs come from L1.

import type { AsyncBlockSource } from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BundleError } from "./bundle.ts";

/** The blocks of a CAR, by CID, and how much of it couldn't be read as blocks. */
export interface BlockStore {
  readonly source: AsyncBlockSource;
  /** Sections read as blocks, repeats included. */
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

/**
 * Reads a CARv1 file as a block store. Throws `BundleError` if it doesn't
 * start with a CARv1 header: it is then no store at all. After the header,
 * sections are read in order until the first that isn't a whole
 * varint-length section starting with a CID, and the bytes from there on are
 * counted, never read: a store cut short still serves the blocks before the
 * cut. A block is served whatever it holds, and repeats are all served, in
 * file order: the reader takes the first answer that hashes to its CID.
 */
export function readBlockStore(car: Uint8Array): BlockStore {
  if (!(car instanceof Uint8Array)) throw new TypeError("car must be a Uint8Array");
  const bytes = new Uint8Array(car);
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
  const index = new Map<string, Uint8Array[]>();
  let at = header[1] + header[0];
  let blocks = 0;
  while (at < bytes.length) {
    const section = varint(bytes, at);
    if (section === undefined || section[1] + section[0] > bytes.length) break;
    const [length, start] = section;
    const cid = cidLength(bytes, start, length);
    if (cid === undefined) break;
    const key = bytesToHex(bytes.subarray(start, start + cid));
    const block = bytes.subarray(start + cid, start + length);
    const served = index.get(key);
    if (served === undefined) index.set(key, [block]);
    else served.push(block);
    blocks++;
    at = start + length;
  }
  return {
    // Answers over `limit` are left out: the reader would never hash them.
    source: (cid, limit) =>
      Promise.resolve((index.get(bytesToHex(cid)) ?? []).filter((b) => b.length <= limit)),
    blocks,
    unreadableBytes: bytes.length - at,
  };
}
