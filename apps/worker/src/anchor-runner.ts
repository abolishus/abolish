// The anchoring runner's startup (P4-1 part 2b-2b-1): the anchor's checks
// and the Safe's, then the adapter the `{board-anchor}` job sends through.
// It starts only once the L1 node is on the configured chain, the anchor's
// finalized code fixes the configured clock and names the Safe as its
// authority (`checkAnchorDeployment`), and the Safe at the finalized block is
// exactly the deployment record's (`checkAnchorSafe`), so a misconfigured or
// changed Safe is refused before the first run rather than at its first
// signature (T-49, T-69).
//
// Until a co-signer on independent hosting exists (P4-1 part 2b-2b-2), the
// runner's own keys must meet the threshold, so one runner holds the whole
// quorum: what the Safe is there to prevent (docs/spec/contracts.md, Board
// anchor, Known-weak). That is a testnet's arrangement only, so the runner
// starts only on Sepolia or a local Anvil chain, the L1s AGENTS.md allows;
// any chain with real funds is the owner's decision (AGENTS.md, rule A).

import type { PublicClient } from "viem";
import { checkAnchorDeployment, ViemAnchorChain } from "./anchor-chain.ts";
import type { AnchorConfig } from "./anchor-env.ts";
import { checkAnchorSafe, keySigner, safeSender } from "./anchor-safe.ts";

/** The only L1 chains a runner may send to: Sepolia and a local Anvil. */
export const TESTNET_CHAIN_IDS: readonly bigint[] = [11_155_111n, 31_337n];

/**
 * The adapter for `startWorker`'s `anchor`, once every startup check has
 * passed. Throws naming the first mismatch, never a key, a URL or a node's
 * answer.
 */
export async function connectAnchorRunner(
  client: PublicClient,
  config: Omit<AnchorConfig, "l1RpcUrl" | "everyMs">,
): Promise<ViemAnchorChain> {
  const { chainId, anchor, clock, safe } = config;
  if (!TESTNET_CHAIN_IDS.includes(chainId))
    throw new Error("the anchoring runner runs only on Sepolia or Anvil");
  // Refuses an owner key the record doesn't name, too few for the
  // threshold and a malformed executor key, before anything is read.
  const send = safeSender({
    client,
    chainId,
    anchor,
    safe,
    signers: config.ownerKeys.map(keySigner),
    executor: config.executorKey,
  });
  await checkAnchorDeployment(client, { chainId, anchor, clock, authority: safe.address });
  const finalized = (await client.getBlock({ blockTag: "finalized" })).number;
  await checkAnchorSafe(client, safe, finalized);
  return new ViemAnchorChain({ client, chainId, anchor, clock, authority: safe.address, send });
}
