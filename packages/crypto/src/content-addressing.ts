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

/** What `readObject` found: the object's bytes, or why it has none. */
export type ObjectRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "unavailable" | "inconsistent" };

/**
 * What a source served for block `cid`, in the order tried. `limit` is
 * `CHUNK_SIZE`, which no block of the layout exceeds, where a fetcher stops
 * reading; an answer over it is never hashed.
 */
export type BlockSource = (cid: Uint8Array, limit: number) => readonly Uint8Array[];

/** `BlockSource` for a fetcher that waits on the network. */
export type AsyncBlockSource = (cid: Uint8Array, limit: number) => Promise<readonly Uint8Array[]>;

/**
 * Reads the object of exactly `length` bytes that `cid` names, block by
 * block (docs/spec/content-addressing.md, Reading by CID). `blocks` gives
 * what each source served for each block; the first answer within the limit
 * that hashes to its CID is read, so a wrong answer is only a failed fetch
 * from its source, and sources may each serve some blocks.
 *
 * - `unavailable`: no source served some block of it. Never a verdict on the
 *   object: the sources may not hold it, or no one may.
 * - `inconsistent`: blocks that hash to their CIDs don't form `contentDag` of
 *   `length` bytes (another length, chunking or layout, a CID of another
 *   form, a node that isn't canonical). A function of `cid` and `length`
 *   alone, so every source that serves the blocks gives the same answer.
 *
 * Only the canonical DAG's shape for `length` is walked, and each node is
 * checked when it arrives, before its children are asked for, so no CID
 * makes a reader fetch more blocks, or keep more bytes, than that object has
 * (T-49, T-52, T-53, T-24).
 */
export function readObject(cid: Uint8Array, length: number, blocks: BlockSource): ObjectRead {
  return readWith(cid, length, blocks, CHUNK_SIZE, MAX_LINKS, CHUNK_SIZE);
}

/** `readObject` over a source that waits on the network. */
export async function readObjectAsync(
  cid: Uint8Array,
  length: number,
  blocks: AsyncBlockSource,
): Promise<ObjectRead> {
  checkSource(blocks);
  return driveAsync(walk(cid, exact(length), CHUNK_SIZE, MAX_LINKS, CHUNK_SIZE), blocks);
}

/**
 * Reads the object that `cid` names when its length isn't fixed by a signed
 * record but only bounded by `maxLength`, as a board segment object's is by
 * its checkpoints' sizes (docs/spec/content-addressing.md, Reading within a
 * bound). The length is the root's: a raw root's own length, at most one
 * chunk, or a dag-pb root's `filesize`, over one chunk; then the object is
 * read as `readObject` reads one of that length, the root not asked for
 * again. A length over `maxLength` is `inconsistent`, before any other block
 * is asked for, so no CID makes a reader fetch or keep more than
 * `maxLength` bytes (T-49, T-52). Both outcomes stay a function of `cid` and
 * `maxLength`: a canonical root's `filesize` is the length of its object.
 */
export function readObjectWithin(
  cid: Uint8Array,
  maxLength: number,
  blocks: BlockSource,
): ObjectRead {
  checkSource(blocks);
  return drive(walk(cid, bounded(maxLength), CHUNK_SIZE, MAX_LINKS, CHUNK_SIZE), blocks);
}

/** `readObjectWithin` over a source that waits on the network. */
export async function readObjectWithinAsync(
  cid: Uint8Array,
  maxLength: number,
  blocks: AsyncBlockSource,
): Promise<ObjectRead> {
  checkSource(blocks);
  return driveAsync(walk(cid, bounded(maxLength), CHUNK_SIZE, MAX_LINKS, CHUNK_SIZE), blocks);
}

/** Internal: `readObject` under `dagWith`'s limits, for the deeper layouts' tests. */
export function readWith(
  cid: Uint8Array,
  length: number,
  blocks: BlockSource,
  chunkSize: number,
  maxLinks: number,
  blockLimit: number,
): ObjectRead {
  checkSource(blocks);
  return drive(walk(cid, exact(length), chunkSize, maxLinks, blockLimit), blocks);
}

/** Internal: `readObjectWithin` under `dagWith`'s limits, for the deeper layouts' tests. */
export function readWithinWith(
  cid: Uint8Array,
  maxLength: number,
  blocks: BlockSource,
  chunkSize: number,
  maxLinks: number,
  blockLimit: number,
): ObjectRead {
  checkSource(blocks);
  return drive(walk(cid, bounded(maxLength), chunkSize, maxLinks, blockLimit), blocks);
}

// How long the object is: exactly `length`, or the root's own claim, refused
// over `max`.
type Length = { readonly exact: number } | { readonly max: number };

function exact(length: number): Length {
  if (!Number.isSafeInteger(length) || length < 1)
    throw new RangeError("readObject: length must be a positive integer");
  return { exact: length };
}

function bounded(maxLength: number): Length {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1)
    throw new RangeError("readObjectWithin: maxLength must be a positive integer");
  return { max: maxLength };
}

function checkSource(blocks: unknown): void {
  if (typeof blocks !== "function") throw new TypeError("readObject: blocks must be a function");
}

// One block request: the walk yields the CID and the limit, and is resumed
// with what the sources served.
interface Request {
  readonly cid: Uint8Array;
  readonly limit: number;
}

type Walk = Generator<Request, ObjectRead, readonly Uint8Array[]>;

function drive(w: Walk, blocks: BlockSource): ObjectRead {
  for (let step = w.next(); ;) {
    if (step.done === true) return step.value;
    step = w.next(blocks(step.value.cid, step.value.limit));
  }
}

async function driveAsync(w: Walk, blocks: AsyncBlockSource): Promise<ObjectRead> {
  for (let step = w.next(); ;) {
    if (step.done === true) return step.value;
    step = w.next(await blocks(step.value.cid, step.value.limit));
  }
}

// The read itself, written once for both drivers: a generator that yields
// each block it needs, in walk order, and hashes what comes back.
function* walk(
  cid: Uint8Array,
  len: Length,
  chunkSize: number,
  maxLinks: number,
  blockLimit: number,
): Walk {
  if (!(cid instanceof Uint8Array)) throw new TypeError("readObject: cid must be bytes");
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new RangeError("readObject: chunkSize must be a positive integer");
  if (!Number.isSafeInteger(maxLinks) || maxLinks < 2)
    throw new RangeError("readObject: maxLinks must be at least 2");
  if (!Number.isSafeInteger(blockLimit) || blockLimit < chunkSize)
    throw new RangeError("readObject: blockLimit must be an integer of at least chunkSize");
  let length: number;
  // The root, when the length is learnt from it, so it isn't asked for twice.
  let root: Uint8Array | undefined;
  if ("exact" in len) length = len.exact;
  else {
    const raw = hasPrefix(cid, RAW);
    if (!raw && !hasPrefix(cid, DAG_PB)) return { ok: false, reason: "inconsistent" };
    root = yield* fetchBlock(cid, blockLimit);
    if (root === undefined) return { ok: false, reason: "unavailable" };
    // An object of at most one chunk is one raw block, and only those are:
    // so a raw root's length is the object's, and a dag-pb root's `filesize`
    // must be over one chunk. Any other claim the canonical walk below
    // refuses, so no root can make the read longer than its object.
    const claimed = raw ? root.length : fileSize(root);
    if (
      claimed === undefined ||
      claimed < 1 ||
      claimed > len.max ||
      (raw ? claimed > chunkSize : claimed <= chunkSize)
    )
      return { ok: false, reason: "inconsistent" };
    length = claimed;
  }
  const chunks = Math.ceil(length / chunkSize);
  let height = 0;
  for (let span = 1; span < chunks; span *= maxLinks) height++;
  // Each node covers `maxLinks ** h` chunks from `first`, the last one
  // fewer, as the balanced layout builds them bottom up; a node above the
  // leaves is dag-pb even with one child. Its size and Tsize, and so every
  // byte of it but its links' CIDs, follow from `length` alone.
  const childCount = (h: number, first: number) => {
    const span = maxLinks ** (h - 1);
    return Math.ceil((Math.min(chunks, first + span * maxLinks) - first) / span);
  };
  const shapes = new Map<string, Node>();
  const shape = (h: number, first: number): Node => {
    const key = `${h}:${first}`;
    const known = shapes.get(key);
    if (known !== undefined) return known;
    let node: Node;
    if (h === 0) {
      const size = Math.min(chunkSize, length - first * chunkSize);
      node = walked(PLACEHOLDER, size, size);
    } else {
      const span = maxLinks ** (h - 1);
      const children = Array.from({ length: childCount(h, first) }, (_, i) =>
        shape(h - 1, first + i * span),
      );
      const built = parent(children);
      node = walked(PLACEHOLDER, built.size, built.tsize);
    }
    shapes.set(key, node);
    return node;
  };
  // Allocated at the first leaf that hashes, so a CID no source serves costs nothing.
  let object: Uint8Array | undefined;
  function* read(
    c: Uint8Array,
    h: number,
    first: number,
    held: Uint8Array | undefined,
  ): Generator<Request, Failure | undefined, readonly Uint8Array[]> {
    if (!hasPrefix(c, h === 0 ? RAW : DAG_PB)) return "inconsistent";
    // Any answer within the limit is hashed, so a CID over a block of
    // another length is the object's, never a failed fetch.
    const bytes = held ?? (yield* fetchBlock(c, blockLimit));
    if (bytes === undefined) return "unavailable";
    if (h === 0) {
      const at = first * chunkSize;
      if (bytes.length !== shape(0, first).size) return "inconsistent";
      object ??= new Uint8Array(length);
      object.set(bytes, at);
      return undefined;
    }
    const span = maxLinks ** (h - 1);
    const links = linkCids(bytes, childCount(h, first));
    if (links === undefined) return "inconsistent";
    // The canonical node for these CIDs at this place must be exactly the
    // block that hashed (no other Tsize, name, field or order), before any
    // child is asked for.
    const rebuilt = parent(
      links.map((link, i) => ({ ...shape(h - 1, first + i * span), cid: link })),
    );
    if (!equal(rebuilt.bytes, bytes)) return "inconsistent";
    for (const [i, link] of links.entries()) {
      const failed = yield* read(link, h - 1, first + i * span, undefined);
      if (failed !== undefined) return failed;
    }
    return undefined;
  }
  const failed = yield* read(cid, height, 0, root);
  if (failed !== undefined) return { ok: false, reason: failed };
  // The walk reached every leaf, so the object was allocated.
  return { ok: true, bytes: object as Uint8Array };
}

type Failure = "unavailable" | "inconsistent";

// A node's place in the canonical DAG, with what its parent's encoding reads
// of it (its size and Tsize) and no bytes kept.
const PLACEHOLDER = new Uint8Array(36);

const walked = (cid: Uint8Array, size: number, tsize: number): Node => ({
  cid,
  bytes: new Uint8Array(0),
  size,
  tsize,
  children: [],
});

function hasPrefix(c: Uint8Array, codec: number): boolean {
  return c.length === 36 && c[0] === 0x01 && c[1] === codec && c[2] === SHA2_256 && c[3] === 0x20;
}

// The first answer within `limit` that hashes to the CID; any other is its
// source's failed fetch, and one over the limit isn't hashed.
function* fetchBlock(
  c: Uint8Array,
  limit: number,
): Generator<Request, Uint8Array | undefined, readonly Uint8Array[]> {
  const digest = c.subarray(4);
  const answers: unknown = yield { cid: Uint8Array.from(c), limit };
  if (!Array.isArray(answers)) throw new TypeError("readObject: blocks must return an array");
  for (const b of answers as unknown[])
    if (b instanceof Uint8Array && b.length <= limit && equal(sha256(b), digest))
      return Uint8Array.from(b);
  return undefined;
}

// A dag-pb UnixFS root's `filesize`, where canonical form puts it: after the
// links, the Data field opens with Type (File) and then filesize. Undefined
// if it isn't there; the canonical walk then checks every byte of the node.
function fileSize(node: Uint8Array): number | undefined {
  let at = 0;
  while (node[at] === 0x12) {
    const link = readVarint(node, at + 1);
    if (link === undefined) return undefined;
    at = link.next + link.value;
  }
  if (node[at] !== 0x0a) return undefined;
  const data = readVarint(node, at + 1);
  if (data === undefined) return undefined;
  const p = data.next;
  if (node[p] !== 0x08 || node[p + 1] !== UNIXFS_FILE || node[p + 2] !== 0x18) return undefined;
  const size = readVarint(node, p + 3);
  // A varint of 8 bytes can exceed 2^53, where floating point loses digits.
  return size !== undefined && Number.isSafeInteger(size.value) ? size.value : undefined;
}

// The CIDs of a dag-pb node's first `n` links, where canonical form puts
// them (each Links field first, its Hash first), or undefined if they aren't
// there; the rebuilt node is compared with the whole block afterwards.
function linkCids(node: Uint8Array, n: number): Uint8Array[] | undefined {
  const out: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    if (node[at] !== 0x12) return undefined;
    const len = readVarint(node, at + 1);
    if (len === undefined) return undefined;
    const start = len.next;
    if (start + len.value > node.length || node[start] !== 0x0a || node[start + 1] !== 36)
      return undefined;
    out.push(node.slice(start + 2, start + 38));
    at = start + len.value;
  }
  return out;
}

function readVarint(b: Uint8Array, at: number): { value: number; next: number } | undefined {
  let value = 0;
  for (let i = 0, scale = 1; i < 8; i++, scale *= 0x80) {
    const x = b[at + i];
    if (x === undefined) return undefined;
    value += (x & 0x7f) * scale;
    if (x < 0x80) return { value, next: at + i + 1 };
  }
  return undefined;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
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
