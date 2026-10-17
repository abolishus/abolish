// The registry sync (P3-5 part 3a): the election registry's logs from the
// index, judged against the registry's event accumulator at the L2's
// finalized block, then recorded by core's syncRegistrations. The index is
// trusted for nothing: a log it drops, adds, alters or moves fails the
// accumulator (T-71). The L2 node is trusted for its finalized head and the
// registry's storage there, read with eth_getStorageAt rather than proven
// under an output root (T-34's residual for RPC reads): a lying node can hold
// registrations back, or vouch for an index it agrees with. Nothing here logs
// or throws what it read or either URL (T-10).

import {
  type IndexedLog,
  type RegistryDeployment,
  type RegistrySyncReport,
  syncRegistrations,
} from "@abolishus/core";
import type { ProvenEventAccumulator } from "@abolishus/crypto";
import { readIndexedLogs } from "@abolishus/indexer";
import type { Sql } from "postgres";
import { type Address, hexToBigInt, hexToBytes, type PublicClient, toHex } from "viem";

/**
 * The accumulator's base slot, the ERC-7201 namespace `abolish.event-accumulator`
 * (docs/spec/contracts.md, Rules for every contract): the accumulator at `S`,
 * the count at `S + 1`.
 */
export const ACCUMULATOR_SLOT = 0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600n;

/** One L2 node's finalized chain. Made by `connect`, which checks the chain. */
export class ViemRegistryAccumulator {
  readonly #client: PublicClient;

  private constructor(client: PublicClient) {
    this.#client = client;
  }

  /** Refuses a node on any chain but `chainId`, the deployment's L2. */
  static async connect(client: PublicClient, chainId: bigint): Promise<ViemRegistryAccumulator> {
    if (BigInt(await client.getChainId()) !== chainId)
      throw new Error("the L2 node is on another chain");
    return new ViemRegistryAccumulator(client);
  }

  /** `contract`'s accumulator and count at the node's finalized head. */
  async finalized(contract: Address): Promise<ProvenEventAccumulator> {
    const head = await this.#client.getBlock({ blockTag: "finalized" });
    if (head.number === null) throw new Error("the node has no finalized block");
    const block = head.number;
    const word = async (slot: bigint) => {
      const value = await this.#client.getStorageAt({
        address: contract,
        slot: toHex(slot, { size: 32 }),
        blockNumber: block,
      });
      if (value === undefined || !/^0x[0-9a-f]{64}$/i.test(value))
        throw new Error("the node answered a storage read with something other than a word");
      return value;
    };
    const [accumulator, count] = await Promise.all([
      word(ACCUMULATOR_SLOT),
      word(ACCUMULATOR_SLOT + 1n),
    ]);
    // A count is a u64: a word with any of its top 192 bits set isn't one.
    const n = hexToBigInt(count);
    if (n >= 1n << 64n) throw new Error("the registry's count isn't a u64");
    return { block, accumulator: hexToBytes(accumulator), count: n };
  }
}

export interface RegistrySyncOptions {
  /** The worker's database, as abolish_app. */
  readonly sql: Sql;
  /** The indexer's database, read only, and its schema. */
  readonly index: Sql;
  readonly indexSchema: string;
  readonly accumulator: ViemRegistryAccumulator;
  readonly deployment: RegistryDeployment;
}

/** One run per call: the registry's logs as of the node's finalized head. */
export class RegistrySync {
  readonly #options: RegistrySyncOptions;

  constructor(options: RegistrySyncOptions) {
    this.#options = options;
  }

  async run(): Promise<RegistrySyncReport> {
    const { sql, index, indexSchema, accumulator, deployment } = this.#options;
    const registry = toHex(deployment.contracts.electionRegistry);
    // The accumulator first: the index already holds every log up to the
    // finalized block once it has caught up, and logs after it are left.
    const proven = await accumulator.finalized(registry);
    const logs: IndexedLog[] = await readIndexedLogs(index, indexSchema, registry);
    return syncRegistrations(sql, deployment, logs, proven);
  }
}
