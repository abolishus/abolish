// What the node verifies an election against, read from L2: its creation and
// its registered definition from the election registry, and the panel the
// definition names from the trustee registry (docs/spec/contracts.md,
// Election registry and Trustee registry). Every log must pass the event
// check of the contract-event record (`checkContractEvent`), so nothing but
// the canonical encoding of an event the contract declares is read.
//
// The L2 node is trusted here for which logs exist: no reader proves them
// yet ([[verifier]] 2.1, 3.1 and 4.4 are the checks that will). The verifier
// reports the definition and the panel as local inputs, so a node that lies
// can leave an election unverified or change what its report finds against
// those inputs, never make it verify (T-53, T-71).

import {
  type AnyElectionDefinitionRecord,
  checkContractEvent,
  type ContractEvent,
  type ContractEventRecord,
  type ContractEventVersion,
  type ElectionDefinitionV7Record,
  type EventContracts,
  type L1Origin,
  type Panel,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { type Rpc, RpcError } from "./rpc.ts";

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const topic = (signature: string) => keccak_256(new TextEncoder().encode(signature));

export const ELECTION_CREATED = topic(
  "ElectionCreated(bytes32,address,uint64,uint64,uint64,bytes32)",
);
export const DEFINITION_REGISTERED = topic(
  "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)",
);
export const PANEL_PINNED = topic("PanelPinned(bytes32,uint8,uint8,uint8,bytes)");
export const AVAILABILITY_ATTESTATION_SUBMITTED = topic(
  "AvailabilityAttestationSubmitted(bytes32,uint8,bytes)",
);
export const AVAILABILITY_COMPLAINT_SUBMITTED = topic(
  "AvailabilityComplaintSubmitted(bytes32,uint8,bytes)",
);

/**
 * The contract-event version this release reads: the newest whose tables hold
 * every event the deployable contracts emit, version 12, whose `PanelPinned`
 * logs the kind the trustee registry pins each panel with (P2-16 part 5e-2);
 * the other events read here are the same in every version from 2 on. The
 * verifier judges the logs again under the version the definition pins (4.4).
 */
export const READ_VERSION: ContractEventVersion = 12;

/** Why an election couldn't be read from L2; the election is reported and skipped. */
export type L2ErrorCode =
  /** No `ElectionCreated` for it in finalized L2 history. */
  | "l2-creation-missing"
  /** No `DefinitionRegistered` for it in finalized L2 history: not registered, or not final yet. */
  | "l2-definition-missing"
  /** More than one of either, which the registry never emits. */
  | "l2-repeated"
  /** No `PanelPinned` for the definition's panel in finalized L2 history. */
  | "l2-panel-missing";

export class L2Error extends Error {
  override readonly name = "L2Error";
  readonly code: L2ErrorCode;
  constructor(code: L2ErrorCode) {
    super(code);
    this.code = code;
  }
}

/** The L2 node's finalized block number: logs above it may still be reorganised away. */
export async function l2Finalized(rpc: Rpc): Promise<bigint> {
  const block = (await rpc.call("eth_getBlockByNumber", ["finalized", false])) as {
    number?: unknown;
  } | null;
  const number = block?.number;
  if (typeof number !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/u.test(number))
    throw new RpcError("eth_getBlockByNumber: not a block");
  return BigInt(number);
}

const WORD = /^0x[0-9a-fA-F]{64}$/u;
const QUANTITY_64 = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/u;

/**
 * The logs `address` emitted from `fromBlock` to `toBlock` matching
 * `topics`, as contract-event records. `n` and `l2_timestamp` are 0: the
 * event check reads neither, and nothing here replays the accumulator. A log
 * of another address, of another shape, outside the range or marked removed
 * (reorganised away) is dropped.
 */
export async function contractLogs(
  rpc: Rpc,
  address: Uint8Array,
  topics: readonly (Uint8Array | readonly Uint8Array[])[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ContractEventRecord[]> {
  return (await readLogs(rpc, address, topics, fromBlock, toBlock)).map((l) => l.record);
}

/**
 * Every log `address` emitted from `fromBlock` to `toBlock`, as
 * contract-event records numbered from 0 in the node's order, each with its
 * block's timestamp, for the accumulator's replay
 * (`checkEventAccumulatorProof`). The timestamp is the log's
 * `blockTimestamp` where the node gives one, and otherwise its block's, one
 * request per block. Nothing here is trusted: the replay against a proven
 * accumulator fails a log dropped, added, reordered or given another block
 * or time, so the node can only make it fail. Dropped as `contractLogs`
 * drops them, and so is a log with no topic, which no contract of ours
 * emits.
 */
export async function contractSequence(
  rpc: Rpc,
  address: Uint8Array,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ContractEventRecord[]> {
  const logs = await readLogs(rpc, address, [], fromBlock, toBlock);
  const times = new Map<bigint, bigint>();
  const records: ContractEventRecord[] = [];
  for (const { record, blockTimestamp } of logs) {
    if (record.topics.length === 0) continue;
    let time = blockTimestamp ?? times.get(record.l2_block);
    if (time === undefined) {
      const block = (await rpc.call("eth_getBlockByNumber", [
        `0x${record.l2_block.toString(16)}`,
        false,
      ])) as { number?: unknown; timestamp?: unknown } | null;
      if (u64Quantity(block?.number, "eth_getBlockByNumber") !== record.l2_block)
        throw new RpcError("eth_getBlockByNumber: another block");
      time = u64Quantity(block?.timestamp, "eth_getBlockByNumber");
      times.set(record.l2_block, time);
    }
    records.push({ ...record, n: BigInt(records.length), l2_timestamp: time });
  }
  return records;
}

function u64Quantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !QUANTITY_64.test(value))
    throw new RpcError(`${what}: not a u64 quantity`);
  return BigInt(value);
}

async function readLogs(
  rpc: Rpc,
  address: Uint8Array,
  topics: readonly (Uint8Array | readonly Uint8Array[])[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ record: ContractEventRecord; blockTimestamp: bigint | undefined }[]> {
  const logs = await rpc.call("eth_getLogs", [
    {
      address: hex(address),
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      topics: topics.map((t) => (t instanceof Uint8Array ? hex(t) : t.map(hex))),
    },
  ]);
  if (!Array.isArray(logs)) throw new RpcError("eth_getLogs: not a list");
  const out: { record: ContractEventRecord; blockTimestamp: bigint | undefined }[] = [];
  for (const log of logs) {
    const l = (log ?? {}) as {
      address?: unknown;
      topics?: unknown;
      data?: unknown;
      blockNumber?: unknown;
      blockTimestamp?: unknown;
      removed?: unknown;
    };
    const blockNumber = l.blockNumber;
    if (
      l.removed === true ||
      typeof l.address !== "string" ||
      l.address.toLowerCase() !== hex(address) ||
      !Array.isArray(l.topics) ||
      l.topics.length > 4 ||
      !l.topics.every((t) => typeof t === "string" && WORD.test(t)) ||
      typeof l.data !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})*$/u.test(l.data) ||
      typeof blockNumber !== "string" ||
      !QUANTITY_64.test(blockNumber) ||
      BigInt(blockNumber) < fromBlock ||
      BigInt(blockNumber) > toBlock
    )
      continue;
    out.push({
      record: {
        contract: Uint8Array.from(address),
        n: 0n,
        l2_block: BigInt(blockNumber),
        l2_timestamp: 0n,
        topics: (l.topics as string[]).map((t) => hexToBytes(t.slice(2))),
        data: hexToBytes(l.data.slice(2)),
      },
      blockTimestamp:
        typeof l.blockTimestamp === "string" && QUANTITY_64.test(l.blockTimestamp)
          ? BigInt(l.blockTimestamp)
          : undefined,
    });
  }
  return out;
}

/** An election as the election registry created and registered it. */
export interface Registration {
  /** The definition's canonical encoding, as `DefinitionRegistered` carries it. */
  readonly definition: Uint8Array;
  /** Never version 7 under `READ_VERSION` 12, which fails its registration. */
  readonly decoded: AnyElectionDefinitionRecord | ElectionDefinitionV7Record;
  /** The L1 origin of the creation, which fixes the election's first segment. */
  readonly created: L1Origin;
}

// The registry's own role only: until the definition is read, no other
// contract of it is known, and a zero address is no contract's.
const registryOnly = (registry: Uint8Array): EventContracts => ({
  electionRegistry: registry,
  trusteeRegistry: new Uint8Array(20),
  groupRegistry: new Uint8Array(20),
  board: new Uint8Array(20),
});

const same = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b);

/**
 * The election's one `ElectionCreated` and one `DefinitionRegistered` from
 * `registry`, in finalized history up to `toBlock`. Throws `L2Error` when
 * either is missing or repeated, `RpcError` when the node's answer can't be
 * read.
 */
export async function registration(
  rpc: Rpc,
  registry: Uint8Array,
  electionId: Uint8Array,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Registration> {
  const logs = await contractLogs(
    rpc,
    registry,
    [[ELECTION_CREATED, DEFINITION_REGISTERED], electionId],
    fromBlock,
    toBlock,
  );
  const created: Extract<ContractEvent, { event: "ElectionCreated" }>[] = [];
  const registered: Extract<ContractEvent, { event: "DefinitionRegistered" }>[] = [];
  // A log failing the event check, or naming another election, is no
  // evidence of this one's: it is passed over, as a withheld log would be.
  for (const record of logs) {
    const checked = checkContractEvent(record, registryOnly(registry), READ_VERSION);
    if (!checked.ok || !("electionId" in checked.event)) continue;
    if (!same(checked.event.electionId, electionId)) continue;
    if (checked.event.event === "ElectionCreated") created.push(checked.event);
    else if (checked.event.event === "DefinitionRegistered") registered.push(checked.event);
  }
  if (created.length > 1 || registered.length > 1) throw new L2Error("l2-repeated");
  const [creation] = created;
  const [definition] = registered;
  if (creation === undefined) throw new L2Error("l2-creation-missing");
  if (definition === undefined) throw new L2Error("l2-definition-missing");
  return {
    definition: definition.definition,
    decoded: definition.decoded,
    created: creation.l1Origin,
  };
}

/**
 * The panel `panelId` names, from its one `PanelPinned` log of the
 * definition's trustee registry up to `toBlock`. Throws `L2Error` when it is
 * missing or repeated, `RpcError` when the node's answer can't be read.
 */
export async function pinnedPanel(
  rpc: Rpc,
  contracts: EventContracts,
  panelId: Uint8Array,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Panel> {
  const logs = await contractLogs(
    rpc,
    contracts.trusteeRegistry,
    [PANEL_PINNED, panelId],
    fromBlock,
    toBlock,
  );
  const panels: Panel[] = [];
  for (const record of logs) {
    const checked = checkContractEvent(record, contracts, READ_VERSION);
    if (checked.ok && checked.event.event === "PanelPinned" && same(checked.event.panelId, panelId))
      panels.push({ threshold: checked.event.threshold, keys: checked.event.keys });
  }
  if (panels.length > 1) throw new L2Error("l2-repeated");
  const [panel] = panels;
  if (panel === undefined) throw new L2Error("l2-panel-missing");
  return panel;
}
