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

// docs/spec/vectors/contract-event.json comes from an independent Python
// implementation of docs/spec/contracts.md, Contract-event record
// (scripts/contract-event-vectors.py, with its own Keccak-256, ABI reader,
// SEC 1 decompression and accumulator), so the bytes, verdicts and
// accumulators here never come from the code under test (T-17, T-31, T-71).

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

const vectors = JSON.parse(
  readFileSync(new URL("contract-event.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const contracts: EventContracts = {
  electionRegistry: hex(vectors.contracts["election-registry"]),
  trusteeRegistry: hex(vectors.contracts["trustee-registry"]),
  groupRegistry: hex(vectors.contracts["group-registry"]),
  board: hex(vectors.contracts.board),
};

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
  }
}

describe("contract-event vectors (docs/spec/vectors/contract-event.json)", () => {
  test("the file is the contract-event format for record type 0x0008, version 1", () => {
    expect(vectors.format).toBe("abolish-contract-event-vectors/1");
    expect(vectors.recordType).toBe("0x0008");
    expect(vectors.version).toBe(1);
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
      expect(CONTRACT_EVENT_SIGNATURES[role]).toEqual(
        vectors.events.filter((e) => e.role === role).map((e) => e.signature),
      );
    for (const e of vectors.events)
      expect(bytesToHex(keccak_256(new TextEncoder().encode(e.signature)))).toBe(e.topic0);
  });

  test.each(vectors.records.map((r) => [r.id, r] as const))(
    "%s: encodes, decodes and passes the event check as its contract's event",
    (_id, v) => {
      const record = recordOf(v.fields);
      expect(encodeContractEvent(record)).toEqual(hex(v.encoding));
      expect(decodeContractEvent(hex(v.encoding), 1)).toEqual(record);
      const result = checkContractEvent(record, contracts);
      if (!result.ok) throw new Error(`${v.id}: ${result.error}`);
      expect(result.role).toBe(v.role);
      expect(project(result.event)).toEqual(v.event);
    },
  );

  test.each(vectors.eventFailures.map((r) => [r.id, r] as const))(
    "%s: decodes, and the event check fails with its code",
    (_id, v) => {
      const record = decodeContractEvent(hex(v.encoding), 1);
      expect(record).toEqual(recordOf(v.fields));
      expect(checkContractEvent(record, contracts)).toEqual({ ok: false, error: v.error });
    },
  );

  test.each(vectors.decodeErrors.map((v) => [v.id, v] as const))(
    "%s: rejected with its code and offset",
    (_id, v) => {
      let error: unknown;
      try {
        decodeContractEvent(hex(v.encoding), 1);
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
        return decodeContractEvent(hex(v.encoding), 1);
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
        expect(decodeContractEvent(encodeContractEvent(r), 1)).toEqual(r);
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
        expect(encodeContractEvent(decoded)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("refuses to encode what it can't decode: five topics, data over the maximum", () => {
    const base = recordOf(vectors.records[0]?.fields ?? ({} as VectorFields));
    const topic = new Uint8Array(32);
    expect(() =>
      encodeContractEvent({ ...base, topics: [topic, topic, topic, topic, topic] }),
    ).toThrow(EncodeError);
    expect(() =>
      encodeContractEvent({ ...base, data: new Uint8Array(MAX_EVENT_DATA + 1) }),
    ).toThrow(EncodeError);
  });

  // One event, one encoding: changing any byte of an honest record's topics
  // or data either fails the event check or changes the decoded event, so
  // no field carries bytes its event doesn't define (T-17, T-31).
  test("every change to an honest event's topics or data is refused or decodes differently", () => {
    const honest = vectors.records.map((v) => recordOf(v.fields));
    fc.assert(
      fc.property(
        fc.nat({ max: honest.length - 1 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (which, at, xor) => {
          const r = honest[which];
          if (r === undefined) throw new Error("no record");
          const before = checkContractEvent(r, contracts);
          if (!before.ok) throw new Error("an honest record failed");
          const bytes = [...r.topics.slice(1), r.data];
          const total = bytes.reduce((s, b) => s + b.length, 0);
          if (total === 0) return;
          let k = at % total;
          const changed = bytes.map((b) => {
            const c = b.slice();
            if (k >= 0 && k < c.length) c[k] = (c[k] ?? 0) ^ xor;
            k -= b.length;
            return c;
          });
          const data = changed.pop() ?? new Uint8Array();
          const topic0 = r.topics[0];
          if (topic0 === undefined) throw new Error("no topic 0");
          const after = checkContractEvent({ ...r, topics: [topic0, ...changed], data }, contracts);
          if (after.ok) expect(project(after.event)).not.toEqual(project(before.event));
        },
      ),
      { numRuns },
    );
  });

  test("a record of another role's address never passes as that role's", () => {
    const created = vectors.records.find((v) => v.id === "election-created");
    if (created === undefined) throw new Error("no election-created record");
    const r = recordOf(created.fields);
    for (const contract of [contracts.trusteeRegistry, contracts.groupRegistry, contracts.board])
      expect(checkContractEvent({ ...r, contract }, contracts)).toEqual({
        ok: false,
        error: "unknown-event",
      });
  });
});
