// The registries' records that a rolling poll's ballots are judged against
// (P2-17 part 7b-2; docs/spec/membership.md, Settled and final): the group
// registry's and the election registry's records from the index, each
// checked against its accumulator proven under one output root posted on
// L1, with the timestamp of that root's block from the header it commits
// to. Core's `rollingChains` builds each poll's chain from them with the
// verifier's `rollingChain`, and its admission judges a ballot only against
// a step whose boundary is before that timestamp; the operator's counted
// tally builds a closed poll's chain from them too, with the block's
// number. So no step root comes from a ballot, a relay, the index or the
// L2 node: an index that drops, adds, alters or moves a record fails its
// accumulator, and a node that lies fails the proof (T-08, T-25, T-34,
// T-71). Every read is of public
// chain data, and nothing here logs or throws what it read or any URL (T-10).

import {
  type ProvenRegistryRecords,
  provenGroupRecords,
  type RegistryRecordSource,
} from "@abolishus/core";
import { readContractEvents } from "@abolishus/indexer";
import type { RollingChainRelease } from "@abolishus/verifier";
import type { Sql } from "postgres";
import { type Address, toHex } from "viem";
import type { ProvenAccumulators } from "./output-roots.ts";

/**
 * How long one read is used for, in milliseconds. Output roots are posted
 * about hourly, so a read a minute old is almost always the newest root's
 * already, and each batch of rolling ballots costs no node or index reads
 * of its own.
 */
export const REGISTRY_RECORDS_MAX_AGE_MS = 60_000;

/**
 * How far, in seconds, a proven block's timestamp may be ahead of the
 * worker's clock: the OP Stack's sequencer drift bound (1,800 s).
 */
export const MAX_CLOCK_SKEW_SECONDS = 1_800n;

/** Where the accumulators come from: `ProvenRegistryAccumulator` in production. */
export interface RegistryAccumulators {
  provenTogether(contracts: readonly Address[]): Promise<ProvenAccumulators>;
}

export interface RegistryRecordsOptions {
  /** The indexer's database, read only, and its schema. */
  readonly index: Sql;
  readonly indexSchema: string;
  readonly accumulators: RegistryAccumulators;
  /** The L2's chain ID, which each accumulator binds. */
  readonly chainId: bigint;
  /** The two registries, 20 bytes each, as the deployment names them. */
  readonly groupRegistry: Uint8Array;
  readonly electionRegistry: Uint8Array;
  /** Milliseconds a read is reused for (default `REGISTRY_RECORDS_MAX_AGE_MS`). */
  readonly maxAgeMs?: number;
  /** The clock, in milliseconds (default `Date.now`). */
  readonly now?: () => number;
}

/**
 * The registries' proven records for core's `rollingChains`. A read is
 * reused for `maxAgeMs`, and reads made meanwhile share it; a failed read is
 * never reused, so the next submission reads again.
 */
export class ProvenRegistryRecordSource implements RegistryRecordSource {
  readonly #o: RegistryRecordsOptions;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  #held: { readonly since: number; readonly read: Promise<ProvenRegistryRecords> } | undefined;

  constructor(options: RegistryRecordsOptions) {
    const maxAgeMs = options.maxAgeMs ?? REGISTRY_RECORDS_MAX_AGE_MS;
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0)
      throw new RangeError("maxAgeMs must be an integer ≥ 0");
    if (options.groupRegistry.length !== 20 || options.electionRegistry.length !== 20)
      throw new RangeError("each registry must be 20 bytes");
    this.#o = options;
    this.#maxAgeMs = maxAgeMs;
    this.#now = options.now ?? Date.now;
  }

  read(): Promise<ProvenRegistryRecords> {
    const now = this.#now();
    const held = this.#held;
    if (held !== undefined && now - held.since < this.#maxAgeMs) return held.read;
    const read = this.#read();
    this.#held = { since: now, read };
    read.catch(() => {
      if (this.#held?.read === read) this.#held = undefined;
    });
    return read;
  }

  async #read(): Promise<ProvenRegistryRecords> {
    const { index, indexSchema, accumulators, chainId, groupRegistry, electionRegistry } = this.#o;
    // The accumulators first, both under one root: the index holds every
    // record up to that block once it has caught up, and later ones are
    // left by the count.
    const proven = await accumulators.provenTogether([
      toHex(groupRegistry),
      toHex(electionRegistry),
    ]);
    const [group, election] = proven.accumulators;
    if (
      proven.accumulators.length !== 2 ||
      group?.block !== proven.block ||
      election?.block !== proven.block
    )
      throw new Error("the registries' accumulators aren't proven at one block");
    const records = [];
    // `provenGroupRecords` is the accumulator check for any one contract,
    // the election registry's too (its `GroupRecordsError` names no role):
    // its records up to the block, each naming that contract.
    for (const [contract, state] of [
      [groupRegistry, group],
      [electionRegistry, election],
    ] as const) {
      const indexed = await readContractEvents(index, indexSchema, toHex(contract));
      records.push(...provenGroupRecords(chainId, contract, indexed, state).records);
    }
    // A block stamped ahead of our clock would settle steps whose boundary
    // hasn't come: only a game's proposer can post one, and it fails here
    // rather than wait for the game to be shown false (T-08).
    if (proven.timestamp > BigInt(Math.floor(this.#now() / 1000)) + MAX_CLOCK_SKEW_SECONDS)
      throw new Error("the output root's block is stamped ahead of this worker's clock");
    return { at: proven.timestamp, block: proven.block, records };
  }
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Throws unless the registries this worker reads are the ones `release`
 * pins: under any others, 2.4's recount stops every rolling poll's chain
 * (`group-registry`), so every rolling ballot would be refused while the
 * worker looked healthy.
 */
export function checkPinnedRegistries(
  release: RollingChainRelease,
  deployment: Pick<RegistryRecordsOptions, "chainId" | "groupRegistry" | "electionRegistry">,
): void {
  if (
    release.chainId !== deployment.chainId ||
    !equal(release.registry, deployment.groupRegistry) ||
    !equal(release.electionRegistry, deployment.electionRegistry)
  )
    throw new Error("the registry sync's chain and registries aren't the ones the release pins");
}
