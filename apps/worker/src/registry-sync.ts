// The registry sync (P3-5 parts 3a and 3b): the election registry's logs
// from the index, judged against the registry's event accumulator after the
// L2 block of the newest output root posted on L1, then recorded by core's
// syncRegistrations. The index is trusted for nothing: a log it drops, adds,
// alters or moves fails the accumulator (T-71). Nor is the L2 node, whose
// answers are proven under the output root (src/output-roots.ts; T-34).
// Nothing here logs or throws what it read or any URL (T-10).

import {
  type IndexedLog,
  type RegistryDeployment,
  type RegistrySyncReport,
  syncRegistrations,
} from "@abolishus/core";
import type { ProvenEventAccumulator } from "@abolishus/crypto";
import { readIndexedLogs } from "@abolishus/indexer";
import type { Sql } from "postgres";
import { type Address, toHex } from "viem";

/** Where the registry's accumulator comes from: proven under an output root in production. */
export interface RegistryAccumulator {
  proven(contract: Address): Promise<ProvenEventAccumulator>;
}

export interface RegistrySyncOptions {
  /** The worker's database, as abolish_app. */
  readonly sql: Sql;
  /** The indexer's database, read only, and its schema. */
  readonly index: Sql;
  readonly indexSchema: string;
  readonly accumulator: RegistryAccumulator;
  readonly deployment: RegistryDeployment;
}

/** One run per call: the registry's logs as of the newest output root's block. */
export class RegistrySync {
  readonly #options: RegistrySyncOptions;

  constructor(options: RegistrySyncOptions) {
    this.#options = options;
  }

  async run(): Promise<RegistrySyncReport> {
    const { sql, index, indexSchema, accumulator, deployment } = this.#options;
    const registry = toHex(deployment.contracts.electionRegistry);
    // The accumulator first: the index already holds every log up to the
    // proven block once it has caught up, and logs after it are left.
    const proven = await accumulator.proven(registry);
    const logs: IndexedLog[] = await readIndexedLogs(index, indexSchema, registry);
    return syncRegistrations(sql, deployment, logs, proven);
  }
}
