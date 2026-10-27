// The contract-event record, record type 0x0008 versions 1 to 12
// (docs/spec/contracts.md, Contract-event record): one log of one of our L2
// contracts exactly as the event accumulator hashes it, and the event check
// that ties it to the contract a definition names and to the event tables of
// that contract's section. The versions share a layout and differ only in
// their tables: version 2 adds the board's events and reads the registries'
// events as the deployable registries emit them, and version 3 adds the
// board's relayed-ballot and close-statement events (the close rule, T-50,
// T-35), version 4 the board's share-receipt and share-complaint batch events
// (T-25, P1-12d, P1-12e), version 5 its obligation-root event (T-25,
// T-52, P1-12f), version 6 the group registry's Tier 1 addition event
// (T-53, P3-3), version 7 its two self-paid events (T-25, T-53, P3-2), and
// version 8 the board's availability attestation and complaint events (T-24,
// T-53, P4-3), and version 9 the election registry's author panel
// registration with the board's framing of ballot version 4 and the
// version-2 delivery records, which name their seat's panel (T-37, T-53,
// P2-16), version 10 the board's rolling ballot event, which carries the
// root a version-5 ballot was proved against (T-25, T-52, P2-17), and version
// 11 its relayed rolling ballot event, which carries the relay call's fields
// and root as well (T-50, T-71, P2-17), and version 12 replaces the trustee
// registry's `PanelPinned` with one that logs each panel's kind, which the
// election registry reads to refuse a civic-record poll under a panel that
// isn't independent (T-14, T-53, P2-16).
// The accumulator's storage proofs are the only
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
  decodeAvailabilityAttestation,
  decodeAvailabilityComplaint,
  MAX_ATTESTED_ROOTS,
} from "./availability.ts";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  decode,
  list,
  struct,
  bytesVar,
  BN254_R,
  u64,
} from "./codec.ts";
import type { ArchivedContractLog } from "./event-accumulator.ts";
import {
  decodeGroupAddition,
  decodeGroupRemoval,
  GROUP_REGISTRY_MAX_REGISTRARS,
  isForbiddenCommitment,
  type GroupAddition,
  type GroupRemoval,
} from "./group-registry.ts";
import { decodeCloseStatement } from "./close-statement.ts";
import {
  COMPLAINT_BATCH_MAX,
  decodeObligationRoot,
  decodeShareReceiptBatch,
  OBLIGATION_ROOT_LENGTH,
  OBLIGATION_ROOT_LENGTH_V2,
  RECEIPT_BATCH_MAX,
} from "./delivery.ts";
import {
  type BoardFraming,
  frameBallot,
  frameComplaintBatch,
  frameDelivery,
  frameRollingBallot,
} from "./direct-submit.ts";
import {
  type AnyElectionDefinitionRecord,
  decodeElectionDefinitionRecord,
  decodeRegistrableElectionDefinition,
} from "./protocol.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { MAX_TRUSTEES, p256Key } from "./trustee.ts";
import { decodeTier1Addition, VOUCH_K, VOUCH_LENGTH } from "./vouch.ts";

/**
 * `MAX_EVENT_DATA`: the framing bound on a record's `data`, checked before
 * anything is allocated (T-52). Every event of any version's tables is far
 * smaller: version 1's largest, a `MembersAdded`, is 25,120 bytes, version
 * 2's a framed `BallotSubmitted`, about 175 KB, version 9's a framed
 * `BallotSubmitted` carrying ballot version 4, about 209 KB, and versions
 * 10's and 11's a rolling event carrying ballot version 5, that with the
 * step's 4 bytes and the root's word (and, for the relayed one, its four call
 * fields' 128 bytes); version 12's `PanelPinned` is 32 bytes more than
 * version 1's, its kind's word. An event that needs more is a new record
 * version.
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

/**
 * Record type 0x0008, versions 1 to 12 (docs/spec/contracts.md,
 * Contract-event record): one layout, with each version's own event tables.
 */
export const CONTRACT_EVENT = recordType(RECORD_TYPES.contractEvent, {
  1: contractEventV1,
  2: contractEventV1,
  3: contractEventV1,
  4: contractEventV1,
  5: contractEventV1,
  6: contractEventV1,
  7: contractEventV1,
  8: contractEventV1,
  9: contractEventV1,
  10: contractEventV1,
  11: contractEventV1,
  12: contractEventV1,
});

const SCHEMA = new RecordSchema([CONTRACT_EVENT]);

export type ContractEventRecord = CodecValue<typeof contractEventV1>;

/** The record's versions; the profile pins one for every contract's events. */
export type ContractEventVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export function encodeContractEvent(
  record: ContractEventRecord,
  version: ContractEventVersion,
): Uint8Array {
  return SCHEMA.encode(CONTRACT_EVENT, version, record);
}

/** Strictly decodes a contract-event record under the version the profile pins. */
export function decodeContractEvent(
  bytes: Uint8Array,
  pinned: ContractEventVersion,
): ContractEventRecord {
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
      /** Version 1 only under record version 1; 1 and 3 to 6 under version 2. */
      readonly decoded: AnyElectionDefinitionRecord;
    }
  | {
      readonly event: "PanelPinned";
      readonly panelId: Uint8Array;
      readonly threshold: number;
      readonly quorum: number;
      /**
       * The panel's kind, 1 (`independent`) or 2 (`transitional`), under
       * version 12, whose `PanelPinned` logs it; absent under versions 1 to
       * 11. Verifier 2.5 judges `panel-kind` by the kind its release pins,
       * never this one.
       */
      readonly kind?: PanelKindWord;
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
      readonly event: "AuthorPanelRegistered";
      readonly definitionHash: Uint8Array;
      /** The `authorPanelId` topic, which is the registration's own `panel_id`. */
      readonly authorPanelId: Uint8Array;
      /** The registration, in the trustee registry's key-set layout; 3.1 judges it. */
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
    }
  | {
      readonly event:
        | "BallotSubmitted"
        | "ShareReceiptSubmitted"
        | "SharePosted"
        | "ShareComplaintSubmitted";
      readonly definitionHash: Uint8Array;
      /** The record's own `ballot_hash`; a ballot's, recomputed from its bytes. */
      readonly ballotHash: Uint8Array;
      /** The record the board accepted, framed as the board frames it. */
      readonly record: Uint8Array;
    }
  | {
      readonly event: "RelayedBallotSubmitted";
      readonly definitionHash: Uint8Array;
      /** The ballot's hash, recomputed from its bytes. */
      readonly ballotHash: Uint8Array;
      /** The relay call's index, L1 block, stamp and gas limit, as the deposit named them. */
      readonly index: bigint;
      readonly l1Block: bigint;
      readonly stamp: bigint;
      readonly gasLimit: bigint;
      /** The ballot record, framed as the board frames it. */
      readonly record: Uint8Array;
    }
  | {
      readonly event: "RollingBallotSubmitted";
      readonly definitionHash: Uint8Array;
      /** The ballot's hash, recomputed from its bytes. */
      readonly ballotHash: Uint8Array;
      /**
       * The root the submitter supplied, a non-zero field element; whether it
       * is the root of the step the ballot names is verifier 5.1's.
       */
      readonly root: bigint;
      /** The version-5 ballot record, framed as the board frames it. */
      readonly record: Uint8Array;
    }
  | {
      readonly event: "RelayedRollingBallotSubmitted";
      readonly definitionHash: Uint8Array;
      /** The ballot's hash, recomputed from its bytes. */
      readonly ballotHash: Uint8Array;
      /** The relay call's index, L1 block, stamp and gas limit, as the deposit named them. */
      readonly index: bigint;
      readonly l1Block: bigint;
      readonly stamp: bigint;
      readonly gasLimit: bigint;
      /** The root the relay call carried, a non-zero field element. */
      readonly root: bigint;
      /** The version-5 ballot record, framed as the board frames it. */
      readonly record: Uint8Array;
    }
  | {
      readonly event: "CloseStatementSubmitted";
      readonly definitionHash: Uint8Array;
      readonly signer: number;
      /** The close statement, which decodes strictly as version 1. */
      readonly record: Uint8Array;
    }
  | {
      readonly event: "ShareReceiptBatchSubmitted";
      readonly definitionHash: Uint8Array;
      readonly seat: number;
      /** The share-receipt batch, which decodes strictly as version 1. */
      readonly record: Uint8Array;
    }
  | {
      readonly event: "ShareComplaintBatchSubmitted";
      readonly definitionHash: Uint8Array;
      readonly seat: number;
      /** The share-complaint batch, framed as the board frames version 1. */
      readonly record: Uint8Array;
    }
  | {
      readonly event: "ObligationRootSubmitted";
      readonly definitionHash: Uint8Array;
      readonly seat: number;
      /** The obligation root, which decodes strictly as version 1. */
      readonly record: Uint8Array;
    }
  | {
      readonly event: "Tier1MemberAdded";
      /** The Tier 1 addition record, which decodes strictly (docs/spec/vouching.md). */
      readonly record: Uint8Array;
    }
  | { readonly event: "SelfPaidGroupCreated"; readonly groupId: bigint }
  | {
      readonly event: "SelfPaidMemberAdded";
      /** The `groupId` topic; the record's own `group_id` is 2.4's to compare. */
      readonly groupId: bigint;
      /** The `index` topic the registry assigned. */
      readonly index: bigint;
      /** The self-paid record, exactly 40 bytes. */
      readonly record: Uint8Array;
      readonly commitment: bigint;
    }
  | {
      readonly event: "AvailabilityAttestationSubmitted" | "AvailabilityComplaintSubmitted";
      readonly definitionHash: Uint8Array;
      readonly seat: number;
      /** The availability attestation or complaint, which decodes strictly as version 1. */
      readonly record: Uint8Array;
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

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

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

// Version 1's allocation bound, above the largest version-1 definition (every
// list at its maximum: 717 bytes), so any definition that could decode
// reaches the decoder, which alone decides. Version 2's is `MAX_EVENT_DATA`:
// its definitions run to about 66 KB.
const MAX_DEFINITION_V1 = 4096;

function definitionRegistered(
  max: number,
  decodeDefinition: (bytes: Uint8Array) => AnyElectionDefinitionRecord,
): EventSpec {
  return {
    signature: "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)",
    decode(topics, data) {
      const [, electionId, definitionHash] = topics;
      if (topics.length !== 3 || electionId === undefined || definitionHash === undefined)
        return "event-topics";
      const abi = readAbi(data, 4, [{ at: 3, words: false, max }]);
      const origin = abi && l1Origin(abi.words, 0);
      const definition = abi?.tails[0];
      if (origin === undefined || definition === undefined) return "event-data";
      let decoded: AnyElectionDefinitionRecord;
      try {
        decoded = decodeDefinition(definition);
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
}

// Version 1 with its self-pin, as the first registry decoded it.
const DEFINITION_REGISTERED = definitionRegistered(MAX_DEFINITION_V1, (b) => {
  const record = decodeElectionDefinitionRecord(b);
  if (record.version !== 1) throw new DecodeError("unknown-version", 2);
  return record;
});

// Versions 1 and 3 to 6, each with its self-pin, as the registry decodes them (rule 2).
const DEFINITION_REGISTERED_V2 = definitionRegistered(
  MAX_EVENT_DATA,
  decodeRegistrableElectionDefinition,
);

/** A panel's kind as the trustee registry logs it: 1 `independent`, 2 `transitional`. */
export type PanelKindWord = 1 | 2;

// The kinds the trustee registry pins (docs/spec/contracts.md, Trustee
// registry, Deployment, check 7). Any other word, 0 and 3 included, is no
// kind the registry emits, so it fails `event-data`, and a canonical `uint8`
// word with a valid low byte but a high bit set never reads as that kind
// (T-31, T-53).
function panelKindWord(w: Uint8Array): PanelKindWord | undefined {
  const v = uintWord(w, 8);
  return v === 1n || v === 2n ? (Number(v) as PanelKindWord) : undefined;
}

// Version 1's `PanelPinned(bytes32,uint8,uint8,bytes)`, data `abi.encode(k,
// q, keys)`; and version 12's `PanelPinned(bytes32,uint8,uint8,uint8,bytes)`,
// data `abi.encode(k, q, kind, keys)` with the keys' offset `0x80`. Version
// 1's data under version 12's topic fails, since its third word is the
// offset `0x60`, never a kind (T-31).
function panelPinned(withKind: boolean): EventSpec {
  const head = withKind ? 4 : 3;
  return {
    signature: withKind
      ? "PanelPinned(bytes32,uint8,uint8,uint8,bytes)"
      : "PanelPinned(bytes32,uint8,uint8,bytes)",
    decode(topics, data) {
      const [, panelId] = topics;
      if (topics.length !== 2 || panelId === undefined) return "event-topics";
      const abi = readAbi(data, head, [{ at: head - 1, words: false, max: 33 * MAX_TRUSTEES }]);
      const threshold = abi && uintWord(word(abi.words, 0), 8);
      const quorum = abi && uintWord(word(abi.words, 1), 8);
      const kind = withKind ? abi && panelKindWord(word(abi.words, 2)) : undefined;
      const encodings = abi?.tails[0];
      if (
        threshold === undefined ||
        quorum === undefined ||
        (withKind && kind === undefined) ||
        encodings === undefined
      )
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
        ...(kind === undefined ? {} : { kind }),
        keys,
      };
    },
  };
}

const PANEL_PINNED = panelPinned(false);
const PANEL_PINNED_V12 = panelPinned(true);

// `panel_id ‖ stub_hash ‖ ceremony_transcript_hash`, then version 1's
// `u8(count) ‖ (u8 ‖ p256-sig) × count`, or version 2's `u8(seats) ‖ seat ×
// seats ‖ u8(count) ‖ approval × count`, each seat `u8 ‖ bytes[32] ‖ x ‖ y`.
const REGISTRATION_HEADER = 97;
const REGISTRATION_SEAT = 97;
const REGISTRATION_APPROVAL = 65;

function ceremonyRegistered(
  lengthOk: (registration: Uint8Array) => boolean,
  max: number,
): EventSpec {
  return {
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
      const registration = readAbi(data, 1, [{ at: 0, words: false, max }])?.tails[0];
      if (registration === undefined || !lengthOk(registration)) return "event-data";
      return {
        event: "CeremonyRegistered",
        stubHash: stubHash.slice(),
        panelId: panelId.slice(),
        transcriptHash: transcriptHash.slice(),
        registration,
      };
    },
  };
}

// Version 1's length rule: exactly the header and the approvals its count
// byte names, the trustee registry's first layout, frozen with version 1.
const CEREMONY_REGISTERED = ceremonyRegistered(
  (r) => {
    const count = r[REGISTRATION_HEADER - 1];
    return count !== undefined && r.length === REGISTRATION_HEADER + REGISTRATION_APPROVAL * count;
  },
  REGISTRATION_HEADER + 255 * REGISTRATION_APPROVAL,
);

// Version 2's: the key-set layout the registry takes (Trustee registry,
// Registration, check 2), exactly `98 + 97 · seats + 65 · count` bytes.
function keySetLayout(r: Uint8Array): boolean {
  const seats = r[REGISTRATION_HEADER - 1];
  if (seats === undefined) return false;
  const countAt = REGISTRATION_HEADER + REGISTRATION_SEAT * seats;
  const count = r[countAt];
  return count !== undefined && r.length === countAt + 1 + REGISTRATION_APPROVAL * count;
}

const KEY_SET_MAX = REGISTRATION_HEADER + 1 + 255 * (REGISTRATION_SEAT + REGISTRATION_APPROVAL);

const CEREMONY_REGISTERED_V2 = ceremonyRegistered(keySetLayout, KEY_SET_MAX);

// The author panel's key set, which the election registry records with the
// definition (Election registry, Author panel registration and Events): the
// trustee registry's key-set layout, as version 2's `CeremonyRegistered`,
// and the `authorPanelId` topic must be the record's `panel_id`, so the
// event's two readings of the panel agree (T-31, T-37). The registry's check
// 2 makes that the definition's author panel identifier, so every record it
// logs passes (T-53); the `definitionHash` topic, the stub, the transcript,
// the seats and the approvals are 3.1's, which reads the definition.
const AUTHOR_PANEL_REGISTERED: EventSpec = {
  signature: "AuthorPanelRegistered(bytes32,bytes32,bytes)",
  decode(topics, data) {
    const [, definitionHash, authorPanelId] = topics;
    if (topics.length !== 3 || definitionHash === undefined || authorPanelId === undefined)
      return "event-topics";
    const registration = readAbi(data, 1, [{ at: 0, words: false, max: KEY_SET_MAX }])?.tails[0];
    if (
      registration === undefined ||
      !keySetLayout(registration) ||
      !equalBytes(registration.subarray(0, 32), authorPanelId)
    )
      return "event-data";
    return {
      event: "AuthorPanelRegistered",
      definitionHash: definitionHash.slice(),
      authorPanelId: authorPanelId.slice(),
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

// The board's events (Board, Events): each carries the record it accepted
// whole, with its `definition_hash` and `ballot_hash` as the topics. The
// record must be one the board frames, and the topics exactly what it names
// (a ballot's hash recomputed from its bytes), so a topic can't disagree
// with its record (T-31) and no event carries a byte the record doesn't
// define (T-17).
function boardEvent(
  name: "BallotSubmitted" | "ShareReceiptSubmitted" | "SharePosted" | "ShareComplaintSubmitted",
  frame: (record: Uint8Array) => { definitionHash: Uint8Array; ballotHash: Uint8Array } | undefined,
): EventSpec {
  return {
    signature: `${name}(bytes32,bytes32,bytes)`,
    decode(topics, data) {
      const [, definitionHash, ballotHash] = topics;
      if (topics.length !== 3 || definitionHash === undefined || ballotHash === undefined)
        return "event-topics";
      const record = readAbi(data, 1, [{ at: 0, words: false, max: MAX_EVENT_DATA }])?.tails[0];
      const framed = record && frame(record);
      if (
        record === undefined ||
        framed === undefined ||
        !equalBytes(framed.definitionHash, definitionHash) ||
        !equalBytes(framed.ballotHash, ballotHash)
      )
        return "event-data";
      return {
        event: name,
        definitionHash: definitionHash.slice(),
        ballotHash: ballotHash.slice(),
        record,
      };
    },
  };
}

// A ballot forced through the L1 relay (Board, Relayed ballots): the relay
// call's four fields, which verifier 4.5 matches against the call hash the
// relay stored, then the record, framed as an ordinary submission's is.
function relayedBallotSubmitted(framing: BoardFraming): EventSpec {
  return {
    signature: "RelayedBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes)",
    decode(topics, data) {
      const [, definitionHash, ballotHash] = topics;
      if (topics.length !== 3 || definitionHash === undefined || ballotHash === undefined)
        return "event-topics";
      const abi = readAbi(data, 5, [{ at: 4, words: false, max: MAX_EVENT_DATA }]);
      if (abi === undefined) return "event-data";
      const [index, l1Block, stamp, gasLimit] = [0, 1, 2, 3].map((i) =>
        uintWord(word(abi.words, i), 64),
      );
      const record = abi.tails[0];
      const framed = record && frameBallot(record, framing);
      if (
        index === undefined ||
        l1Block === undefined ||
        stamp === undefined ||
        gasLimit === undefined ||
        record === undefined ||
        framed === undefined ||
        !equalBytes(framed.definitionHash, definitionHash) ||
        !equalBytes(framed.ballotHash, ballotHash)
      )
        return "event-data";
      return {
        event: "RelayedBallotSubmitted",
        definitionHash: definitionHash.slice(),
        ballotHash: ballotHash.slice(),
        index,
        l1Block,
        stamp,
        gasLimit,
        record,
      };
    },
  };
}

const RELAYED_BALLOT_SUBMITTED = relayedBallotSubmitted(8);

// A rolling root as the board's membership check takes it (Membership
// proofs, `signal` and `root`): a canonical `field<bn254>` word other than 0.
function rollingRoot(word: Uint8Array): bigint | undefined {
  const v = bigEndian(word);
  return v !== 0n && v < BN254_R ? v : undefined;
}

// The ballot of either rolling event: version 5 alone, framed as the rolling
// calls frame it, with the topics recomputed from its bytes (What the board
// frames (version 10); T-31).
function rollingBallot(
  record: Uint8Array,
  definitionHash: Uint8Array,
  ballotHash: Uint8Array,
): boolean {
  const framed = frameRollingBallot(record);
  return (
    framed !== undefined &&
    equalBytes(framed.definitionHash, definitionHash) &&
    equalBytes(framed.ballotHash, ballotHash)
  );
}

// A rolling poll's direct submission (Board, Rolling ballots):
// `abi.encode(root, record)`, the record's offset 0x40.
const ROLLING_BALLOT_SUBMITTED: EventSpec = {
  signature: "RollingBallotSubmitted(bytes32,bytes32,bytes32,bytes)",
  decode(topics, data) {
    const [, definitionHash, ballotHash] = topics;
    if (topics.length !== 3 || definitionHash === undefined || ballotHash === undefined)
      return "event-topics";
    const abi = readAbi(data, 2, [{ at: 1, words: false, max: MAX_EVENT_DATA }]);
    const root = abi && rollingRoot(word(abi.words, 0));
    const record = abi?.tails[0];
    if (
      root === undefined ||
      record === undefined ||
      !rollingBallot(record, definitionHash, ballotHash)
    )
      return "event-data";
    return {
      event: "RollingBallotSubmitted",
      definitionHash: definitionHash.slice(),
      ballotHash: ballotHash.slice(),
      root,
      record,
    };
  },
};

// A rolling ballot forced through the L1 relay (Board, Relayed rolling
// ballots): `abi.encode(index, l1Block, stamp, gasLimit, root, record)`, the
// record's offset 0xc0, so neither this event's data nor
// `RelayedBallotSubmitted`'s (offset 0xa0) reads under the other's topic.
// Verifier 4.5 matches the four fields and the root against the call hash
// the relay stored under its rolling tag.
const RELAYED_ROLLING_BALLOT_SUBMITTED: EventSpec = {
  signature:
    "RelayedRollingBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes32,bytes)",
  decode(topics, data) {
    const [, definitionHash, ballotHash] = topics;
    if (topics.length !== 3 || definitionHash === undefined || ballotHash === undefined)
      return "event-topics";
    const abi = readAbi(data, 6, [{ at: 5, words: false, max: MAX_EVENT_DATA }]);
    if (abi === undefined) return "event-data";
    const [index, l1Block, stamp, gasLimit] = [0, 1, 2, 3].map((i) =>
      uintWord(word(abi.words, i), 64),
    );
    const root = rollingRoot(word(abi.words, 4));
    const record = abi.tails[0];
    if (
      index === undefined ||
      l1Block === undefined ||
      stamp === undefined ||
      gasLimit === undefined ||
      root === undefined ||
      record === undefined ||
      !rollingBallot(record, definitionHash, ballotHash)
    )
      return "event-data";
    return {
      event: "RelayedRollingBallotSubmitted",
      definitionHash: definitionHash.slice(),
      ballotHash: ballotHash.slice(),
      index,
      l1Block,
      stamp,
      gasLimit,
      root,
      record,
    };
  },
};

// A close statement through the contract path (Board, Close statements): the
// record whole, which decodes strictly as version 1, the version contract-event
// version 3 fixes, with its `definition_hash` and `signer` as the topics. The
// signature's verification and the seat are the verifier's (close.md, Close
// head), as the board judged them when it accepted the record.
const CLOSE_STATEMENT_LENGTH = 180;

const CLOSE_STATEMENT_SUBMITTED: EventSpec = {
  signature: "CloseStatementSubmitted(bytes32,uint8,bytes)",
  decode(topics, data) {
    const [, definitionHash, signerWord] = topics;
    const signer = signerWord && uintWord(signerWord, 8);
    if (topics.length !== 3 || definitionHash === undefined || signer === undefined)
      return "event-topics";
    const record = readAbi(data, 1, [{ at: 0, words: false, max: CLOSE_STATEMENT_LENGTH }])
      ?.tails[0];
    if (record === undefined) return "event-data";
    let statement;
    try {
      statement = decodeCloseStatement(record, 1);
    } catch (e) {
      if (e instanceof DecodeError) return "event-data";
      throw e;
    }
    if (
      !equalBytes(statement.definition_hash, definitionHash) ||
      BigInt(statement.signer) !== signer
    )
      return "event-data";
    return {
      event: "CloseStatementSubmitted",
      definitionHash: definitionHash.slice(),
      signer: statement.signer,
      record,
    };
  },
};

// A share-receipt batch through the contract path (Board, Delivery records):
// the record whole, which decodes strictly as version 1, the version
// contract-event version 4 fixes, with its `definition_hash` and `seat` as
// the topics. Its signature and pairs are the delivery check's.
const BATCH_LENGTH_MAX = 104 + 64 * RECEIPT_BATCH_MAX;

const SHARE_RECEIPT_BATCH_SUBMITTED: EventSpec = {
  signature: "ShareReceiptBatchSubmitted(bytes32,uint8,bytes)",
  decode(topics, data) {
    const [, definitionHash, seatWord] = topics;
    const seat = seatWord && uintWord(seatWord, 8);
    if (topics.length !== 3 || definitionHash === undefined || seat === undefined)
      return "event-topics";
    const record = readAbi(data, 1, [{ at: 0, words: false, max: BATCH_LENGTH_MAX }])?.tails[0];
    if (record === undefined) return "event-data";
    let batch;
    try {
      batch = decodeShareReceiptBatch(record, 1);
    } catch (e) {
      if (e instanceof DecodeError) return "event-data";
      throw e;
    }
    if (!equalBytes(batch.definition_hash, definitionHash) || BigInt(batch.seat) !== seat)
      return "event-data";
    return {
      event: "ShareReceiptBatchSubmitted",
      definitionHash: definitionHash.slice(),
      seat: batch.seat,
      record,
    };
  },
};

// A share-complaint batch through the contract path: the record whole,
// framed as the board frames it, each `D` never decoded, so a batch the
// board emits always passes (T-53); the delivery check decodes it strictly.
const COMPLAINT_BATCH_LENGTH_MAX = 104 + 128 * COMPLAINT_BATCH_MAX;

const SHARE_COMPLAINT_BATCH_SUBMITTED: EventSpec = {
  signature: "ShareComplaintBatchSubmitted(bytes32,uint8,bytes)",
  decode(topics, data) {
    const [, definitionHash, seatWord] = topics;
    const seat = seatWord && uintWord(seatWord, 8);
    if (topics.length !== 3 || definitionHash === undefined || seat === undefined)
      return "event-topics";
    const record = readAbi(data, 1, [{ at: 0, words: false, max: COMPLAINT_BATCH_LENGTH_MAX }])
      ?.tails[0];
    const framed = record && frameComplaintBatch(record);
    if (
      record === undefined ||
      framed === undefined ||
      !equalBytes(framed.definitionHash, definitionHash) ||
      BigInt(framed.seat) !== seat
    )
      return "event-data";
    return {
      event: "ShareComplaintBatchSubmitted",
      definitionHash: definitionHash.slice(),
      seat: framed.seat,
      record,
    };
  },
};

// An obligation root through the contract path (Board, Delivery records):
// the record whole, which decodes strictly as version 1, the version
// contract-event version 5 fixes, with its `definition_hash` and `seat` as
// the topics. Its signature, slot, count and leaves are the delivery check's.

const OBLIGATION_ROOT_SUBMITTED: EventSpec = {
  signature: "ObligationRootSubmitted(bytes32,uint8,bytes)",
  decode(topics, data) {
    const [, definitionHash, seatWord] = topics;
    const seat = seatWord && uintWord(seatWord, 8);
    if (topics.length !== 3 || definitionHash === undefined || seat === undefined)
      return "event-topics";
    const record = readAbi(data, 1, [{ at: 0, words: false, max: OBLIGATION_ROOT_LENGTH }])
      ?.tails[0];
    if (record === undefined) return "event-data";
    let root;
    try {
      root = decodeObligationRoot(record, 1);
    } catch (e) {
      if (e instanceof DecodeError) return "event-data";
      throw e;
    }
    if (!equalBytes(root.definition_hash, definitionHash) || BigInt(root.seat) !== seat)
      return "event-data";
    return {
      event: "ObligationRootSubmitted",
      definitionHash: definitionHash.slice(),
      seat: root.seat,
      record,
    };
  },
};

// Version 9's batches and roots (What the board frames (version 9)): a record
// of version 1, read as versions 4 and 5 read it, or of version 2, which puts
// its `panel` at 35 and its `seat` at 36, so the seat topic is recomputed
// from the bytes under the record's own version, and a version-2 record
// whose topic is its panel byte, or a version-1 record relabelled, fails
// `event-data` (T-31). A version-2 record carries its panel, which the
// topics don't repeat: a reader finding a seat's records by topic finds both
// panels' and tells them apart by the record (T-37). Any other version fails
// `event-data`; whether a record's version is the one its election's ballot
// version fixes is the delivery check's (verifier 5.9).
function batchOrRootV9(
  event: "ShareReceiptBatchSubmitted" | "ShareComplaintBatchSubmitted" | "ObligationRootSubmitted",
  max: number,
  read: (
    record: Uint8Array,
  ) => { readonly definitionHash: Uint8Array; readonly seat: number } | undefined,
): EventSpec {
  return {
    signature: `${event}(bytes32,uint8,bytes)`,
    decode(topics, data) {
      const [, definitionHash, seatWord] = topics;
      const seat = seatWord && uintWord(seatWord, 8);
      if (topics.length !== 3 || definitionHash === undefined || seat === undefined)
        return "event-topics";
      const record = readAbi(data, 1, [{ at: 0, words: false, max }])?.tails[0];
      if (record === undefined) return "event-data";
      let named;
      try {
        named = read(record);
      } catch (e) {
        if (e instanceof DecodeError) return "event-data";
        throw e;
      }
      if (
        named === undefined ||
        !equalBytes(named.definitionHash, definitionHash) ||
        BigInt(named.seat) !== seat
      )
        return "event-data";
      return { event, definitionHash: definitionHash.slice(), seat: named.seat, record };
    },
  };
}

// Each decoded strictly under its own version byte; a version-2 record's
// `seat` is the one after its `panel`.
const SHARE_RECEIPT_BATCH_SUBMITTED_V9 = batchOrRootV9(
  "ShareReceiptBatchSubmitted",
  BATCH_LENGTH_MAX + 1,
  (r) => {
    const batch =
      r[2] === 1
        ? decodeShareReceiptBatch(r, 1)
        : r[2] === 2
          ? decodeShareReceiptBatch(r, 2)
          : undefined;
    return batch && { definitionHash: batch.definition_hash, seat: batch.seat };
  },
);

// Framed, each `D` never decoded, as the board frames it under version 9.
const SHARE_COMPLAINT_BATCH_SUBMITTED_V9 = batchOrRootV9(
  "ShareComplaintBatchSubmitted",
  COMPLAINT_BATCH_LENGTH_MAX + 1,
  (r) => frameComplaintBatch(r, 9),
);

const OBLIGATION_ROOT_SUBMITTED_V9 = batchOrRootV9(
  "ObligationRootSubmitted",
  OBLIGATION_ROOT_LENGTH_V2,
  (r) => {
    const root =
      r[2] === 1 ? decodeObligationRoot(r, 1) : r[2] === 2 ? decodeObligationRoot(r, 2) : undefined;
    return root && { definitionHash: root.definition_hash, seat: root.seat };
  },
);

// An availability attestation or complaint through the contract path (Board,
// Availability records): the record whole, which decodes strictly as version
// 1, the version contract-event version 8 fixes, with its `definition_hash`
// and `seat` as the topics. Each event carries only its own type, so the
// other's record fails as any other decoding does. Its panel, seat,
// signature, roots, checkpoint and time are the availability check's.
const ATTESTATION_LENGTH_MAX = 138 + 32 * MAX_ATTESTED_ROOTS;
const AVAILABILITY_COMPLAINT_LENGTH = 170;

function availabilityEvent(
  event: "AvailabilityAttestationSubmitted" | "AvailabilityComplaintSubmitted",
  max: number,
  decodeRecord: (record: Uint8Array) => {
    readonly definition_hash: Uint8Array;
    readonly seat: number;
  },
): EventSpec {
  return {
    signature: `${event}(bytes32,uint8,bytes)`,
    decode(topics, data) {
      const [, definitionHash, seatWord] = topics;
      const seat = seatWord && uintWord(seatWord, 8);
      if (topics.length !== 3 || definitionHash === undefined || seat === undefined)
        return "event-topics";
      const record = readAbi(data, 1, [{ at: 0, words: false, max }])?.tails[0];
      if (record === undefined) return "event-data";
      let decoded;
      try {
        decoded = decodeRecord(record);
      } catch (e) {
        if (e instanceof DecodeError) return "event-data";
        throw e;
      }
      if (!equalBytes(decoded.definition_hash, definitionHash) || BigInt(decoded.seat) !== seat)
        return "event-data";
      return { event, definitionHash: definitionHash.slice(), seat: decoded.seat, record };
    },
  };
}

const AVAILABILITY_ATTESTATION_SUBMITTED = availabilityEvent(
  "AvailabilityAttestationSubmitted",
  ATTESTATION_LENGTH_MAX,
  (r) => decodeAvailabilityAttestation(r, 1),
);

const AVAILABILITY_COMPLAINT_SUBMITTED = availabilityEvent(
  "AvailabilityComplaintSubmitted",
  AVAILABILITY_COMPLAINT_LENGTH,
  (r) => decodeAvailabilityComplaint(r, 1),
);

// A Tier 1 addition (Group registry, Tier 1 additions): the record whole,
// which decodes strictly as docs/spec/vouching.md decodes it, and no topic beyond
// topic 0, since the group is the record's. The registry refuses every
// record that doesn't decode (rules 2, 4, 5 and 7), so every one it logs
// passes (T-53); whether it counts is the counting rule's.
const TIER1_ADDITION_LENGTH = 8 + 32 + 1 + VOUCH_K * VOUCH_LENGTH;

const TIER1_MEMBER_ADDED: EventSpec = {
  signature: "Tier1MemberAdded(bytes)",
  decode(topics, data) {
    if (topics.length !== 1) return "event-topics";
    const record = readAbi(data, 1, [{ at: 0, words: false, max: TIER1_ADDITION_LENGTH }])
      ?.tails[0];
    if (record === undefined || !decodeTier1Addition(record).ok) return "event-data";
    return { event: "Tier1MemberAdded", record };
  },
};

// The self-paid path (Group registry, Self-paid additions). A self-paid
// group's creation logs its identifier only, since its tier is always 0. An
// addition carries `u64(group_id) ‖ field<bn254>(commitment)` whole, with the
// registry's stateless checks, exactly 40 bytes and a commitment that isn't
// forbidden (rules 2 and 6), so every record it logs passes (T-53); the
// group's kind, the topic against the record and the index against the
// group's count are 2.4's replay (Group registry, Verification).
const SELF_PAID_RECORD_LENGTH = 40;

const SELF_PAID_GROUP_CREATED: EventSpec = {
  signature: "SelfPaidGroupCreated(uint64)",
  decode(topics, data) {
    const [, g] = topics;
    const groupId = g && uintWord(g, 64);
    if (topics.length !== 2 || groupId === undefined) return "event-topics";
    if (data.length !== 0) return "event-data";
    return { event: "SelfPaidGroupCreated", groupId };
  },
};

const SELF_PAID_MEMBER_ADDED: EventSpec = {
  signature: "SelfPaidMemberAdded(uint64,uint64,bytes)",
  decode(topics, data) {
    const [, g, i] = topics;
    const groupId = g && uintWord(g, 64);
    const index = i && uintWord(i, 64);
    if (topics.length !== 3 || groupId === undefined || index === undefined) return "event-topics";
    const record = readAbi(data, 1, [{ at: 0, words: false, max: SELF_PAID_RECORD_LENGTH }])
      ?.tails[0];
    if (record === undefined || record.length !== SELF_PAID_RECORD_LENGTH) return "event-data";
    const commitment = bigEndian(record.subarray(8));
    if (isForbiddenCommitment(commitment)) return "event-data";
    return { event: "SelfPaidMemberAdded", groupId, index, record, commitment };
  },
};

function boardEvents(framing: BoardFraming): readonly EventSpec[] {
  return [
    boardEvent("BallotSubmitted", (r) => frameBallot(r, framing)),
    boardEvent("ShareReceiptSubmitted", (r) =>
      frameDelivery(RECORD_TYPES.shareReceipt, r, framing),
    ),
    boardEvent("SharePosted", (r) => frameDelivery(RECORD_TYPES.sharePosting, r, framing)),
    boardEvent("ShareComplaintSubmitted", (r) =>
      frameDelivery(RECORD_TYPES.shareComplaint, r, framing),
    ),
  ];
}

const BOARD_EVENTS = boardEvents(8);

// Version 9's board rows, which versions 10 and 11 keep in the same order.
const BOARD_EVENTS_V9: readonly EventSpec[] = [
  ...boardEvents(9),
  relayedBallotSubmitted(9),
  CLOSE_STATEMENT_SUBMITTED,
  SHARE_RECEIPT_BATCH_SUBMITTED_V9,
  SHARE_COMPLAINT_BATCH_SUBMITTED_V9,
  OBLIGATION_ROOT_SUBMITTED_V9,
  AVAILABILITY_ATTESTATION_SUBMITTED,
  AVAILABILITY_COMPLAINT_SUBMITTED,
];

const GROUP_EVENTS: readonly EventSpec[] = [
  REGISTRARS_PINNED,
  GROUP_CREATED,
  MEMBERS_ADDED,
  MEMBERS_REMOVED,
];

// Frozen with each version's vectors (docs/spec/versioning.md): a later
// change to any contract's events is a new version's table.
const TABLES: Readonly<
  Record<ContractEventVersion, Readonly<Record<ContractRole, readonly EventSpec[]>>>
> = {
  1: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED],
    "group-registry": GROUP_EVENTS,
    // Version 1 has no board events: a frozen version's tables never gain one.
    board: [],
  },
  2: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": GROUP_EVENTS,
    board: BOARD_EVENTS,
  },
  // Version 2's rows, with the close rule's two board events added.
  3: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": GROUP_EVENTS,
    board: [...BOARD_EVENTS, RELAYED_BALLOT_SUBMITTED, CLOSE_STATEMENT_SUBMITTED],
  },
  // Version 3's rows, with the two batches' events added.
  4: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": GROUP_EVENTS,
    board: [
      ...BOARD_EVENTS,
      RELAYED_BALLOT_SUBMITTED,
      CLOSE_STATEMENT_SUBMITTED,
      SHARE_RECEIPT_BATCH_SUBMITTED,
      SHARE_COMPLAINT_BATCH_SUBMITTED,
    ],
  },
  // Version 4's rows, with the obligation root's event added.
  5: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": GROUP_EVENTS,
    board: [
      ...BOARD_EVENTS,
      RELAYED_BALLOT_SUBMITTED,
      CLOSE_STATEMENT_SUBMITTED,
      SHARE_RECEIPT_BATCH_SUBMITTED,
      SHARE_COMPLAINT_BATCH_SUBMITTED,
      OBLIGATION_ROOT_SUBMITTED,
    ],
  },
  // Version 5's rows, with the group registry's Tier 1 addition event added.
  6: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": [...GROUP_EVENTS, TIER1_MEMBER_ADDED],
    board: [
      ...BOARD_EVENTS,
      RELAYED_BALLOT_SUBMITTED,
      CLOSE_STATEMENT_SUBMITTED,
      SHARE_RECEIPT_BATCH_SUBMITTED,
      SHARE_COMPLAINT_BATCH_SUBMITTED,
      OBLIGATION_ROOT_SUBMITTED,
    ],
  },
  // Version 6's rows, with the group registry's two self-paid events added.
  7: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": [
      ...GROUP_EVENTS,
      TIER1_MEMBER_ADDED,
      SELF_PAID_GROUP_CREATED,
      SELF_PAID_MEMBER_ADDED,
    ],
    board: [
      ...BOARD_EVENTS,
      RELAYED_BALLOT_SUBMITTED,
      CLOSE_STATEMENT_SUBMITTED,
      SHARE_RECEIPT_BATCH_SUBMITTED,
      SHARE_COMPLAINT_BATCH_SUBMITTED,
      OBLIGATION_ROOT_SUBMITTED,
    ],
  },
  // Version 7's rows, with the board's two availability events added.
  8: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": [
      ...GROUP_EVENTS,
      TIER1_MEMBER_ADDED,
      SELF_PAID_GROUP_CREATED,
      SELF_PAID_MEMBER_ADDED,
    ],
    board: [
      ...BOARD_EVENTS,
      RELAYED_BALLOT_SUBMITTED,
      CLOSE_STATEMENT_SUBMITTED,
      SHARE_RECEIPT_BATCH_SUBMITTED,
      SHARE_COMPLAINT_BATCH_SUBMITTED,
      OBLIGATION_ROOT_SUBMITTED,
      AVAILABILITY_ATTESTATION_SUBMITTED,
      AVAILABILITY_COMPLAINT_SUBMITTED,
    ],
  },
  // Version 8's rows, in the same order, with the election registry's author
  // panel registration added and the board's eight rows that carry a ballot
  // or a delivery record reading them under version 9's framing.
  9: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2, AUTHOR_PANEL_REGISTERED],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": [
      ...GROUP_EVENTS,
      TIER1_MEMBER_ADDED,
      SELF_PAID_GROUP_CREATED,
      SELF_PAID_MEMBER_ADDED,
    ],
    board: BOARD_EVENTS_V9,
  },
  // Version 9's rows, every one unchanged, with the board's rolling ballot
  // event added.
  10: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2, AUTHOR_PANEL_REGISTERED],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": [
      ...GROUP_EVENTS,
      TIER1_MEMBER_ADDED,
      SELF_PAID_GROUP_CREATED,
      SELF_PAID_MEMBER_ADDED,
    ],
    board: [...BOARD_EVENTS_V9, ROLLING_BALLOT_SUBMITTED],
  },
  // Version 10's rows, every one unchanged, with the board's relayed rolling
  // ballot event added.
  11: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2, AUTHOR_PANEL_REGISTERED],
    "trustee-registry": [PANEL_PINNED, CEREMONY_REGISTERED_V2],
    "group-registry": [
      ...GROUP_EVENTS,
      TIER1_MEMBER_ADDED,
      SELF_PAID_GROUP_CREATED,
      SELF_PAID_MEMBER_ADDED,
    ],
    board: [...BOARD_EVENTS_V9, ROLLING_BALLOT_SUBMITTED, RELAYED_ROLLING_BALLOT_SUBMITTED],
  },
  // Version 11's rows, every one unchanged but the trustee registry's
  // `PanelPinned`, replaced in place by the one that logs the kind.
  12: {
    "election-registry": [ELECTION_CREATED, DEFINITION_REGISTERED_V2, AUTHOR_PANEL_REGISTERED],
    "trustee-registry": [PANEL_PINNED_V12, CEREMONY_REGISTERED_V2],
    "group-registry": [
      ...GROUP_EVENTS,
      TIER1_MEMBER_ADDED,
      SELF_PAID_GROUP_CREATED,
      SELF_PAID_MEMBER_ADDED,
    ],
    board: [...BOARD_EVENTS_V9, ROLLING_BALLOT_SUBMITTED, RELAYED_ROLLING_BALLOT_SUBMITTED],
  },
};

const ROLES = ["election-registry", "trustee-registry", "group-registry", "board"] as const;
const VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const BY_TOPIC: ReadonlyMap<
  ContractEventVersion,
  ReadonlyMap<ContractRole, ReadonlyMap<string, EventSpec>>
> = new Map(
  VERSIONS.map((v) => [
    v,
    new Map(
      ROLES.map((role) => [
        role,
        new Map(TABLES[v][role].map((e) => [hexOf(keccak_256(utf8.encode(e.signature))), e])),
      ]),
    ),
  ]),
);

/**
 * Each version's event signatures by role, in table order (topic 0 of each
 * is the keccak-256 of its signature). A third party's own tables can be
 * compared with these, and the contracts' ABI is (packages/contracts).
 */
export const CONTRACT_EVENT_SIGNATURES: Readonly<
  Record<ContractEventVersion, Readonly<Record<ContractRole, readonly string[]>>>
> = Object.freeze({
  1: signaturesOf(1),
  2: signaturesOf(2),
  3: signaturesOf(3),
  4: signaturesOf(4),
  5: signaturesOf(5),
  6: signaturesOf(6),
  7: signaturesOf(7),
  8: signaturesOf(8),
  9: signaturesOf(9),
  10: signaturesOf(10),
  11: signaturesOf(11),
  12: signaturesOf(12),
});

function signaturesOf(v: ContractEventVersion): Readonly<Record<ContractRole, readonly string[]>> {
  return Object.freeze(
    Object.fromEntries(
      ROLES.map((r) => [r, Object.freeze(TABLES[v][r].map((e) => e.signature))]),
    ) as Record<ContractRole, readonly string[]>,
  );
}

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
 * The event check of docs/spec/contracts.md (Contract-event record), under
 * the version the profile pins: the record's contract is one of the
 * definition's L2 contracts, its topic 0 is an event of that contract's
 * table in that version, its topics are that event's, each indexed value
 * canonical for its type, and its data is the canonical ABI encoding of the
 * event's other fields, every embedded record decoding (or, for the board's,
 * framed) as the contract decodes it. Reports the first that fails, in that
 * order. It checks the log's form only: whether the log is the contract's is
 * the accumulator's (`checkEventAccumulatorProof` over `contractEventLog`),
 * and what the fields mean is for the checks that use them (verifier 2.1 to
 * 3.1, 5).
 */
export function checkContractEvent(
  record: ContractEventRecord,
  contracts: EventContracts,
  version: ContractEventVersion,
): ContractEventResult {
  const role = roleOf(contracts, record.contract);
  if (role === undefined) return { ok: false, error: "unknown-contract" };
  const [topic0] = record.topics;
  const spec = topic0 && BY_TOPIC.get(version)?.get(role)?.get(hexOf(topic0));
  if (spec === undefined) return { ok: false, error: "unknown-event" };
  const event = spec.decode(record.topics, record.data);
  return typeof event === "string" ? { ok: false, error: event } : { ok: true, role, event };
}
