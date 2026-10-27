// The registries' event accumulators proven under an L2 output root
// (docs/spec/contracts.md, Event accumulator, Output root), for the checks
// that read a registry's log from the seat's own L2 node: the electorate
// check (src/electorate.ts) and the registration check
// (src/registration.ts). The L2 node then answers for availability alone: a
// log it serves counts only once the registry's whole log, from its
// deployment block to the proven block, replays to the accumulator and count
// the root proves, so a log hidden, invented, altered, reordered or moved
// fails the replay and the check refuses (T-71). What stays trusted is the
// root: the L1 node's answers about the games, as for the worker's registry
// sync, an unresolved game being its proposer's word until it resolves, and
// L2 governance, which rewrites the accumulator with the state (T-71).

import {
  checkEventAccumulatorProof,
  type ContractEventRecord,
  contractEventLog,
  type ProvenEventAccumulator,
} from "@abolishus/crypto";
import {
  accumulatorUnderRoot,
  chainId,
  contractSequence,
  GameBlockError,
  respectedOutputRoots,
  type Rpc,
  RpcError,
} from "@abolishus/node";
import { OutputRootError } from "@abolishus/verifier";

/**
 * The accumulators and counts of `registries`, in their order, all proven
 * under one output root of an L2 block at or after `atLeast`, or undefined
 * if no root there can be had yet. `l1OutputRootAccumulators` in
 * production.
 */
export type RegistryAccumulators = (
  registries: readonly Uint8Array[],
  atLeast: bigint,
) => Promise<readonly ProvenEventAccumulator[] | undefined>;

/**
 * The registries' accumulators under the output root of the highest block
 * at or after `atLeast` that a respected game on the seat's L1 node claims
 * (`respectedOutputRoots`) and the seat's L2 node proves for every registry
 * (`accumulatorUnderRoot`); undefined when there is none. A claim that
 * doesn't prove is passed over for the next, so whoever posts a false root
 * or a block far ahead can't stop the checks until the game is shown false.
 */
export function l1OutputRootAccumulators(options: {
  readonly l1: Rpc;
  readonly l1ChainId: bigint;
  /** The L2's `OptimismPortal` on L1, 20 bytes. */
  readonly portal: Uint8Array;
  readonly l2: Rpc;
}): RegistryAccumulators {
  const { l1, l1ChainId, portal, l2 } = options;
  return async (registries, atLeast) => {
    // A node on another L1 could name any games at the portal's address.
    if ((await chainId(l1)) !== l1ChainId) throw new RpcError("the L1 node is on another chain");
    for (const root of await respectedOutputRoots(l1, portal)) {
      if (root.l2Block < atLeast) break;
      try {
        const proven: ProvenEventAccumulator[] = [];
        for (const r of registries) proven.push(await accumulatorUnderRoot(l2, root, r));
        return proven;
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
 * `registry`'s whole log from its deployment block `fromBlock` to the
 * proven block, from the seat's L2 node, or undefined when it doesn't
 * replay to the proven accumulator and count (T-71). A deployment block
 * after the registry's first log leaves the replay short, so the check
 * refuses rather than reading part of the log. Throws `RpcError` for a node
 * that can't be read, and `RangeError` for a log the accumulator can't step
 * over (a timestamp past a `u64`, say).
 */
export async function provenLog(
  l2: Rpc,
  l2ChainId: bigint,
  registry: Uint8Array,
  fromBlock: bigint,
  proven: ProvenEventAccumulator,
): Promise<ContractEventRecord[] | undefined> {
  const logs = await contractSequence(l2, registry, fromBlock, proven.block);
  return checkEventAccumulatorProof(l2ChainId, registry, logs.map(contractEventLog), proven) ===
    null
    ? logs
    : undefined;
}
