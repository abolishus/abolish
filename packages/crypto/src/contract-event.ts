// The contract-event record, record type 0x0008 version 1
// (docs/spec/contracts.md, Contract-event record): one log of one of our L2
// contracts exactly as the event accumulator hashes it, and the event check
// that ties it to the contract a definition names and to the event tables of
// that contract's section. The accumulator's storage proofs are the only
// evidence archived with it: no transaction, receipt or header, so the
// archive holds no bytes our contracts didn't define (T-17;
// docs/adr/0025-contract-event-evidence.md). The event check refuses any log
// whose topics or data aren't the canonical ABI encoding of an event the
// contract declares, with every embedded record decoding as the contract
// decodes it, so nothing outside a field's defined bytes rides along (T-17,
// T-31) and a record from a contract the election doesn't name never counts
// (T-71).

import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  decode,
  list,
  struct,
  bytesVar,
  u64,
} from "./codec.ts";
import type { ArchivedContractLog } from "./event-accumulator.ts";
import {
  decodeGroupAddition,
  decodeGroupRemoval,
  GROUP_REGISTRY_MAX_REGISTRARS,
  type GroupAddition,
  type GroupRemoval,
} from "./group-registry.ts";
import type { ElectionDefinition } from "./election-definition.ts";
import { decodeElectionDefinition } from "./protocol.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { MAX_TRUSTEES, p256Key } from "./trustee.ts";

/**
 * `MAX_EVENT_DATA`: the framing bound on a record's `data`, checked before
 * anything is allocated (T-52). Every event of version 1's tables is far
 * smaller (the largest, a `MembersAdded`, is at most 25,120 bytes); an
 * event that needs more is a new record version.
 */
export const MAX_EVENT_DATA = 1 << 20;

/** A log has 1 to 4 topics, `topics[0]` its signature hash; the event check enforces the 1. */
export const MAX_EVENT_TOPICS = 4;

const contractEventV1 = struct([
  ["contract", bytesFixed(20)],
  ["n", u64],
  ["l2_block", u64],
  ["l2_timestamp", u64],
  ["topics", list(bytesFixed(32), MAX_EVENT_TOPICS)],
  ["data", bytesVar(MAX_EVENT_DATA)],
] as const);

/** Record type 0x0008, version 1 (docs/spec/contracts.md, Contract-event record). */
export const CONTRACT_EVENT = recordType(RECORD_TYPES.contractEvent, { 1: contractEventV1 });

const SCHEMA = new RecordSchema([CONTRACT_EVENT]);

export type ContractEventRecord = CodecValue<typeof contractEventV1>;

export function encodeContractEvent(record: ContractEventRecord): Uint8Array {
  return SCHEMA.encode(CONTRACT_EVENT, 1, record);
}

/** Strictly decodes a contract-event record under the version the profile pins. */
export function decodeContractEvent(bytes: Uint8Array, pinned: 1): ContractEventRecord {
  return SCHEMA.decode(CONTRACT_EVENT, bytes, pinned).value;
}

/**
 * The record as the event accumulator replays it (docs/spec/contracts.md,
 * Event accumulator, Verification), for `checkEventAccumulatorProof` over
 * one contract's records in order of `n`.
 */
export function contractEventLog(record: ContractEventRecord): ArchivedContractLog {
  return {
    n: record.n,
    block: record.l2_block,
    timestamp: record.l2_timestamp,
    topics: record.topics,
    data: record.data,
  };
}

/** The roles of a definition's L2 contracts that emit events (docs/spec/contracts.md). */
export type ContractRole = "election-registry" | "trustee-registry" | "group-registry" | "board";

/** The definition's L2 contract addresses, by role. */
export interface EventContracts {
  readonly electionRegistry: Uint8Array;
  readonly trusteeRegistry: Uint8Array;
  readonly groupRegistry: Uint8Array;
  readonly board: Uint8Array;
}

/** The event check's codes, in the order it runs (docs/spec/contracts.md, Event check). */
export type ContractEventError =
  | "unknown-contract"
  | "unknown-event"
  | "event-topics"
  | "event-data";

/** An L1 block as the `L1Block` predeploy reported it in the emitting call. */
export interface L1Origin {
  readonly number: bigint;
  readonly timestamp: bigint;
  readonly hash: Uint8Array;
}

/** A log that passed the event check, with its fields decoded. */
export type ContractEvent =
  | {
      readonly event: "ElectionCreated";
      readonly electionId: Uint8Array;
      readonly creator: Uint8Array;
      readonly counter: bigint;
      readonly l1Origin: L1Origin;
    }
  | {
      readonly event: "DefinitionRegistered";
      readonly electionId: Uint8Array;
      readonly definitionHash: Uint8Array;
      readonly l1Origin: L1Origin;
      /** The definition's canonical encoding, as the event carries it. */
      readonly definition: Uint8Array;
      readonly decoded: ElectionDefinition;
    }
  | {
      readonly event: "PanelPinned";
      readonly panelId: Uint8Array;
      readonly threshold: number;
      readonly quorum: number;
      readonly keys: readonly Uint8Array[];
    }
  | {
      readonly event: "CeremonyRegistered";
      readonly stubHash: Uint8Array;
      readonly panelId: Uint8Array;
      readonly transcriptHash: Uint8Array;
      readonly registration: Uint8Array;
    }
  | {
      readonly event: "RegistrarsPinned";
      readonly threshold: number;
      readonly registrars: readonly Uint8Array[];
    }
  | { readonly event: "GroupCreated"; readonly groupId: bigint; readonly tier: number }
  | {
      readonly event: "MembersAdded";
      readonly groupId: bigint;
      readonly firstIndex: bigint;
      readonly record: Uint8Array;
      readonly addition: GroupAddition;
    }
  | {
      readonly event: "MembersRemoved";
      readonly groupId: bigint;
      readonly record: Uint8Array;
      readonly removal: GroupRemoval;
    };

export type ContractEventResult =
  | { readonly ok: true; readonly role: ContractRole; readonly event: ContractEvent }
  | { readonly ok: false; readonly error: ContractEventError };

// What a decoder of one event returns: its fields, or which part failed.
type EventDecode = ContractEvent | "event-topics" | "event-data";

interface EventSpec {
  readonly signature: string;
  readonly decode: (topics: readonly Uint8Array[], data: Uint8Array) => EventDecode;
}

const utf8 = new TextEncoder();

function bigEndian(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

// A 32-byte ABI word whose value is below `2^bits`: the canonical encoding of
// a `uint<bits>` (an `address` is 160 bits), or undefined if a high bit is set.
function uintWord(word: Uint8Array, bits: number): bigint | undefined {
  const v = bigEndian(word);
  return v >> BigInt(bits) === 0n ? v : undefined;
}

const addressOf = (word: Uint8Array) => word.slice(12);

/**
 * Reads the canonical ABI encoding of an event's non-indexed fields: `head`
 * static words, of which the dynamic fields' offset words are given by
 * `dynamic` (in order), each pointing exactly past the previous tail, each
 * tail a length word and that many bytes (or words, for an array) with zero
 * padding, and nothing after. Returns the head words and each dynamic
 * field's contents, or undefined for any other bytes.
 */
function readAbi(
  data: Uint8Array,
  head: number,
  dynamic: readonly { readonly at: number; readonly words: boolean; readonly max: number }[],
): { readonly words: Uint8Array[]; readonly tails: Uint8Array[] } | undefined {
  if (data.length < 32 * head) return undefined;
  const words = Array.from({ length: head }, (_, i) => data.subarray(32 * i, 32 * i + 32));
  const tails: Uint8Array[] = [];
  let next = 32 * head;
  for (const d of dynamic) {
    const offset = words[d.at];
    if (offset === undefined || uintWord(offset, 64) !== BigInt(next)) return undefined;
    if (data.length < next + 32) return undefined;
    const count = uintWord(data.subarray(next, next + 32), 64);
    // The bound is checked before the length is used (T-52).
    if (count === undefined || count > BigInt(d.max)) return undefined;
    const length = d.words ? 32 * Number(count) : Number(count);
    const padded = 32 * Math.ceil(length / 32);
    if (data.length < next + 32 + padded) return undefined;
    const body = data.subarray(next + 32, next + 32 + length);
    if (data.subarray(next + 32 + length, next + 32 + padded).some((b) => b !== 0))
      return undefined;
    tails.push(body.slice());
    next += 32 + padded;
  }
  return next === data.length ? { words, tails } : undefined;
}

const word = (words: readonly Uint8Array[], i: number) => words[i] ?? new Uint8Array(32);

function l1Origin(words: readonly Uint8Array[], at: number): L1Origin | undefined {
  const number = uintWord(word(words, at), 64);
  const timestamp = uintWord(word(words, at + 1), 64);
  if (number === undefined || timestamp === undefined) return undefined;
  return { number, timestamp, hash: word(words, at + 2).slice() };
}

const ELECTION_CREATED: EventSpec = {
  signature: "ElectionCreated(bytes32,address,uint64,uint64,uint64,bytes32)",
  decode(topics, data) {
    const [, electionId, creator] = topics;
    if (topics.length !== 3 || electionId === undefined || creator === undefined)
      return "event-topics";
    if (uintWord(creator, 160) === undefined) return "event-topics";
    const abi = readAbi(data, 4, []);
    const counter = abi && uintWord(word(abi.words, 0), 64);
    const origin = abi && l1Origin(abi.words, 1);
    if (counter === undefined || origin === undefined) return "event-data";
    return {
      event: "ElectionCreated",
      electionId: electionId.slice(),
      creator: addressOf(creator),
      counter,
      l1Origin: origin,
    };
  },
};

// An allocation bound only, above the largest version-1 definition (every
// list at its maximum: 717 bytes), so any definition that could decode
// reaches the decoder, which alone decides.
const MAX_DEFINITION = 4096;

const DEFINITION_REGISTERED: EventSpec = {
  signature: "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)",
  decode(topics, data) {
    const [, electionId, definitionHash] = topics;
    if (topics.length !== 3 || electionId === undefined || definitionHash === undefined)
      return "event-topics";
    const abi = readAbi(data, 4, [{ at: 3, words: false, max: MAX_DEFINITION }]);
    const origin = abi && l1Origin(abi.words, 0);
    const definition = abi?.tails[0];
    if (origin === undefined || definition === undefined) return "event-data";
    // Version 1 with its self-pin, as the registry decodes it (rule 2).
    let decoded: ElectionDefinition;
    try {
      decoded = decodeElectionDefinition(definition);
    } catch (e) {
      if (e instanceof DecodeError) return "event-data";
      throw e;
    }
    return {
      event: "DefinitionRegistered",
      electionId: electionId.slice(),
      definitionHash: definitionHash.slice(),
      l1Origin: origin,
      definition,
      decoded,
    };
  },
};

const PANEL_PINNED: EventSpec = {
  signature: "PanelPinned(bytes32,uint8,uint8,bytes)",
  decode(topics, data) {
    const [, panelId] = topics;
    if (topics.length !== 2 || panelId === undefined) return "event-topics";
    const abi = readAbi(data, 3, [{ at: 2, words: false, max: 33 * MAX_TRUSTEES }]);
    const threshold = abi && uintWord(word(abi.words, 0), 8);
    const quorum = abi && uintWord(word(abi.words, 1), 8);
    const encodings = abi?.tails[0];
    if (threshold === undefined || quorum === undefined || encodings === undefined)
      return "event-data";
    if (encodings.length === 0 || encodings.length % 33 !== 0) return "event-data";
    const keys: Uint8Array[] = [];
    for (let i = 0; i < encodings.length; i += 33) {
      try {
        keys.push(decode(p256Key, encodings.subarray(i, i + 33)));
      } catch (e) {
        if (e instanceof DecodeError) return "event-data";
        throw e;
      }
    }
    return {
      event: "PanelPinned",
      panelId: panelId.slice(),
      threshold: Number(threshold),
      quorum: Number(quorum),
      keys,
    };
  },
};

// `panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(count) ‖ (u8 ‖ p256-sig) × count`.
const REGISTRATION_HEADER = 97;
const REGISTRATION_APPROVAL = 65;

const CEREMONY_REGISTERED: EventSpec = {
  signature: "CeremonyRegistered(bytes32,bytes32,bytes32,bytes)",
  decode(topics, data) {
    const [, stubHash, panelId, transcriptHash] = topics;
    if (
      topics.length !== 4 ||
      stubHash === undefined ||
      panelId === undefined ||
      transcriptHash === undefined
    )
      return "event-topics";
    const max = REGISTRATION_HEADER + 255 * REGISTRATION_APPROVAL;
    const registration = readAbi(data, 1, [{ at: 0, words: false, max }])?.tails[0];
    // The registry's length rule (Registration, check 2): exactly the header
    // and the approvals its count byte names.
    const count = registration?.[REGISTRATION_HEADER - 1];
    if (
      registration === undefined ||
      count === undefined ||
      registration.length !== REGISTRATION_HEADER + REGISTRATION_APPROVAL * count
    )
      return "event-data";
    return {
      event: "CeremonyRegistered",
      stubHash: stubHash.slice(),
      panelId: panelId.slice(),
      transcriptHash: transcriptHash.slice(),
      registration,
    };
  },
};

const REGISTRARS_PINNED: EventSpec = {
  signature: "RegistrarsPinned(uint8,address[])",
  decode(topics, data) {
    if (topics.length !== 1) return "event-topics";
    const abi = readAbi(data, 2, [{ at: 1, words: true, max: GROUP_REGISTRY_MAX_REGISTRARS }]);
    const threshold = abi && uintWord(word(abi.words, 0), 8);
    const list = abi?.tails[0];
    if (threshold === undefined || list === undefined) return "event-data";
    const registrars: Uint8Array[] = [];
    for (let i = 0; i < list.length; i += 32) {
      const w = list.subarray(i, i + 32);
      if (uintWord(w, 160) === undefined) return "event-data";
      registrars.push(addressOf(w));
    }
    return { event: "RegistrarsPinned", threshold: Number(threshold), registrars };
  },
};

const GROUP_CREATED: EventSpec = {
  signature: "GroupCreated(uint64,uint8)",
  decode(topics, data) {
    const [, g, t] = topics;
    const groupId = g && uintWord(g, 64);
    const tier = t && uintWord(t, 8);
    if (topics.length !== 3 || groupId === undefined || tier === undefined) return "event-topics";
    if (data.length !== 0) return "event-data";
    return { event: "GroupCreated", groupId, tier: Number(tier) };
  },
};

// The largest record the registry's stateless checks accept: a full batch and
// 255 approvals, the most its count byte can name.
const MAX_GROUP_RECORD = 18 + 32 * 256 + 1 + 66 * 255;

const MEMBERS_ADDED: EventSpec = {
  signature: "MembersAdded(uint64,uint64,bytes)",
  decode(topics, data) {
    const [, g, f] = topics;
    const groupId = g && uintWord(g, 64);
    const firstIndex = f && uintWord(f, 64);
    if (topics.length !== 3 || groupId === undefined || firstIndex === undefined)
      return "event-topics";
    const record = readAbi(data, 1, [{ at: 0, words: false, max: MAX_GROUP_RECORD }])?.tails[0];
    const addition = record && decodeGroupAddition(record);
    if (record === undefined || addition === undefined || !addition.ok) return "event-data";
    return { event: "MembersAdded", groupId, firstIndex, record, addition: addition.value };
  },
};

const MEMBERS_REMOVED: EventSpec = {
  signature: "MembersRemoved(uint64,bytes)",
  decode(topics, data) {
    const [, g] = topics;
    const groupId = g && uintWord(g, 64);
    if (topics.length !== 2 || groupId === undefined) return "event-topics";
    const record = readAbi(data, 1, [{ at: 0, words: false, max: MAX_GROUP_RECORD }])?.tails[0];
    const removal = record && decodeGroupRemoval(record);
    if (record === undefined || removal === undefined || !removal.ok) return "event-data";
    return { event: "MembersRemoved", groupId, record, removal: removal.value };
  },
};

const TABLES: Readonly<Record<ContractRole, readonly EventSpec[]>> = {
  "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED],
  "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED],
  "group-registry": [REGISTRARS_PINNED, GROUP_CREATED, MEMBERS_ADDED, MEMBERS_REMOVED],
  // Version 1 has no board events: they come in a later version of the
  // record with direct submission (P1-18), since a frozen version's tables
  // never gain one (docs/spec/versioning.md).
  board: [],
};

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const BY_TOPIC: ReadonlyMap<ContractRole, ReadonlyMap<string, EventSpec>> = new Map(
  (Object.keys(TABLES) as ContractRole[]).map((role) => [
    role,
    new Map(TABLES[role].map((e) => [hexOf(keccak_256(utf8.encode(e.signature))), e])),
  ]),
);

/**
 * Each role's event signatures, in table order, with topic 0 of each (the
 * keccak-256 of the signature). A third party's own tables can be compared
 * with these, and the contracts' ABI is (packages/contracts).
 */
export const CONTRACT_EVENT_SIGNATURES: Readonly<Record<ContractRole, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(TABLES) as ContractRole[]).map((r) => [
        r,
        Object.freeze(TABLES[r].map((e) => e.signature)),
      ]),
    ) as Record<ContractRole, readonly string[]>,
  );

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function roleOf(contracts: EventContracts, address: Uint8Array): ContractRole | undefined {
  const roles: readonly [ContractRole, Uint8Array][] = [
    ["election-registry", contracts.electionRegistry],
    ["trustee-registry", contracts.trusteeRegistry],
    ["group-registry", contracts.groupRegistry],
    ["board", contracts.board],
  ];
  // The definition's `chain` rule keeps the four addresses distinct, so at
  // most one role matches.
  return roles.find(([, a]) => equalBytes(a, address))?.[0];
}

/**
 * The event check of docs/spec/contracts.md (Contract-event record): the
 * record's contract is one of the definition's L2 contracts, its topic 0 is
 * an event of that contract's table, its topics are that event's, each
 * indexed value canonical for its type, and its data is the canonical ABI
 * encoding of the event's other fields, every embedded record decoding as
 * the contract decodes it. Reports the first that fails, in that order. It
 * checks the log's form only: whether the log is the contract's is the
 * accumulator's (`checkEventAccumulatorProof` over `contractEventLog`), and
 * what the fields mean is for the checks that use them (verifier 2.1 to 3.1).
 */
export function checkContractEvent(
  record: ContractEventRecord,
  contracts: EventContracts,
): ContractEventResult {
  const role = roleOf(contracts, record.contract);
  if (role === undefined) return { ok: false, error: "unknown-contract" };
  const [topic0] = record.topics;
  const spec = topic0 && BY_TOPIC.get(role)?.get(hexOf(topic0));
  if (spec === undefined) return { ok: false, error: "unknown-event" };
  const event = spec.decode(record.topics, record.data);
  return typeof event === "string" ? { ok: false, error: event } : { ok: true, role, event };
}
