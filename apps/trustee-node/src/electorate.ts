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
// Tier 2 tier) is a refusal, never a pass.

import {
  checkEventAccumulatorProof,
  contractEventLog,
  type ProvenEventAccumulator,
} from "@abolishus/crypto";
import {
  accumulatorUnderRoot,
  chainId,
  contractSequence,
  GameBlockError,
  l2Finalized,
  respectedOutputRoots,
  type Rpc,
  RpcError,
} from "@abolishus/node";
import { electorateCheck, type GroupRegistryRelease, OutputRootError } from "@abolishus/verifier";
import { bytesToHex, keccak256, toBytes } from "viem";
import type { ElectorateCheck } from "./stub.ts";

// Topic 0 of each event the recount reads ([[contracts]], Group registry):
// the replay takes every log, but the recount these alone, so an event no
// contract-event version this release reads decodes (T-36) can't fail every
// stub. Their order is kept, which is all the first-occurrence rule ranks by.
const GROUP_EVENTS = [
  "RegistrarsPinned(uint8,address[])",
  "GroupCreated(uint64,uint8)",
  "MembersAdded(uint64,uint64,bytes)",
  "MembersRemoved(uint64,bytes)",
  "Tier1MemberAdded(bytes)",
  "SelfPaidGroupCreated(uint64)",
  "SelfPaidMemberAdded(uint64,uint64,bytes)",
].map((s) => keccak256(toBytes(s)));

/**
 * The group registry's accumulator and count proven at an L2 block at or
 * after `atLeast`, or undefined if no root there can be had yet.
 * `l1OutputRootAccumulator` in production.
 */
export type RegistryAccumulator = (atLeast: bigint) => Promise<ProvenEventAccumulator | undefined>;

export interface L2ElectorateOptions extends GroupRegistryRelease {
  /** The seat's own L2 node, deriving its finalized chain from L1. */
  readonly l2: Rpc;
  /**
   * The group registry's deployment block: its log is read from here, so a
   * later block leaves the replay short and refuses every stub.
   */
  readonly fromBlock: bigint;
  readonly accumulator: RegistryAccumulator;
}

/**
 * The registry's accumulator under the output root of the highest block at
 * or after `atLeast` that a respected game on the seat's L1 node claims
 * (`respectedOutputRoots`) and the seat's L2 node proves
 * (`accumulatorUnderRoot`); undefined when there is none. A claim that
 * doesn't prove is passed over for the next, so whoever posts a false root
 * or a block far ahead can't stop the check until the game is shown false.
 */
export function l1OutputRootAccumulator(options: {
  readonly l1: Rpc;
  readonly l1ChainId: bigint;
  /** The L2's `OptimismPortal` on L1, 20 bytes. */
  readonly portal: Uint8Array;
  readonly l2: Rpc;
  /** The group registry, 20 bytes. */
  readonly registry: Uint8Array;
}): RegistryAccumulator {
  const { l1, l1ChainId, portal, l2, registry } = options;
  return async (atLeast) => {
    // A node on another L1 could name any games at the portal's address.
    if ((await chainId(l1)) !== l1ChainId) throw new RpcError("the L1 node is on another chain");
    for (const root of await respectedOutputRoots(l1, portal)) {
      if (root.l2Block < atLeast) break;
      try {
        return await accumulatorUnderRoot(l2, root, registry);
      } catch (e) {
        if (e instanceof OutputRootError || e instanceof GameBlockError || e instanceof RpcError)
          continue;
        throw e;
      }
    }
    return undefined;
  };
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
  const { l2, fromBlock, accumulator, ...release } = options;
  return async (stub) => {
    const top = stub.value.electorate.reduce(
      (m, t) => (t.root_l2_block > m ? t.root_l2_block : m),
      0n,
    );
    try {
      // T-71: a node on another chain could show any contract's logs at the
      // pinned address, and a self-paid group's need no signature.
      if ((await chainId(l2)) !== release.chainId) return false;
      // Finality isn't what makes the log safe (the proven root is), but
      // the root's own L2 block may not be final either.
      if (top < fromBlock || top > (await l2Finalized(l2))) return false;
      const proven = await accumulator(top);
      if (proven === undefined || proven.block < top) return false;
      // T-71: the whole log to the proven block, every event of the
      // registry, must be the one the accumulator commits to; the recount
      // takes its group events, each tier's up to its own root block.
      const logs = await contractSequence(l2, release.registry, fromBlock, proven.block);
      const replay = logs.map(contractEventLog);
      if (checkEventAccumulatorProof(release.chainId, release.registry, replay, proven) !== null)
        return false;
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
