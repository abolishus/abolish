// Finalized L1 blocks for ballot admission's L1 reference check (verifier
// 5.8; packages/core's `L1References`), read over viem from one L1 node.
// Each block is read by number at or below a finalized head the node
// reported, and must come back as that number with a hash and a timestamp,
// so a node answering for another block, or none, fails the read and the
// ballot is boarded unchecked rather than judged by it. What the node says
// about the chain is trusted (T-34's residual for RPC reads): a lying node
// can make ballots be refused here, which voters answer by submitting
// directly (T-25), or let bad references through, which the verifier rejects.
// Every read is of public chain data, and nothing here logs or throws what it
// read or the node's URL (T-10).

import type { FinalizedL1Source } from "@abolishus/core";
import { hexToBytes, type PublicClient } from "viem";

/** One L1 node's finalized chain. Made by `connect`, which checks the chain. */
export class ViemL1Source implements FinalizedL1Source {
  readonly chainId: bigint;
  readonly #client: PublicClient;

  private constructor(client: PublicClient, chainId: bigint) {
    this.#client = client;
    this.chainId = chainId;
  }

  /** Refuses a node on any chain but `chainId` (the definitions' `l1_chain_id`). */
  static async connect(client: PublicClient, chainId: bigint): Promise<ViemL1Source> {
    if (BigInt(await client.getChainId()) !== chainId)
      throw new Error("the L1 node is on another chain");
    return new ViemL1Source(client, chainId);
  }

  async finalizedHead(): Promise<bigint> {
    const block = await this.#client.getBlock({ blockTag: "finalized" });
    if (block.number === null) throw new Error("the node has no finalized block");
    return block.number;
  }

  async block(n: bigint): Promise<{ hash: Uint8Array; timestamp: bigint }> {
    const block = await this.#client.getBlock({ blockNumber: n });
    if (block.number !== n || block.hash === null)
      throw new Error("the node answered for another block");
    return { hash: hexToBytes(block.hash), timestamp: block.timestamp };
  }
}
