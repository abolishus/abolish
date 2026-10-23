// The permanent archive (docs/spec/archive.md; ADR 0005, option A): the
// archive manifest (record type 0x0021) that lists archived objects with the
// Arweave transactions holding their CARs and links the manifests before it,
// from version 2 with the contract-event evidence (record type 0x0025) it
// lists and from version 3 the contract-event runs (record type 0x0026)
// holding our contracts' events, the board anchor's locators naming the latest confirmed manifest,
// and the reader of an object from a transaction's data. Nothing found
// through the archive is trusted beyond being the bytes its CID names: the
// board checks judge it against L1's checkpoints (T-49, T-51, T-24).

import {
  bytesFixed,
  bytesVar,
  type Codec,
  DecodeError,
  EncodeError,
  Reader,
  u64,
  Writer,
} from "./codec.ts";
import { type BlockSource, CHUNK_SIZE, objectCar, readObjectWithin } from "./content-addressing.ts";
import { type ContractEventRecord, MAX_EVENT_DATA, MAX_EVENT_TOPICS } from "./contract-event.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";

/** `MAX_MANIFEST_OBJECTS`: the most objects one version-1 manifest lists. */
export const MAX_MANIFEST_OBJECTS = 8192;

/** `MAX_MANIFEST_LINKS`: the most earlier manifests one version-1 manifest links. */
export const MAX_MANIFEST_LINKS = 1024;

/** `MAX_MANIFEST_EVIDENCE`: the most evidence records one version-2 manifest lists. */
export const MAX_MANIFEST_EVIDENCE = 1024;

/** `MAX_MANIFEST_RUNS`: the most contract-event runs one version-3 manifest lists. */
export const MAX_MANIFEST_RUNS = 1024;

/** `MAX_RUN_EVENTS`: the most events one contract-event run holds. */
export const MAX_RUN_EVENTS = 65_536;

/** `MAX_CONTRACT_EVENT_RUN`: a run's longest encoding, the bound a reader reads it within. */
export const MAX_CONTRACT_EVENT_RUN = 1 << 24;

/** A version-1 locator's length: `u16(1)`, the manifest's CID and the transaction ID. Versions 2 and 3 have the same. */
export const LOCATOR_V1_LENGTH = 70;

/** `MAX_EVIDENCE_HEADER`: the longest L2 header a contract-event evidence record carries. */
export const MAX_EVIDENCE_HEADER = 1024;

/** `MAX_TRIE_NODE`: a branch node of sixteen 32-byte references, the largest node a trie with 32-byte keys has. */
export const MAX_TRIE_NODE = 532;

/** `MAX_EVIDENCE_NODES`: the most trie nodes one evidence record carries. */
export const MAX_EVIDENCE_NODES = 64;

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

/** One evidence record a version-2 manifest lists: what it proves, its CID and the transaction holding it. */
export interface EvidenceRef {
  readonly contract: Uint8Array;
  readonly l2_block: bigint;
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
}

/** Archive manifest, version 2 (docs/spec/archive.md, Layout (version 2)): version 1 and the evidence. */
export interface ArchiveManifestV2 extends ArchiveManifest {
  readonly evidence: readonly EvidenceRef[];
}

/** One contract-event run a version-3 manifest lists: whose events and which, its CID and the transaction holding it. */
export interface RunRef {
  readonly contract: Uint8Array;
  readonly first: bigint;
  readonly count: number;
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
}

/** Archive manifest, version 3 (docs/spec/archive.md, Layout (version 3)): version 2 and the runs. */
export interface ArchiveManifestV3 extends ArchiveManifestV2 {
  readonly runs: readonly RunRef[];
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

// Bytewise order, a prefix before anything it starts: negative, zero or positive.
function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

// A reference's order: contract, then block, then CID (Layout (version 2)).
function compareRefs(a: EvidenceRef, b: EvidenceRef): number {
  const c = compare(a.contract, b.contract);
  if (c !== 0) return c;
  if (a.l2_block !== b.l2_block) return a.l2_block < b.l2_block ? -1 : 1;
  return compare(a.cid, b.cid);
}

// A run reference's order: contract, then first index, then CID (Layout (version 3)).
function compareRunRefs(a: RunRef, b: RunRef): number {
  const c = compare(a.contract, b.contract);
  if (c !== 0) return c;
  if (a.first !== b.first) return a.first < b.first ? -1 : 1;
  return compare(a.cid, b.cid);
}

const TWO_64 = 1n << 64n;

// A run of `n` events from `first` holds at least one and at most
// MAX_RUN_EVENTS, and its last index is a u64.
const runSpan = (first: bigint, n: number) =>
  n >= 1 && n <= MAX_RUN_EVENTS && first + BigInt(n) <= TWO_64;

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

// Version 1's fields, which version 2 starts with. Read in field order, each
// rule judged as soon as the fields it reads are read, so every rejection has
// one code at one offset (archive.json and archive-v2.json, decode).
function writeBody(w: Writer, value: ArchiveManifest): void {
  u64.write(w, value.l1_chain_id);
  address.write(w, value.anchor);
  u64.write(w, value.sequence);
  const objects = list<ArchivedObject>(value.objects, MAX_MANIFEST_OBJECTS, "objects");
  const links = list<ManifestLink>(value.links, MAX_MANIFEST_LINKS, "links");
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
}

function readBody(r: Reader): { manifest: ArchiveManifest; objectsAt: number } {
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
  return { manifest: { l1_chain_id, anchor, sequence, objects, links }, objectsAt };
}

const manifestV1: Codec<ArchiveManifest> = {
  minLength: 8 + 20 + 8 + 4 + 4,
  write(w, value) {
    const objects = list<ArchivedObject>(value.objects, MAX_MANIFEST_OBJECTS, "objects");
    const links = list<ManifestLink>(value.links, MAX_MANIFEST_LINKS, "links");
    if (objects.length === 0 && links.length === 0)
      throw new EncodeError("archive manifest: names nothing");
    writeBody(w, value);
  },
  read(r) {
    const { manifest, objectsAt } = readBody(r);
    if (manifest.objects.length === 0 && manifest.links.length === 0)
      throw new DecodeError("non-canonical", objectsAt);
    return manifest;
  },
};

function writeEvidence(w: Writer, value: ArchiveManifestV2): void {
  const evidence = list<EvidenceRef>(value.evidence, MAX_MANIFEST_EVIDENCE, "evidence");
  w.uint(4, evidence.length);
  let previous: EvidenceRef | undefined;
  for (const e of evidence) {
    const ref = { ...e, cid: Uint8Array.from(e.cid), contract: Uint8Array.from(e.contract) };
    if (!framedCid(ref.cid, true))
      throw new EncodeError("archive manifest: an evidence record's CID isn't raw");
    if (previous !== undefined && compareRefs(previous, ref) >= 0)
      throw new EncodeError("archive manifest: evidence not in ascending order");
    address.write(w, ref.contract);
    u64.write(w, ref.l2_block);
    cid36.write(w, ref.cid);
    id32.write(w, ref.transaction);
    previous = ref;
  }
}

function readEvidence(r: Reader): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  for (let i = 0, n = count(r, MAX_MANIFEST_EVIDENCE); i < n; i++) {
    const at = r.offset;
    const contract = address.read(r);
    const l2_block = u64.read(r);
    const cidAt = r.offset;
    const cid = cid36.read(r);
    if (!framedCid(cid, true)) throw new DecodeError("non-canonical", cidAt);
    const ref = { contract, l2_block, cid, transaction: id32.read(r) };
    // The order is judged once the whole reference is read, at the reference's offset.
    const before = evidence[i - 1];
    if (before !== undefined && compareRefs(before, ref) >= 0)
      throw new DecodeError("non-canonical", at);
    evidence.push(ref);
  }
  return evidence;
}

const manifestV2: Codec<ArchiveManifestV2> = {
  minLength: 8 + 20 + 8 + 4 + 4 + 4,
  write(w, value) {
    const objects = list<ArchivedObject>(value.objects, MAX_MANIFEST_OBJECTS, "objects");
    const links = list<ManifestLink>(value.links, MAX_MANIFEST_LINKS, "links");
    const evidence = list<EvidenceRef>(value.evidence, MAX_MANIFEST_EVIDENCE, "evidence");
    if (objects.length === 0 && links.length === 0 && evidence.length === 0)
      throw new EncodeError("archive manifest: names nothing");
    writeBody(w, value);
    writeEvidence(w, value);
  },
  read(r) {
    const { manifest, objectsAt } = readBody(r);
    const evidence = readEvidence(r);
    if (manifest.objects.length === 0 && manifest.links.length === 0 && evidence.length === 0)
      throw new DecodeError("non-canonical", objectsAt);
    return { ...manifest, evidence };
  },
};

const manifestV3: Codec<ArchiveManifestV3> = {
  minLength: 8 + 20 + 8 + 4 + 4 + 4 + 4,
  write(w, value) {
    const objects = list<ArchivedObject>(value.objects, MAX_MANIFEST_OBJECTS, "objects");
    const links = list<ManifestLink>(value.links, MAX_MANIFEST_LINKS, "links");
    const evidence = list<EvidenceRef>(value.evidence, MAX_MANIFEST_EVIDENCE, "evidence");
    const runs = list<RunRef>(value.runs, MAX_MANIFEST_RUNS, "runs");
    if (objects.length === 0 && links.length === 0 && evidence.length === 0 && runs.length === 0)
      throw new EncodeError("archive manifest: names nothing");
    writeBody(w, value);
    writeEvidence(w, value);
    w.uint(4, runs.length);
    let previous: RunRef | undefined;
    for (const x of runs) {
      const ref = { ...x, cid: Uint8Array.from(x.cid), contract: Uint8Array.from(x.contract) };
      address.write(w, ref.contract);
      u64.write(w, ref.first);
      if (!Number.isSafeInteger(ref.count) || !runSpan(ref.first, ref.count))
        throw new EncodeError("archive manifest: a run's count");
      w.uint(4, ref.count);
      if (!framedCid(ref.cid, false)) throw new EncodeError("archive manifest: a run's CID");
      if (previous !== undefined && compareRunRefs(previous, ref) >= 0)
        throw new EncodeError("archive manifest: runs not in ascending order");
      cid36.write(w, ref.cid);
      id32.write(w, ref.transaction);
      previous = ref;
    }
  },
  read(r) {
    const { manifest, objectsAt } = readBody(r);
    const evidence = readEvidence(r);
    const runs: RunRef[] = [];
    for (let i = 0, n = count(r, MAX_MANIFEST_RUNS); i < n; i++) {
      const at = r.offset;
      const contract = address.read(r);
      const first = u64.read(r);
      const countAt = r.offset;
      const events = r.uint(4);
      if (!runSpan(first, events)) throw new DecodeError("non-canonical", countAt);
      const cidAt = r.offset;
      const cid = cid36.read(r);
      if (!framedCid(cid, false)) throw new DecodeError("non-canonical", cidAt);
      const ref = { contract, first, count: events, cid, transaction: id32.read(r) };
      const before = runs[i - 1];
      if (before !== undefined && compareRunRefs(before, ref) >= 0)
        throw new DecodeError("non-canonical", at);
      runs.push(ref);
    }
    if (
      manifest.objects.length === 0 &&
      manifest.links.length === 0 &&
      evidence.length === 0 &&
      runs.length === 0
    )
      throw new DecodeError("non-canonical", objectsAt);
    return { ...manifest, evidence, runs };
  },
};

/** Record type `0x0021`. No profile pins it: each locator version fixes the manifest version it names. */
export const ARCHIVE_MANIFEST = recordType(RECORD_TYPES.archiveManifest, {
  1: manifestV1,
  2: manifestV2,
  3: manifestV3,
});

/**
 * Contract-event evidence, version 1 (docs/spec/archive.md, Contract-event
 * evidence): one contract's event accumulator proven at one L2 block under
 * the output root a dispute game on L1 claims.
 */
export interface ContractEventEvidence {
  readonly l2_chain_id: bigint;
  readonly contract: Uint8Array;
  readonly game_index: bigint;
  readonly game: Uint8Array;
  readonly output_root: Uint8Array;
  readonly message_passer_storage_root: Uint8Array;
  /** The L2 block's header, RLP-encoded. */
  readonly header: Uint8Array;
  /** Trie nodes in strictly ascending byte order, each once. */
  readonly nodes: readonly Uint8Array[];
}

const headerBytes = bytesVar(MAX_EVIDENCE_HEADER);
const nodeBytes = bytesVar(MAX_TRIE_NODE);

// Only the form is judged here: that the header is one header and each node a
// trie node the proof walks is the evidence check's (packages/verifier).
const evidenceV1: Codec<ContractEventEvidence> = {
  minLength: 8 + 20 + 8 + 20 + 32 + 32 + 4 + 4,
  write(w, value) {
    u64.write(w, value.l2_chain_id);
    address.write(w, value.contract);
    u64.write(w, value.game_index);
    address.write(w, value.game);
    id32.write(w, value.output_root);
    id32.write(w, value.message_passer_storage_root);
    if (!(value.header instanceof Uint8Array) || value.header.length === 0)
      throw new EncodeError("contract-event evidence: an empty header");
    headerBytes.write(w, value.header);
    const nodes = list<Uint8Array>(value.nodes, MAX_EVIDENCE_NODES, "nodes");
    if (nodes.length === 0) throw new EncodeError("contract-event evidence: no nodes");
    w.uint(4, nodes.length);
    let previous: Uint8Array | undefined;
    for (const n of nodes) {
      if (!(n instanceof Uint8Array) || n.length === 0)
        throw new EncodeError("contract-event evidence: an empty node");
      const node = Uint8Array.from(n);
      if (previous !== undefined && compare(previous, node) >= 0)
        throw new EncodeError("contract-event evidence: nodes not in ascending order");
      nodeBytes.write(w, node);
      previous = node;
    }
  },
  read(r) {
    const l2_chain_id = u64.read(r);
    const contract = address.read(r);
    const game_index = u64.read(r);
    const game = address.read(r);
    const output_root = id32.read(r);
    const message_passer_storage_root = id32.read(r);
    const headerAt = r.offset;
    const header = headerBytes.read(r);
    if (header.length === 0) throw new DecodeError("non-canonical", headerAt);
    const nodesAt = r.offset;
    const n = count(r, MAX_EVIDENCE_NODES);
    // No account is proven without a node.
    if (n === 0) throw new DecodeError("non-canonical", nodesAt);
    const nodes: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const at = r.offset;
      const node = nodeBytes.read(r);
      const before = nodes[i - 1];
      // One order and no repeats, so one set of nodes has one encoding.
      if (node.length === 0 || (before !== undefined && compare(before, node) >= 0))
        throw new DecodeError("non-canonical", at);
      nodes.push(node);
    }
    return {
      l2_chain_id,
      contract,
      game_index,
      game,
      output_root,
      message_passer_storage_root,
      header,
      nodes,
    };
  },
};

/** Record type `0x0025`. No profile pins it: the manifest version that lists it fixes its version. */
export const CONTRACT_EVENT_EVIDENCE = recordType(RECORD_TYPES.contractEventEvidence, {
  1: evidenceV1,
});

/**
 * A contract-event run's event (docs/spec/archive.md, Contract-event run):
 * the fields of its contract-event record that the run doesn't share or imply.
 */
export interface RunEvent {
  readonly l2_block: bigint;
  readonly l2_timestamp: bigint;
  readonly topics: readonly Uint8Array[];
  readonly data: Uint8Array;
}

/**
 * Contract-event run, version 1 (docs/spec/archive.md, Contract-event run):
 * one contract's consecutive events, event `i` at index `first + i`.
 */
export interface ContractEventRun {
  readonly l2_chain_id: bigint;
  readonly contract: Uint8Array;
  readonly first: bigint;
  readonly events: readonly RunEvent[];
}

const topic = bytesFixed(32);
const eventData = bytesVar(MAX_EVENT_DATA);

// Only the form is judged here: that the events are the contract's history is
// the replay's against evidence, and that each is one of its contract's is the
// event check's (T-53).
const runV1: Codec<ContractEventRun> = {
  minLength: 8 + 20 + 8 + 4,
  write(w, value) {
    u64.write(w, value.l2_chain_id);
    address.write(w, value.contract);
    u64.write(w, value.first);
    const events = list<RunEvent>(value.events, MAX_RUN_EVENTS, "events");
    if (!runSpan(value.first, events.length))
      throw new EncodeError("contract-event run: no events, or an index past 2^64 - 1");
    w.uint(4, events.length);
    for (const e of events) {
      u64.write(w, e.l2_block);
      u64.write(w, e.l2_timestamp);
      const topics = list<Uint8Array>(e.topics, MAX_EVENT_TOPICS, "topics");
      w.uint(4, topics.length);
      for (const t of topics) topic.write(w, t);
      eventData.write(w, e.data);
    }
  },
  read(r) {
    const l2_chain_id = u64.read(r);
    const contract = address.read(r);
    const first = u64.read(r);
    const eventsAt = r.offset;
    const n = count(r, MAX_RUN_EVENTS);
    if (!runSpan(first, n)) throw new DecodeError("non-canonical", eventsAt);
    const events: RunEvent[] = [];
    for (let i = 0; i < n; i++) {
      const l2_block = u64.read(r);
      const l2_timestamp = u64.read(r);
      const topics: Uint8Array[] = [];
      for (let j = 0, k = count(r, MAX_EVENT_TOPICS); j < k; j++) topics.push(topic.read(r));
      events.push({ l2_block, l2_timestamp, topics, data: eventData.read(r) });
    }
    return { l2_chain_id, contract, first, events };
  },
};

/** Record type `0x0026`. No profile pins it: the manifest version that lists it fixes its version. */
export const CONTRACT_EVENT_RUN = recordType(RECORD_TYPES.contractEventRun, { 1: runV1 });

const SCHEMA = new RecordSchema([ARCHIVE_MANIFEST, CONTRACT_EVENT_EVIDENCE, CONTRACT_EVENT_RUN]);

/** Encodes a manifest of version 1 (the default), 2 or 3. */
export function encodeArchiveManifest(manifest: ArchiveManifest, version?: 1): Uint8Array;
export function encodeArchiveManifest(manifest: ArchiveManifestV2, version: 2): Uint8Array;
export function encodeArchiveManifest(manifest: ArchiveManifestV3, version: 3): Uint8Array;
export function encodeArchiveManifest(
  manifest: ArchiveManifest | ArchiveManifestV2 | ArchiveManifestV3,
  version: 1 | 2 | 3 = 1,
): Uint8Array {
  if (version === 3) return SCHEMA.encode(ARCHIVE_MANIFEST, 3, manifest as ArchiveManifestV3);
  // A later version's value is an earlier one's to the type checker: encoding
  // it under the earlier version would drop its lists without a word.
  if (Object.hasOwn(manifest, "runs"))
    throw new EncodeError("archive manifest: runs need version 3");
  if (version === 2) return SCHEMA.encode(ARCHIVE_MANIFEST, 2, manifest as ArchiveManifestV2);
  if (version !== 1) throw new EncodeError("archive manifest: version 1, 2 or 3");
  if (Object.hasOwn(manifest, "evidence"))
    throw new EncodeError("archive manifest: evidence needs version 2");
  return SCHEMA.encode(ARCHIVE_MANIFEST, 1, manifest);
}

/** Strictly decodes a manifest under the version its locator fixes. */
export function decodeArchiveManifest(bytes: Uint8Array, pinned: 1): ArchiveManifest;
export function decodeArchiveManifest(bytes: Uint8Array, pinned: 2): ArchiveManifestV2;
export function decodeArchiveManifest(bytes: Uint8Array, pinned: 3): ArchiveManifestV3;
export function decodeArchiveManifest(
  bytes: Uint8Array,
  pinned: 1 | 2 | 3,
): ArchiveManifest | ArchiveManifestV2 | ArchiveManifestV3 {
  return SCHEMA.decode(ARCHIVE_MANIFEST, bytes, pinned).value;
}

/** Encodes a run, refusing one over `MAX_CONTRACT_EVENT_RUN` bytes, which no reader reads. */
export function encodeContractEventRun(run: ContractEventRun): Uint8Array {
  const bytes = SCHEMA.encode(CONTRACT_EVENT_RUN, 1, run);
  if (bytes.length > MAX_CONTRACT_EVENT_RUN)
    throw new EncodeError(`contract-event run: ${bytes.length} bytes is over 2^24`);
  return bytes;
}

/**
 * Strictly decodes a run under the version its manifest fixes (version 3
 * lists version 1). `MAX_CONTRACT_EVENT_RUN` is the reader's bound (Archived
 * objects), applied before the bytes are held, and the encoder's rule, never
 * a decoding one: a longer run decodes here but no reader reads one.
 */
export function decodeContractEventRun(bytes: Uint8Array, pinned: 1): ContractEventRun {
  return SCHEMA.decode(CONTRACT_EVENT_RUN, bytes, pinned).value;
}

/**
 * A run's events as contract-event records (0x0008), event `i` at index
 * `first + i`, each to be framed under the contract-event version its
 * election's profile pins and judged as a boarded record is: the layout is
 * one for versions 1 to 9 (docs/spec/contracts.md, Layout (versions 1 to 9)).
 */
export function contractEventRunRecords(run: ContractEventRun): ContractEventRecord[] {
  return run.events.map((e, i) => ({
    contract: run.contract,
    n: run.first + BigInt(i),
    l2_block: e.l2_block,
    l2_timestamp: e.l2_timestamp,
    topics: e.topics,
    data: e.data,
  }));
}

export function encodeContractEventEvidence(evidence: ContractEventEvidence): Uint8Array {
  return SCHEMA.encode(CONTRACT_EVENT_EVIDENCE, 1, evidence);
}

/** Strictly decodes an evidence record under the version its manifest fixes (version 2 lists version 1). */
export function decodeContractEventEvidence(bytes: Uint8Array, pinned: 1): ContractEventEvidence {
  return SCHEMA.decode(CONTRACT_EVENT_EVIDENCE, bytes, pinned).value;
}

/** The locator versions this package reads. */
export type LocatorVersion = 1 | 2 | 3;

/** What a locator names (docs/spec/archive.md, Locator), to a reader that knows the versions `V`. */
export type LocatorRead<V extends LocatorVersion = LocatorVersion> =
  | {
      readonly kind: "manifest";
      readonly version: V;
      readonly manifest: Uint8Array;
      readonly transaction: Uint8Array;
    }
  | { readonly kind: "locator-version"; readonly version: number }
  | { readonly kind: "locator-length" | "locator-cid" | "locator-framing" };

/** `u16(version) ‖ manifest ‖ transaction`: the locator naming a manifest of that version (1 by default). */
export function encodeArchiveLocator(
  manifest: Uint8Array,
  transaction: Uint8Array,
  version: LocatorVersion = 1,
): Uint8Array {
  if (version !== 1 && version !== 2 && version !== 3)
    throw new EncodeError("locator: version 1, 2 or 3");
  const cid = Uint8Array.from(manifest);
  if (!framedCid(cid, true)) throw new EncodeError("locator: the manifest's CID isn't raw");
  const w = new Writer();
  w.uint(2, version);
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
 * a locator). `known` is the versions the caller reads chains of: version 1
 * alone by default, so a reader that can't walk a later chain reports its
 * locator as one it doesn't know.
 */
export function decodeArchiveLocator<V extends LocatorVersion = 1>(
  locator: Uint8Array,
  known: readonly V[] = [1 as V],
): LocatorRead<V> {
  if (!(locator instanceof Uint8Array)) throw new TypeError("locator: expected bytes");
  if (!Array.isArray(known) || known.some((v) => v !== 1 && v !== 2 && v !== 3))
    throw new TypeError("locator: known versions are 1, 2 and 3");
  const b = Uint8Array.from(locator);
  if (b.length < 3 || b.length > 128) return { kind: "locator-framing" };
  const version = ((b[0] as number) << 8) | (b[1] as number);
  if (version === 0) return { kind: "locator-framing" };
  if (!(known as readonly number[]).includes(version)) return { kind: "locator-version", version };
  if (b.length !== LOCATOR_V1_LENGTH) return { kind: "locator-length" };
  const manifest = b.slice(2, 38);
  if (!framedCid(manifest, true)) return { kind: "locator-cid" };
  return { kind: "manifest", version: version as V, manifest, transaction: b.slice(38) };
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
