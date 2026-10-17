// Registrations and definitions from the election registry's indexed logs
// (P3-5 part 3a). The worker reads the registry's logs from the index and the
// registry's event accumulator at the L2's finalized block from its node;
// this checks the logs against the accumulator before it trusts one, so an
// index missing, adding, altering or reordering a log is refused rather than
// recorded (T-71), then records each finalized DefinitionRegistered in chain
// order and stores its definition. A registration is permanent and fixes
// which poll owns which short code (T-49, T-53), so nothing above the
// finalized block is ever recorded, and a log the check refuses stops the run
// before anything after it is.

import {
  checkContractEvent,
  checkEventAccumulatorProof,
  type ContractEventError,
  contractEventLog,
  type ContractEventRecord,
  type ContractEventVersion,
  type EventAccumulatorProofError,
  type EventContracts,
  type ProvenEventAccumulator,
} from "@abolishus/crypto";
import type { Sql } from "postgres";
import { DefinitionError, type DefinitionErrorCode, storeDefinition } from "./definitions.ts";
import { latestRegistration, recordRegistration } from "./registrations.ts";

/** A log of the registry as the index holds it, with its index in its block. */
export interface IndexedLog {
  readonly record: ContractEventRecord;
  readonly logIndex: number;
}

/** The deployment the registry's logs are judged under. */
export interface RegistryDeployment {
  /** The L2's chain ID, which the accumulator binds. */
  readonly chainId: bigint;
  /** The deployment's four L2 contracts; logs are read from the election registry. */
  readonly contracts: EventContracts;
  /** The contract-event version the deployment's profiles pin (verifier 2.3). */
  readonly version: ContractEventVersion;
}

export type RegistrySyncErrorCode =
  /** The logs aren't the registry's whole sequence up to the proven block. */
  | "incomplete"
  /** A log fails the event check, or isn't the registry's. */
  | "event-check";

/**
 * The accumulator check's or the event check's own code, or a log that
 * passes the event check but names another contract or files its
 * definition under another election.
 */
export type RegistrySyncReason =
  | EventAccumulatorProofError
  | ContractEventError
  | "other-contract"
  | "other-election";

export class RegistrySyncError extends Error {
  override readonly name = "RegistrySyncError";
  readonly code: RegistrySyncErrorCode;
  readonly reason: RegistrySyncReason;
  constructor(code: RegistrySyncErrorCode, reason: RegistrySyncReason) {
    super(`registry sync refused: ${code} (${reason})`);
    this.code = code;
    this.reason = reason;
  }
}

export interface RegistrySyncReport {
  /** Registrations recorded by this run. */
  readonly recorded: number;
  /**
   * Registrations recorded whose definition isn't stored: `storeDefinition`
   * refuses it (a later definition version, or one 2.1 fails), though the
   * registry accepted it, so it still owns its codes.
   */
  readonly unstored: readonly {
    readonly electionId: Uint8Array;
    readonly code: Exclude<DefinitionErrorCode, "conflict">;
  }[];
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const after = (
  log: ContractEventRecord,
  logIndex: number,
  latest: { readonly l2Block: bigint; readonly logIndex: number },
) =>
  log.l2_block > latest.l2Block || (log.l2_block === latest.l2Block && logIndex > latest.logIndex);

/**
 * Records every DefinitionRegistered among `logs` up to `proven.block` that
 * isn't recorded yet, storing its definition first. `logs` are all the
 * registry's indexed logs in chain order, `n` counting from 0; logs above
 * the proven block are left for a later run. `proven` is the registry's
 * accumulator and count at the L2's finalized block, as the caller's node
 * reports them. Throws `RegistrySyncError` before recording anything if the
 * logs aren't the registry's sequence, and stops at the first log the event
 * check refuses, so a registration is never recorded ahead of one before it.
 * Run outside any REPEATABLE READ or SERIALIZABLE transaction, as
 * `recordRegistration` requires.
 */
export async function syncRegistrations(
  client: Sql,
  deployment: RegistryDeployment,
  logs: readonly IndexedLog[],
  proven: ProvenEventAccumulator,
): Promise<RegistrySyncReport> {
  const registry = deployment.contracts.electionRegistry;
  // T-71: the accumulator binds the registry's address and every log's
  // position, block, time, topics and data, so the index can't stand for a
  // log the registry didn't emit or hide one it did.
  const incomplete = checkEventAccumulatorProof(
    deployment.chainId,
    registry,
    logs.map((l) => contractEventLog(l.record)),
    proven,
  );
  if (incomplete !== null) throw new RegistrySyncError("incomplete", incomplete);
  const latest = await latestRegistration(client);
  const unstored: { electionId: Uint8Array; code: Exclude<DefinitionErrorCode, "conflict"> }[] = [];
  let recorded = 0;
  for (const { record, logIndex } of logs.slice(0, Number(proven.count))) {
    if (latest !== undefined && !after(record, logIndex, latest)) continue;
    const checked = checkContractEvent(record, deployment.contracts, deployment.version);
    if (!checked.ok) throw new RegistrySyncError("event-check", checked.error);
    // The accumulator was replayed under the registry's address whatever the
    // record says; a record naming another contract is the index's error.
    if (checked.role !== "election-registry")
      throw new RegistrySyncError("event-check", "other-contract");
    const { event } = checked;
    if (event.event !== "DefinitionRegistered") continue;
    try {
      const stored = await storeDefinition(client, event.definition);
      // The registry files a definition under the ID it carries; one filed
      // under another would leave its own election's row unregistered.
      if (!equal(stored.electionId, event.electionId))
        throw new RegistrySyncError("event-check", "other-election");
    } catch (e) {
      if (!(e instanceof DefinitionError) || e.code === "conflict") throw e;
      unstored.push({ electionId: event.electionId, code: e.code });
    }
    await recordRegistration(client, {
      electionId: event.electionId,
      definitionHash: event.definitionHash,
      l2Block: record.l2_block,
      logIndex,
    });
    recorded++;
  }
  return { recorded, unstored };
}
