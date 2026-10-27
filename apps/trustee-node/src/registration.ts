// The deployment's registration check (docs/spec/share-encryption.md, Intake
// and receipts; [[verifier]] 2.1, 3.1's registration part and 3.2 from L2
// state, Registration): the election registry's `DefinitionRegistered` for
// the election and the trustee registry's `CeremonyRegistered` for its stub
// and panel, read from the seat's own L2 node, on the pinned chain, from
// each registry's deployment block to a block an output root proves, and
// judged by `packages/verifier`'s `registrationCheck` under the registries
// the configuration pins. A seat takes a ballot only once the registry holds
// the definition it checked, over the ceremony it approved with the key set
// its own transcript check returned, so no share it receipts is one of an
// election registered under other bytes or other keys (T-34, T-37, T-71).
//
// The L2 node is trusted for nothing but availability (part 3d), as for
// the electorate check (src/output-root.ts): both registries' accumulators
// and counts are proven under one output root a respected dispute game
// claims on L1, and each registry's whole log, from its own deployment
// block to the proven block, must replay to them before the records are
// judged. So a node that invents a registration or a ceremony record, or
// hides one, fails the replay and the seat refuses; it can no longer make
// the seat take ballots of a definition before, or without, its
// registration (T-71, T-53). What remains trusted is the root, as there. A
// registration after the newest proven root waits for the next one (the
// L2's proposal interval). Whatever can't be decided (a node of another
// chain, one that can't be read or doesn't prove, no root yet) is a refusal.

import { chainId, GameBlockError, type Rpc, RpcError } from "@abolishus/node";
import { OutputRootError, registrationCheck, type RegistrationRelease } from "@abolishus/verifier";
import { bytesToHex, keccak256, toBytes } from "viem";
import type { RegistrationCheck } from "./intake.ts";
import { provenLog, type RegistryAccumulators } from "./output-root.ts";
import { stubHash } from "./stub.ts";

const topic = (signature: string) => keccak256(toBytes(signature), "bytes");
const DEFINITION_REGISTERED = topic(
  "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)",
);
const CEREMONY_REGISTERED = topic("CeremonyRegistered(bytes32,bytes32,bytes32,bytes)");

export interface L2RegistrationOptions extends RegistrationRelease {
  /** The seat's own L2 node, deriving its finalized chain from L1. */
  readonly l2: Rpc;
  /**
   * The election registry's deployment block: its log is read from here,
   * so a later block leaves the replay short and refuses every delivery.
   */
  readonly fromBlock: bigint;
  /** The trustee registry's deployment block, for its log likewise. */
  readonly trusteeFromBlock: bigint;
  /** `l1OutputRootAccumulators` in production. */
  readonly accumulators: RegistryAccumulators;
}

/** Whether `record` leads with `topics`, as `eth_getLogs`' topic filter matches. */
const leads = (record: { readonly topics: readonly Uint8Array[] }, topics: readonly Uint8Array[]) =>
  topics.every((t, i) => {
    const u = record.topics[i];
    return u !== undefined && bytesToHex(u) === bytesToHex(t);
  });

/**
 * The `RegistrationCheck` over the seat's L2 node. Resolves `false` on a
 * node of another chain than the release's, when either registry's log
 * doesn't replay to its accumulator proven under one output root, for a
 * definition that proven history doesn't show registered over the approved
 * ceremony and key set, and when a node can't be read or its answers don't
 * prove.
 */
export function l2RegistrationCheck(options: L2RegistrationOptions): RegistrationCheck {
  const { l2, fromBlock, trusteeFromBlock, accumulators, ...release } = options;
  return async (definition, keySetHash) => {
    const d = definition.value;
    try {
      // T-71: a node on another chain could show any contract's logs at the
      // pinned addresses.
      if ((await chainId(l2)) !== release.chainId) return false;
      // At or after both deployments, so neither log's range is empty.
      const atLeast = fromBlock > trusteeFromBlock ? fromBlock : trusteeFromBlock;
      const proven = await accumulators(
        [release.electionRegistry, release.trusteeRegistry],
        atLeast,
      );
      const [election, trustee] = proven ?? [];
      if (election === undefined || trustee === undefined) return false;
      if (election.block < atLeast || trustee.block < atLeast) return false;
      const electionLog = await provenLog(
        l2,
        release.chainId,
        release.electionRegistry,
        fromBlock,
        election,
      );
      const trusteeLog = await provenLog(
        l2,
        release.chainId,
        release.trusteeRegistry,
        trusteeFromBlock,
        trustee,
      );
      if (electionLog === undefined || trusteeLog === undefined) return false;
      // Only the election's registration and its ceremony's, by their
      // indexed topics: nothing else of either registry can fail the check.
      const registered = electionLog.filter((r) =>
        leads(r, [DEFINITION_REGISTERED, d.election_id]),
      );
      const recorded = trusteeLog.filter((r) =>
        leads(r, [CEREMONY_REGISTERED, stubHash(definition), d.panel_id]),
      );
      return (
        registrationCheck(definition, keySetHash, [...recorded, ...registered], release).status ===
        "pass"
      );
    } catch (e) {
      if (
        e instanceof RpcError ||
        e instanceof OutputRootError ||
        e instanceof GameBlockError ||
        // A log the accumulator can't step over (src/output-root.ts).
        e instanceof RangeError
      )
        return false;
      throw e;
    }
  };
}
