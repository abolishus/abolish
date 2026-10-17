// The stub step's deployment (P2-22 part 4b): every pin a stub carries, from
// one deployment record, checked against the chain before any stub is built.
// The registry sync's configuration names the L2's chain and contracts; the
// election registry at that address holds the rest of the deployment as
// immutables (the L1's chain, the board anchor and the relay), and each must
// be what the sync names, so the roots step's group registry, the sync's
// board and the stub's pins are one deployment. The default panel must be
// one the trustee registry pins, at its threshold, and the sync must read the
// contract-event version the stub's profile pins. Then core's
// `pollStubDeploymentRule` judges the whole of it as the registry's rules
// would. Anything else refuses to start: a stub that can't register would
// cost a ceremony and the poll (T-25, T-34, T-37).
//
// The node is trusted for none of it beyond startup: a node that lies here
// makes stubs the registry refuses, a poll lost, never a definition that
// verifies under other pins.

import { electionRegistryAbi, trusteeRegistryAbi } from "@abolishus/contracts/abi";
import {
  POLL_DEFINITION_PROFILE,
  type PollStubDeployment,
  pollStubDeploymentRule,
} from "@abolishus/core";
import { type ContractEventVersion, electionId, panelId, RECORD_TYPES } from "@abolishus/crypto";
import {
  type Address,
  bytesToHex,
  ContractFunctionExecutionError,
  getAddress,
  hexToBytes,
  type PublicClient,
} from "viem";
import type { PollStubConfig } from "./poll-stub-env.ts";

export interface PollStubPins {
  /** The L2's chain and contracts, as the registry sync names them. */
  readonly chainId: bigint;
  readonly l1ChainId: bigint;
  readonly electionRegistry: Address;
  readonly board: Address;
  readonly trusteeRegistry: Address;
  readonly groupRegistry: Address;
  /** The contract-event version the sync reads. */
  readonly eventVersion: ContractEventVersion;
}

/**
 * The startup check and the deployment every stub pins: throws, naming what
 * differs and nothing secret, unless the node is on `pins.chainId`, the
 * election registry there (at the finalized block) holds `pins`' board,
 * trustee and group registries and L1 chain, the trustee registry pins
 * `config.panel` at its threshold, the profile's contract-event pin is
 * `pins.eventVersion`, and core's rule accepts the result.
 */
export async function pollStubDeployment(
  client: PublicClient,
  pins: PollStubPins,
  config: PollStubConfig,
): Promise<PollStubDeployment> {
  const contractEvent = POLL_DEFINITION_PROFILE.pins.find(
    (p) => p.record_type === RECORD_TYPES.contractEvent,
  )?.version;
  if (contractEvent !== pins.eventVersion)
    throw new Error("the registry sync reads another contract-event version than stubs pin");
  const chainId = BigInt(await client.getChainId());
  if (chainId !== pins.chainId) throw new Error("the L2 node is on another chain");
  const blockNumber = (await client.getBlock({ blockTag: "finalized" })).number;
  const read = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      if (e instanceof ContractFunctionExecutionError) throw new Error(`the address isn't ${what}`);
      throw e;
    }
  };
  const registry = (
    functionName: "board" | "trusteeRegistry" | "groupRegistry" | "l1Anchor" | "l1Relay",
  ) =>
    read("an election registry", () =>
      client.readContract({
        address: pins.electionRegistry,
        abi: electionRegistryAbi,
        functionName,
        blockNumber,
      }),
    );
  const [first, board, trusteeRegistry, groupRegistry, l1Anchor, l1Relay, l1ChainId] =
    await Promise.all([
      read("an election registry", () =>
        client.readContract({
          address: pins.electionRegistry,
          abi: electionRegistryAbi,
          functionName: "electionIdAt",
          args: [0n],
          blockNumber,
        }),
      ),
      registry("board"),
      registry("trusteeRegistry"),
      registry("groupRegistry"),
      registry("l1Anchor"),
      registry("l1Relay"),
      read("an election registry", () =>
        client.readContract({
          address: pins.electionRegistry,
          abi: electionRegistryAbi,
          functionName: "l1ChainId",
          blockNumber,
        }),
      ),
    ]);
  // Numbered as the release's registry numbers them, as the creation step
  // checks too, so the stubs' registry is one with the release's rules.
  const want = electionId(pins.chainId, hexToBytes(getAddress(pins.electionRegistry)), 0n);
  if (first.toLowerCase() !== bytesToHex(want))
    throw new Error("the registry numbers its elections for another chain or address");
  for (const [name, held, named] of [
    ["board", board, pins.board],
    ["trustee registry", trusteeRegistry, pins.trusteeRegistry],
    ["group registry", groupRegistry, pins.groupRegistry],
  ] as const)
    if (getAddress(held) !== getAddress(named))
      throw new Error(`the election registry names another ${name}`);
  if (l1ChainId !== pins.l1ChainId) throw new Error("the election registry names another L1");
  const deployment: PollStubDeployment = {
    l2ChainId: pins.chainId,
    l1ChainId: pins.l1ChainId,
    electionRegistry: hexToBytes(getAddress(pins.electionRegistry)),
    board: hexToBytes(getAddress(pins.board)),
    trusteeRegistry: hexToBytes(getAddress(pins.trusteeRegistry)),
    groupRegistry: hexToBytes(getAddress(pins.groupRegistry)),
    l1Anchor: hexToBytes(getAddress(l1Anchor)),
    l1Relay: hexToBytes(getAddress(l1Relay)),
    panel: config.panel,
    receiptKeys: config.receiptKeys,
    l1InclusionBound: config.l1InclusionBound,
    sequencingWindow: config.sequencingWindow,
    maxSequencerDrift: config.maxSequencerDrift,
  };
  // The rule first: it judges the panel before its identifier is taken.
  const rule = pollStubDeploymentRule(deployment);
  if (rule !== undefined) throw new Error(`the stub's deployment breaks its rule: ${rule}`);
  // The identifier binds the threshold, the size and every key in seat
  // order, so a non-empty entry under it is this panel (T-37); the
  // threshold and size are compared as well, at no cost.
  const [threshold, size] = await read("a trustee registry", () =>
    client.readContract({
      address: pins.trusteeRegistry,
      abi: trusteeRegistryAbi,
      functionName: "panelOf",
      args: [bytesToHex(panelId(config.panel))],
      blockNumber,
    }),
  );
  if (size !== config.panel.keys.length || threshold !== config.panel.threshold)
    throw new Error("the trustee registry doesn't pin the panel");
  return deployment;
}
