// The stub checks a node runs before it sends its round-1 message and again
// before it signs a ceremony registration (docs/spec/ceremony.md, Stub
// checks). The stub reaches the permanent archive once registered, so a node
// lends its keys only to one whose fields the pins and the chain fix, never
// to chosen bytes (T-17, G-12, T-37), and only to one whose contract-path
// obligation it can force through L1 in time (check 4; T-25, T-52, T-54).
import {
  CONTRACT_EVENT_WINDOW,
  DecodeError,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  definitionMembers,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  electionStubHash,
  electionStubV5Hash,
  forcedPathDemand,
  type ForcedPathElection,
  forcedPathFits,
  type ForcedPathWindows,
  membershipVkHash,
  type Panel,
  panelId,
  pinnedVersion,
  profileCombinationRule,
  RECORD_TYPES,
} from "@abolishus/crypto";

/**
 * The windows this release sizes the forced path by (docs/spec/delivery.md,
 * Capacity): `W_C`, the registry's `CONTRACT_EVENT_WINDOW` of 14 hours, `F` of
 * 13 hours (Base's 12-hour forced-inclusion delay and an hour of missed slots)
 * and `R` of one hour, which `deliveryWindowFits` accepts with hourly anchoring
 * periods and a 12-hour deadline. A release
 * that changes `R` changes every node's and client's intake cutoff, so it is
 * the release's, never a node's own setting.
 */
export const RELEASE_WINDOWS: ForcedPathWindows = Object.freeze({
  contractEventWindow: CONTRACT_EVENT_WINDOW,
  forcedInclusion: 46_800n,
  margin: 3_600n,
});

/**
 * A stub of a definition version this release reads: version 1, and version
 * 5, the one the website creates (questions over regional cells,
 * `packages/core`'s poll stubs). Versions 3 and 4 have no creator, and
 * version 6's author panel and version 7's rolling tiers aren't read yet.
 */
export type Stub =
  | { readonly version: 1; readonly value: ElectionDefinition }
  | { readonly version: 5; readonly value: ElectionDefinitionV5 };

/**
 * Strictly decodes a stub of a version `Stub` holds, throwing `DecodeError`
 * otherwise (`unknown-version` for a definition version it doesn't hold).
 */
export function decodeStub(bytes: Uint8Array): Stub {
  // Version 5 isn't among the versions decodeElectionDefinitionRecord
  // reads; its version byte is read here only to pick the decoder, which
  // checks it again against the profile.
  if (bytes instanceof Uint8Array && bytes[2] === 5)
    return { version: 5, value: decodeElectionDefinitionV5(bytes) };
  const record = decodeElectionDefinitionRecord(bytes);
  if (record.version !== 1) throw new DecodeError("unknown-version", 2);
  return record;
}

/** `stub_hash` under the stub's own version (docs/spec/election-definition.md, Stub hash and the ceremony). */
export function stubHash(stub: Stub): Uint8Array {
  return stub.version === 1 ? electionStubHash(stub.value) : electionStubV5Hash(stub.value);
}

/** The hash of the definition a transcript registers: the stub with `ceremony_transcript_hash` set. */
export function stubDefinitionHash(stub: Stub, transcriptHash: Uint8Array): Uint8Array {
  return stub.version === 1
    ? electionDefinitionHash({ ...stub.value, ceremony_transcript_hash: transcriptHash })
    : electionDefinitionV5Hash({ ...stub.value, ceremony_transcript_hash: transcriptHash });
}

/** What the capacity check reads from a stub (versions 1 and 5: one panel, no author seats). */
export function stubDemand(stub: ElectionDefinition | ElectionDefinitionV5): ForcedPathElection {
  return {
    members: definitionMembers(stub),
    seats: stub.panel_size,
    closesAt: stub.closes_at,
    l1InclusionBound: BigInt(stub.l1_inclusion_bound),
  };
}

/** What the node's release and deployment pin. */
export interface Pins {
  readonly panel: Panel;
  readonly l2ChainId: bigint;
  /** The trustee registry the node registers with, 20 bytes. */
  readonly trusteeRegistry: Uint8Array;
}

/**
 * [[verifier]] 2.4 on a stub, against finalized L2 state at each tier's
 * `root_l2_block`: every tier's `root`, `group_id` and `group_size` match the
 * tier tree rebuilt from that tier's counted additions. It must resolve
 * `false` whenever it can't decide (a block not yet final, a node it can't
 * reach), since a node refuses a stub it hasn't checked. The check belongs
 * to `packages/verifier` (AGENTS.md, the verifier's trust base); the node
 * only calls it.
 */
export type ElectorateCheck = (stub: Stub) => Promise<boolean>;

/** Why a node refuses a stub, in checking order. */
export type StubRefusal =
  | "stub-decode"
  | "stub-version"
  | "stub-transcript-hash"
  | "stub-rule"
  | "stub-pins"
  | "stub-profile"
  | "stub-membership-key"
  | "stub-electorate"
  | "stub-capacity";

export type StubCheck =
  | { readonly ok: true; readonly stub: Stub; readonly stubHash: Uint8Array }
  | { readonly ok: false; readonly code: StubRefusal };

// The versions of the record types `profileCombinationRule` doesn't judge
// that this release reads. Fixed here rather than read from crypto's record
// types, so a version crypto adds reaches nodes only through a release that
// lists it; the ceremony transcript is the one this node checks (1).
const READ_VERSIONS: ReadonlyMap<number, ReadonlySet<number>> = new Map([
  [RECORD_TYPES.receipt, new Set([1])],
  [RECORD_TYPES.ceremonyTranscript, new Set([1])],
  [RECORD_TYPES.tallyOpening, new Set([1])],
  // Version 8 only: the election registry registers no other (docs/spec/
  // contracts.md, Registration, rule 9), so a ceremony for another would
  // lend keys to an election that can't be registered.
  [RECORD_TYPES.contractEvent, new Set([8])],
]);

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Stub checks 1 to 4. Definition versions 1 and 5 are read (`Stub`); any
 * other is refused (`stub-version`), so no ceremony runs for an election the
 * node can't check: no author panel's (version 6), and no rolling one
 * (version 7), whose members over the poll check 4 can't count.
 * `served` holds the demand of every election the seat has approved, by stub
 * hash (hex); the stub's own entry, if any, is left out.
 */
export async function checkStub(
  bytes: Uint8Array,
  pins: Pins,
  electorate: ElectorateCheck,
  served: ReadonlyMap<string, ForcedPathElection>,
): Promise<StubCheck> {
  let record: Stub;
  try {
    record = decodeStub(bytes);
  } catch (e) {
    if (e instanceof DecodeError) {
      // An unknown definition version decodes as nothing this node reads.
      return { ok: false, code: e.code === "unknown-version" ? "stub-version" : "stub-decode" };
    }
    throw e;
  }
  const stub = record.value;
  // 1: the stub as the creator fixed it, before any transcript exists; its
  // hash is recomputed here, never taken from the coordinator.
  if (!stub.ceremony_transcript_hash.every((b) => b === 0))
    return { ok: false, code: "stub-transcript-hash" };
  // Version 5's rule includes the questions' and cells' own (T-28, T-34).
  const rule =
    record.version === 1
      ? electionDefinitionRule(record.value)
      : electionDefinitionV5Rule(record.value);
  if (rule !== undefined) return { ok: false, code: "stub-rule" };
  // 2: the panel, the chain and the registry this node's release and
  // deployment pin.
  if (
    !equal(stub.panel_id, panelId(pins.panel)) ||
    stub.threshold !== pins.panel.threshold ||
    stub.panel_size !== pins.panel.keys.length ||
    stub.l2_chain_id !== pins.l2ChainId ||
    !equal(stub.trustee_registry, pins.trusteeRegistry)
  )
    return { ok: false, code: "stub-pins" };
  // 3, [[verifier]] 2.3: every pinned version is one this release reads, in
  // a combination that fits. The well-formedness rule above makes the pins
  // exactly types 0x0001 to 0x0009: `profileCombinationRule` judges seven of
  // them (the contract event's included), and the rest are judged here. Unlike the verifier, which leaves an election
  // it can't read unverifiable, a node refuses: it can't check what it
  // can't read.
  if (
    profileCombinationRule(stub) !== undefined ||
    stub.profile.pins.some((p) => {
      const read = READ_VERSIONS.get(p.record_type);
      return read !== undefined && !read.has(p.version);
    })
  )
    return { ok: false, code: "stub-profile" };
  // 3, [[verifier]] 1.3: ballot versions 1 to 3 prove membership under the
  // one key this release pins; a later version's key isn't known here. The
  // profile combination above already ties the ballot version to the
  // definition's (1 under 1, 3 under 5).
  const ballot = pinnedVersion(stub, RECORD_TYPES.ballot);
  if (
    (ballot !== 1 && ballot !== 2 && ballot !== 3) ||
    !equal(stub.membership_vk_hash, membershipVkHash())
  )
    return { ok: false, code: "stub-membership-key" };
  // 3, [[verifier]] 2.4: the electorate, against the chain.
  // The hash is of the stub as checked above; the deployment's check gets
  // its own decoded copy, so nothing it does can change what is hashed.
  const hash = stubHash(record);
  if (!(await electorate(decodeStub(bytes)))) return { ok: false, code: "stub-electorate" };
  // 4: the forced path, over the counts 2.4 just checked, with every election
  // this seat serves whose intervals can overlap this one's; the others never
  // share a moment with it (docs/spec/delivery.md, Capacity).
  const own = Buffer.from(hash).toString("hex");
  const demand = stubDemand(stub);
  const mine = forcedPathDemand(demand, RELEASE_WINDOWS);
  const others = [...served]
    .filter(([hash]) => hash !== own)
    .map(([, other]) => other)
    .filter((other) => {
      const o = forcedPathDemand(other, RELEASE_WINDOWS);
      return o.complaints.end > mine.receipts.start && o.receipts.start < mine.complaints.end;
    });
  if (!forcedPathFits([...others, demand], RELEASE_WINDOWS))
    return { ok: false, code: "stub-capacity" };
  return { ok: true, stub: record, stubHash: hash };
}
