import fc from "fast-check";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type ArchiveManifestV3,
  checkEventAccumulatorProof,
  type ContractEventRun,
  contractEventLog,
  contractEventRunRecords,
  DecodeError,
  decodeArchiveLocator,
  decodeArchiveManifest,
  decodeContractEvent,
  decodeContractEventRun,
  encodeArchiveLocator,
  encodeArchiveManifest,
  encodeContractEvent,
  encodeContractEventRun,
  EncodeError,
  LOCATOR_V1_LENGTH,
  MANIFEST_BOUND,
  MAX_CONTRACT_EVENT_RUN,
  MAX_EVENT_DATA,
  MAX_MANIFEST_EVIDENCE,
  MAX_MANIFEST_LINKS,
  MAX_MANIFEST_OBJECTS,
  MAX_MANIFEST_RUNS,
  MAX_RUN_EVENTS,
  objectCid,
  RECORD_TYPES,
  readArchivedObject,
  objectCar,
  replayEventAccumulator,
  type RunEvent,
  type RunRef,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/archive-v3.json comes from an independent Python
// implementation of docs/spec/archive.md's version-3 manifest, contract-event
// run and locators (scripts/archive-v3-vectors.py, with its own strict
// decoders), one of its runs carrying contract-event-v9.json's election-registry
// sequence, so no expected value here comes from the code under test (T-31,
// T-17, T-52).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const U64_MAX = (1n << 64n) - 1n;

interface RunRefJson {
  readonly contract: string;
  readonly first: string;
  readonly count: number;
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
  readonly evidence: readonly {
    readonly contract: string;
    readonly l2Block: string;
    readonly cid: string;
    readonly transaction: string;
  }[];
  readonly runs: readonly RunRefJson[];
}

interface RunJson {
  readonly l2ChainId: string;
  readonly contract: string;
  readonly first: string;
  readonly events: readonly {
    readonly l2Block: string;
    readonly l2Timestamp: string;
    readonly topics: readonly string[];
    readonly data: string;
  }[];
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
    readonly maxRuns: number;
  };
  readonly run: {
    readonly recordType: string;
    readonly version: number;
    readonly maxEvents: number;
    readonly maxLength: number;
    readonly recordsVersion: 9;
  };
  readonly locatorLength: number;
  readonly runs: readonly {
    readonly id: string;
    readonly length: number;
    readonly cid: string;
    readonly fields?: RunJson;
    readonly encoding?: string;
    readonly records?: readonly string[];
    readonly recipe?: "max-events" | "max-length";
    readonly sha256?: string;
  }[];
  readonly runDecode: readonly Rejection[];
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

interface EventVectors {
  readonly chainId: string;
  readonly contracts: Readonly<Record<string, string>>;
  readonly sequences: readonly {
    readonly role: string;
    readonly records: readonly string[];
    readonly accumulators: readonly string[];
    readonly count: number;
  }[];
}

const file = JSON.parse(readFileSync(new URL("archive-v3.json", SPEC_VECTORS), "utf8")) as Vectors;
const events = JSON.parse(
  readFileSync(new URL("contract-event-v9.json", SPEC_VECTORS), "utf8"),
) as EventVectors;

function manifest(j: ManifestJson): ArchiveManifestV3 {
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
    runs: j.runs.map((r) => ({
      contract: hex(r.contract),
      first: BigInt(r.first),
      count: r.count,
      cid: hex(r.cid),
      transaction: hex(r.transaction),
    })),
  };
}

function run(j: RunJson): ContractEventRun {
  return {
    l2_chain_id: BigInt(j.l2ChainId),
    contract: hex(j.contract),
    first: BigInt(j.first),
    events: j.events.map((e) => ({
      l2_block: BigInt(e.l2Block),
      l2_timestamp: BigInt(e.l2Timestamp),
      topics: e.topics.map(hex),
      data: hex(e.data),
    })),
  };
}

const label32 = (label: string) => new Uint8Array(sha256(`archive/${label}`));
const prefixed = (codec: number, digest: Uint8Array) =>
  Uint8Array.from([0x01, codec, 0x12, 0x20, ...digest]);
const ref = (contract: Uint8Array, first: bigint, count: number, label: string): RunRef => ({
  contract,
  first,
  count,
  cid: prefixed(0x55, label32(`run/${label}`)),
  transaction: label32(`tx/run/${label}`),
});

// The order the spec gives run references: contract, first index, CID.
function byRun(a: RunRef, b: RunRef): number {
  return (
    Buffer.compare(a.contract, b.contract) ||
    (a.first < b.first ? -1 : a.first > b.first ? 1 : 0) ||
    Buffer.compare(a.cid, b.cid)
  );
}

// archive-v2.json's rules: "full", which archive-v3.json's "full" extends.
function fullManifest(): ArchiveManifestV3 {
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
  const evidence = Array.from({ length: MAX_MANIFEST_EVIDENCE }, (_, i) => ({
    contract: contracts[i % 4] as Uint8Array,
    l2_block: BigInt(Math.floor(i / 4)),
    cid: prefixed(0x55, label32(`evidence/full-${i}`)),
    transaction: label32(`tx/evidence/full-${i}`),
  })).sort(
    (a, b) =>
      Buffer.compare(a.contract, b.contract) ||
      (a.l2_block < b.l2_block ? -1 : a.l2_block > b.l2_block ? 1 : 0) ||
      Buffer.compare(a.cid, b.cid),
  );
  const runs = Array.from({ length: MAX_MANIFEST_RUNS }, (_, i) =>
    ref(contracts[i % 4] as Uint8Array, BigInt(1000 * Math.floor(i / 4)), 1000, `full-${i}`),
  ).sort(byRun);
  return {
    l1_chain_id: 11155111n,
    anchor: hex("5fbdb2315678afecb367f032d93f642f64180aa3"),
    sequence: BigInt(MAX_MANIFEST_LINKS),
    objects,
    links,
    evidence,
    runs,
  };
}

// archive-v3.json's rules: "max-events" and "max-length".
function maxEventsRun(): ContractEventRun {
  return {
    l2_chain_id: 84532n,
    contract: label32("max-events").subarray(0, 20),
    first: 0n,
    events: Array.from({ length: MAX_RUN_EVENTS }, (_, i) => ({
      l2_block: BigInt(i),
      l2_timestamp: BigInt(i),
      topics: [],
      data: new Uint8Array(0),
    })),
  };
}

function maxLengthRun(): ContractEventRun {
  const head = 3 + 8 + 20 + 8 + 4;
  const each = 8 + 8 + 4 + 32 + 4;
  const last = MAX_CONTRACT_EVENT_RUN - head - 16 * each - 15 * MAX_EVENT_DATA;
  return {
    l2_chain_id: 84532n,
    contract: label32("max-length").subarray(0, 20),
    first: 7n,
    events: Array.from({ length: 16 }, (_, i) => ({
      l2_block: BigInt(i),
      l2_timestamp: BigInt(1000 + i),
      topics: [label32(`topic/${i}`)],
      data: new Uint8Array(i < 15 ? MAX_EVENT_DATA : last).fill(i),
    })),
  };
}

const recipes = { "max-events": maxEventsRun, "max-length": maxLengthRun };

function decodeError(f: () => unknown): { code: string; offset: number } | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return { code: e.code, offset: e.offset };
    throw e;
  }
  return undefined;
}

describe("archive-v3.json", () => {
  test("format, record types and limits match the code", () => {
    expect(file.format).toBe("abolish-archive-vectors/3");
    expect(Number(file.manifest.recordType)).toBe(RECORD_TYPES.archiveManifest);
    expect(file.manifest.version).toBe(3);
    expect(file.manifest.maxRuns).toBe(MAX_MANIFEST_RUNS);
    expect(Number(file.run.recordType)).toBe(RECORD_TYPES.contractEventRun);
    expect(RECORD_TYPES.contractEventRun).toBe(0x0026);
    expect(file.run.version).toBe(1);
    expect(file.run.maxEvents).toBe(MAX_RUN_EVENTS);
    expect(file.run.maxLength).toBe(MAX_CONTRACT_EVENT_RUN);
    expect(file.locatorLength).toBe(LOCATOR_V1_LENGTH);
  });

  // The recipes' runs are up to 16 MiB: compared by their encodings' digests,
  // which a deep comparison of every byte array would take minutes over.
  test.each(file.runs)("run $id encodes, decodes and has its CID", { timeout: 30_000 }, (v) => {
    const r = v.recipe === undefined ? run(v.fields as RunJson) : recipes[v.recipe]();
    const encoding = encodeContractEventRun(r);
    expect(encoding.length).toBe(v.length);
    if (v.encoding !== undefined) expect(toHex(encoding)).toBe(v.encoding);
    else expect(toHex(sha256(encoding))).toBe(v.sha256);
    const back = decodeContractEventRun(encoding, 1);
    if (v.recipe === undefined) expect(back).toEqual(r);
    else expect(toHex(sha256(encodeContractEventRun(back)))).toBe(v.sha256);
    // A run past one chunk is a dag-pb object, and reads back from its CAR within the bound.
    expect(toHex(objectCid(encoding))).toBe(v.cid);
    if (v.recipe !== undefined) {
      const read = readArchivedObject(objectCar(encoding), hex(v.cid), MAX_CONTRACT_EVENT_RUN);
      expect(read.ok && read.bytes.length).toBe(v.length);
    }
    if (v.records !== undefined)
      expect(
        contractEventRunRecords(r).map((x) =>
          toHex(encodeContractEvent(x, file.run.recordsVersion)),
        ),
      ).toEqual(v.records);
  });

  test("the election-registry run's events are contract-event-v9.json's records and replay to its accumulators", () => {
    const v = file.runs.find((x) => x.id === "election-registry-sequence");
    const r = run(v?.fields as RunJson);
    const seq = events.sequences.find((s) => s.role === "election-registry");
    if (seq === undefined) throw new Error("no election-registry sequence");
    const records = contractEventRunRecords(r);
    // Each framed record decodes strictly under version 9 to itself.
    for (const x of records) expect(decodeContractEvent(encodeContractEvent(x, 9), 9)).toEqual(x);
    expect(r.l2_chain_id).toBe(BigInt(events.chainId));
    expect(toHex(r.contract)).toBe(events.contracts["election-registry"]);
    for (const [i, acc] of seq.accumulators.entries())
      expect(
        toHex(
          replayEventAccumulator(
            r.l2_chain_id,
            r.contract,
            records.slice(0, i + 1).map(contractEventLog),
          ).accumulator,
        ),
      ).toBe(acc);
    const last = records.at(-1);
    if (last === undefined) throw new Error("empty run");
    expect(
      checkEventAccumulatorProof(r.l2_chain_id, r.contract, records.map(contractEventLog), {
        block: last.l2_block,
        count: BigInt(seq.count),
        accumulator: hex(seq.accumulators.at(-1) as string),
      }),
    ).toBeNull();
  });

  test("the blocks-decreasing run decodes, and the replay's order rule refuses it", () => {
    const r = run(file.runs.find((x) => x.id === "blocks-decreasing")?.fields as RunJson);
    const logs = contractEventRunRecords(r).map(contractEventLog);
    const state = replayEventAccumulator(r.l2_chain_id, r.contract, logs);
    expect(
      checkEventAccumulatorProof(r.l2_chain_id, r.contract, logs, { ...state, block: 9n }),
    ).toBe("order");
  });

  test.each(file.runDecode)("rejects run $id with its code at its offset", (v) => {
    expect(decodeError(() => decodeContractEventRun(hex(v.encoding), 1))).toEqual({
      code: v.code,
      offset: v.offset,
    });
  });

  test.each(file.manifests)("version-3 manifest $id encodes, decodes and has its CID", (v) => {
    const m = v.recipe === "full" ? fullManifest() : manifest(v.fields as ManifestJson);
    const encoding = encodeArchiveManifest(m, 3);
    expect(encoding.length).toBe(v.length);
    if (v.encoding !== undefined) expect(toHex(encoding)).toBe(v.encoding);
    else expect(toHex(sha256(encoding))).toBe(v.sha256);
    expect(decodeArchiveManifest(encoding, 3)).toEqual(m);
    expect(encoding.length).toBeLessThanOrEqual(MANIFEST_BOUND);
    expect(toHex(objectCid(encoding))).toBe(v.cid);
  });

  test("the runs-only manifest names three of the file's runs by their CIDs", () => {
    const listed = manifest(
      file.manifests.find((v) => v.id === "runs-only")?.fields as ManifestJson,
    ).runs;
    const byCid = new Map(file.runs.map((v) => [v.cid, v]));
    expect(listed).toHaveLength(3);
    for (const x of listed) {
      const v = byCid.get(toHex(x.cid));
      if (v === undefined) throw new Error(`no run ${toHex(x.cid)}`);
      const r = v.recipe === undefined ? run(v.fields as RunJson) : recipes[v.recipe]();
      // The reference's claims are the run's own.
      expect([toHex(x.contract), x.first, x.count]).toEqual([
        toHex(r.contract),
        r.first,
        r.events.length,
      ]);
    }
  });

  test.each(file.manifestDecode)("rejects manifest $id with its code at its offset", (v) => {
    expect(decodeError(() => decodeArchiveManifest(hex(v.encoding), 3))).toEqual({
      code: v.code,
      offset: v.offset,
    });
  });

  test.each(file.locators)("locator $id reads as a reader knowing versions 1 to 3", (v) => {
    const read = decodeArchiveLocator(hex(v.locator), [1, 2, 3]);
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

  test("a reader knowing versions 1 and 2 reports a version-3 locator as unknown", () => {
    // packages/verifier reads with [1, 2] until it reads runs (P4-3 part 3b-3c-2b).
    const v3 = file.locators.find((v) => v.id === "v3");
    expect(decodeArchiveLocator(hex(v3?.locator as string), [1, 2])).toEqual({
      kind: "locator-version",
      version: 3,
    });
    expect(decodeArchiveLocator(hex(v3?.locator as string))).toEqual({
      kind: "locator-version",
      version: 3,
    });
  });

  test("a version-3 manifest under version 2's pin, and the reverse, is profile-mismatch", () => {
    const m = manifest(file.manifests.find((v) => v.id === "period")?.fields as ManifestJson);
    expect(decodeError(() => decodeArchiveManifest(encodeArchiveManifest(m, 3), 2))).toEqual({
      code: "profile-mismatch",
      offset: 2,
    });
    const { runs: _, ...v2 } = m;
    expect(decodeError(() => decodeArchiveManifest(encodeArchiveManifest(v2, 2), 3))).toEqual({
      code: "profile-mismatch",
      offset: 2,
    });
  });
});

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });
const anyCid = fc
  .tuple(fc.constantFrom(0x55, 0x70), bytes(32))
  .map(([codec, d]) => prefixed(codec, d));

const runRefArb = fc
  .record({
    // A few contracts and indices, so references often share both and order by CID.
    contract: fc.constantFrom(...[0, 1, 2].map((c) => label32(`contract/${c}`).subarray(0, 20))),
    first: fc.oneof(fc.bigInt({ min: 0n, max: 3n }), fc.bigInt({ min: 0n, max: U64_MAX })),
    count: fc.integer({ min: 1, max: MAX_RUN_EVENTS }),
    cid: anyCid,
    transaction: bytes(32),
  })
  .filter((r) => r.first + BigInt(r.count) <= 1n << 64n);

const manifestArb: fc.Arbitrary<ArchiveManifestV3> = fc
  .record({
    l1_chain_id: fc.bigInt({ min: 0n, max: U64_MAX }),
    anchor: bytes(20),
    sequence: fc.bigInt({ min: 1n, max: U64_MAX }),
    objects: fc.constant([]),
    links: fc.constant([]),
    evidence: fc.constant([]),
    runs: fc.uniqueArray(runRefArb, {
      minLength: 1,
      maxLength: 6,
      selector: (r) => `${toHex(r.contract)}/${r.first}/${toHex(r.cid)}`,
    }),
  })
  .map((m) => ({ ...m, runs: [...m.runs].sort(byRun) }));

const eventArb: fc.Arbitrary<RunEvent> = fc.record({
  l2_block: fc.bigInt({ min: 0n, max: U64_MAX }),
  l2_timestamp: fc.bigInt({ min: 0n, max: U64_MAX }),
  topics: fc.array(bytes(32), { maxLength: 4 }),
  data: fc.uint8Array({ maxLength: 40 }),
});

const runArb: fc.Arbitrary<ContractEventRun> = fc
  .record({
    l2_chain_id: fc.bigInt({ min: 0n, max: U64_MAX }),
    contract: bytes(20),
    first: fc.oneof(
      fc.bigInt({ min: 0n, max: 5n }),
      fc.bigInt({ min: U64_MAX - 5n, max: U64_MAX }),
    ),
    events: fc.array(eventArb, { minLength: 1, maxLength: 6 }),
  })
  .filter((r) => r.first + BigInt(r.events.length) <= 1n << 64n);

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

describe("version-3 manifest properties", () => {
  test("decode(encode(m)) = m and encode(decode(b)) = b", () => {
    fc.assert(
      fc.property(manifestArb, (m) => {
        const b = encodeArchiveManifest(m, 3);
        const back = decodeArchiveManifest(b, 3);
        expect(back).toEqual(m);
        expect(encodeArchiveManifest(back, 3)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("any changed byte either fails to decode or re-encodes to exactly itself", () => {
    flips(
      manifestArb,
      (m) => encodeArchiveManifest(m, 3),
      (b) => decodeArchiveManifest(b, 3),
    );
  });

  test("the encoder refuses what the decoder would reject", () => {
    const m = manifest(file.manifests.find((v) => v.id === "period")?.fields as ManifestJson);
    const refuse = (value: ArchiveManifestV3) =>
      expect(() => encodeArchiveManifest(value, 3)).toThrow(EncodeError);
    const first = m.runs[0] as RunRef;
    refuse({ ...m, objects: [], links: [], evidence: [], runs: [] });
    refuse({ ...m, runs: [...m.runs].reverse() });
    refuse({ ...m, runs: [first, ...m.runs] });
    refuse({ ...m, runs: [{ ...first, count: 0 }] });
    refuse({ ...m, runs: [{ ...first, count: MAX_RUN_EVENTS + 1 }] });
    refuse({ ...m, runs: [{ ...first, count: 1.5 }] });
    refuse({ ...m, runs: [{ ...first, first: U64_MAX, count: 2 }] });
    refuse({ ...m, runs: [{ ...first, cid: prefixed(0x71, new Uint8Array(32)) }] });
    refuse({ ...m, runs: [{ ...first, contract: new Uint8Array(19) }] });
    refuse({
      ...m,
      runs: Array.from({ length: MAX_MANIFEST_RUNS + 1 }, (_, i) =>
        ref(first.contract, BigInt(i), 1, `over-${i}`),
      ),
    });
    // Version 2's rules hold under version 3.
    refuse({ ...m, evidence: [...m.evidence].reverse() });
    refuse({ ...m, objects: [...m.objects].reverse() });
    // An earlier version never drops a version-3 value's runs.
    expect(() => encodeArchiveManifest(m, 2)).toThrow(EncodeError);
    const noEvidence: ArchiveManifestV3 = { ...m, evidence: [] };
    expect(() => encodeArchiveManifest(noEvidence)).toThrow(EncodeError);
    expect(() => encodeArchiveManifest(m, 4 as 3)).toThrow(EncodeError);
    // The last index, and a manifest of runs alone, are well formed.
    const alone = {
      ...m,
      objects: [],
      links: [],
      evidence: [],
      runs: [{ ...first, first: U64_MAX, count: 1 }],
    };
    expect(decodeArchiveManifest(encodeArchiveManifest(alone, 3), 3)).toEqual(alone);
  });
});

describe("contract-event run properties", () => {
  test("decode(encode(r)) = r and encode(decode(b)) = b", () => {
    fc.assert(
      fc.property(runArb, (r) => {
        const b = encodeContractEventRun(r);
        const back = decodeContractEventRun(b, 1);
        expect(back).toEqual(r);
        expect(encodeContractEventRun(back)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("any changed byte either fails to decode or re-encodes to exactly itself", () => {
    flips(runArb, encodeContractEventRun, (b) => decodeContractEventRun(b, 1));
  });

  test("event i is the record at first + i, whatever version frames it", () => {
    fc.assert(
      fc.property(runArb, fc.integer({ min: 1, max: 9 }), (r, version) => {
        const records = contractEventRunRecords(r);
        expect(records).toHaveLength(r.events.length);
        for (const [i, x] of records.entries()) {
          const e = r.events[i] as RunEvent;
          expect(x).toEqual({ contract: r.contract, n: r.first + BigInt(i), ...e });
          const v = version as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
          expect(decodeContractEvent(encodeContractEvent(x, v), v)).toEqual(x);
        }
      }),
      { numRuns },
    );
  });

  test("the encoder refuses what the decoder would reject, and a run past 2^24 bytes", () => {
    const r = run(file.runs.find((v) => v.id === "one-event")?.fields as RunJson);
    const refuse = (value: ContractEventRun) =>
      expect(() => encodeContractEventRun(value)).toThrow(EncodeError);
    const e = r.events[0] as RunEvent;
    refuse({ ...r, events: [] });
    refuse({ ...r, first: U64_MAX, events: [e, e] });
    refuse({
      ...r,
      events: [{ ...e, topics: [...e.topics, ...e.topics, e.topics[0] as Uint8Array] }],
    });
    refuse({ ...r, events: [{ ...e, data: new Uint8Array(MAX_EVENT_DATA + 1) }] });
    refuse({ ...r, events: [{ ...e, topics: [new Uint8Array(31)] }] });
    refuse({ ...r, contract: new Uint8Array(21) });
    const max = maxLengthRun();
    const last = max.events.at(-1) as RunEvent;
    refuse({
      ...max,
      events: [...max.events.slice(0, -1), { ...last, data: new Uint8Array(last.data.length + 1) }],
    });
    // A run is only decoded under version 1, the one version 3 lists.
    expect(() => decodeContractEventRun(encodeContractEventRun(r), 2 as 1)).toThrow(RangeError);
  });
});

describe("argument checks", () => {
  test("locators of versions 1 to 3 only, and the reader's known versions only those", () => {
    const cid = prefixed(0x55, new Uint8Array(32));
    expect(encodeArchiveLocator(cid, new Uint8Array(32), 3).length).toBe(LOCATOR_V1_LENGTH);
    expect(() => encodeArchiveLocator(cid, new Uint8Array(32), 4 as 3)).toThrow(EncodeError);
    expect(() => decodeArchiveLocator(new Uint8Array(70), [4 as 3])).toThrow(TypeError);
  });
});
