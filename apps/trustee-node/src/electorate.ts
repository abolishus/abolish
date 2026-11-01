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
// The L2 node is trusted for nothing but availability (part 3c): the
// registry's event accumulator and count are proven under the newest output
// root a dispute game of the type the L2's portal respects claims on L1, at
// a block at or after the stub's `root_l2_block`, and the node's whole log of
// the registry up to that block must replay to them
// (`checkEventAccumulatorProof`). So a node that hides, invents, alters,
// reorders or moves a log fails the replay and the seat refuses the stub;
// it can no longer pass an overstated one (T-71, T-06). What remains trusted
// is the root: the L1 node's answers about the games, as for the worker's
// registry sync, and an unresolved game is its proposer's word until it
// resolves; L2 governance that rewrites state rewrites the accumulator too
// (T-71). Whatever can't be decided (a block not final yet or not under a
// posted root, a node that can't be read or doesn't prove, a Tier 1 or
// Tier 2 tier) is a refusal, never a pass. A rolling stub's recount is
// its tiers' opening state, with every listed group's history replayed
// strictly through the proven block (T-13, T-16, T-08).

import { chainId, GameBlockError, l2Finalized, type Rpc, RpcError } from "@abolishus/node";
import { electorateCheck, type GroupRegistryRelease, OutputRootError } from "@abolishus/verifier";
import { bytesToHex, keccak256, toBytes } from "viem";
import { provenLog, type RegistryAccumulators } from "./output-root.ts";
import { type ElectorateCheck, stubRootBlock } from "./stub.ts";

// Topic 0 of each event the recount reads ([[contracts]], Group registry):
// the replay takes every log, but the recount these alone, so an event no
// contract-event version this release reads decodes (T-36) can't fail every
// stub. Their order is kept, which is all the first-occurrence rule ranks by.
export const GROUP_EVENTS = [
  "RegistrarsPinned(uint8,address[])",
  "GroupCreated(uint64,uint8)",
  "MembersAdded(uint64,uint64,bytes)",
  "MembersRemoved(uint64,bytes)",
  "Tier1MemberAdded(bytes)",
  "SelfPaidGroupCreated(uint64)",
  "SelfPaidMemberAdded(uint64,uint64,bytes)",
].map((s) => keccak256(toBytes(s)));

export interface L2ElectorateOptions extends GroupRegistryRelease {
  /** The seat's own L2 node, deriving its finalized chain from L1. */
  readonly l2: Rpc;
  /**
   * The group registry's deployment block: its log is read from here, so a
   * later block leaves the replay short and refuses every stub.
   */
  readonly fromBlock: bigint;
  /** `l1OutputRootAccumulators` in production. */
  readonly accumulators: RegistryAccumulators;
}

/**
 * The `ElectorateCheck` over the seat's L2 node. Resolves `false` on a node
 * of another chain than the release's, for a stub whose latest
 * `root_l2_block` isn't finalized yet, precedes the registry's deployment or
 * is past the proven block, when the node's log doesn't replay to the
 * proven accumulator or the recount doesn't pass, and when a node can't be
 * read or its answers don't prove.
 */
export function l2ElectorateCheck(options: L2ElectorateOptions): ElectorateCheck {
  const { l2, fromBlock, accumulators, ...release } = options;
  return async (stub) => {
    // A rolling stub's tiers are its rolling ones: its fixed list is empty.
    const top = stubRootBlock(stub);
    try {
      // T-71: a node on another chain could show any contract's logs at the
      // pinned address, and a self-paid group's need no signature.
      if ((await chainId(l2)) !== release.chainId) return false;
      // Finality isn't what makes the log safe (the proven root is), but
      // the root's own L2 block may not be final either.
      if (top < fromBlock || top > (await l2Finalized(l2))) return false;
      const [proven] = (await accumulators([release.registry], top)) ?? [];
      if (proven === undefined || proven.block < top) return false;
      // T-71: the whole log to the proven block, every event of the
      // registry, must be the one the accumulator commits to; the recount
      // takes its group events, each tier's up to its own root block.
      const logs = await provenLog(l2, release.chainId, release.registry, fromBlock, proven);
      if (logs === undefined) return false;
      const records = logs.filter((r) => {
        const topic = r.topics[0];
        return topic !== undefined && GROUP_EVENTS.includes(bytesToHex(topic));
      });
      return electorateCheck(stub, records, release).status === "pass";
    } catch (e) {
      if (
        e instanceof RpcError ||
        e instanceof OutputRootError ||
        e instanceof GameBlockError ||
        // A log the node serves outside what the accumulator can step over
        // (a timestamp past a `u64`, say). It also turns a fault of the
        // seat's own into a refusal, which fails closed.
        e instanceof RangeError
      )
        return false;
      throw e;
    }
  };
}
