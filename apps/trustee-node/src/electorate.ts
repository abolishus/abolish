// The deployment's electorate check (docs/spec/ceremony.md, Stub checks,
// step 3; [[verifier]] 2.4): the group registry's whole log, from its
// deployment block to the stub's latest `root_l2_block`, read from the seat's
// own L2 node in finalized history and recounted by `packages/verifier`'s
// `electorateCheck` under the registry and registrars the configuration
// pins. A seat lends its keys only to a stub whose every tier is the one the
// registry's history makes, so no stub overstates a tier's anonymity set,
// puts a group under another tier's label or names a root no registered
// history reaches (T-13, T-16, T-06, T-71).
//
// The L2 node is trusted for which logs exist, as for the node's other L2
// reads (src/recorded.ts): the registry's event accumulator isn't proven
// against an output root here yet. A node that hides logs can make the seat
// refuse an honest stub; one that invents them can't forge a signed group's
// records without the registrars' keys, but can invent a self-paid group's,
// which need no signature, and so pass a stub listing one. The node is the
// seat's own, as for every duty, and the verifier's 2.4 and 4.4 still judge
// the board against the archive's replay (T-53, T-71). Whatever can't be decided (a block not final yet, a node
// that can't be read, a Tier 1 or Tier 2 tier) is a refusal, never a pass.

import type { ContractEventRecord } from "@abolishus/crypto";
import { contractLogs, l2Finalized, type Rpc, RpcError } from "@abolishus/node";
import { electorateCheck, type GroupRegistryRelease } from "@abolishus/verifier";
import type { ElectorateCheck } from "./stub.ts";

export interface L2ElectorateOptions extends GroupRegistryRelease {
  /** The seat's own L2 node, deriving its finalized chain from L1. */
  readonly l2: Rpc;
  /** The group registry's deployment block: its log is read from here. */
  readonly fromBlock: bigint;
}

/**
 * The `ElectorateCheck` over the seat's L2 node. Resolves `false` for a stub
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
      if (top < fromBlock || top > (await l2Finalized(l2))) return false;
      // Every log, so each record's `n` is its place in the registry's
      // sequence, which orders self-paid additions (first occurrence).
      const logs = await contractLogs(l2, release.registry, [], fromBlock, top);
      const records: ContractEventRecord[] = logs.map((r, i) => ({ ...r, n: BigInt(i) }));
      return electorateCheck(stub, records, release).status === "pass";
    } catch (e) {
      if (e instanceof RpcError) return false;
      throw e;
    }
  };
}
