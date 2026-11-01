// The chain a rolling poll's ballots are judged against at intake
// (docs/spec/share-encryption.md, Ballot version 5; docs/spec/membership.md,
// Root clock and steps; P2-17 part 7c-3b): the group registry's group
// events and the election registry's registration of the definition, read
// from the seat's own L2 node on the pinned chain, each registry's whole log
// replayed to its accumulator proven under one output root on L1
// (src/output-root.ts), and built into the chain by `packages/verifier`'s
// `rollingChain` under the registries the configuration pins: 2.4's rolling
// recount must pass, and the registration must be found. `safeAt` is the
// proven block's timestamp, from the header the root commits to, and the
// block must also be final in the node's view. So the step roots a seat
// checks a ballot's proof against are ones it computed itself from proven,
// final history, never a root a ballot, a relay or the node names, and a
// step is judged only once a proven block is past its boundary (T-08, T-25,
// T-52, T-71). What stays trusted is the root, as for the electorate and
// registration checks: an unresolved game is its proposer's word, and the
// intake guards the clock against a block stamped ahead of it (src/intake.ts).

import type { ElectionDefinitionV7Record, RollingBallotChain } from "@abolishus/crypto";
import { chainId, GameBlockError, l2Finalized, type Rpc, RpcError } from "@abolishus/node";
import { OutputRootError, rollingChain, type RollingChainRelease } from "@abolishus/verifier";
import { bytesToHex, keccak256, toBytes } from "viem";
import { GROUP_EVENTS } from "./electorate.ts";
import { provenLog, type RegistryAccumulators } from "./output-root.ts";

const DEFINITION_REGISTERED = bytesToHex(
  keccak256(toBytes("DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)"), "bytes"),
);

/** A rolling poll's chain, with the timestamp of the proven block it runs through. */
export interface RollingIntakeChain {
  readonly chain: RollingBallotChain;
  /** The proven, final L2 block's timestamp: every step whose boundary is before it is settled. */
  readonly safeAt: bigint;
}

/**
 * The chain of a rolling definition (version 7 under `electorate_mode` 2,
 * with its `ceremony_transcript_hash` set), or `undefined` whenever it can't
 * be decided, since a seat takes no rolling ballot it can't judge against
 * roots of its own. `l2RollingChain` in the deployment.
 */
export type RollingChainCheck = (
  definition: ElectionDefinitionV7Record,
) => Promise<RollingIntakeChain | undefined>;

export interface L2RollingChainOptions extends RollingChainRelease {
  /** The seat's own L2 node, deriving its finalized chain from L1. */
  readonly l2: Rpc;
  /** The group registry's deployment block, its log read from here. */
  readonly fromBlock: bigint;
  /** The election registry's deployment block, likewise. */
  readonly electionFromBlock: bigint;
  /** `l1OutputRootAccumulators` in production. */
  readonly accumulators: RegistryAccumulators;
}

/**
 * The `RollingChainCheck` over the seat's L2 node. Resolves `undefined` on
 * a node of another chain than the release's, when no root proves both
 * registries at one block at or after every rolling tier's `root_l2_block`
 * and both deployments, when that block isn't final in the node's view,
 * when either log doesn't replay to its accumulator, when the recount or
 * the registration doesn't pass, and when a node can't be read or its
 * answers don't prove.
 */
export function l2RollingChain(options: L2RollingChainOptions): RollingChainCheck {
  const { l2, fromBlock, electionFromBlock, accumulators, ...release } = options;
  return async (definition) => {
    const rootBlock = definition.value.rolling_electorate.reduce(
      (m, t) => (t.root_l2_block > m ? t.root_l2_block : m),
      0n,
    );
    const atLeast = [fromBlock, electionFromBlock, rootBlock].reduce((m, b) => (b > m ? b : m));
    try {
      // T-71: a node on another chain could show any contract's logs at the
      // pinned addresses, and a self-paid group's need no signature.
      if ((await chainId(l2)) !== release.chainId) return undefined;
      const [group, election] =
        (await accumulators([release.registry, release.electionRegistry], atLeast)) ?? [];
      // One block for both, so the registration and the steps are read over
      // the same history, and `safeAt` is that block's.
      if (
        group === undefined ||
        election === undefined ||
        group.block !== election.block ||
        group.timestamp !== election.timestamp ||
        group.block < atLeast
      )
        return undefined;
      // T-08, T-71: a respected game may claim an unsafe block, which the
      // seat's honest node proves; a step settled over a block later
      // reorganised away could gain or lose events.
      if (group.block > (await l2Finalized(l2))) return undefined;
      const groupLog = await provenLog(l2, release.chainId, release.registry, fromBlock, group);
      const electionLog = await provenLog(
        l2,
        release.chainId,
        release.electionRegistry,
        electionFromBlock,
        election,
      );
      if (groupLog === undefined || electionLog === undefined) return undefined;
      // The group events alone, as the electorate check reads them, and the
      // election's own registrations, as the registration check does: no
      // other event of either registry can stop the chain (T-36).
      const id = bytesToHex(definition.value.election_id);
      const records = [
        ...groupLog.filter((r) => {
          const topic = r.topics[0];
          return topic !== undefined && GROUP_EVENTS.includes(bytesToHex(topic));
        }),
        ...electionLog.filter((r) => {
          const [topic, election] = r.topics;
          return (
            topic !== undefined &&
            election !== undefined &&
            bytesToHex(topic) === DEFINITION_REGISTERED &&
            bytesToHex(election) === id
          );
        }),
      ];
      const outcome = rollingChain(definition, records, release);
      return "status" in outcome ? { chain: outcome.chain, safeAt: group.timestamp } : undefined;
    } catch (e) {
      if (
        e instanceof RpcError ||
        e instanceof OutputRootError ||
        e instanceof GameBlockError ||
        // A log the accumulator can't step over (src/output-root.ts).
        e instanceof RangeError
      )
        return undefined;
      throw e;
    }
  };
}
