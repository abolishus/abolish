// Which events the indexer subscribes to: every event in each L2 contract's
// generated ABI. Ponder fetches only the logs of events with a handler, so a
// contract's sequence is complete in `contract_log` only if every one of its
// events has one; deriving the list from the ABIs keeps an event a later
// contract version adds from being skipped silently (T-71, T-25).

import {
  boardAbi,
  electionRegistryAbi,
  groupRegistryAbi,
  trusteeRegistryAbi,
} from "@abolishus/contracts/abi";
import type { ContractName } from "./env.ts";

export const INDEXED_ABIS = {
  ElectionRegistry: electionRegistryAbi,
  TrusteeRegistry: trusteeRegistryAbi,
  GroupRegistry: groupRegistryAbi,
  Board: boardAbi,
} as const satisfies Record<ContractName, readonly { type: string }[]>;

/** Every `Contract:Event` Ponder must handle, in ABI order. */
export function indexedEvents(): `${ContractName}:${string}`[] {
  return (Object.keys(INDEXED_ABIS) as ContractName[]).flatMap((contract) =>
    (INDEXED_ABIS[contract] as readonly { type: string; name?: string }[])
      .filter((item) => item.type === "event")
      .map((item) => `${contract}:${item.name}` as const),
  );
}
