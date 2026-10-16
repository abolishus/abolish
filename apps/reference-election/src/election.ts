// Stage 1 of the reference election: a trustee panel, its key ceremony through
// @abolishus/crypto's production entry points (docs/spec/ceremony.md), and the
// election definition that binds the ceremony's transcript
// (docs/spec/election-definition.md, Stub hash and the ceremony). Everything a
// later item builds is a stub here, named in STUBS so the transcript says so.

import {
  answersMessage,
  BOARD_ENTRY,
  type BoardEntryVersion,
  ceremonyKeygen,
  ceremonyTranscriptHash,
  challengesMessage,
  type DisplayText,
  displayTextCommitment,
  type ElectionDefinition,
  electionDefinitionRule,
  electionId,
  electionStubHash,
  encodeBoardEntry,
  encodeCeremonyTranscript,
  identityKey,
  keysMessage,
  membershipVkHash,
  newDisplayTextSalt,
  type Panel,
  panelId,
  pinnedVersion,
  RECORD_TYPES,
  revealsMessage,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Under rule 7 of [[0006-trustees]], 4-of-7 opens only with n − 1 = 6 seats taking part. */
export const PANEL = Object.freeze({ threshold: 4, size: 7 });

/** What this part stands in for, and the item that replaces each with the real thing. */
export const STUBS = Object.freeze({
  l2: "the L2 is a second local Anvil, not Base Sepolia, with forge's MockL1Block at the L1Block predeploy reporting the L1 Anvil's latest block as each event's origin; the verifier reads nothing from it yet (verifier 2.1, 2.4, 3.1 and 4.4, P1-19)",
  groupRegistrars:
    "the group registry's two registrars are placeholder addresses: no group is created (stage 3, P3-2)",
  l1Relay: "the L1 relay is a placeholder address: no relay is deployed (P4-2)",
  electorate:
    "one Tier 0 group with a placeholder root and size: no registration or membership yet (stage 2, P3-2)",
  panel:
    "the panel's identity keys are fresh random keys, given to the verifier as a local file: no release pins a panel yet ([[0006-trustees]], P1-7)",
  anchorAuthority:
    "the anchoring authority is a one-byte contract Anvil lets the fixture send from, not the Safe (P4-1 part 2)",
  seal: "lastSegment is the segment after the ceremony's: no definition-derived seal yet, since no post-close window is fixed (P1-13, P1-15, P1-18)",
});

// Distinct, recognisable placeholder values: anyone can recompute them from
// their label, so none can be mistaken for a deployment's.
const label = (name: string) =>
  keccak_256(new TextEncoder().encode(`reference-election/placeholder/${name}`));
export const placeholder = (name: string) => label(name).slice(12);

export interface Trustee {
  readonly index: number;
  readonly identitySecret: Uint8Array;
}

/** The panel's seats with their identity secrets, and the panel they make. */
export interface Trustees {
  readonly seats: readonly Trustee[];
  readonly panel: Panel;
}

export function newTrustees(): Trustees {
  const seats: Trustee[] = Array.from({ length: PANEL.size }, (_, i) => ({
    index: i + 1,
    identitySecret: crypto.getRandomValues(new Uint8Array(32)),
  }));
  return {
    seats,
    panel: { threshold: PANEL.threshold, keys: seats.map((t) => identityKey(t.identitySecret)) },
  };
}

/** The L2 contracts a definition names (l2.ts deploys them). */
export interface L2Deployment {
  readonly l2ChainId: bigint;
  readonly electionRegistry: Uint8Array;
  readonly board: Uint8Array;
  readonly trusteeRegistry: Uint8Array;
  readonly groupRegistry: Uint8Array;
  readonly l1Relay: Uint8Array;
}

export interface Ceremony {
  readonly panel: Panel;
  readonly definition: ElectionDefinition;
  readonly transcript: Uint8Array;
  /** The seats that took part. */
  readonly seats: readonly Trustee[];
}

export interface Timing {
  readonly l1ChainId: bigint;
  readonly l1Anchor: Uint8Array;
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  readonly inclusionBound: number;
}

/**
 * The versions the profile pins where they aren't 1: board-entry version 5,
 * which carries the destruction statements tally-opening version 1 needs
 * ([[verifier]] 2.3) and the close statements, and contract-event version 4,
 * which archives every board event, the close rule's and the share-receipt
 * batch's. The election registry
 * registers no other profile for a version-1 definition ([[contracts]],
 * Election registry, Registration, rule 9).
 */
const PINNED: ReadonlyMap<number, number> = new Map([
  [RECORD_TYPES.boardEntry, 5],
  [RECORD_TYPES.contractEvent, 4],
]);

/** The profile: plurality, every type from 0x0001 to 0x0009 pinned, at version 1 but those in `PINNED`. */
function profile(): ElectionDefinition["profile"] {
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: PINNED.get(t) ?? 1 });
  return { protocol_major: 1, pins };
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The display text: real, though no client shows it yet (P2-8). */
export function displayText(): DisplayText {
  return {
    salt: newDisplayTextSalt(),
    translations: [
      {
        language: utf8("en"),
        question: utf8("Reference election: which option do you prefer?"),
        description: utf8(
          "A fixture run by the reference election (P1-20). It counts for nothing.",
        ),
        options: ["A", "B", "C"].map((x) => ({
          label: utf8(`Option ${x}`),
          description: utf8(""),
        })),
      },
    ],
  };
}

export interface CeremonyOptions {
  /** The election registry's counter of the election's creation. */
  readonly counter: bigint;
  /** How many seats, from the last, send nothing at all. */
  readonly absent: number;
}

/**
 * Writes the stub of the election `l2` created as number `counter`, runs the
 * key ceremony over it with all but `absent` of `trustees` taking part, and
 * returns the definition that binds the transcript.
 */
export function runCeremony(
  timing: Timing,
  l2: L2Deployment,
  trustees: Trustees,
  text: DisplayText,
  { counter, absent }: CeremonyOptions,
): Ceremony {
  const { panel } = trustees;
  const stub: ElectionDefinition = {
    profile: profile(),
    election_id: electionId(l2.l2ChainId, l2.electionRegistry, counter),
    l2_chain_id: l2.l2ChainId,
    l1_chain_id: timing.l1ChainId,
    election_registry: l2.electionRegistry,
    board: l2.board,
    trustee_registry: l2.trusteeRegistry,
    group_registry: l2.groupRegistry,
    l1_anchor: timing.l1Anchor,
    l1_relay: l2.l1Relay,
    election_type: 1,
    tally_scheme: 1,
    option_count: 3,
    min_selections: 0,
    max_selections: 1,
    electorate: [{ tier: 0, group_id: 1n, root: 1n, root_l2_block: 1n, group_size: 1n }],
    // The pinned key, which verifier 1.3 requires; no ballot is cast yet (stage 4).
    membership_vk_hash: membershipVkHash(),
    panel_id: panelId(panel),
    threshold: panel.threshold,
    panel_size: panel.keys.length,
    ceremony_transcript_hash: new Uint8Array(32),
    opens_at: timing.opensAt,
    closes_at: timing.closesAt,
    l1_inclusion_bound: timing.inclusionBound,
    sequencing_window: 3600n,
    max_sequencer_drift: 1800n,
    display_text_commitment: displayTextCommitment(text),
  };
  const params = {
    l2ChainId: stub.l2_chain_id,
    trusteeRegistry: stub.trustee_registry,
    electionId: stub.election_id,
    stubHash: electionStubHash(stub),
    panel,
    runId: crypto.getRandomValues(new Uint8Array(32)),
  };
  const present = trustees.seats.slice(0, trustees.seats.length - absent);
  const seats = present.map((t) => ceremonyKeygen(t.index, t.identitySecret));
  const keys = seats.map((s) => keysMessage(params, s));
  const challenges = seats.map((s) => challengesMessage(params, s, keys));
  const round2 = challenges.map((c) => c.message);
  const answers = seats.map((s) => answersMessage(params, s, keys, round2));
  const reveals = seats.map((s, i) =>
    revealsMessage(params, s, { keys, challenges: round2, answers }, challenges[i]?.secrets ?? []),
  );
  const transcript = encodeCeremonyTranscript({
    run_id: params.runId,
    keys,
    challenges: round2,
    answers,
    reveals,
  });
  const definition = { ...stub, ceremony_transcript_hash: ceremonyTranscriptHash(transcript) };
  const rule = electionDefinitionRule(definition);
  if (rule !== undefined) throw new Error(`the fixture's definition breaks ${rule}`);
  return { panel, definition, transcript, seats: present };
}

/** The board-entry version the definition pins. */
export function boardEntryVersion(d: ElectionDefinition): BoardEntryVersion {
  const v = pinnedVersion(d, RECORD_TYPES.boardEntry);
  if (v === undefined || !(v in BOARD_ENTRY.versions))
    throw new Error("the definition pins no board-entry version");
  return v as BoardEntryVersion;
}

/** One board entry carrying `payload` at `index`, in `segment`. */
export function boardEntry(
  d: ElectionDefinition,
  index: bigint,
  segment: number,
  payload: Uint8Array,
): Uint8Array {
  return encodeBoardEntry(
    { election_id: d.election_id, index, segment, payload },
    boardEntryVersion(d),
  );
}
