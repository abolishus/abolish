import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  checkContractEvent,
  checkEventAccumulatorProof,
  CONTRACT_EVENT_SIGNATURES,
  type ContractEvent,
  contractEventLog,
  type ContractEventRecord,
  type ContractEventVersion,
  decode,
  element,
  type ContractRole,
  DecodeError,
  decodeContractEvent,
  encodeContractEvent,
  EncodeError,
  type EventContracts,
  MAX_EVENT_DATA,
  MAX_EVENT_TOPICS,
  replayEventAccumulator,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/contract-event.json (version 1), contract-event-v2.json
// (version 2) and contract-event-v3.json (version 3) come from independent
// Python implementations of docs/spec/contracts.md, Contract-event record
// (scripts/contract-event-vectors.py, with its own Keccak-256, ABI reader,
// SEC 1 decompression and accumulator, scripts/contract-event-v2-vectors.py,
// with its own BN254 point checks and the board's framing, and
// scripts/contract-event-v3-vectors.py, with its own close-statement
// decoding), so the bytes,
// verdicts and accumulators here never come from the code under test (T-17,
// T-31, T-71).

interface VectorFields {
  readonly contract: string;
  readonly n: string;
  readonly l2Block: string;
  readonly l2Timestamp: string;
  readonly topics: readonly string[];
  readonly data: string;
}

interface VectorRecord {
  readonly id: string;
  readonly fields: VectorFields;
  readonly encoding: string;
  readonly role?: ContractRole;
  readonly event?: unknown;
  readonly error?: string;
}

interface Vectors {
  readonly format: string;
  readonly recordType: string;
  readonly version: number;
  readonly maxEventData: number;
  readonly maxEventTopics: number;
  readonly chainId: string;
  readonly contracts: Readonly<Record<ContractRole, string>>;
  readonly events: readonly {
    readonly role: ContractRole;
    readonly signature: string;
    readonly indexed: readonly string[];
    readonly topic0: string;
  }[];
  readonly records: readonly VectorRecord[];
  readonly eventFailures: readonly VectorRecord[];
  readonly decodeErrors: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly sequences: readonly {
    readonly role: ContractRole;
    readonly records: readonly string[];
    readonly accumulators: readonly string[];
    readonly count: string;
  }[];
}

const load = (file: string) =>
  JSON.parse(readFileSync(new URL(file, SPEC_VECTORS), "utf8")) as Vectors;

const FILES: Readonly<Record<ContractEventVersion, Vectors>> = {
  1: load("contract-event.json"),
  2: load("contract-event-v2.json"),
  3: load("contract-event-v3.json"),
  4: load("contract-event-v4.json"),
};
const vectors = FILES[1];

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const contractsOf = (v: Vectors): EventContracts => ({
  electionRegistry: hex(v.contracts["election-registry"]),
  trusteeRegistry: hex(v.contracts["trustee-registry"]),
  groupRegistry: hex(v.contracts["group-registry"]),
  board: hex(v.contracts.board),
});
const contracts = contractsOf(vectors);

const recordOf = (f: VectorFields): ContractEventRecord => ({
  contract: hex(f.contract),
  n: BigInt(f.n),
  l2_block: BigInt(f.l2Block),
  l2_timestamp: BigInt(f.l2Timestamp),
  topics: f.topics.map(hex),
  data: hex(f.data),
});

// The decoded event in the vector file's shape: bytes as hex, u64s as
// decimal strings, the embedded records as their bytes.
function project(e: ContractEvent): unknown {
  const origin = (o: { number: bigint; timestamp: bigint; hash: Uint8Array }) => ({
    number: String(o.number),
    timestamp: String(o.timestamp),
    hash: bytesToHex(o.hash),
  });
  switch (e.event) {
    case "ElectionCreated":
      return {
        event: e.event,
        electionId: bytesToHex(e.electionId),
        creator: bytesToHex(e.creator),
        counter: String(e.counter),
        l1Origin: origin(e.l1Origin),
      };
    case "DefinitionRegistered":
      return {
        event: e.event,
        electionId: bytesToHex(e.electionId),
        definitionHash: bytesToHex(e.definitionHash),
        l1Origin: origin(e.l1Origin),
        definition: bytesToHex(e.definition),
      };
    case "PanelPinned":
      return {
        event: e.event,
        panelId: bytesToHex(e.panelId),
        threshold: e.threshold,
        quorum: e.quorum,
        keys: e.keys.map(bytesToHex),
      };
    case "CeremonyRegistered":
      return {
        event: e.event,
        stubHash: bytesToHex(e.stubHash),
        panelId: bytesToHex(e.panelId),
        transcriptHash: bytesToHex(e.transcriptHash),
        registration: bytesToHex(e.registration),
      };
    case "RegistrarsPinned":
      return {
        event: e.event,
        threshold: e.threshold,
        registrars: e.registrars.map(bytesToHex),
      };
    case "GroupCreated":
      return { event: e.event, groupId: String(e.groupId), tier: e.tier };
    case "MembersAdded":
      return {
        event: e.event,
        groupId: String(e.groupId),
        firstIndex: String(e.firstIndex),
        record: bytesToHex(e.record),
      };
    case "MembersRemoved":
      return { event: e.event, groupId: String(e.groupId), record: bytesToHex(e.record) };
    case "BallotSubmitted":
    case "ShareReceiptSubmitted":
    case "SharePosted":
    case "ShareComplaintSubmitted":
      return {
        event: e.event,
        definitionHash: bytesToHex(e.definitionHash),
        ballotHash: bytesToHex(e.ballotHash),
        record: bytesToHex(e.record),
      };
    case "RelayedBallotSubmitted":
      return {
        event: e.event,
        definitionHash: bytesToHex(e.definitionHash),
        ballotHash: bytesToHex(e.ballotHash),
        index: String(e.index),
        l1Block: String(e.l1Block),
        stamp: String(e.stamp),
        gasLimit: String(e.gasLimit),
        record: bytesToHex(e.record),
      };
    case "ShareReceiptBatchSubmitted":
      return {
        event: e.event,
        definitionHash: bytesToHex(e.definitionHash),
        seat: e.seat,
        record: bytesToHex(e.record),
      };
    case "CloseStatementSubmitted":
      return {
        event: e.event,
        definitionHash: bytesToHex(e.definitionHash),
        signer: e.signer,
        record: bytesToHex(e.record),
      };
  }
}

// The test's own ABI encoder (the Solidity ABI specification, as
// `abi.encode` produces it), so a passing record's topics and data can be
// rebuilt from its decoded event alone.
const sigTopic = (signature: string) => keccak_256(new TextEncoder().encode(signature));

function uintWord(v: bigint | number): Uint8Array {
  const w = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0; i--) {
    w[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return w;
}

const leftPad = (b: Uint8Array) => {
  const w = new Uint8Array(32);
  w.set(b, 32 - b.length);
  return w;
};

const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// `bytes` tail: length word, content, zero padding to a word.
const tail = (b: Uint8Array) =>
  concat([uintWord(b.length), b, new Uint8Array((32 - (b.length % 32)) % 32)]);

/** The topics and data `abi.encode` gives for `e` (one dynamic field at most, last). */
function reencode(
  e: ContractEvent,
  version: ContractEventVersion,
): { topics: Uint8Array[]; data: Uint8Array } {
  const dyn = (head: Uint8Array[], body: Uint8Array) =>
    concat([...head, uintWord(32 * (head.length + 1)), body]);
  const origin = (o: { number: bigint; timestamp: bigint; hash: Uint8Array }) => [
    uintWord(o.number),
    uintWord(o.timestamp),
    o.hash,
  ];
  const sig = (name: string) =>
    sigTopic(
      CONTRACT_EVENT_SIGNATURES[version][ROLE_OF[e.event]].find((s) => s.startsWith(`${name}(`)) ??
        "",
    );
  switch (e.event) {
    case "ElectionCreated":
      return {
        topics: [sig(e.event), e.electionId, leftPad(e.creator)],
        data: concat([uintWord(e.counter), ...origin(e.l1Origin)]),
      };
    case "DefinitionRegistered":
      return {
        topics: [sig(e.event), e.electionId, e.definitionHash],
        data: dyn(origin(e.l1Origin), tail(e.definition)),
      };
    case "PanelPinned":
      return {
        topics: [sig(e.event), e.panelId],
        data: dyn([uintWord(e.threshold), uintWord(e.quorum)], tail(concat(e.keys))),
      };
    case "CeremonyRegistered":
      return {
        topics: [sig(e.event), e.stubHash, e.panelId, e.transcriptHash],
        data: dyn([], tail(e.registration)),
      };
    case "RegistrarsPinned":
      return {
        topics: [sig(e.event)],
        data: dyn(
          [uintWord(e.threshold)],
          concat([uintWord(e.registrars.length), ...e.registrars.map(leftPad)]),
        ),
      };
    case "GroupCreated":
      return {
        topics: [sig(e.event), uintWord(e.groupId), uintWord(e.tier)],
        data: new Uint8Array(),
      };
    case "MembersAdded":
      return {
        topics: [sig(e.event), uintWord(e.groupId), uintWord(e.firstIndex)],
        data: dyn([], tail(e.record)),
      };
    case "MembersRemoved":
      return { topics: [sig(e.event), uintWord(e.groupId)], data: dyn([], tail(e.record)) };
    case "BallotSubmitted":
    case "ShareReceiptSubmitted":
    case "SharePosted":
    case "ShareComplaintSubmitted":
      return {
        topics: [sig(e.event), e.definitionHash, e.ballotHash],
        data: dyn([], tail(e.record)),
      };
    case "RelayedBallotSubmitted":
      return {
        topics: [sig(e.event), e.definitionHash, e.ballotHash],
        data: dyn(
          [uintWord(e.index), uintWord(e.l1Block), uintWord(e.stamp), uintWord(e.gasLimit)],
          tail(e.record),
        ),
      };
    case "CloseStatementSubmitted":
      return {
        topics: [sig(e.event), e.definitionHash, uintWord(e.signer)],
        data: dyn([], tail(e.record)),
      };
    case "ShareReceiptBatchSubmitted":
      return {
        topics: [sig(e.event), e.definitionHash, uintWord(e.seat)],
        data: dyn([], tail(e.record)),
      };
  }
}

const ROLE_OF: Readonly<Record<ContractEvent["event"], ContractRole>> = {
  ElectionCreated: "election-registry",
  DefinitionRegistered: "election-registry",
  PanelPinned: "trustee-registry",
  CeremonyRegistered: "trustee-registry",
  RegistrarsPinned: "group-registry",
  GroupCreated: "group-registry",
  MembersAdded: "group-registry",
  MembersRemoved: "group-registry",
  BallotSubmitted: "board",
  ShareReceiptSubmitted: "board",
  SharePosted: "board",
  ShareComplaintSubmitted: "board",
  RelayedBallotSubmitted: "board",
  CloseStatementSubmitted: "board",
  ShareReceiptBatchSubmitted: "board",
};

describe.each([
  [1, "contract-event.json"],
  [2, "contract-event-v2.json"],
  [3, "contract-event-v3.json"],
  [4, "contract-event-v4.json"],
] as const)("contract-event version %i vectors (docs/spec/vectors/%s)", (version, file) => {
  const vectors = FILES[version];
  const contracts = contractsOf(vectors);

  test(`${file} is the contract-event format for record type 0x0008, version ${version}`, () => {
    expect(vectors.format).toBe(`abolish-contract-event-vectors/${version}`);
    expect(vectors.recordType).toBe("0x0008");
    expect(vectors.version).toBe(version);
    expect(vectors.maxEventData).toBe(MAX_EVENT_DATA);
    expect(vectors.maxEventTopics).toBe(MAX_EVENT_TOPICS);
  });

  test("each role's table is the file's, in order, and topic 0 is the signature's keccak-256", () => {
    for (const role of [
      "election-registry",
      "trustee-registry",
      "group-registry",
      "board",
    ] as const)
      expect(CONTRACT_EVENT_SIGNATURES[version][role]).toEqual(
        vectors.events.filter((e) => e.role === role).map((e) => e.signature),
      );
    for (const e of vectors.events)
      expect(bytesToHex(keccak_256(new TextEncoder().encode(e.signature)))).toBe(e.topic0);
  });

  test.each(vectors.records.map((r) => [r.id, r] as const))(
    "%s: encodes, decodes and passes the event check as its contract's event",
    (_id, v) => {
      const record = recordOf(v.fields);
      expect(encodeContractEvent(record, version)).toEqual(hex(v.encoding));
      expect(decodeContractEvent(hex(v.encoding), version)).toEqual(record);
      const result = checkContractEvent(record, contracts, version);
      if (!result.ok) throw new Error(`${v.id}: ${result.error}`);
      expect(result.role).toBe(v.role);
      expect(project(result.event)).toEqual(v.event);
    },
  );

  test.each(vectors.eventFailures.map((r) => [r.id, r] as const))(
    "%s: decodes, and the event check fails with its code",
    (_id, v) => {
      const record = decodeContractEvent(hex(v.encoding), version);
      expect(record).toEqual(recordOf(v.fields));
      expect(checkContractEvent(record, contracts, version)).toEqual({ ok: false, error: v.error });
    },
  );

  test.each(vectors.decodeErrors.map((v) => [v.id, v] as const))(
    "%s: rejected with its code and offset",
    (_id, v) => {
      let error: unknown;
      try {
        decodeContractEvent(hex(v.encoding), version);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe(v.error);
      expect((error as DecodeError).offset).toBe(v.offset);
    },
  );

  test.each(vectors.sequences.map((s) => [s.role, s] as const))(
    "%s: the records replay into the file's accumulators and match a proof of the last",
    (role, s) => {
      const byId = new Map(vectors.records.map((r) => [r.id, r]));
      const records = s.records.map((id) => {
        const v = byId.get(id);
        if (v === undefined) throw new Error(`no record ${id}`);
        return decodeContractEvent(hex(v.encoding), version);
      });
      const chainId = BigInt(vectors.chainId);
      const address = hex(vectors.contracts[role]);
      for (const [i, acc] of s.accumulators.entries()) {
        const state = replayEventAccumulator(
          chainId,
          address,
          records.slice(0, i + 1).map(contractEventLog),
        );
        expect(bytesToHex(state.accumulator)).toBe(acc);
      }
      const last = records.at(-1);
      const accumulator = s.accumulators.at(-1);
      if (last === undefined || accumulator === undefined) throw new Error("empty sequence");
      expect(
        checkEventAccumulatorProof(chainId, address, records.map(contractEventLog), {
          block: last.l2_block,
          count: BigInt(s.count),
          accumulator: hex(accumulator),
        }),
      ).toBeNull();
    },
  );
});

describe("contract-event record properties", () => {
  const byte32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
  const u64 = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });
  const record = fc.record({
    contract: fc.uint8Array({ minLength: 20, maxLength: 20 }),
    n: u64,
    l2_block: u64,
    l2_timestamp: u64,
    topics: fc.array(byte32, { maxLength: MAX_EVENT_TOPICS }),
    data: fc.uint8Array({ maxLength: 300 }),
  });

  test("decode(encode(x)) = x", () => {
    fc.assert(
      fc.property(record, (r) => {
        expect(decodeContractEvent(encodeContractEvent(r, 1), 1)).toEqual(r);
      }),
      { numRuns },
    );
  });

  test("random bytes are rejected or re-encode to themselves", () => {
    const honest = hex(vectors.records[0]?.encoding ?? "");
    const mutated = fc
      .tuple(fc.nat({ max: honest.length - 1 }), fc.integer({ min: 0, max: 255 }), fc.nat(8))
      .map(([at, value, cut]) => {
        const b = honest.slice(0, honest.length - cut);
        if (at < b.length) b[at] = value;
        return b;
      });
    fc.assert(
      fc.property(fc.oneof(mutated, fc.uint8Array({ maxLength: 200 })), (b) => {
        let decoded: ContractEventRecord;
        try {
          decoded = decodeContractEvent(b, 1);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          return;
        }
        expect(encodeContractEvent(decoded, 1)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("refuses to encode what it can't decode: five topics, data over the maximum", () => {
    const base = recordOf(vectors.records[0]?.fields ?? ({} as VectorFields));
    const topic = new Uint8Array(32);
    expect(() =>
      encodeContractEvent({ ...base, topics: [topic, topic, topic, topic, topic] }, 1),
    ).toThrow(EncodeError);
    expect(() =>
      encodeContractEvent({ ...base, data: new Uint8Array(MAX_EVENT_DATA + 1) }, 1),
    ).toThrow(EncodeError);
  });

  // One event, one encoding: every record that passes is exactly the
  // re-encoding of its decoded event, so no field carries bytes its event
  // doesn't define and no event has a second record (T-17, T-31). Mutations
  // flip, drop, insert and append bytes, and add or remove topics.
  test.each([1, 2, 3, 4] as const)(
    "version %i: every passing record's topics and data are those rebuilt from its decoded event",
    (version) => {
      const contracts = contractsOf(FILES[version]);
      const honest = FILES[version].records.map((v) => recordOf(v.fields));
      const mutate = fc.tuple(
        fc.nat({ max: honest.length - 1 }),
        fc.constantFrom("flip", "drop", "insert", "append", "add-topic", "drop-topic"),
        fc.nat(),
        fc.integer({ min: 0, max: 255 }),
      );
      fc.assert(
        fc.property(mutate, ([which, how, at, value]) => {
          const r = honest[which];
          if (r === undefined) throw new Error("no record");
          const d = r.data;
          const i = d.length === 0 ? 0 : at % d.length;
          const data =
            how === "flip" && d.length > 0
              ? d.map((x, j) => (j === i ? x ^ (value | 1) : x))
              : how === "drop" && d.length > 0
                ? concat([d.subarray(0, i), d.subarray(i + 1)])
                : how === "insert"
                  ? concat([d.subarray(0, i), new Uint8Array([value]), d.subarray(i)])
                  : how === "append"
                    ? concat([d, new Uint8Array([value])])
                    : d;
          const topics =
            how === "add-topic"
              ? [...r.topics, uintWord(value)]
              : how === "drop-topic"
                ? r.topics.slice(0, -1)
                : r.topics;
          for (const candidate of [r, { ...r, topics, data }]) {
            const result = checkContractEvent(candidate, contracts, version);
            if (!result.ok) continue;
            const rebuilt = reencode(result.event, version);
            // Compared as hex: the largest records are 25 KB.
            expect(rebuilt.topics.map(bytesToHex)).toEqual(candidate.topics.map(bytesToHex));
            expect(bytesToHex(rebuilt.data)).toBe(bytesToHex(candidate.data));
          }
        }),
        { numRuns },
      );
    },
    120_000,
  );

  test("a record of another role's address never passes as that role's", () => {
    const created = vectors.records.find((v) => v.id === "election-created");
    if (created === undefined) throw new Error("no election-created record");
    const r = recordOf(created.fields);
    for (const contract of [contracts.trusteeRegistry, contracts.groupRegistry, contracts.board])
      expect(checkContractEvent({ ...r, contract }, contracts, 1)).toEqual({
        ok: false,
        error: "unknown-event",
      });
  });
});

describe("contract-event version 2 against version 1", () => {
  const v2 = contractsOf(FILES[2]);

  // Version 2's tables extend version 1's: every event it keeps is checked
  // exactly as version 1 checks it, so an election moving to version 2 reads
  // the registries' unchanged events the same way.
  test("every version-1 vector of an event version 2 keeps has the same verdict under version 2", () => {
    const kept = (v: VectorRecord) => {
      const topic0 = v.fields.topics[0];
      const changed = ["CeremonyRegistered", "DefinitionRegistered"].map((n) =>
        bytesToHex(
          sigTopic(
            CONTRACT_EVENT_SIGNATURES[1][ROLE_OF[n as ContractEvent["event"]]].find((s) =>
              s.startsWith(`${n}(`),
            ) ?? "",
          ),
        ),
      );
      return topic0 === undefined || !changed.includes(topic0);
    };
    const all = [...FILES[1].records, ...FILES[1].eventFailures].filter(kept);
    expect(all.length).toBeGreaterThan(30);
    for (const v of all) {
      const record = { ...recordOf(v.fields), contract: v2Address(v.fields.contract) };
      const result = checkContractEvent(record, v2, 2);
      expect(result.ok ? project(result.event) : result).toEqual(
        v.error === undefined ? v.event : { ok: false, error: v.error },
      );
    }
  });

  // Each version-1 definition that version 1's check reads is one version 2 reads too.
  test("every DefinitionRegistered record version 1 passes, version 2 passes", () => {
    for (const v of FILES[1].records.filter(
      (r) => (r.event as { event?: string }).event === "DefinitionRegistered",
    )) {
      const record = { ...recordOf(v.fields), contract: v2.electionRegistry };
      const result = checkContractEvent(record, v2, 2);
      if (!result.ok) throw new Error(`${v.id}: ${result.error}`);
      expect(result.event.event === "DefinitionRegistered" && result.event.decoded.version).toBe(1);
    }
  });

  // The board frames elements, never decodes them (T-53): these vectors'
  // elements aren't ristretto255 points, and their events still pass.
  test("the framed elements of the not-a-point vectors aren't points", () => {
    const ids = ["ballot-element-not-a-point", "share-posting-dh-not-a-point"];
    for (const id of ids) {
      const v = FILES[2].records.find((r) => r.id === id);
      if (v === undefined) throw new Error(`no record ${id}`);
      const result = checkContractEvent(recordOf(v.fields), v2, 2);
      if (!result.ok || !("record" in result.event)) throw new Error(`${id} doesn't pass`);
      const record = result.event.record;
      const at = id.startsWith("ballot") ? 364 + 8 : 3 + 32 + 32 + 1 + 32 + 1088;
      expect(() => decode(element, record.subarray(at, at + 32))).toThrow(DecodeError);
    }
  });
});

describe("contract-event version 3 against version 2", () => {
  const v3 = contractsOf(FILES[3]);

  // Version 3 keeps every row of version 2 unchanged, so an election moving
  // to version 3 reads every event version 2 reads the same way, and adds
  // only the board's two close-rule events.
  test("every version-2 vector has the same verdict under version 3", () => {
    const all = [...FILES[2].records, ...FILES[2].eventFailures];
    expect(all.length).toBeGreaterThan(60);
    for (const v of all) {
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, 2, 3) };
      const result = checkContractEvent(record, v3, 3);
      expect(result.ok ? project(result.event) : result).toEqual(
        v.error === undefined ? v.event : { ok: false, error: v.error },
      );
    }
  });

  test("version 2 names neither close-rule event, so it refuses each as unknown-event", () => {
    const v2 = contractsOf(FILES[2]);
    const added = FILES[3].records.filter((r) =>
      ["RelayedBallotSubmitted", "CloseStatementSubmitted"].includes(
        (r.event as { event?: string }).event ?? "",
      ),
    );
    expect(added.length).toBeGreaterThan(5);
    for (const v of added) {
      const record = { ...recordOf(v.fields), contract: v2.board };
      expect(checkContractEvent(record, v2, 2)).toEqual({ ok: false, error: "unknown-event" });
    }
  });
});

describe("contract-event version 4 against version 3", () => {
  const v4 = contractsOf(FILES[4]);

  // Version 4 keeps every row of version 3 unchanged, and adds only the
  // board's share-receipt batch event.
  test("every version-3 vector has the same verdict under version 4", () => {
    const all = [...FILES[3].records, ...FILES[3].eventFailures];
    expect(all.length).toBeGreaterThan(40);
    for (const v of all) {
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, 3, 4) };
      const result = checkContractEvent(record, v4, 4);
      expect(result.ok ? project(result.event) : result).toEqual(
        v.error === undefined ? v.event : { ok: false, error: v.error },
      );
    }
  });

  test("version 3 names no batch event, so it refuses each as unknown-event", () => {
    const v3 = contractsOf(FILES[3]);
    const added = FILES[4].records.filter(
      (r) => (r.event as { event?: string }).event === "ShareReceiptBatchSubmitted",
    );
    expect(added.map((r) => r.id)).toEqual(
      (FILES[4] as Vectors & { unknownUnderVersion3: string[] }).unknownUnderVersion3,
    );
    expect(added.length).toBe(3);
    for (const v of added) {
      const record = { ...recordOf(v.fields), contract: v3.board };
      expect(checkContractEvent(record, v3, 3)).toEqual({ ok: false, error: "unknown-event" });
    }
  });
});

// One file's addresses, mapped by role to another's.
function mapAddress(
  contract: string,
  from: ContractEventVersion,
  to: ContractEventVersion,
): Uint8Array {
  const role = (Object.keys(FILES[from].contracts) as ContractRole[]).find(
    (r) => FILES[from].contracts[r] === contract,
  );
  return hex(role === undefined ? contract : FILES[to].contracts[role]);
}

const v2Address = (contract: string) => mapAddress(contract, 1, 2);
