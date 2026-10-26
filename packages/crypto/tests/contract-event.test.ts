import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  checkContractEvent,
  checkEventAccumulatorProof,
  COMPLAINT_BATCH_MAX,
  decodeShareComplaintBatch,
  encodeShareComplaintBatchV2,
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
  ds,
  encodeContractEvent,
  EncodeError,
  type EventContracts,
  frameBallot,
  H,
  MAX_EVENT_DATA,
  MAX_EVENT_TOPICS,
  membershipVkEncoding,
  replayEventAccumulator,
  verifyMembershipProof,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/contract-event.json (version 1) to contract-event-v9.json
// (version 6, with its own strict Tier 1 addition decoder, version 7, with
// its own checks of the self-paid record, version 8, with
// scripts/availability-vectors.py's decoding of the availability records,
// and version 9, with its own framing of ballot version 4 and the version-2
// delivery records and its own key-set layout check) come from independent
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
  5: load("contract-event-v5.json"),
  6: load("contract-event-v6.json"),
  7: load("contract-event-v7.json"),
  8: load("contract-event-v8.json"),
  9: load("contract-event-v9.json"),
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
    case "AuthorPanelRegistered":
      return {
        event: e.event,
        definitionHash: bytesToHex(e.definitionHash),
        authorPanelId: bytesToHex(e.authorPanelId),
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
    case "ShareComplaintBatchSubmitted":
    case "ObligationRootSubmitted":
    case "AvailabilityAttestationSubmitted":
    case "AvailabilityComplaintSubmitted":
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
    case "Tier1MemberAdded":
      return { event: e.event, record: bytesToHex(e.record) };
    case "SelfPaidGroupCreated":
      return { event: e.event, groupId: String(e.groupId) };
    case "SelfPaidMemberAdded":
      return {
        event: e.event,
        groupId: String(e.groupId),
        index: String(e.index),
        record: bytesToHex(e.record),
        commitment: e.commitment.toString(16).padStart(64, "0"),
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
    case "AuthorPanelRegistered":
      return {
        topics: [sig(e.event), e.definitionHash, e.authorPanelId],
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
    case "ShareComplaintBatchSubmitted":
    case "ObligationRootSubmitted":
    case "AvailabilityAttestationSubmitted":
    case "AvailabilityComplaintSubmitted":
      return {
        topics: [sig(e.event), e.definitionHash, uintWord(e.seat)],
        data: dyn([], tail(e.record)),
      };
    case "Tier1MemberAdded":
      return { topics: [sig(e.event)], data: dyn([], tail(e.record)) };
    case "SelfPaidGroupCreated":
      return { topics: [sig(e.event), uintWord(e.groupId)], data: new Uint8Array() };
    case "SelfPaidMemberAdded":
      return {
        topics: [sig(e.event), uintWord(e.groupId), uintWord(e.index)],
        data: dyn([], tail(e.record)),
      };
  }
}

const ROLE_OF: Readonly<Record<ContractEvent["event"], ContractRole>> = {
  ElectionCreated: "election-registry",
  DefinitionRegistered: "election-registry",
  AuthorPanelRegistered: "election-registry",
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
  ShareComplaintBatchSubmitted: "board",
  ObligationRootSubmitted: "board",
  AvailabilityAttestationSubmitted: "board",
  AvailabilityComplaintSubmitted: "board",
  Tier1MemberAdded: "group-registry",
  SelfPaidGroupCreated: "group-registry",
  SelfPaidMemberAdded: "group-registry",
};

describe.each([
  [1, "contract-event.json"],
  [2, "contract-event-v2.json"],
  [3, "contract-event-v3.json"],
  [4, "contract-event-v4.json"],
  [5, "contract-event-v5.json"],
  [6, "contract-event-v6.json"],
  [7, "contract-event-v7.json"],
  [8, "contract-event-v8.json"],
  [9, "contract-event-v9.json"],
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
  test.each([1, 2, 3, 4, 5, 7, 8, 9] as const)(
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
    const added = FILES[4].records.filter((r) =>
      ["ShareReceiptBatchSubmitted", "ShareComplaintBatchSubmitted"].includes(
        (r.event as { event?: string }).event ?? "",
      ),
    );
    expect(added.map((r) => r.id)).toEqual(
      (FILES[4] as Vectors & { unknownUnderVersion3: string[] }).unknownUnderVersion3,
    );
    expect(added.length).toBe(6);
    for (const v of added) {
      const record = { ...recordOf(v.fields), contract: v3.board };
      expect(checkContractEvent(record, v3, 3)).toEqual({ ok: false, error: "unknown-event" });
    }
  });
});

describe("contract-event version 5 against version 4", () => {
  const v5 = contractsOf(FILES[5]);

  // Version 5 keeps every row of version 4 unchanged, and adds only the
  // board's obligation-root event.
  test("every version-4 vector has the same verdict under version 5", () => {
    const all = [...FILES[4].records, ...FILES[4].eventFailures];
    expect(all.length).toBeGreaterThan(40);
    for (const v of all) {
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, 4, 5) };
      const result = checkContractEvent(record, v5, 5);
      expect(result.ok ? project(result.event) : result).toEqual(
        v.error === undefined ? v.event : { ok: false, error: v.error },
      );
    }
  });

  test("version 4 names no root event, so it refuses each as unknown-event", () => {
    const v4 = contractsOf(FILES[4]);
    const added = FILES[5].records.filter(
      (r) => (r.event as { event?: string }).event === "ObligationRootSubmitted",
    );
    expect(added.map((r) => r.id)).toEqual(
      (FILES[5] as Vectors & { unknownUnderVersion4: string[] }).unknownUnderVersion4,
    );
    expect(added.length).toBe(5);
    for (const v of added) {
      const record = { ...recordOf(v.fields), contract: v4.board };
      expect(checkContractEvent(record, v4, 4)).toEqual({ ok: false, error: "unknown-event" });
    }
  });
});

describe("contract-event version 6 against version 5", () => {
  const v6 = contractsOf(FILES[6]);

  // Version 6 keeps every row of version 5 unchanged, and adds only the
  // group registry's Tier 1 addition event.
  test("every version-5 vector has the same verdict under version 6", () => {
    const all = [...FILES[5].records, ...FILES[5].eventFailures];
    expect(all.length).toBeGreaterThan(40);
    for (const v of all) {
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, 5, 6) };
      const result = checkContractEvent(record, v6, 6);
      expect(result.ok ? project(result.event) : result).toEqual(
        v.error === undefined ? v.event : { ok: false, error: v.error },
      );
    }
  });

  test("version 5 names no Tier 1 event, so it refuses each as unknown-event", () => {
    const v5 = contractsOf(FILES[5]);
    const added = FILES[6].records.filter(
      (r) => (r.event as { event?: string }).event === "Tier1MemberAdded",
    );
    expect(added.map((r) => r.id)).toEqual(
      (FILES[6] as Vectors & { unknownUnderVersion5: string[] }).unknownUnderVersion5,
    );
    expect(added.length).toBe(53);
    for (const v of added) {
      const record = { ...recordOf(v.fields), contract: v5.groupRegistry };
      expect(checkContractEvent(record, v5, 5)).toEqual({ ok: false, error: "unknown-event" });
    }
  });
});

describe("contract-event version 7 against version 6", () => {
  const v7 = contractsOf(FILES[7]);

  // Version 7 keeps every row of version 6 unchanged, and adds only the
  // group registry's two self-paid events.
  test("every version-6 vector has the same verdict under version 7", () => {
    const all = [...FILES[6].records, ...FILES[6].eventFailures];
    expect(all.length).toBeGreaterThan(40);
    for (const v of all) {
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, 6, 7) };
      const result = checkContractEvent(record, v7, 7);
      expect(result.ok ? project(result.event) : result).toEqual(
        v.error === undefined ? v.event : { ok: false, error: v.error },
      );
    }
  });

  test("version 6 names no self-paid event, so it refuses each as unknown-event", () => {
    const v6 = contractsOf(FILES[6]);
    const selfPaid = FILES[7].records.filter((r) =>
      ["SelfPaidGroupCreated", "SelfPaidMemberAdded"].includes(
        (r.event as { event?: string }).event ?? "",
      ),
    );
    expect(selfPaid.map((r) => r.id)).toEqual(
      (FILES[7] as Vectors & { unknownUnderVersion6: string[] }).unknownUnderVersion6,
    );
    expect(selfPaid.length).toBe(11);
    for (const v of selfPaid) {
      const record = { ...recordOf(v.fields), contract: v6.groupRegistry };
      expect(checkContractEvent(record, v6, 6)).toEqual({ ok: false, error: "unknown-event" });
    }
  });
});

describe("contract-event version 8 against version 7", () => {
  const v8 = contractsOf(FILES[8]);

  // Version 8 keeps every row of version 7 unchanged, and adds only the
  // board's two availability events.
  test("every version-7 vector has the same verdict under version 8", () => {
    const all = [...FILES[7].records, ...FILES[7].eventFailures];
    expect(all.length).toBeGreaterThan(30);
    for (const v of all) {
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, 7, 8) };
      const result = checkContractEvent(record, v8, 8);
      expect(result.ok ? project(result.event) : result).toEqual(
        v.error === undefined ? v.event : { ok: false, error: v.error },
      );
    }
  });

  test("version 7 names no availability event, so it refuses each as unknown-event", () => {
    const v7 = contractsOf(FILES[7]);
    const added = FILES[8].records.filter((r) =>
      ["AvailabilityAttestationSubmitted", "AvailabilityComplaintSubmitted"].includes(
        (r.event as { event?: string }).event ?? "",
      ),
    );
    expect(added.map((r) => r.id)).toEqual(
      (FILES[8] as Vectors & { unknownUnderVersion7: string[] }).unknownUnderVersion7,
    );
    expect(added.length).toBe(13);
    for (const v of added) {
      const record = { ...recordOf(v.fields), contract: v7.board };
      expect(checkContractEvent(record, v7, 7)).toEqual({ ok: false, error: "unknown-event" });
    }
  });

  // Each event carries only its own record type, signed or not: the event
  // check decodes, never verifies (Event tables (version 8)).
  test("every availability record of availability.json passes in its own event only", () => {
    const { records } = load("availability.json") as unknown as {
      readonly records: readonly { readonly id: string; readonly kind: string }[];
    };
    for (const { id, kind } of records) {
      const v = FILES[8].records.find((r) => r.id === `availability-${id}`);
      if (v === undefined) throw new Error(`no version-8 record of ${id}`);
      expect((v.event as { event: string }).event).toBe(
        kind === "attestation"
          ? "AvailabilityAttestationSubmitted"
          : "AvailabilityComplaintSubmitted",
      );
    }
  });
});

describe("contract-event version 9 against version 8", () => {
  const v9 = contractsOf(FILES[9]);
  const v8 = contractsOf(FILES[8]);
  const sameVerdict = (all: readonly VectorRecord[], from: ContractEventVersion) => {
    for (const v of all) {
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, from, 9) };
      const result = checkContractEvent(record, v9, 9);
      expect(result.ok ? project(result.event) : result).toEqual(
        v.error === undefined ? v.event : { ok: false, error: v.error },
      );
    }
  };

  // Version 9 reads every record version 8 passes exactly as version 8 does,
  // and fails every other with the same code: its board rows only widen the
  // framing to the versions it adds (Event tables (version 9)).
  test("every version-8 vector has the same verdict under version 9", () => {
    const all = [...FILES[8].records, ...FILES[8].eventFailures];
    expect(all.length).toBeGreaterThan(40);
    sameVerdict(all, 8);
  });

  // The earlier files' board failures, among them every ballot and delivery
  // decode rejection that needs no election, still fail under the wider
  // framing: none of them is a version version 9 adds.
  test.each([2, 3, 4, 5] as const)(
    "every board failure of version %i keeps its verdict under version 9",
    (from) => {
      const board = FILES[from].contracts.board;
      const failures = FILES[from].eventFailures.filter((v) => v.fields.contract === board);
      expect(failures.length).toBeGreaterThan(10);
      sameVerdict(failures, from);
    },
  );

  // Under version 8 the author registration is no event of the election
  // registry's, and a version-4 ballot or a version-2 delivery record
  // doesn't frame, so a profile pinning version 8 can't be given either by
  // a board that accepts them: version 8 must be retired first (T-53).
  test("underVersion8 gives each version-9 record's verdict under version 8", () => {
    const under = (FILES[9] as Vectors & { underVersion8: Record<string, string> }).underVersion8;
    const records = new Map(FILES[9].records.map((r) => [r.id, r]));
    expect(Object.keys(under).length).toBeGreaterThan(40);
    for (const [id, error] of Object.entries(under)) {
      const v = records.get(id);
      if (v === undefined) throw new Error(`no record ${id}`);
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, 9, 8) };
      expect(checkContractEvent(record, v8, 8)).toEqual({ ok: false, error });
    }
    // Every other version-9 record passes version 8 with the same fields.
    for (const v of FILES[9].records.filter((r) => under[r.id] === undefined)) {
      const record = { ...recordOf(v.fields), contract: mapAddress(v.fields.contract, 9, 8) };
      const result = checkContractEvent(record, v8, 8);
      if (!result.ok) throw new Error(`${v.id}: ${result.error} under version 8`);
      expect(project(result.event)).toEqual(v.event);
    }
  });

  // A record with AuthorPanelRegistered's topic 0 that version 9 fails is no
  // event of version 8's tables at all.
  test("version 9's failing author registrations are unknown-event under version 8", () => {
    const topic0 = bytesToHex(sigTopic("AuthorPanelRegistered(bytes32,bytes32,bytes)"));
    const failing = FILES[9].eventFailures.filter(
      (v) =>
        v.fields.topics[0] === topic0 &&
        v.fields.contract === FILES[9].contracts["election-registry"],
    );
    expect(failing.length).toBeGreaterThan(10);
    for (const v of failing) {
      const record = { ...recordOf(v.fields), contract: v8.electionRegistry };
      expect(checkContractEvent(record, v8, 8)).toEqual({ ok: false, error: "unknown-event" });
    }
  });

  // The largest batch either panel's seat can send, one byte past version
  // 1's bound for its panel byte: a check whose bound left the byte out would
  // refuse a batch the board emits, and so fail every election on the board
  // (T-53).
  test("a version-2 complaint batch of COMPLAINT_BATCH_MAX entries passes under version 9", () => {
    const v = FILES[9].records.find((r) => r.id === "delivery-batch-v2-complaint-batch-author");
    if (v === undefined) throw new Error("no version-2 complaint batch");
    const passed = checkContractEvent(recordOf(v.fields), v9, 9);
    if (!passed.ok || passed.event.event !== "ShareComplaintBatchSubmitted")
      throw new Error("the honest batch doesn't pass");
    const base = decodeShareComplaintBatch(passed.event.record, 2);
    const proof = base.complaints[0]?.proof;
    if (proof === undefined) throw new Error("an empty batch");
    const complaints = Array.from({ length: COMPLAINT_BATCH_MAX }, (_, i) => ({
      ballot_hash: uintWord(i + 1),
      proof,
    }));
    const record = encodeShareComplaintBatchV2({ ...base, complaints });
    expect(record.length).toBe(105 + 128 * COMPLAINT_BATCH_MAX);
    const full = {
      ...recordOf(v.fields),
      topics: [
        sigTopic("ShareComplaintBatchSubmitted(bytes32,uint8,bytes)"),
        base.definition_hash,
        uintWord(base.seat),
      ],
      data: concat([uintWord(32), tail(record)]),
    };
    const result = checkContractEvent(full, v9, 9);
    expect(result.ok && result.event.event).toBe("ShareComplaintBatchSubmitted");
  });

  // The board frames an author element, a version-2 complaint's `D` and a
  // posting's `ct_dh`, never decodes them (T-53): these vectors' elements
  // aren't ristretto255 points, and their events still pass.
  test("the framed elements of the version-9 not-a-point vectors aren't points", () => {
    const cases: readonly [string, (record: Uint8Array) => number][] = [
      // The first author element: past the fixed fields, both of the default
      // half's lists, and the author list's two counts.
      [
        "ballot-v4-author-element-not-point",
        (r) => {
          const view = new DataView(r.buffer, r.byteOffset);
          let at = 364;
          const options = view.getUint32(at);
          at += 4;
          for (let j = 0; j < options; j++) at += 4 + 32 * view.getUint32(at);
          at += 4 + 32 * view.getUint32(at);
          return at + 4 + 4;
        },
      ],
      ["complaint-v2-d-not-point", () => 3 + 32 + 32 + 1 + 1],
      ["posting-v2-ct_dh-not-point", () => 3 + 32 + 32 + 1 + 1 + 32 + 1088],
      ["complaint-batch-v2-d-not-point", () => 3 + 32 + 1 + 1 + 4 + 32],
    ];
    for (const [id, at] of cases) {
      const v = FILES[9].records.find((r) => r.id === id);
      if (v === undefined) throw new Error(`no record ${id}`);
      const result = checkContractEvent(recordOf(v.fields), v9, 9);
      if (!result.ok || !("record" in result.event)) throw new Error(`${id} doesn't pass`);
      const record = result.event.record;
      const i = at(record);
      expect(() => decode(element, record.subarray(i, i + 32))).toThrow(DecodeError);
    }
  });
});

// docs/spec/vectors/contract-event-v10.json (version 10, the board's rolling
// ballot event) from scripts/contract-event-v10-vectors.py, with its own
// framing of ballot version 5 and the step roots of
// scripts/ballot-v5-records-vectors.py. packages/crypto doesn't read version
// 10 until P2-17 part 3, so this reads it from the spec: version 9's layout
// and tables, through packages/crypto, and the one event version 10 adds,
// read here (docs/spec/contracts.md, Event tables (version 10)).
interface RollingRoot {
  readonly record: string;
  readonly ballot: string;
  readonly step: number;
  readonly suppliedRoot: string;
  readonly stepRoot: string | null;
  readonly rootCheck: "match" | "root-step-mismatch" | "not-reached";
}
const V10 = load("contract-event-v10.json") as Vectors & {
  readonly underVersion9: Readonly<Record<string, string>>;
  readonly rollingRoots: readonly RollingRoot[];
};
const ROLLING = "RollingBallotSubmitted(bytes32,bytes32,bytes32,bytes)";
const STEP_AT = 364;
const ROLLING_VOTE_AT = 368;

const bigWord = (w: Uint8Array) => BigInt(`0x${bytesToHex(w) || "0"}`);
const sameBytes = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b);

// What the board frames (version 10): a version-5 ballot is version 4's
// record with a `u32` step, any value, between the proof and the committed
// vote, so it frames exactly when its bytes without the step, labelled
// version 4, frame under version 9; its ballot hash is the one formula
// every version shares, over the bytes from the step on (Hashes (version 5)).
function frameRolling(
  record: Uint8Array,
): { definitionHash: Uint8Array; ballotHash: Uint8Array } | undefined {
  if (record.length < ROLLING_VOTE_AT || record[0] !== 0 || record[1] !== 2 || record[2] !== 5)
    return undefined;
  const asV4 = concat([
    record.subarray(0, 2),
    Uint8Array.of(4),
    record.subarray(3, STEP_AT),
    record.subarray(ROLLING_VOTE_AT),
  ]);
  if (frameBallot(asV4, 9) === undefined) return undefined;
  const hashed = concat([
    record.subarray(3, 35),
    record.subarray(0, 3),
    record.subarray(35, 68),
    record.subarray(STEP_AT),
  ]);
  return { definitionHash: record.slice(3, 35), ballotHash: H(ds("abolish/v1/ballot", hashed)) };
}

// `abi.encode(bytes32 root, bytes record)`, canonical: the root's word, the
// offset 0x40, the length, the record, zero padding and nothing after.
function rollingData(data: Uint8Array): { root: bigint; record: Uint8Array } | undefined {
  if (data.length < 96 || bigWord(data.subarray(32, 64)) !== 64n) return undefined;
  const length = bigWord(data.subarray(64, 96));
  if (length > BigInt(MAX_EVENT_DATA)) return undefined;
  const end = 96 + Number(length);
  const padded = 96 + 32 * Math.ceil(Number(length) / 32);
  if (data.length !== padded || data.subarray(end).some((b) => b !== 0)) return undefined;
  return { root: bigWord(data.subarray(0, 32)), record: data.slice(96, end) };
}

/** Version 10's event check, projected to the vector file's shape. */
function checkV10(record: ContractEventRecord, contracts: EventContracts): unknown {
  const [topic0, definitionHash, ballotHash] = record.topics;
  if (
    !sameBytes(record.contract, contracts.board) ||
    topic0 === undefined ||
    !sameBytes(topic0, sigTopic(ROLLING))
  ) {
    // Every other event is version 9's, row for row, and the rolling
    // event's topic 0 from any other role is unknown there, as here.
    const result = checkContractEvent(record, contracts, 9);
    return result.ok ? { role: result.role, event: project(result.event) } : result;
  }
  if (record.topics.length !== 3 || definitionHash === undefined || ballotHash === undefined)
    return { ok: false, error: "event-topics" };
  const data = rollingData(record.data);
  const framed = data && frameRolling(data.record);
  if (
    data === undefined ||
    data.root === 0n ||
    data.root >= BN254_R ||
    framed === undefined ||
    !sameBytes(framed.definitionHash, definitionHash) ||
    !sameBytes(framed.ballotHash, ballotHash)
  )
    return { ok: false, error: "event-data" };
  return {
    role: "board",
    event: {
      event: "RollingBallotSubmitted",
      definitionHash: bytesToHex(definitionHash),
      ballotHash: bytesToHex(ballotHash),
      root: String(data.root),
      record: bytesToHex(data.record),
    },
  };
}

// Version 10's layout is version 9's, field for field (Layout (versions 1
// to 10)): the same bytes with the version byte 10.
const relabel = (b: Uint8Array, version: number) =>
  concat([b.subarray(0, 2), Uint8Array.of(version), b.subarray(3)]);
function decodeV10(b: Uint8Array): ContractEventRecord {
  if (b.length >= 3 && b[0] === 0 && b[1] === 8 && b[2] !== 10)
    throw new DecodeError("profile-mismatch", 2);
  return decodeContractEvent(relabel(b, 9), 9);
}

describe("contract-event version 10 (docs/spec/vectors/contract-event-v10.json)", () => {
  const v10 = contractsOf(V10);
  const v9 = contractsOf(FILES[9]);
  const toV10 = (contract: string, from: Vectors) => {
    const role = (Object.keys(from.contracts) as ContractRole[]).find(
      (r) => from.contracts[r] === contract,
    );
    return hex(role === undefined ? contract : V10.contracts[role]);
  };

  test("contract-event-v10.json is the contract-event format for record type 0x0008, version 10", () => {
    expect(V10.format).toBe("abolish-contract-event-vectors/10");
    expect(V10.recordType).toBe("0x0008");
    expect(V10.version).toBe(10);
    expect(V10.maxEventData).toBe(MAX_EVENT_DATA);
    expect(V10.maxEventTopics).toBe(MAX_EVENT_TOPICS);
  });

  test("its tables are version 9's with the rolling ballot event after the board's", () => {
    for (const role of [
      "election-registry",
      "trustee-registry",
      "group-registry",
      "board",
    ] as const)
      expect(V10.events.filter((e) => e.role === role).map((e) => e.signature)).toEqual([
        ...CONTRACT_EVENT_SIGNATURES[9][role],
        ...(role === "board" ? [ROLLING] : []),
      ]);
    for (const e of V10.events)
      expect(bytesToHex(keccak_256(new TextEncoder().encode(e.signature)))).toBe(e.topic0);
    expect(V10.events.find((e) => e.signature === ROLLING)?.indexed).toEqual([
      "definitionHash",
      "ballotHash",
    ]);
  });

  test.each(V10.records.map((r) => [r.id, r] as const))(
    "%s: encodes, decodes and passes the event check as its contract's event",
    (_id, v) => {
      const record = recordOf(v.fields);
      expect(relabel(encodeContractEvent(record, 9), 10)).toEqual(hex(v.encoding));
      expect(decodeV10(hex(v.encoding))).toEqual(record);
      expect(checkV10(record, v10)).toEqual({ role: v.role, event: v.event });
    },
  );

  test.each(V10.eventFailures.map((r) => [r.id, r] as const))(
    "%s: decodes, and the event check fails with its code",
    (_id, v) => {
      const record = decodeV10(hex(v.encoding));
      expect(record).toEqual(recordOf(v.fields));
      expect(checkV10(record, v10)).toEqual({ ok: false, error: v.error });
    },
  );

  test.each(V10.decodeErrors.map((v) => [v.id, v] as const))(
    "%s: rejected with its code and offset",
    (_id, v) => {
      let error: unknown;
      try {
        decodeV10(hex(v.encoding));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe(v.error);
      expect((error as DecodeError).offset).toBe(v.offset);
    },
  );

  test("the board's records replay into the file's accumulators", () => {
    const [s] = V10.sequences;
    if (s === undefined || V10.sequences.length !== 1) throw new Error("one sequence expected");
    const byId = new Map(V10.records.map((r) => [r.id, r]));
    const records = s.records.map((id) => decodeV10(hex(byId.get(id)?.encoding ?? "")));
    const chainId = BigInt(V10.chainId);
    const address = hex(V10.contracts[s.role]);
    for (const [i, acc] of s.accumulators.entries())
      expect(
        bytesToHex(
          replayEventAccumulator(chainId, address, records.slice(0, i + 1).map(contractEventLog))
            .accumulator,
        ),
      ).toBe(acc);
    expect(String(records.length)).toBe(s.count);
  });

  // Version 10 keeps every row of version 9's and adds one event, whose
  // topic 0 no earlier record carries (Event tables (version 10)).
  test("every version-9 vector, and every board failure of versions 2 to 5 and 8, keeps its verdict", () => {
    const all: [VectorRecord, Vectors][] = [
      ...[...FILES[9].records, ...FILES[9].eventFailures].map(
        (v) => [v, FILES[9]] as [VectorRecord, Vectors],
      ),
      ...([2, 3, 4, 5, 8] as const).flatMap((from) =>
        FILES[from].eventFailures
          .filter((v) => v.fields.contract === FILES[from].contracts.board)
          .map((v) => [v, FILES[from]] as [VectorRecord, Vectors]),
      ),
    ];
    expect(all.length).toBeGreaterThan(300);
    for (const [v, from] of all) {
      const record = { ...recordOf(v.fields), contract: toV10(v.fields.contract, from) };
      expect(checkV10(record, v10)).toEqual(
        v.error === undefined ? { role: v.role, event: v.event } : { ok: false, error: v.error },
      );
    }
  });

  // Under version 9 the rolling event is no event of the board's, so a
  // profile pinning version 9 can't be given a board with the rolling call:
  // version 9 must be retired first (T-53).
  test("underVersion9 gives each rolling record's verdict under version 9, and the rest pass it alike", () => {
    const topic0 = bytesToHex(sigTopic(ROLLING));
    const toV9 = (v: VectorRecord) => ({
      ...recordOf(v.fields),
      contract: hex(
        FILES[9].contracts[
          (Object.keys(V10.contracts) as ContractRole[]).find(
            (r) => V10.contracts[r] === v.fields.contract,
          ) ?? "board"
        ],
      ),
    });
    for (const v of V10.records) {
      const rolling = v.fields.topics[0] === topic0;
      expect(V10.underVersion9[v.id]).toBe(rolling ? "unknown-event" : undefined);
      const result = checkContractEvent(toV9(v), v9, 9);
      expect(result.ok ? { role: result.role, event: project(result.event) } : result).toEqual(
        rolling ? { ok: false, error: "unknown-event" } : { role: v.role, event: v.event },
      );
    }
    const failing = V10.eventFailures.filter(
      (v) => v.fields.topics[0] === topic0 && v.fields.contract === V10.contracts.board,
    );
    expect(failing.length).toBeGreaterThan(20);
    for (const v of failing)
      expect(checkContractEvent(toV9(v), v9, 9)).toEqual({ ok: false, error: "unknown-event" });
  });

  // The supplied root against the step's (ballot-validity.md, Admission
  // (version 5), root-step-mismatch): the step roots are
  // ballot-v5-records.json's, rebuilt by its own generator from the group
  // registry's events, and the board's check of the proof against the
  // supplied root is packages/crypto's Groth16 verifier under the signals
  // that file derives from each ballot.
  test("each rolling record's supplied root, and its comparison with the step's root", () => {
    const v5 = JSON.parse(
      readFileSync(new URL("ballot-v5-records.json", SPEC_VECTORS), "utf8"),
    ) as {
      readonly elections: Readonly<
        Record<
          string,
          {
            readonly definitionHash: string;
            readonly cells: readonly {
              readonly steps: readonly { readonly step: number; readonly root: string }[];
            }[];
          }
        >
      >;
      readonly ballots: readonly {
        readonly id: string;
        readonly election: string;
        readonly encoding: string;
        readonly signals?: {
          readonly nullifier: string;
          readonly message: string;
          readonly scope: string;
        };
      }[];
    };
    const ballots = new Map(v5.ballots.map((b) => [b.id, b]));
    const records = new Map(V10.records.map((r) => [r.id, r]));
    expect(V10.rollingRoots.length).toBe(v5.ballots.length + 2);
    for (const r of V10.rollingRoots) {
      const v = records.get(r.record);
      const b = ballots.get(r.ballot);
      if (v === undefined || b === undefined)
        throw new Error(`no record or ballot for ${r.record}`);
      const event = (
        checkV10(recordOf(v.fields), v10) as { event: { root: string; record: string } }
      ).event;
      expect(event.root).toBe(r.suppliedRoot);
      expect(event.record).toBe(b.encoding);
      const record = hex(b.encoding);
      const step = new DataView(record.buffer, record.byteOffset).getUint32(STEP_AT);
      expect(step).toBe(r.step);
      const election = v5.elections[b.election];
      const stepRoot =
        election !== undefined && bytesToHex(record.subarray(3, 35)) === election.definitionHash
          ? election.cells[record[35] ?? 0]?.steps.find((s) => s.step === step)?.root
          : undefined;
      expect(stepRoot ?? null).toBe(r.stepRoot);
      const check =
        stepRoot === undefined
          ? "not-reached"
          : stepRoot === r.suppliedRoot
            ? "match"
            : "root-step-mismatch";
      expect(r.rootCheck).toBe(check);
    }

    // The mismatched root the board accepts: membership-other-step-root's
    // proof verifies against the supplied root, step N0 − 1's, and not
    // against the root of the step it names, so only the verifier's
    // comparison rejects it. The front-runner's relabelled copy is the
    // reverse: its proof fails against the root supplied, so the board
    // refuses it and the honest submission stands (T-25).
    const proofHolds = (id: string, which: "suppliedRoot" | "stepRoot") => {
      const r = V10.rollingRoots.find((x) => x.record === id);
      const b = r && ballots.get(r.ballot);
      const root = r?.[which];
      if (b?.signals === undefined || root === undefined || root === null)
        throw new Error(`no signals or root for ${id}`);
      return verifyMembershipProof(hex(b.encoding).subarray(108, STEP_AT), {
        root: BigInt(root),
        nullifier: BigInt(b.signals.nullifier),
        message: BigInt(b.signals.message),
        scope: BigInt(b.signals.scope),
      });
    };
    expect(V10.rollingRoots.find((x) => x.record === "rolling-root-mismatch")?.rootCheck).toBe(
      "root-step-mismatch",
    );
    expect(proofHolds("rolling-root-mismatch", "suppliedRoot")).toBe(true);
    expect(proofHolds("rolling-root-mismatch", "stepRoot")).toBe(false);
    expect(proofHolds("rolling-root-front-run", "suppliedRoot")).toBe(false);
    expect(proofHolds("rolling-root-front-run", "stepRoot")).toBe(true);
    // The argument that a proof fixes its root needs the pinned key's IC_1,
    // the root's coefficient in L, not to be the identity (contracts.md,
    // Board, Rolling ballots, One root per record).
    const ic1 = membershipVkEncoding().subarray(448 + 64, 448 + 128);
    expect(ic1.some((b) => b !== 0)).toBe(true);
  });
});

// docs/spec/vectors/contract-event-v11.json (version 11, the board's relayed
// rolling ballot event) from scripts/contract-event-v11-vectors.py, and the
// rolling relay calls of scripts/relay-rolling-vectors.py. Read here, as
// version 10 is, from the spec: version 10's reading above, and the one
// event version 11 adds (docs/spec/contracts.md, Event tables (version 11)).
const V11 = load("contract-event-v11.json") as Vectors & {
  readonly underVersion10: Readonly<Record<string, string>>;
  readonly relayedRoots: readonly RollingRoot[];
  readonly relayMatches: readonly {
    readonly record: string;
    readonly call: string;
    readonly callHash: string;
    readonly result: "match" | "relay-unmatched";
  }[];
};
const RELAYED_ROLLING =
  "RelayedRollingBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes32,bytes)";
const U64_MAX = (1n << 64n) - 1n;

// `abi.encode(uint64 index, uint64 l1Block, uint64 stamp, uint64 gasLimit,
// bytes32 root, bytes record)`, canonical: four words below 2⁶⁴, the root's
// word, the offset 0xc0, the length, the record, zero padding, nothing after.
function relayedRollingData(data: Uint8Array):
  | {
      fields: readonly bigint[];
      root: bigint;
      record: Uint8Array;
    }
  | undefined {
  if (data.length < 224 || bigWord(data.subarray(160, 192)) !== 192n) return undefined;
  const fields = [0, 1, 2, 3].map((i) => bigWord(data.subarray(32 * i, 32 * i + 32)));
  if (fields.some((f) => f > U64_MAX)) return undefined;
  const length = bigWord(data.subarray(192, 224));
  if (length > BigInt(MAX_EVENT_DATA)) return undefined;
  const end = 224 + Number(length);
  const padded = 224 + 32 * Math.ceil(Number(length) / 32);
  if (data.length !== padded || data.subarray(end).some((b) => b !== 0)) return undefined;
  return { fields, root: bigWord(data.subarray(128, 160)), record: data.slice(224, end) };
}

/** Version 11's event check, projected to the vector file's shape. */
function checkV11(record: ContractEventRecord, contracts: EventContracts): unknown {
  const [topic0, definitionHash, ballotHash] = record.topics;
  if (
    !sameBytes(record.contract, contracts.board) ||
    topic0 === undefined ||
    !sameBytes(topic0, sigTopic(RELAYED_ROLLING))
  )
    return checkV10(record, contracts);
  if (record.topics.length !== 3 || definitionHash === undefined || ballotHash === undefined)
    return { ok: false, error: "event-topics" };
  const data = relayedRollingData(record.data);
  const framed = data && frameRolling(data.record);
  if (
    data === undefined ||
    data.root === 0n ||
    data.root >= BN254_R ||
    framed === undefined ||
    !sameBytes(framed.definitionHash, definitionHash) ||
    !sameBytes(framed.ballotHash, ballotHash)
  )
    return { ok: false, error: "event-data" };
  const [index, l1Block, stamp, gasLimit] = data.fields.map(String);
  return {
    role: "board",
    event: {
      event: "RelayedRollingBallotSubmitted",
      definitionHash: bytesToHex(definitionHash),
      ballotHash: bytesToHex(ballotHash),
      index,
      l1Block,
      stamp,
      gasLimit,
      root: String(data.root),
      record: bytesToHex(data.record),
    },
  };
}

function decodeV11(b: Uint8Array): ContractEventRecord {
  if (b.length >= 3 && b[0] === 0 && b[1] === 8 && b[2] !== 11)
    throw new DecodeError("profile-mismatch", 2);
  return decodeContractEvent(relabel(b, 9), 9);
}

describe("contract-event version 11 (docs/spec/vectors/contract-event-v11.json)", () => {
  const v11 = contractsOf(V11);
  const toV11 = (contract: string, from: Vectors) => {
    const role = (Object.keys(from.contracts) as ContractRole[]).find(
      (r) => from.contracts[r] === contract,
    );
    return hex(role === undefined ? contract : V11.contracts[role]);
  };

  test("contract-event-v11.json is the contract-event format for record type 0x0008, version 11", () => {
    expect(V11.format).toBe("abolish-contract-event-vectors/11");
    expect(V11.recordType).toBe("0x0008");
    expect(V11.version).toBe(11);
    expect(V11.maxEventData).toBe(MAX_EVENT_DATA);
    expect(V11.maxEventTopics).toBe(MAX_EVENT_TOPICS);
  });

  test("its tables are version 10's with the relayed rolling event after the board's", () => {
    for (const role of [
      "election-registry",
      "trustee-registry",
      "group-registry",
      "board",
    ] as const)
      expect(V11.events.filter((e) => e.role === role).map((e) => e.signature)).toEqual(
        V10.events
          .filter((e) => e.role === role)
          .map((e) => e.signature)
          .concat(role === "board" ? [RELAYED_ROLLING] : []),
      );
    for (const e of V11.events)
      expect(bytesToHex(keccak_256(new TextEncoder().encode(e.signature)))).toBe(e.topic0);
    expect(V11.events.find((e) => e.signature === RELAYED_ROLLING)?.indexed).toEqual([
      "definitionHash",
      "ballotHash",
    ]);
  });

  test.each(V11.records.map((r) => [r.id, r] as const))(
    "%s: encodes, decodes and passes the event check as its contract's event",
    (_id, v) => {
      const record = recordOf(v.fields);
      expect(relabel(encodeContractEvent(record, 9), 11)).toEqual(hex(v.encoding));
      expect(decodeV11(hex(v.encoding))).toEqual(record);
      expect(checkV11(record, v11)).toEqual({ role: v.role, event: v.event });
    },
  );

  test.each(V11.eventFailures.map((r) => [r.id, r] as const))(
    "%s: decodes, and the event check fails with its code",
    (_id, v) => {
      const record = decodeV11(hex(v.encoding));
      expect(record).toEqual(recordOf(v.fields));
      expect(checkV11(record, v11)).toEqual({ ok: false, error: v.error });
    },
  );

  test.each(V11.decodeErrors.map((v) => [v.id, v] as const))(
    "%s: rejected with its code and offset",
    (_id, v) => {
      let error: unknown;
      try {
        decodeV11(hex(v.encoding));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code).toBe(v.error);
      expect((error as DecodeError).offset).toBe(v.offset);
    },
  );

  test("the board's records replay into the file's accumulators", () => {
    const [s] = V11.sequences;
    if (s === undefined || V11.sequences.length !== 1) throw new Error("one sequence expected");
    const byId = new Map(V11.records.map((r) => [r.id, r]));
    const records = s.records.map((id) => decodeV11(hex(byId.get(id)?.encoding ?? "")));
    const chainId = BigInt(V11.chainId);
    const address = hex(V11.contracts[s.role]);
    for (const [i, acc] of s.accumulators.entries())
      expect(
        bytesToHex(
          replayEventAccumulator(chainId, address, records.slice(0, i + 1).map(contractEventLog))
            .accumulator,
        ),
      ).toBe(acc);
    expect(String(records.length)).toBe(s.count);
  });

  // Version 11 keeps every row of version 10's and adds one event, whose
  // topic 0 no earlier record carries (Event tables (version 11)).
  test("every version-10 vector, and every board failure of versions 2 to 5, 8 and 9, keeps its verdict", () => {
    const all: [VectorRecord, Vectors][] = [
      ...[...V10.records, ...V10.eventFailures].map((v) => [v, V10] as [VectorRecord, Vectors]),
      ...([2, 3, 4, 5, 8, 9] as const).flatMap((from) =>
        FILES[from].eventFailures
          .filter((v) => v.fields.contract === FILES[from].contracts.board)
          .map((v) => [v, FILES[from]] as [VectorRecord, Vectors]),
      ),
    ];
    expect(all.length).toBeGreaterThan(400);
    for (const [v, from] of all) {
      const record = { ...recordOf(v.fields), contract: toV11(v.fields.contract, from) };
      expect(checkV11(record, v11)).toEqual(
        v.error === undefined ? { role: v.role, event: v.event } : { ok: false, error: v.error },
      );
    }
  });

  // Under version 10 the relayed rolling event is no event of the board's,
  // so version 10 must be retired before a board with the relayed rolling
  // call is deployed (T-53).
  test("underVersion10 gives each relayed rolling record's verdict under version 10, and the rest pass it alike", () => {
    const topic0 = bytesToHex(sigTopic(RELAYED_ROLLING));
    for (const v of V11.records) {
      const relayed = v.fields.topics[0] === topic0;
      expect(V11.underVersion10[v.id]).toBe(relayed ? "unknown-event" : undefined);
      expect(checkV10(recordOf(v.fields), v11)).toEqual(
        relayed ? { ok: false, error: "unknown-event" } : { role: v.role, event: v.event },
      );
    }
    const failing = V11.eventFailures.filter(
      (v) => v.fields.topics[0] === topic0 && v.fields.contract === V11.contracts.board,
    );
    expect(failing.length).toBeGreaterThan(20);
    for (const v of failing)
      expect(checkV10(recordOf(v.fields), v11)).toEqual({ ok: false, error: "unknown-event" });
  });

  test("each relayed rolling record's supplied root, and its comparison with the step's root", () => {
    const v5 = JSON.parse(
      readFileSync(new URL("ballot-v5-records.json", SPEC_VECTORS), "utf8"),
    ) as {
      readonly elections: Readonly<
        Record<
          string,
          {
            readonly definitionHash: string;
            readonly cells: readonly {
              readonly steps: readonly { readonly step: number; readonly root: string }[];
            }[];
          }
        >
      >;
      readonly ballots: readonly {
        readonly id: string;
        readonly election: string;
        readonly encoding: string;
      }[];
    };
    const ballots = new Map(v5.ballots.map((b) => [b.id, b]));
    const records = new Map(V11.records.map((r) => [r.id, r]));
    expect(V11.relayedRoots.length).toBe(v5.ballots.length + 1);
    for (const r of V11.relayedRoots) {
      const v = records.get(r.record);
      const b = ballots.get(r.ballot);
      if (v === undefined || b === undefined)
        throw new Error(`no record or ballot for ${r.record}`);
      const event = (
        checkV11(recordOf(v.fields), v11) as { event: { root: string; record: string } }
      ).event;
      expect(event.root).toBe(r.suppliedRoot);
      expect(event.record).toBe(b.encoding);
      const record = hex(b.encoding);
      const step = new DataView(record.buffer, record.byteOffset).getUint32(STEP_AT);
      expect(step).toBe(r.step);
      const election = v5.elections[b.election];
      const stepRoot =
        election !== undefined && bytesToHex(record.subarray(3, 35)) === election.definitionHash
          ? election.cells[record[35] ?? 0]?.steps.find((s) => s.step === step)?.root
          : undefined;
      expect(stepRoot ?? null).toBe(r.stepRoot);
      expect(r.rootCheck).toBe(
        stepRoot === undefined
          ? "not-reached"
          : stepRoot === r.suppliedRoot
            ? "match"
            : "root-step-mismatch",
      );
    }
  });

  // Verifier 4.5's match (contracts.md, L1 relay, Verification): the call
  // hash recomputed from the event's fields and root under the rolling tag,
  // against the word relay-rolling.json gives for the call.
  test("relayMatches: each event against its relay call's word", () => {
    const relay = JSON.parse(readFileSync(new URL("relay-rolling.json", SPEC_VECTORS), "utf8")) as {
      readonly calls: readonly {
        readonly id: string;
        readonly l1ChainId: string;
        readonly relay: string;
        readonly callHash: string;
      }[];
    };
    const records = new Map(V11.records.map((r) => [r.id, r]));
    expect(new Set(V11.relayMatches.map((m) => m.result))).toEqual(
      new Set(["match", "relay-unmatched"]),
    );
    const u64 = (v: string) => hex(BigInt(v).toString(16).padStart(16, "0"));
    for (const m of V11.relayMatches) {
      const call = relay.calls.find((c) => c.id === m.call);
      const v = records.get(m.record);
      if (call === undefined || v === undefined)
        throw new Error(`no call or record for ${m.record}`);
      const e = (
        checkV11(recordOf(v.fields), v11) as {
          event: {
            index: string;
            l1Block: string;
            stamp: string;
            gasLimit: string;
            root: string;
            record: string;
          };
        }
      ).event;
      const callHash = H(
        ds(
          "abolish/v1/relay-rolling-call",
          concat([
            u64(call.l1ChainId),
            hex(call.relay),
            u64(e.index),
            u64(e.l1Block),
            u64(e.stamp),
            u64(e.gasLimit),
            hex(BigInt(e.root).toString(16).padStart(64, "0")),
            hex(e.record),
          ]),
        ),
      );
      expect(bytesToHex(callHash), m.record).toBe(m.callHash);
      expect(m.callHash === call.callHash ? "match" : "relay-unmatched", m.record).toBe(m.result);
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
