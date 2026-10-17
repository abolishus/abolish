// Stage 8, the board's half (P4-3 part 2b-2c): the board as a block mirror
// holds it, each segment's object and entry-hash list as content-addressed
// blocks in a CARv1 file (docs/spec/board.md, Segment objects;
// docs/spec/content-addressing.md), the form `apps/node serve --blocks` reads
// and an IPFS node exports. The rebuild then reads it back by the CIDs the
// anchored checkpoints name on L1, never from the fixture's memory (T-24,
// T-49, T-51).

import { boardEntryHash, contentDag } from "@abolishus/crypto";
import { concatBytes } from "@noble/hashes/utils.js";

// Every board-entry version's layout: the segment is the u32 after the record
// header (3), election_id (32) and index (8).
const SEGMENT_AT = 3 + 32 + 8;

/** What a mirror publishes for one segment: its object and its entry-hash list. */
export interface SegmentObjects {
  readonly segment: number;
  /** Its entries' encodings, concatenated in board order. */
  readonly object: Uint8Array;
  /** Their entry hashes, concatenated in the same order. */
  readonly hashes: Uint8Array;
}

/**
 * Each segment's objects, in board order. An empty segment has none. Throws
 * on an entry too short for its segment field or a segment that decreases,
 * which no board the fixture appends can hold: objects cut from such a copy
 * would name no anchored CID, and the run would report the copy withheld
 * rather than the fixture's mistake.
 */
export function segmentObjects(entries: readonly Uint8Array[]): SegmentObjects[] {
  const runs: { segment: number; entries: Uint8Array[] }[] = [];
  for (const e of entries) {
    if (e.length < SEGMENT_AT + 4) throw new RangeError("an entry too short for its segment");
    const segment = new DataView(e.buffer, e.byteOffset + SEGMENT_AT, 4).getUint32(0);
    const last = runs.at(-1);
    if (last !== undefined && segment < last.segment) throw new RangeError("a segment decreased");
    if (last?.segment === segment) last.entries.push(e);
    else runs.push({ segment, entries: [e] });
  }
  return runs.map((r) => ({
    segment: r.segment,
    object: concatBytes(...r.entries),
    hashes: concatBytes(...r.entries.map(boardEntryHash)),
  }));
}

function varint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError("varint: not a safe unsigned integer");
  const out: number[] = [];
  do {
    out.push((n % 0x80) | (n >= 0x80 ? 0x80 : 0));
    n = Math.floor(n / 0x80);
  } while (n > 0);
  return Uint8Array.from(out);
}

const ascii = (s: string) => new TextEncoder().encode(s);

// A CBOR array's head in its shortest form, as dag-cbor requires (RFC 8949,
// 3.1 and 4.2.1): the length in the initial byte below 24, else in the 1, 2
// or 4 bytes after it.
function arrayHead(n: number): Uint8Array {
  if (n < 24) return Uint8Array.of(0x80 + n);
  if (n < 0x100) return Uint8Array.of(0x98, n);
  if (n < 0x10000) return Uint8Array.of(0x99, n >> 8, n & 0xff);
  if (n < 2 ** 32)
    return Uint8Array.of(0x9a, n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  throw new RangeError("blocksCar: too many objects");
}

/**
 * A CARv1 (the IPLD CAR specification, version 1) of every block of every
 * object: the dag-cbor header `{roots, version: 1}` naming each object's root,
 * then each object's blocks in `contentDag`'s order. The verifier and the node
 * never read the roots (the CIDs come from L1), but an IPFS node importing the
 * file pins them.
 */
export function blocksCar(objects: readonly Uint8Array[]): Uint8Array {
  const dags = objects.map(contentDag);
  const roots = dags.flatMap((d) => {
    // Tag 42 over a byte string of 0x00 then the 36-byte CIDv1.
    if (d.root.length !== 36) throw new RangeError("blocksCar: a root that isn't a 36-byte CIDv1");
    return [Uint8Array.of(0xd8, 0x2a, 0x58, 37, 0x00), d.root];
  });
  const header = concatBytes(
    Uint8Array.of(0xa2, 0x65),
    ascii("roots"),
    arrayHead(dags.length),
    ...roots,
    Uint8Array.of(0x67),
    ascii("version"),
    Uint8Array.of(0x01),
  );
  const parts = [varint(header.length), header];
  for (const d of dags)
    for (const b of d.blocks) parts.push(varint(b.cid.length + b.bytes.length), b.cid, b.bytes);
  return concatBytes(...parts);
}
