// The deployment's electorate check (docs/spec/ceremony.md, Stub checks,
// step 3; [[verifier]] 2.4): the group registry's group events, from its
// deployment block to the stub's latest `root_l2_block`, read from the
// seat's own L2 node, on the pinned chain, in finalized history, and
// recounted by `packages/verifier`'s `electorateCheck` under the registry
// and registrars the configuration pins. A seat lends its keys only to a
// stub whose every tier is the one the registry's history makes, so no stub
// overstates a tier's anonymity set, puts a group under another tier's label
// or names a root no registered history reaches (T-13, T-16, T-06, T-71).
//
// The L2 node is trusted for which logs exist and their order, as for the
// node's other L2 reads (src/recorded.ts): the registry's event accumulator
// isn't proven against an output root here yet (part 3c). A node that hides
// logs can make the seat refuse an honest stub or pass an overstated one (a
// dropped trailing removal leaves a removed member counted; a hidden signed
// copy moves a member's region); one that reorders them changes which
// self-paid copy counts; one that invents them can't forge a signed group's
// records without the registrars' keys, but can invent a self-paid group's,
// which need no signature. The node is the seat's own, as for every duty,
// and the verifier's 2.4 and 4.4 still judge the board against the
// archive's replay (T-53, T-71). Whatever can't be decided (a block not
// final yet, a node that can't be read, a Tier 1 or Tier 2 tier) is a
// refusal, never a pass.

import type { ContractEventRecord } from "@abolishus/crypto";
import { chainId, contractLogs, l2Finalized, type Rpc, RpcError } from "@abolishus/node";
import { electorateCheck, type GroupRegistryRelease } from "@abolishus/verifier";
import { keccak256, toBytes } from "viem";
import type { ElectorateCheck } from "./stub.ts";

// Topic 0 of each event the recount reads ([[contracts]], Group registry):
// asking for these alone keeps an event no contract-event version this
// release reads decodes (T-36) from failing every stub, and keeps their
// order, which is all the first-occurrence rule ranks by.
const GROUP_EVENTS = [
  "RegistrarsPinned(uint8,address[])",
  "GroupCreated(uint64,uint8)",
  "MembersAdded(uint64,uint64,bytes)",
  "MembersRemoved(uint64,bytes)",
  "Tier1MemberAdded(bytes)",
  "SelfPaidGroupCreated(uint64)",
  "SelfPaidMemberAdded(uint64,uint64,bytes)",
].map((s) => keccak256(toBytes(s), "bytes"));

export interface L2ElectorateOptions extends GroupRegistryRelease {
  /** The seat's own L2 node, deriving its finalized chain from L1. */
  readonly l2: Rpc;
  /** The group registry's deployment block: its log is read from here. */
  readonly fromBlock: bigint;
}

/**
 * The `ElectorateCheck` over the seat's L2 node. Resolves `false` on a node
 * of another chain than the release's, for a stub
 * whose latest `root_l2_block` isn't finalized yet or precedes the
 * registry's deployment, or that the recount doesn't pass, and when the
 * node can't be read.
 */
export function l2ElectorateCheck(options: L2ElectorateOptions): ElectorateCheck {
  const { l2, fromBlock, ...release } = options;
  return async (stub) => {
    const top = stub.value.electorate.reduce(
      (m, t) => (t.root_l2_block > m ? t.root_l2_block : m),
      0n,
    );
    try {
      // T-71: a node on another chain could show any contract's logs at the
      // pinned address, and a self-paid group's need no signature.
      if ((await chainId(l2)) !== release.chainId) return false;
      if (top < fromBlock || top > (await l2Finalized(l2))) return false;
      const logs = await contractLogs(l2, release.registry, [GROUP_EVENTS], fromBlock, top);
      const records: ContractEventRecord[] = logs.map((r, i) => ({ ...r, n: BigInt(i) }));
      return electorateCheck(stub, records, release).status === "pass";
    } catch (e) {
      if (e instanceof RpcError) return false;
      throw e;
    }
  };
}
