// The registration from L2 state (docs/spec/verifier.md, Registration): the
// election registry's `DefinitionRegistered` for the definition's election
// (2.1: the one registered, never re-registered, definition is this one) and
// the trustee registry's `CeremonyRegistered` for its stub and panel (3.1's
// registration part: the transcript the quorum approved is the definition's,
// and the key set it recorded is the one the caller's transcript check
// returned, 3.2), under the registries the release pins. So no share is made
// or receipted under a definition the registry doesn't hold, or under keys
// other than the ones the registered ceremony approved (T-34, T-37, T-71).
//
// The records are the caller's: a trustee node's finalized L2 read of those
// two events (docs/spec/share-encryption.md, Intake and receipts), or the subset a board carries.
// This decides only what they show: whether they are the registries' own,
// and all of them, is the caller's to know (4.4 and the archive's replay),
// so a pass here is a pass over those records, never 2.1's or 3.1's pass on
// its own.

import {
  type AnyElectionDefinitionRecord,
  checkContractEvent,
  type ContractEventRecord,
  type ContractEventVersion,
  DecodeError,
  decodeCeremonyRegistration,
  type ElectionDefinitionV7Record,
  type EventContracts,
  keySetHash,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { concatBytes } from "@noble/hashes/utils.js";
import { authorRunOf, decodeDefinition, readDefinition } from "./definition.ts";

/** The election registry and its chain, as the release pins them. */
export interface ElectionRegistryRelease {
  /** The L2's chain ID. */
  readonly chainId: bigint;
  /** The election registry, 20 bytes. */
  readonly electionRegistry: Uint8Array;
}

/** The registries and their chain, as the release pins them. */
export interface RegistrationRelease extends ElectionRegistryRelease {
  /** The trustee registry, 20 bytes. */
  readonly trusteeRegistry: Uint8Array;
}

/** Why the registration check fails a definition. */
export type RegistrationFailure =
  /** The definition names another L2, election registry or trustee registry than the release pins. */
  | "registries"
  /** A record of either registry fails the event check under the pinned version. */
  | "registry-records"
  /** No `DefinitionRegistered` for the definition's election. */
  | "definition-unregistered"
  /** One for its election registers another definition, or there is more than one. */
  | "definition-registered"
  /** No `CeremonyRegistered` for the definition's stub and panel. */
  | "ceremony-unregistered"
  /** One records another transcript, or there is more than one. */
  | "ceremony-registered"
  /** The recorded key set isn't the one the transcript check returned. */
  | "key-set-mismatch";

export type RegistrationOutcome =
  | { readonly status: "pass" }
  | { readonly status: "fail"; readonly code: RegistrationFailure }
  | {
      readonly status: "unverifiable";
      /**
       * `unsupported-version` for a contract-event pin this release doesn't
       * read; `author-panel` for a definition with an author panel, whose
       * registration this check doesn't read.
       */
      readonly code: "unsupported-version" | "author-panel";
    };

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The contract-event versions crypto's event check reads, as 4.4 and the
// recount read them (src/events.ts, src/electorate.ts).
const isReadable = (v: number | undefined): v is ContractEventVersion =>
  v !== undefined && Number.isInteger(v) && v >= 1 && v <= 13;

/**
 * The registration of `definition`, the definition the caller checked, from
 * `records` (others' contracts' ignored), under `release`. `keySet` is the
 * `key_set_hash` of the key set the caller's check of the definition's
 * ceremony transcript returned (3.2). The first failing step gives the
 * outcome: the registries, the records, the definition's registration, then
 * its ceremony's. `definition` must be well formed (2.1). Throws
 * `TypeError` or `RangeError` for malformed arguments.
 */
export function registrationCheck(
  definition: AnyElectionDefinitionRecord | ElectionDefinitionV7Record,
  keySet: Uint8Array,
  records: readonly ContractEventRecord[],
  release: RegistrationRelease,
): RegistrationOutcome {
  const d = definition.value;
  const version = pinnedVersion(d, RECORD_TYPES.contractEvent);
  if (!isReadable(version)) return { status: "unverifiable", code: "unsupported-version" };
  // T-71: a registry no release pins is anyone's to write, so what it
  // records proves nothing about this deployment.
  if (
    d.l2_chain_id !== release.chainId ||
    !equal(d.election_registry, release.electionRegistry) ||
    !equal(d.trustee_registry, release.trusteeRegistry)
  )
    return { status: "fail", code: "registries" };
  const read = readDefinition(definition);
  if (authorRunOf(definition) !== undefined)
    return { status: "unverifiable", code: "author-panel" };
  // The `chain` rule of 2.1 keeps the four addresses pairwise distinct, so
  // each record has at most one role.
  const contracts: EventContracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const definitions: { readonly record: ContractEventRecord; readonly definition: Uint8Array }[] =
    [];
  const ceremonies: { transcriptHash: Uint8Array; registration: Uint8Array }[] = [];
  for (const record of records) {
    if (
      !equal(record.contract, contracts.electionRegistry) &&
      !equal(record.contract, contracts.trusteeRegistry)
    )
      continue;
    const checked = checkContractEvent(record, contracts, version);
    if (!checked.ok) return { status: "fail", code: "registry-records" };
    const e = checked.event;
    if (e.event === "DefinitionRegistered" && equal(e.electionId, d.election_id))
      definitions.push({ record, definition: e.definition });
    else if (
      e.event === "CeremonyRegistered" &&
      equal(e.stubHash, read.stubHash) &&
      equal(e.panelId, d.panel_id)
    )
      ceremonies.push({ transcriptHash: e.transcriptHash, registration: e.registration });
  }

  const registered = matchRegistration(definitions, read.hash);
  if (registered.status !== "pass") return registered;

  // 3.1's registration part: the registry records one transcript per stub
  // and panel, and registers a definition only over the one it recorded.
  const [ceremony] = ceremonies;
  if (ceremony === undefined) return { status: "fail", code: "ceremony-unregistered" };
  if (ceremonies.length > 1 || !equal(ceremony.transcriptHash, d.ceremony_transcript_hash))
    return { status: "fail", code: "ceremony-registered" };
  // The registry logs the record it was given, whose header (`panel_id ‖
  // stub_hash ‖ ceremony_transcript_hash`, in every layout) names the
  // ceremony it records, so one naming another is no log of the registry's.
  const header = ceremony.registration.subarray(0, 96);
  if (!equal(header, concatBytes(d.panel_id, read.stubHash, d.ceremony_transcript_hash)))
    return { status: "fail", code: "registry-records" };
  // Version 1's record carries no key set: the registry recorded only the
  // transcript, and the key set is what checking that transcript returns,
  // which the caller did. From version 2 the registry records the key set a
  // quorum signed, which must be that one (T-37).
  if (version === 1) return { status: "pass" };
  let recorded: Uint8Array;
  try {
    recorded = keySetHash(decodeCeremonyRegistration(ceremony.registration).keySet);
  } catch (e) {
    // The event check's length rule passed, so only a form check fails here.
    if (e instanceof DecodeError) return { status: "fail", code: "registry-records" };
    throw e;
  }
  return equal(recorded, keySet)
    ? { status: "pass" }
    : { status: "fail", code: "key-set-mismatch" };
}

/** The definition's registration (2.1), or why it isn't found. */
export type DefinitionRegistrationOutcome =
  /** `record` is the election registry's `DefinitionRegistered` that registered it. */
  | { readonly status: "pass"; readonly record: ContractEventRecord }
  | {
      readonly status: "fail";
      readonly code: Extract<
        RegistrationFailure,
        "registries" | "registry-records" | "definition-unregistered" | "definition-registered"
      >;
    }
  | { readonly status: "unverifiable"; readonly code: "unsupported-version" };

/**
 * The registration check's steps 1 to 3 over the election registry alone:
 * the `DefinitionRegistered` record of `records` (others' contracts'
 * ignored) that registered `definition`, under `release`, with the same
 * outcomes as `registrationCheck` gives for those steps. Its block's
 * timestamp is a rolling poll's registration time, before which no step is
 * accepted ([[membership]], Root clock and steps), and the accumulator binds
 * it (T-34, T-71). `definition` must be well formed (2.1). Throws
 * `TypeError` or `RangeError` for malformed arguments.
 */
export function definitionRegistration(
  definition: AnyElectionDefinitionRecord | ElectionDefinitionV7Record,
  records: readonly ContractEventRecord[],
  release: ElectionRegistryRelease,
): DefinitionRegistrationOutcome {
  const d = definition.value;
  const version = pinnedVersion(d, RECORD_TYPES.contractEvent);
  if (!isReadable(version)) return { status: "unverifiable", code: "unsupported-version" };
  // T-71, as `registrationCheck`.
  if (d.l2_chain_id !== release.chainId || !equal(d.election_registry, release.electionRegistry))
    return { status: "fail", code: "registries" };
  const contracts: EventContracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const definitions: { readonly record: ContractEventRecord; readonly definition: Uint8Array }[] =
    [];
  for (const record of records) {
    if (!equal(record.contract, contracts.electionRegistry)) continue;
    const checked = checkContractEvent(record, contracts, version);
    if (!checked.ok) return { status: "fail", code: "registry-records" };
    const e = checked.event;
    if (e.event === "DefinitionRegistered" && equal(e.electionId, d.election_id))
      definitions.push({ record, definition: e.definition });
  }
  return matchRegistration(definitions, readDefinition(definition).hash);
}

// 2.1: the registry is write-once per election, so a second registration,
// or one of other bytes, means the definition checked isn't the election's
// (T-34). The hash is recomputed from the logged bytes, never taken from
// the event's topic, which the event check doesn't bind to them.
function matchRegistration(
  definitions: readonly { readonly record: ContractEventRecord; readonly definition: Uint8Array }[],
  hash: Uint8Array,
): DefinitionRegistrationOutcome {
  const [registered] = definitions;
  if (registered === undefined) return { status: "fail", code: "definition-unregistered" };
  if (definitions.length > 1 || !equal(hashOf(registered.definition), hash))
    return { status: "fail", code: "definition-registered" };
  return { status: "pass", record: registered.record };
}

// Every version crypto's event check decodes is one `decodeDefinition`
// reads; one it can't is no registration of a definition this check takes.
function hashOf(definition: Uint8Array): Uint8Array {
  try {
    return readDefinition(decodeDefinition(definition)).hash;
  } catch (e) {
    if (e instanceof DecodeError) return new Uint8Array(0);
    throw e;
  }
}
