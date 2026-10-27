// The deployment's registration check (docs/spec/share-encryption.md, Intake
// and receipts; [[verifier]] 2.1, 3.1's registration part and 3.2 from L2
// state, Registration): the election registry's `DefinitionRegistered` for
// the election and the trustee registry's `CeremonyRegistered` for its stub
// and panel, read from the seat's own L2 node, on the pinned chain, in
// finalized history from the election registry's deployment block, and
// judged by `packages/verifier`'s `registrationCheck` under the registries
// the configuration pins. A seat takes a ballot only once the registry holds
// the definition it checked, over the ceremony it approved with the key set
// its own transcript check returned, so no share it receipts is one of an
// election registered under other bytes or other keys (T-34, T-37, T-71).
//
// Reading the trustee registry from the election registry's deployment
// block misses no ceremony of this deployment's: a stub names an election
// the election registry created, and the panel approves only a stub it can
// check, so no honest ceremony is recorded before the registry existed; one
// that was would be missed, and the seat refuses (`ceremony-unregistered`).
//
// The L2 node is trusted for which logs exist, as for the electorate check
// (src/electorate.ts) and the node's other L2 reads: hiding a registration
// or a ceremony makes the seat refuse, never pass, since both must be shown;
// hiding a second registration, which the write-once registries never make,
// gains nothing. Whatever can't be decided (a node of another chain, one
// that can't be read, a registration not final yet) is a refusal.

import { chainId, contractLogs, l2Finalized, type Rpc, RpcError } from "@abolishus/node";
import { registrationCheck, type RegistrationRelease } from "@abolishus/verifier";
import { keccak256, toBytes } from "viem";
import type { RegistrationCheck } from "./intake.ts";
import { stubHash } from "./stub.ts";

const topic = (signature: string) => keccak256(toBytes(signature), "bytes");
const DEFINITION_REGISTERED = topic(
  "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)",
);
const CEREMONY_REGISTERED = topic("CeremonyRegistered(bytes32,bytes32,bytes32,bytes)");

export interface L2RegistrationOptions extends RegistrationRelease {
  /** The seat's own L2 node, deriving its finalized chain from L1. */
  readonly l2: Rpc;
  /** The election registry's deployment block: both registries are read from here. */
  readonly fromBlock: bigint;
}

/**
 * The `RegistrationCheck` over the seat's L2 node. Resolves `false` on a
 * node of another chain than the release's, for a definition the
 * registries' finalized logs don't show registered over the approved
 * ceremony and key set, and when the node can't be read.
 */
export function l2RegistrationCheck(options: L2RegistrationOptions): RegistrationCheck {
  const { l2, fromBlock, ...release } = options;
  return async (definition, keySetHash) => {
    const d = definition.value;
    try {
      // T-71: a node on another chain could show any contract's logs at the
      // pinned addresses.
      if ((await chainId(l2)) !== release.chainId) return false;
      // Nothing is asked of a range that is empty.
      const top = await l2Finalized(l2);
      if (top < fromBlock) return false;
      // Only the election's registration and its ceremony's, by their
      // indexed topics: nothing else of either registry can fail the check.
      const registered = await contractLogs(
        l2,
        release.electionRegistry,
        [DEFINITION_REGISTERED, d.election_id],
        fromBlock,
        top,
      );
      const recorded = await contractLogs(
        l2,
        release.trusteeRegistry,
        [CEREMONY_REGISTERED, stubHash(definition), d.panel_id],
        fromBlock,
        top,
      );
      return (
        registrationCheck(definition, keySetHash, [...recorded, ...registered], release).status ===
        "pass"
      );
    } catch (e) {
      if (e instanceof RpcError) return false;
      throw e;
    }
  };
}
