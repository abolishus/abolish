// Content addressing (docs/spec/content-addressing.md): how one object the
// protocol stores (a board segment, a display-text record, an archive
// manifest) becomes IPFS blocks, a CIDv1 and a CARv1, with every parameter
// fixed so that anyone holding the same bytes derives the same CID and CAR,
// and an independent pinner's copy matches what was published (T-51, T-49,
// T-24). Integrity never rests on a CID: every byte is checked against the
// L1-anchored roots. dag-pb, UnixFS and the CAR header are written by hand,
// as the few fixed shapes the spec allows, so this package keeps to @noble.

import { sha256 } from "@noble/hashes/sha2.js";

/** The fixed chunk size: 1 MiB. */
export const CHUNK_SIZE = 1_048_576;

/** At most this many links per interior node. */
export const MAX_LINKS = 1_024;

const RAW = 0x55;
const DAG_PB = 0x70;
const SHA2_256 = 0x12;
const UNIXFS_FILE = 2;

/** One block: its binary CID and its bytes. */
export interface Block {
  readonly cid: Uint8Array;
  readonly bytes: Uint8Array;
}

/** An object's DAG: its root CID and every block once, in depth-first pre-order. */
export interface ContentDag {
  readonly root: Uint8Array;
  readonly blocks: readonly Block[];
}

interface Node {
  readonly cid: Uint8Array;
  readonly bytes: Uint8Array;
  /** The bytes of the object it covers. */
  readonly size: number;
  /** Tsize: its own encoding plus every descendant's. */
  readonly tsize: number;
  readonly children: readonly Node[];
}

/**
 * The object's DAG under the spec's parameters: fixed 1 MiB chunks as raw
 * leaves, and a balanced tree of dag-pb UnixFS `File` nodes of at most 1,024
 * links. An object of at most one chunk is a single raw block.
 */
export function contentDag(object: Uint8Array): ContentDag {
  return dagWith(object, CHUNK_SIZE, MAX_LINKS);
}

/** The object's binary CIDv1 (the root of `contentDag`). */
export function objectCid(object: Uint8Array): Uint8Array {
  return contentDag(object).root;
}

/** The object's CARv1: the header naming its root, then every block once, in depth-first pre-order. */
export function objectCar(object: Uint8Array): Uint8Array {
  return encodeCar(contentDag(object));
}

/** A binary CID in the spec's text form: multibase base32, lowercase, `b` prefix. */
export function cidText(cid: Uint8Array): string {
  return `b${base32(cid)}`;
}

/**
 * Internal: `contentDag` with other chunk and fan-out limits, so the balanced
 * layout's deeper trees can be checked against other implementations with
 * small objects. The protocol uses only `contentDag`'s.
 */
export function dagWith(object: Uint8Array, chunkSize: number, maxLinks: number): ContentDag {
  if (!(object instanceof Uint8Array)) throw new TypeError("contentDag: object must be bytes");
  if (object.length === 0) throw new RangeError("contentDag: the protocol stores no empty object");
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new RangeError("contentDag: chunkSize must be a positive integer");
  if (!Number.isSafeInteger(maxLinks) || maxLinks < 2)
    throw new RangeError("contentDag: maxLinks must be at least 2");
  let level: Node[] = [];
  for (let at = 0; at < object.length; at += chunkSize) {
    const bytes = object.slice(at, at + chunkSize);
    level.push({
      cid: cid(RAW, bytes),
      bytes,
      size: bytes.length,
      tsize: bytes.length,
      children: [],
    });
  }
  // Balanced: each level groups the one below, left to right, into parents of
  // at most maxLinks, until one node is left. A lone chunk is its own root.
  while (level.length > 1) {
    const parents: Node[] = [];
    for (let i = 0; i < level.length; i += maxLinks)
      parents.push(parent(level.slice(i, i + maxLinks)));
    level = parents;
  }
  const root = level[0] as Node;
  const blocks: Block[] = [];
  const seen = new Set<string>();
  const visit = (n: Node) => {
    const key = hex(n.cid);
    if (seen.has(key)) return;
    seen.add(key);
    blocks.push({ cid: n.cid, bytes: n.bytes });
    for (const c of n.children) visit(c);
  };
  visit(root);
  return { root: root.cid, blocks };
}

function parent(children: readonly Node[]): Node {
  // UnixFS Data: Type (1) = File, filesize (3), one blocksizes (4) per child.
  const data = new Writer();
  data.tag(1, 0).varint(UNIXFS_FILE);
  const size = children.reduce((s, c) => s + c.size, 0);
  data.tag(3, 0).varint(size);
  for (const c of children) data.tag(4, 0).varint(c.size);
  // PBNode: Links (2) first, then Data (1), as dag-pb's canonical form orders them.
  const node = new Writer();
  for (const c of children) {
    const link = new Writer();
    link.tag(1, 2).bytes(c.cid);
    link.tag(2, 2).bytes(new Uint8Array(0));
    link.tag(3, 0).varint(c.tsize);
    node.tag(2, 2).bytes(link.done());
  }
  node.tag(1, 2).bytes(data.done());
  const bytes = node.done();
  return {
    cid: cid(DAG_PB, bytes),
    bytes,
    size,
    tsize: bytes.length + children.reduce((s, c) => s + c.tsize, 0),
    children,
  };
}

/** Internal: a CARv1 of a DAG (`{roots: [root], version: 1}` in dag-cbor, then each block). */
export function encodeCar(dag: ContentDag): Uint8Array {
  const root = dag.root;
  // The header's byte-string length byte is canonical only for this length.
  if (root.length !== 36) throw new RangeError("encodeCar: the root must be a 36-byte CIDv1");
  // dag-cbor orders map keys by length, then bytewise: "roots" before "version".
  const header = concat([
    Uint8Array.of(0xa2, 0x65),
    ascii("roots"),
    // A one-element array of tag 42 over a byte string: 0x00 then the CID.
    Uint8Array.of(0x81, 0xd8, 0x2a, 0x58, root.length + 1, 0x00),
    root,
    Uint8Array.of(0x67),
    ascii("version"),
    Uint8Array.of(0x01),
  ]);
  const parts: Uint8Array[] = [varint(header.length), header];
  for (const b of dag.blocks) parts.push(varint(b.cid.length + b.bytes.length), b.cid, b.bytes);
  return concat(parts);
}

function cid(codec: number, bytes: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(0x01, codec, SHA2_256, 0x20), sha256(bytes)]);
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }
  varint(n: number): this {
    this.parts.push(varint(n));
    return this;
  }
  bytes(b: Uint8Array): this {
    this.parts.push(varint(b.length), b);
    return this;
  }
  done(): Uint8Array {
    return concat(this.parts);
  }
}

// Unsigned LEB128, as protobuf, multiformats and CAR use; every value here is
// a safe integer.
function varint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError("varint: not a safe unsigned integer");
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// RFC 4648 base32, lowercase, no padding (multibase `b`).
function base32(b: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const x of b) {
    value = ((value << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
