// The roots step (P2-22 part 3b-2): the group registry's records from the
// index, judged against the registry's event accumulator after the L2 block
// of the newest output root posted on L1, then core's rootPolls roots every
// created, checked poll at that block. The index is trusted for nothing: a
// record it drops, adds, alters or moves fails the accumulator (T-71); nor is
// the L2 node, whose answers are proven under the output root (T-34). It
// holds no key: it runs beside the registry sync, never in the creation
// worker (ADR 0032, rule 2). Nothing here logs or throws what it read or any
// URL (T-10).

import {
  type PollRootDeployment,
  type PollRootReport,
  provenGroupRecords,
  rootPolls,
} from "@abolishus/core";
import { readContractEvents } from "@abolishus/indexer";
import type { Sql } from "postgres";
import { toHex } from "viem";
import type { RegistryAccumulator } from "./registry-sync.ts";

export interface PollRootsOptions {
  /** The worker's database, as abolish_app. */
  readonly sql: Sql;
  /** The indexer's database, read only, and its schema. */
  readonly index: Sql;
  readonly indexSchema: string;
  readonly accumulator: RegistryAccumulator;
  /** The L2's chain ID, which the accumulator binds. */
  readonly chainId: bigint;
  /** The deployment's published groups and the group registry's pins. */
  readonly deployment: PollRootDeployment;
}

/** One run per call, at the newest output root's block. */
export class PollRoots {
  readonly #options: PollRootsOptions;

  constructor(options: PollRootsOptions) {
    this.#options = options;
  }

  async run(now: Date): Promise<PollRootReport> {
    const { sql, index, indexSchema, accumulator, chainId, deployment } = this.#options;
    const registry = deployment.pins.registry;
    return rootPolls(
      sql,
      {
        // Read only when a poll is waiting. The accumulator first: the index
        // holds every record up to the proven block once it has caught up.
        read: async () => {
          const proven = await accumulator.proven(toHex(registry));
          const records = await readContractEvents(index, indexSchema, toHex(registry));
          return provenGroupRecords(chainId, registry, records, proven);
        },
      },
      deployment,
      { now },
    );
  }
}
