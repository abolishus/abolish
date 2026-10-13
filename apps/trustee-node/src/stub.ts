// The stub checks a node runs before it sends its round-1 message and again
// before it signs a ceremony registration (docs/spec/ceremony.md, Stub
// checks). The stub reaches the permanent archive once registered, so a node
// lends its keys only to one whose fields the pins and the chain fix, never
// to chosen bytes (T-17, G-12, T-37).
import {
  DecodeError,
  type ElectionDefinition,
  electionDefinitionRule,
  decodeElectionDefinitionRecord,
  electionStubHash,
  membershipVkHash,
  type Panel,
  panelId,
  pinnedVersion,
  profileCombinationRule,
  RECORD_TYPES,
} from "@abolishus/crypto";

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
export type ElectorateCheck = (stub: ElectionDefinition) => Promise<boolean>;

/** Why a node refuses a stub, in checking order. */
export type StubRefusal =
  | "stub-decode"
  | "stub-version"
  | "stub-transcript-hash"
  | "stub-rule"
  | "stub-pins"
  | "stub-profile"
  | "stub-membership-key"
  | "stub-electorate";

export type StubCheck =
  | { readonly ok: true; readonly stub: ElectionDefinition; readonly stubHash: Uint8Array }
  | { readonly ok: false; readonly code: StubRefusal };

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Stub checks 1 to 3. Only definition version 1 is read so far: a version-3
 * or later stub is refused (`stub-version`) until the node reads its
 * electorate, so no ceremony runs for an election the node can't check.
 */
export async function checkStub(
  bytes: Uint8Array,
  pins: Pins,
  electorate: ElectorateCheck,
): Promise<StubCheck> {
  let record;
  try {
    record = decodeElectionDefinitionRecord(bytes);
  } catch (e) {
    if (e instanceof DecodeError) {
      // An unknown definition version decodes as nothing this node reads.
      return { ok: false, code: e.code === "unknown-version" ? "stub-version" : "stub-decode" };
    }
    throw e;
  }
  if (record.version !== 1) return { ok: false, code: "stub-version" };
  const stub = record.value;
  // 1: the stub as the creator fixed it, before any transcript exists; its
  // hash is recomputed here, never taken from the coordinator.
  if (!stub.ceremony_transcript_hash.every((b) => b === 0))
    return { ok: false, code: "stub-transcript-hash" };
  if (electionDefinitionRule(stub) !== undefined) return { ok: false, code: "stub-rule" };
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
  // a combination that fits. Unlike the verifier, which leaves an election
  // it can't read unverifiable, a node refuses: it can't check what it
  // can't read.
  if (profileCombinationRule(stub) !== undefined) return { ok: false, code: "stub-profile" };
  // 3, [[verifier]] 1.3: ballot versions 1 and 2 prove membership under the
  // one key this release pins; a later version's key isn't known here.
  const ballot = pinnedVersion(stub, RECORD_TYPES.ballot);
  if ((ballot !== 1 && ballot !== 2) || !equal(stub.membership_vk_hash, membershipVkHash()))
    return { ok: false, code: "stub-membership-key" };
  // 3, [[verifier]] 2.4: the electorate, against the chain.
  if (!(await electorate(stub))) return { ok: false, code: "stub-electorate" };
  return { ok: true, stub, stubHash: electionStubHash(stub) };
}
