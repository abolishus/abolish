import fc from "fast-check";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type ArchiveManifestV2,
  type ContractEventEvidence,
  DecodeError,
  decodeArchiveLocator,
  decodeArchiveManifest,
  decodeContractEventEvidence,
  encodeArchiveLocator,
  encodeArchiveManifest,
  encodeContractEventEvidence,
  EncodeError,
  type EvidenceRef,
  LOCATOR_V1_LENGTH,
  MANIFEST_BOUND,
  MAX_EVIDENCE_HEADER,
  MAX_EVIDENCE_NODES,
  MAX_MANIFEST_EVIDENCE,
  MAX_MANIFEST_LINKS,
  MAX_MANIFEST_OBJECTS,
  MAX_TRIE_NODE,
  objectCid,
  RECORD_TYPES,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/archive-v2.json comes from an independent Python
// implementation of docs/spec/archive.md's version-2 manifest, contract-event
// evidence and locators (scripts/archive-v2-vectors.py, with its own strict
// decoders), two of its records from output-root.json's Base Sepolia game,
// header and trie nodes, so no expected value here comes from the code under
// test (T-31, T-17, T-52).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

interface RefJson {
  readonly contract: string;
  readonly l2Block: string;
  readonly cid: string;
  readonly transaction: string;
}

interface ManifestJson {
  readonly l1ChainId: string;
  readonly anchor: string;
  readonly sequence: string;
  readonly objects: readonly { readonly cid: string; readonly transaction: string }[];
  readonly links: readonly {
    readonly sequence: string;
    readonly cid: string;
    readonly transaction: string;
  }[];
  readonly evidence: readonly RefJson[];
}

interface EvidenceJson {
  readonly l2ChainId: string;
  readonly contract: string;
  readonly gameIndex: string;
  readonly game: string;
  readonly outputRoot: string;
  readonly messagePasserStorageRoot: string;
  readonly header: string;
  readonly nodes: readonly string[];
}

interface Rejection {
  readonly id: string;
  readonly encoding: string;
  readonly code: string;
  readonly offset: number;
}

interface Vectors {
  readonly format: string;
  readonly manifest: {
    readonly recordType: string;
    readonly version: number;
    readonly maxObjects: number;
    readonly maxLinks: number;
    readonly maxEvidence: number;
  };
  readonly evidence: {
    readonly recordType: string;
    readonly version: number;
    readonly maxHeader: number;
    readonly maxNode: number;
    readonly maxNodes: number;
  };
  readonly locatorLength: number;
  readonly records: readonly {
    readonly id: string;
    readonly length: number;
    readonly cid: string;
    readonly fields?: EvidenceJson;
    readonly encoding?: string;
    readonly recipe?: "max";
    readonly sha256?: string;
  }[];
  readonly recordDecode: readonly Rejection[];
  readonly manifests: readonly {
    readonly id: string;
    readonly length: number;
    readonly cid: string;
    readonly fields?: ManifestJson;
    readonly encoding?: string;
    readonly recipe?: "full";
    readonly sha256?: string;
  }[];
  readonly manifestDecode: readonly Rejection[];
  readonly locators: readonly {
    readonly id: string;
    readonly locator: string;
    readonly result: Readonly<Record<string, string | number>>;
  }[];
}

const file = JSON.parse(readFileSync(new URL("archive-v2.json", SPEC_VECTORS), "utf8")) as Vectors;

function manifest(j: ManifestJson): ArchiveManifestV2 {
  return {
    l1_chain_id: BigInt(j.l1ChainId),
    anchor: hex(j.anchor),
    sequence: BigInt(j.sequence),
    objects: j.objects.map((o) => ({ cid: hex(o.cid), transaction: hex(o.transaction) })),
    links: j.links.map((l) => ({
      sequence: BigInt(l.sequence),
      cid: hex(l.cid),
      transaction: hex(l.transaction),
    })),
    evidence: j.evidence.map((e) => ({
      contract: hex(e.contract),
      l2_block: BigInt(e.l2Block),
      cid: hex(e.cid),
      transaction: hex(e.transaction),
    })),
  };
}

function evidence(j: EvidenceJson): ContractEventEvidence {
  return {
    l2_chain_id: BigInt(j.l2ChainId),
    contract: hex(j.contract),
    game_index: BigInt(j.gameIndex),
    game: hex(j.game),
    output_root: hex(j.outputRoot),
    message_passer_storage_root: hex(j.messagePasserStorageRoot),
    header: hex(j.header),
    nodes: j.nodes.map(hex),
  };
}

const label32 = (label: string) => new Uint8Array(sha256(`archive/${label}`));
const prefixed = (codec: number, digest: Uint8Array) =>
  Uint8Array.from([0x01, codec, 0x12, 0x20, ...digest]);
const ref = (contract: Uint8Array, l2_block: bigint, label: string): EvidenceRef => ({
  contract,
  l2_block,
  cid: prefixed(0x55, label32(`evidence/${label}`)),
  transaction: label32(`tx/evidence/${label}`),
});

// The order the spec gives references: contract, block, CID, each bytewise or numeric.
function byRef(a: EvidenceRef, b: EvidenceRef): number {
  return (
    Buffer.compare(a.contract, b.contract) ||
    (a.l2_block < b.l2_block ? -1 : a.l2_block > b.l2_block ? 1 : 0) ||
    Buffer.compare(a.cid, b.cid)
  );
}

// archive-v2.json's rules: "full".
function fullManifest(): ArchiveManifestV2 {
  const objects = Array.from({ length: MAX_MANIFEST_OBJECTS }, (_, i) => ({
    cid: prefixed(i % 2 ? 0x70 : 0x55, label32(`object/full-${i}`)),
    transaction: label32(`tx/full-${i}`),
  })).sort((a, b) => Buffer.compare(a.cid, b.cid));
  const links = Array.from({ length: MAX_MANIFEST_LINKS }, (_, s) => ({
    sequence: BigInt(s),
    cid: prefixed(0x55, label32(`manifest/${s}`)),
    transaction: label32(`tx/manifest/${s}`),
  }));
  const contracts = [0, 1, 2, 3].map((c) => label32(`contract/${c}`).subarray(0, 20));
  const evidence = Array.from({ length: MAX_MANIFEST_EVIDENCE }, (_, i) =>
    ref(contracts[i % 4] as Uint8Array, BigInt(Math.floor(i / 4)), `full-${i}`),
  ).sort(byRef);
  return {
    l1_chain_id: 11155111n,
    anchor: hex("5fbdb2315678afecb367f032d93f642f64180aa3"),
    sequence: BigInt(MAX_MANIFEST_LINKS),
    objects,
    links,
    evidence,
  };
}

// archive-v2.json's rules: "max".
function maxEvidence(): ContractEventEvidence {
  const filled = (label: string, length: number) => {
    const parts: Buffer[] = [];
    for (let i = 0; parts.length * 32 < length; i++) parts.push(sha256(`archive-v2/${label}/${i}`));
    return new Uint8Array(Buffer.concat(parts).subarray(0, length));
  };
  return {
    l2_chain_id: (1n << 64n) - 1n,
    contract: new Uint8Array(20).fill(0xff),
    game_index: (1n << 64n) - 1n,
    game: new Uint8Array(20).fill(0xff),
    output_root: label32("max/root"),
    message_passer_storage_root: label32("max/passer"),
    header: filled("header", MAX_EVIDENCE_HEADER),
    nodes: Array.from({ length: MAX_EVIDENCE_NODES }, (_, i) =>
      filled(`node-${i}`, MAX_TRIE_NODE),
    ).sort((a, b) => Buffer.compare(a, b)),
  };
}

function decodeError(f: () => unknown): { code: string; offset: number } | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return { code: e.code, offset: e.offset };
    throw e;
  }
  return undefined;
}

describe("archive-v2.json", () => {
  test("format, record types and limits match the code", () => {
    expect(file.format).toBe("abolish-archive-vectors/2");
    expect(Number(file.manifest.recordType)).toBe(RECORD_TYPES.archiveManifest);
    expect(file.manifest.version).toBe(2);
    expect(file.manifest.maxObjects).toBe(MAX_MANIFEST_OBJECTS);
    expect(file.manifest.maxLinks).toBe(MAX_MANIFEST_LINKS);
    expect(file.manifest.maxEvidence).toBe(MAX_MANIFEST_EVIDENCE);
    expect(Number(file.evidence.recordType)).toBe(RECORD_TYPES.contractEventEvidence);
    expect(RECORD_TYPES.contractEventEvidence).toBe(0x0025);
    expect(file.evidence.version).toBe(1);
    expect(file.evidence.maxHeader).toBe(MAX_EVIDENCE_HEADER);
    expect(file.evidence.maxNode).toBe(MAX_TRIE_NODE);
    expect(file.evidence.maxNodes).toBe(MAX_EVIDENCE_NODES);
    expect(file.locatorLength).toBe(LOCATOR_V1_LENGTH);
  });

  test.each(file.records)("evidence record $id encodes, decodes and has its CID", (v) => {
    const e = v.recipe === "max" ? maxEvidence() : evidence(v.fields as EvidenceJson);
    const encoding = encodeContractEventEvidence(e);
    expect(encoding.length).toBe(v.length);
    if (v.encoding !== undefined) expect(toHex(encoding)).toBe(v.encoding);
    else expect(toHex(sha256(encoding))).toBe(v.sha256);
    expect(decodeContractEventEvidence(encoding, 1)).toEqual(e);
    // Every record is one raw block, so its CID is the raw CID of its encoding.
    expect(encoding.length).toBeLessThanOrEqual(MANIFEST_BOUND);
    expect(toHex(objectCid(encoding))).toBe(v.cid);
  });

  test.each(file.recordDecode)("rejects evidence $id with its code at its offset", (v) => {
    expect(decodeError(() => decodeContractEventEvidence(hex(v.encoding), 1))).toEqual({
      code: v.code,
      offset: v.offset,
    });
  });

  test.each(file.manifests)("version-2 manifest $id encodes, decodes and has its CID", (v) => {
    const m = v.recipe === "full" ? fullManifest() : manifest(v.fields as ManifestJson);
    const encoding = encodeArchiveManifest(m, 2);
    expect(encoding.length).toBe(v.length);
    if (v.encoding !== undefined) expect(toHex(encoding)).toBe(v.encoding);
    else expect(toHex(sha256(encoding))).toBe(v.sha256);
    expect(decodeArchiveManifest(encoding, 2)).toEqual(m);
    expect(encoding.length).toBeLessThanOrEqual(MANIFEST_BOUND);
    expect(toHex(objectCid(encoding))).toBe(v.cid);
  });

  test("the evidence-only manifest names the Base Sepolia records by their CIDs", () => {
    const listed = manifest(
      file.manifests.find((v) => v.id === "evidence-only")?.fields as ManifestJson,
    ).evidence.map((e) => toHex(e.cid));
    const records = file.records.filter((v) => v.id.startsWith("base-sepolia-")).map((v) => v.cid);
    expect([...listed].sort()).toEqual([...records].sort());
  });

  test.each(file.manifestDecode)("rejects manifest $id with its code at its offset", (v) => {
    expect(decodeError(() => decodeArchiveManifest(hex(v.encoding), 2))).toEqual({
      code: v.code,
      offset: v.offset,
    });
  });

  test.each(file.locators)("locator $id reads as a reader knowing versions 1 and 2", (v) => {
    const read = decodeArchiveLocator(hex(v.locator), [1, 2]);
    const json =
      read.kind === "manifest"
        ? { ...read, manifest: toHex(read.manifest), transaction: toHex(read.transaction) }
        : read;
    expect(json).toEqual(v.result);
    if (read.kind === "manifest")
      expect(toHex(encodeArchiveLocator(read.manifest, read.transaction, read.version))).toBe(
        v.locator,
      );
  });

  test("a reader knowing version 1 alone reports a version-2 locator as unknown", () => {
    // packages/verifier reads with the default until it walks version-2 chains (P4-3 part 3b-3b).
    const v2 = file.locators.find((v) => v.id === "v2");
    expect(decodeArchiveLocator(hex(v2?.locator as string))).toEqual({
      kind: "locator-version",
      version: 2,
    });
    const v1 = file.locators.find((v) => v.id === "v1");
    expect(decodeArchiveLocator(hex(v1?.locator as string)).kind).toBe("manifest");
    expect(decodeArchiveLocator(hex(v1?.locator as string), [2])).toEqual({
      kind: "locator-version",
      version: 1,
    });
  });

  test("a manifest of either version under the other's pin is profile-mismatch", () => {
    const m = manifest(file.manifests.find((v) => v.id === "period")?.fields as ManifestJson);
    expect(decodeError(() => decodeArchiveManifest(encodeArchiveManifest(m, 2), 1))).toEqual({
      code: "profile-mismatch",
      offset: 2,
    });
    const { evidence: _, ...v1 } = m;
    expect(decodeError(() => decodeArchiveManifest(encodeArchiveManifest(v1), 2))).toEqual({
      code: "profile-mismatch",
      offset: 2,
    });
  });
});

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });
const rawCid = bytes(32).map((d) => prefixed(0x55, d));

const refArb = fc.record({
  // A few contracts, so references often share one and order by block, then CID.
  contract: fc.constantFrom(...[0, 1, 2].map((c) => label32(`contract/${c}`).subarray(0, 20))),
  l2_block: fc.oneof(
    fc.bigInt({ min: 0n, max: 3n }),
    fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
  ),
  cid: rawCid,
  transaction: bytes(32),
});

const manifestArb: fc.Arbitrary<ArchiveManifestV2> = fc
  .record({
    l1_chain_id: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
    anchor: bytes(20),
    sequence: fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }),
    objects: fc.uniqueArray(fc.record({ cid: rawCid, transaction: bytes(32) }), {
      maxLength: 3,
      selector: (o) => toHex(o.cid),
    }),
    links: fc.constant([]),
    evidence: fc.uniqueArray(refArb, {
      maxLength: 6,
      selector: (e) => `${toHex(e.contract)}/${e.l2_block}/${toHex(e.cid)}`,
    }),
  })
  .map((m) => ({
    ...m,
    objects: [...m.objects].sort((a, b) => Buffer.compare(a.cid, b.cid)),
    evidence: [...m.evidence].sort(byRef),
  }))
  .filter((m) => m.objects.length + m.evidence.length > 0);

const nodeArb = fc.uint8Array({ minLength: 1, maxLength: 40 });
const evidenceArb: fc.Arbitrary<ContractEventEvidence> = fc
  .record({
    l2_chain_id: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
    contract: bytes(20),
    game_index: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
    game: bytes(20),
    output_root: bytes(32),
    message_passer_storage_root: bytes(32),
    header: fc.uint8Array({ minLength: 1, maxLength: 64 }),
    // Short nodes over a small alphabet, so one is often a prefix of another.
    nodes: fc.uniqueArray(
      fc.oneof(
        nodeArb,
        fc.uint8Array({ minLength: 1, maxLength: 3 }).map((b) => b.map((x) => x & 1)),
      ),
      { minLength: 1, maxLength: 8, selector: toHex },
    ),
  })
  .map((e) => ({ ...e, nodes: [...e.nodes].sort((a, b) => Buffer.compare(a, b)) }));

function flips<T>(
  arb: fc.Arbitrary<T>,
  encode: (v: T) => Uint8Array,
  decode: (b: Uint8Array) => T,
) {
  fc.assert(
    fc.property(arb, fc.nat(), fc.integer({ min: 1, max: 255 }), (v, i, x) => {
      const b = encode(v);
      const at = i % b.length;
      const changed = Uint8Array.from(b);
      changed[at] = (changed[at] as number) ^ x;
      let back: T;
      try {
        back = decode(changed);
      } catch (e) {
        expect(e).toBeInstanceOf(DecodeError);
        return;
      }
      expect(encode(back)).toEqual(changed);
    }),
    { numRuns },
  );
}

describe("version-2 manifest properties", () => {
  test("decode(encode(m)) = m and encode(decode(b)) = b", () => {
    fc.assert(
      fc.property(manifestArb, (m) => {
        const b = encodeArchiveManifest(m, 2);
        const back = decodeArchiveManifest(b, 2);
        expect(back).toEqual(m);
        expect(encodeArchiveManifest(back, 2)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("any changed byte either fails to decode or re-encodes to exactly itself", () => {
    flips(
      manifestArb,
      (m) => encodeArchiveManifest(m, 2),
      (b) => decodeArchiveManifest(b, 2),
    );
  });

  test("the encoder refuses what the decoder would reject", () => {
    const m = manifest(file.manifests.find((v) => v.id === "period")?.fields as ManifestJson);
    const refuse = (value: ArchiveManifestV2) =>
      expect(() => encodeArchiveManifest(value, 2)).toThrow(EncodeError);
    const first = m.evidence[0] as EvidenceRef;
    refuse({ ...m, objects: [], links: [], evidence: [] });
    refuse({ ...m, evidence: [...m.evidence].reverse() });
    refuse({ ...m, evidence: [first, ...m.evidence] });
    refuse({ ...m, evidence: [{ ...first, cid: prefixed(0x70, new Uint8Array(32)) }] });
    refuse({ ...m, evidence: [{ ...first, contract: new Uint8Array(19) }] });
    refuse({
      ...m,
      evidence: Array.from({ length: MAX_MANIFEST_EVIDENCE + 1 }, (_, i) =>
        ref(first.contract, BigInt(i), `over-${i}`),
      ),
    });
    // Version 1's rules hold under version 2.
    refuse({ ...m, objects: [...m.objects].reverse() });
    refuse({ ...m, links: [...m.links].reverse() });
    // Version 1 never drops a version-2 value's evidence, and no other version is written.
    expect(() => encodeArchiveManifest(m)).toThrow(EncodeError);
    const empty: ArchiveManifestV2 = { ...m, evidence: [] };
    expect(() => encodeArchiveManifest(empty)).toThrow(EncodeError);
    expect(() => encodeArchiveManifest(m, 4 as 2)).toThrow(EncodeError);
    // A manifest of evidence alone is well formed.
    const alone = { ...m, objects: [], links: [] };
    expect(decodeArchiveManifest(encodeArchiveManifest(alone, 2), 2)).toEqual(alone);
  });
});

describe("contract-event evidence properties", () => {
  test("decode(encode(e)) = e and encode(decode(b)) = b", () => {
    fc.assert(
      fc.property(evidenceArb, (e) => {
        const b = encodeContractEventEvidence(e);
        const back = decodeContractEventEvidence(b, 1);
        expect(back).toEqual(e);
        expect(encodeContractEventEvidence(back)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("any changed byte either fails to decode or re-encodes to exactly itself", () => {
    flips(evidenceArb, encodeContractEventEvidence, (b) => decodeContractEventEvidence(b, 1));
  });

  test("the encoder refuses what the decoder would reject", () => {
    const e = evidence(file.records.find((v) => v.id === "prefix-first")?.fields as EvidenceJson);
    const refuse = (value: ContractEventEvidence) =>
      expect(() => encodeContractEventEvidence(value)).toThrow(EncodeError);
    refuse({ ...e, header: new Uint8Array(0) });
    refuse({ ...e, header: new Uint8Array(MAX_EVIDENCE_HEADER + 1) });
    refuse({ ...e, nodes: [] });
    refuse({ ...e, nodes: [new Uint8Array(0), ...e.nodes] });
    refuse({ ...e, nodes: [...e.nodes].reverse() });
    refuse({ ...e, nodes: [e.nodes[0] as Uint8Array, ...e.nodes] });
    refuse({ ...e, nodes: [new Uint8Array(MAX_TRIE_NODE + 1)] });
    refuse({
      ...e,
      nodes: Array.from({ length: MAX_EVIDENCE_NODES + 1 }, (_, i) => Uint8Array.of(1, i)),
    });
    refuse({ ...e, contract: new Uint8Array(21) });
    refuse({ ...e, output_root: new Uint8Array(31) });
  });
});

describe("argument checks", () => {
  test("locators of version 2 encode at version 1's length", () => {
    // archive-v3.test.ts checks the versions known since version 3.
    const cid = prefixed(0x55, new Uint8Array(32));
    expect(encodeArchiveLocator(cid, new Uint8Array(32), 2).length).toBe(LOCATOR_V1_LENGTH);
  });
});
