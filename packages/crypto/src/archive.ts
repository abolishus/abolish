// The permanent archive (docs/spec/archive.md; ADR 0005, option A): the
// archive manifest (record type 0x0021) that lists archived objects with the
// Arweave transactions holding their CARs and links the manifests before it,
// the board anchor's version-1 locator naming the latest confirmed manifest,
// and the reader of an object from a transaction's data. Nothing found
// through the archive is trusted beyond being the bytes its CID names: the
// board checks judge it against L1's checkpoints (T-49, T-51, T-24).

import { bytesFixed, type Codec, DecodeError, EncodeError, Reader, u64, Writer } from "./codec.ts";
import { type BlockSource, CHUNK_SIZE, objectCar, readObjectWithin } from "./content-addressing.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";

/** `MAX_MANIFEST_OBJECTS`: the most objects one version-1 manifest lists. */
export const MAX_MANIFEST_OBJECTS = 8192;

/** `MAX_MANIFEST_LINKS`: the most earlier manifests one version-1 manifest links. */
export const MAX_MANIFEST_LINKS = 1024;

/** A version-1 locator's length: `u16(1)`, the manifest's CID and the transaction ID. */
export const LOCATOR_V1_LENGTH = 70;

const RAW = 0x55;
const DAG_PB = 0x70;

const cid36 = bytesFixed(36);
const id32 = bytesFixed(32);
const address = bytesFixed(20);

/** One archived object: its CID and the transaction whose data is its CAR. */
export interface ArchivedObject {
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
}

/** One earlier manifest: its sequence, its CID and the transaction holding it. */
export interface ManifestLink {
  readonly sequence: bigint;
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
}

/** Archive manifest, version 1 (docs/spec/archive.md, Layout (version 1)). */
export interface ArchiveManifest {
  readonly l1_chain_id: bigint;
  readonly anchor: Uint8Array;
  readonly sequence: bigint;
  readonly objects: readonly ArchivedObject[];
  readonly links: readonly ManifestLink[];
}

function framedCid(c: Uint8Array, rawOnly: boolean): boolean {
  return (
    c.length === 36 &&
    c[0] === 0x01 &&
    (c[1] === RAW || (!rawOnly && c[1] === DAG_PB)) &&
    c[2] === 0x12 &&
    c[3] === 0x20
  );
}

// Bytewise order of two 36-byte CIDs: negative, zero or positive.
function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

function count(r: Reader, max: number): number {
  const at = r.offset;
  const n = r.uint(4);
  // T-52: the count is checked against its maximum before any element is read.
  if (n > max) throw new DecodeError("length-over-max", at);
  return n;
}

function list<T>(value: unknown, max: number, what: string): readonly T[] {
  if (!Array.isArray(value)) throw new EncodeError(`${what}: expected an array`);
  if (value.length > max) throw new EncodeError(`${what}: ${value.length} is over ${max}`);
  return value as readonly T[];
}

// Read in field order, each rule judged as soon as the fields it reads are
// read, so every rejection has one code at one offset (archive.json, decode).
const manifestV1: Codec<ArchiveManifest> = {
  minLength: 8 + 20 + 8 + 4 + 4,
  write(w, value) {
    u64.write(w, value.l1_chain_id);
    address.write(w, value.anchor);
    u64.write(w, value.sequence);
    const objects = list<ArchivedObject>(value.objects, MAX_MANIFEST_OBJECTS, "objects");
    const links = list<ManifestLink>(value.links, MAX_MANIFEST_LINKS, "links");
    if (objects.length === 0 && links.length === 0)
      throw new EncodeError("archive manifest: names nothing");
    w.uint(4, objects.length);
    let previous: Uint8Array | undefined;
    for (const o of objects) {
      const cid = Uint8Array.from(o.cid);
      if (!framedCid(cid, false)) throw new EncodeError("archive manifest: an object's CID");
      if (previous !== undefined && compare(previous, cid) >= 0)
        throw new EncodeError("archive manifest: objects not in ascending CID order");
      cid36.write(w, cid);
      id32.write(w, o.transaction);
      previous = cid;
    }
    w.uint(4, links.length);
    let last = -1n;
    for (const l of links) {
      u64.write(w, l.sequence);
      if (l.sequence <= last || l.sequence >= value.sequence)
        throw new EncodeError("archive manifest: links not ascending below its sequence");
      const cid = Uint8Array.from(l.cid);
      if (!framedCid(cid, true)) throw new EncodeError("archive manifest: a link's CID isn't raw");
      cid36.write(w, cid);
      id32.write(w, l.transaction);
      last = l.sequence;
    }
  },
  read(r) {
    const l1_chain_id = u64.read(r);
    const anchor = address.read(r);
    const sequence = u64.read(r);
    const objectsAt = r.offset;
    const objects: ArchivedObject[] = [];
    for (let i = 0, n = count(r, MAX_MANIFEST_OBJECTS); i < n; i++) {
      const at = r.offset;
      const cid = cid36.read(r);
      if (!framedCid(cid, false)) throw new DecodeError("non-canonical", at);
      const before = objects[i - 1];
      if (before !== undefined && compare(before.cid, cid) >= 0)
        throw new DecodeError("non-canonical", at);
      objects.push({ cid, transaction: id32.read(r) });
    }
    const links: ManifestLink[] = [];
    for (let i = 0, n = count(r, MAX_MANIFEST_LINKS); i < n; i++) {
      const at = r.offset;
      const linked = u64.read(r);
      const before = links[i - 1];
      if (linked >= sequence || (before !== undefined && linked <= before.sequence))
        throw new DecodeError("non-canonical", at);
      const cidAt = r.offset;
      const cid = cid36.read(r);
      if (!framedCid(cid, true)) throw new DecodeError("non-canonical", cidAt);
      links.push({ sequence: linked, cid, transaction: id32.read(r) });
    }
    if (objects.length === 0 && links.length === 0)
      throw new DecodeError("non-canonical", objectsAt);
    return { l1_chain_id, anchor, sequence, objects, links };
  },
};

/** Record type `0x0021`. No profile pins it: each locator version fixes the manifest version it names. */
export const ARCHIVE_MANIFEST = recordType(RECORD_TYPES.archiveManifest, { 1: manifestV1 });

const SCHEMA = new RecordSchema([ARCHIVE_MANIFEST]);

export function encodeArchiveManifest(manifest: ArchiveManifest): Uint8Array {
  return SCHEMA.encode(ARCHIVE_MANIFEST, 1, manifest);
}

/** Strictly decodes a manifest under the version its locator fixes. */
export function decodeArchiveManifest(bytes: Uint8Array, pinned: 1): ArchiveManifest {
  return SCHEMA.decode(ARCHIVE_MANIFEST, bytes, pinned).value;
}

/** What a locator names (docs/spec/archive.md, Locator). */
export type LocatorRead =
  | {
      readonly kind: "manifest";
      readonly version: 1;
      readonly manifest: Uint8Array;
      readonly transaction: Uint8Array;
    }
  | { readonly kind: "locator-version"; readonly version: number }
  | { readonly kind: "locator-length" | "locator-cid" | "locator-framing" };

/** `u16(1) ‖ manifest ‖ transaction`: the locator naming a version-1 manifest. */
export function encodeArchiveLocator(manifest: Uint8Array, transaction: Uint8Array): Uint8Array {
  const cid = Uint8Array.from(manifest);
  if (!framedCid(cid, true)) throw new EncodeError("locator: the manifest's CID isn't raw");
  const w = new Writer();
  w.uint(2, 1);
  cid36.write(w, cid);
  id32.write(w, transaction);
  return w.finish();
}

/**
 * Reads a locator from the anchor's state or an `ArchiveLocated` log. The
 * anchor frames it (`version ≠ 0`, a body of at least one byte, at most 128
 * bytes in all), and anything else is `locator-framing`; a version this
 * reader doesn't know is `locator-version`, reported and never guessed
 * (T-31). None of these fails anything (docs/spec/archive.md, The chain from
 * a locator).
 */
export function decodeArchiveLocator(locator: Uint8Array): LocatorRead {
  if (!(locator instanceof Uint8Array)) throw new TypeError("locator: expected bytes");
  const b = Uint8Array.from(locator);
  if (b.length < 3 || b.length > 128) return { kind: "locator-framing" };
  const version = ((b[0] as number) << 8) | (b[1] as number);
  if (version === 0) return { kind: "locator-framing" };
  if (version !== 1) return { kind: "locator-version", version };
  if (b.length !== LOCATOR_V1_LENGTH) return { kind: "locator-length" };
  const manifest = b.slice(2, 38);
  if (!framedCid(manifest, true)) return { kind: "locator-cid" };
  return { kind: "manifest", version: 1, manifest, transaction: b.slice(38) };
}

/** What `readArchivedObject` found in a transaction's data. */
export type ArchivedRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "inconsistent" }
  | { readonly ok: false; readonly reason: "over-bound"; readonly length: number };

/**
 * Reads the object `cid` names, at most `maxLength` bytes, from an Arweave
 * transaction's data, which must be exactly `objectCar(object)`
 * (docs/spec/archive.md, Archived objects). The data's header must name
 * `cid`, its blocks must parse, the object is read within the bound from
 * those blocks alone, and the data must then be its CAR byte for byte, so
 * one transaction's data has one reading. Every outcome is a function of the
 * data, `cid` and `maxLength`: a source serving other data is a failed fetch,
 * and the caller tries another (T-24). The caller fetches the data within its
 * own limit, but data of a few distinct blocks can name an object of up to
 * `maxLength` bytes (identical chunks), which is read and hashed again: so
 * `maxLength` is the reader's bound, set to what it can spend (T-52).
 */
export function readArchivedObject(
  data: Uint8Array,
  cid: Uint8Array,
  maxLength: number,
): ArchivedRead {
  if (!(data instanceof Uint8Array) || !(cid instanceof Uint8Array))
    throw new TypeError("readArchivedObject: data and cid must be bytes");
  if (!Number.isSafeInteger(maxLength) || maxLength < 1)
    throw new RangeError("readArchivedObject: maxLength must be a positive integer");
  const held = Uint8Array.from(data);
  const root = Uint8Array.from(cid);
  if (!framedCid(root, false)) return { ok: false, reason: "inconsistent" };
  const header = carHeader(root);
  if (held.length < header.length || compare(held.subarray(0, header.length), header) !== 0)
    return { ok: false, reason: "inconsistent" };
  const blocks = new Map<string, Uint8Array>();
  for (let at = header.length; at < held.length;) {
    const len = minimalVarint(held, at);
    if (len === undefined || len.value < 36 || len.next + len.value > held.length)
      return { ok: false, reason: "inconsistent" };
    const c = held.subarray(len.next, len.next + 36);
    if (!framedCid(c, false)) return { ok: false, reason: "inconsistent" };
    const key = hex(c);
    if (!blocks.has(key)) blocks.set(key, held.subarray(len.next + 36, len.next + len.value));
    at = len.next + len.value;
  }
  const source: BlockSource = (c) => {
    const b = blocks.get(hex(c));
    return b === undefined ? [] : [b];
  };
  const read = readObjectWithin(root, maxLength, source);
  if (read.ok) {
    return same(objectCar(read.bytes), held)
      ? { ok: true, bytes: read.bytes }
      : { ok: false, reason: "inconsistent" };
  }
  if (read.reason === "over-bound") return read;
  return { ok: false, reason: "inconsistent" };
}

/** The bound a manifest is read within: one chunk, since every manifest is one raw block. */
export const MANIFEST_BOUND = CHUNK_SIZE;

// The CAR's leading varint and dag-cbor header for a one-root CAR, as
// content-addressing's `encodeCar` writes them.
function carHeader(root: Uint8Array): Uint8Array {
  const roots = [0x72, 0x6f, 0x6f, 0x74, 0x73];
  const version = [0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e];
  const body = [
    0xa2,
    0x65,
    ...roots,
    0x81,
    0xd8,
    0x2a,
    0x58,
    37,
    0x00,
    ...root,
    0x67,
    ...version,
    0x01,
  ];
  return Uint8Array.from([body.length, ...body]);
}

// Unsigned LEB128 with no redundant trailing zero group, at most 8 bytes.
function minimalVarint(b: Uint8Array, at: number): { value: number; next: number } | undefined {
  let value = 0;
  for (let i = 0, scale = 1; i < 8; i++, scale *= 0x80) {
    const x = b[at + i];
    if (x === undefined) return undefined;
    value += (x & 0x7f) * scale;
    if (x < 0x80) return x === 0 && i > 0 ? undefined : { value, next: at + i + 1 };
  }
  return undefined;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compare(a, b) === 0;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A transaction ID as Arweave writes it: 43 characters of unpadded base64url. */
export function arweaveId(transaction: Uint8Array): string {
  const id = Uint8Array.from(transaction);
  if (id.length !== 32) throw new RangeError("arweaveId: expected 32 bytes");
  return btoa(String.fromCharCode(...id))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
