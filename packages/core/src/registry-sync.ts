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
  type ContractEvent,
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
import { countRegistrations, latestRegistration, recordRegistration } from "./registrations.ts";

type Registered = Extract<ContractEvent, { event: "DefinitionRegistered" }>;

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
  /** The logs aren't the registry's whole sequence up to the proven block, in order. */
  | "incomplete"
  /** A log fails the event check, or isn't the registry's. */
  | "event-check"
  /** The registrations recorded aren't the registry's first ones. */
  | "recorded";

/**
 * The accumulator check's or the event check's own code; a log whose index
 * doesn't rise within its block; a log naming another contract or filing its
 * definition under another election; or recorded registrations this
 * registry's logs don't begin with.
 */
export type RegistrySyncReason =
  | EventAccumulatorProofError
  | "log-index"
  | ContractEventError
  | "other-contract"
  | "other-election"
  | "other-registrations";

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
 * accumulator and count after an L2 block, as the caller proved them; one
 * before the latest recorded registration's block can't vouch for it, and is
 * refused as `recorded` like any table the proof doesn't match. Throws `RegistrySyncError` before recording anything if the
 * logs aren't the registry's sequence, a log's index doesn't rise within its
 * block, or the registrations already recorded aren't the registry's first
 * ones, and stops at the first log the event check refuses, so a
 * registration is never recorded ahead of one before it.
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
  const counted = logs.slice(0, Number(proven.count));
  // T-53: the accumulator doesn't bind a log's index, and the table orders
  // same-block registrations by it, so an index swapping two would hand one
  // poll's code to the other. Each must rise within its block, or nothing
  // is recorded.
  for (const [i, { record, logIndex }] of counted.entries()) {
    const previous = counted[i - 1];
    if (
      !Number.isInteger(logIndex) ||
      logIndex < 0 ||
      (previous?.record.l2_block === record.l2_block && logIndex <= previous.logIndex)
    )
      throw new RegistrySyncError("incomplete", "log-index");
  }
  // Each counted log must be the registry's and pass the event check; the
  // registrations before the first that doesn't are still recorded.
  const registrations: { record: ContractEventRecord; logIndex: number; event: Registered }[] = [];
  let failure: RegistrySyncError | undefined;
  for (const { record, logIndex } of counted) {
    // The accumulator was replayed under the registry's address whatever the
    // record says; a record naming another contract is the index's error.
    if (!equal(record.contract, registry)) {
      failure = new RegistrySyncError("event-check", "other-contract");
      break;
    }
    const checked = checkContractEvent(record, deployment.contracts, deployment.version);
    if (!checked.ok) {
      failure = new RegistrySyncError("event-check", checked.error);
      break;
    }
    const { event } = checked;
    if (event.event !== "DefinitionRegistered") continue;
    // The registry files a definition under the ID it carries; one filed
    // under another would leave its own election's row unregistered.
    if (!equal(event.decoded.value.election_id, event.electionId)) {
      failure = new RegistrySyncError("event-check", "other-election");
      break;
    }
    registrations.push({ record, logIndex, event });
  }
  // What is recorded must be exactly this registry's first registrations,
  // the latest at its position: otherwise the index, the deployment or the
  // table changed under us, and skipping would drop a registration silently.
  const latest = await latestRegistration(client);
  let skip = 0;
  if (latest !== undefined) {
    skip = registrations.findIndex((r) => after(r.record, r.logIndex, latest));
    if (skip === -1) skip = registrations.length;
    const last = registrations[skip - 1];
    if (
      last === undefined ||
      last.record.l2_block !== latest.l2Block ||
      last.logIndex !== latest.logIndex ||
      (await countRegistrations(client)) !== skip
    )
      throw failure ?? new RegistrySyncError("recorded", "other-registrations");
  }
  const unstored: { electionId: Uint8Array; code: Exclude<DefinitionErrorCode, "conflict"> }[] = [];
  let recorded = 0;
  for (const { record, logIndex, event } of registrations.slice(skip)) {
    try {
      await storeDefinition(client, event.definition);
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
  // The registrations before a refused log are recorded; none after it.
  if (failure !== undefined) throw failure;
  return { recorded, unstored };
}
