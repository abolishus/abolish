// Stage 8, the board's half (P4-3 part 2b-2c): the board as a block mirror
// holds it, its segment objects as content-addressed blocks in a CARv1 file
// (docs/spec/board.md, Segment objects; docs/spec/content-addressing.md), the
// form `apps/node serve --blocks` reads and an IPFS node exports. The rebuild
// then reads it back by the CIDs the anchored checkpoints name on L1, never
// from the fixture's memory (T-24, T-49, T-51).

import { contentDag } from "@abolishus/crypto";
import { concatBytes } from "@noble/hashes/utils.js";

// Every board-entry version's layout: the segment is the u32 after the record
// header (3), election_id (32) and index (8).
const SEGMENT_AT = 3 + 32 + 8;

/**
 * Each segment's object: the concatenation of its entries' encodings, in
 * board order. An empty segment has no object.
 */
export function segmentObjects(entries: readonly Uint8Array[]): Uint8Array[] {
  const bySegment = new Map<number, Uint8Array[]>();
  for (const e of entries) {
    if (e.length < SEGMENT_AT + 4) throw new RangeError("an entry too short for its segment");
    const s = new DataView(e.buffer, e.byteOffset + SEGMENT_AT, 4).getUint32(0);
    bySegment.set(s, [...(bySegment.get(s) ?? []), e]);
  }
  return [...bySegment.values()].map((run) => concatBytes(...run));
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

/**
 * A CARv1 (the IPLD CAR specification, version 1) of every block of every
 * object: the dag-cbor header `{roots, version: 1}` naming each object's root,
 * then each object's blocks in `contentDag`'s order. The verifier and the node
 * never read the roots (the CIDs come from L1), but an IPFS node importing the
 * file pins them.
 */
export function blocksCar(objects: readonly Uint8Array[]): Uint8Array {
  const dags = objects.map(contentDag);
  // dag-cbor: an array of fewer than 24 items has its length in the head byte.
  if (dags.length >= 24) throw new RangeError("blocksCar: at most 23 objects");
  const roots = dags.flatMap((d) => {
    // Tag 42 over a byte string of 0x00 then the 36-byte CIDv1.
    if (d.root.length !== 36) throw new RangeError("blocksCar: a root that isn't a 36-byte CIDv1");
    return [Uint8Array.of(0xd8, 0x2a, 0x58, 37, 0x00), d.root];
  });
  const header = concatBytes(
    Uint8Array.of(0xa2, 0x65),
    ascii("roots"),
    Uint8Array.of(0x80 + dags.length),
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
