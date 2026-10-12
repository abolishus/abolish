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
  newDisplayTextSalt,
  type Panel,
  panelId,
  pinnedVersion,
  RECORD_TYPES,
  revealsMessage,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Base Sepolia ([[0004-l2-choice]]): the L2 the definition names. Nothing is sent to it yet. */
export const L2_CHAIN_ID = 84532n;

/** Under rule 7 of [[0006-trustees]], 4-of-7 opens only with n − 1 = 6 seats taking part. */
export const PANEL = Object.freeze({ threshold: 4, size: 7 });

/** What this part stands in for, and the item that replaces each with the real thing. */
export const STUBS = Object.freeze({
  l2Contracts:
    "the election, trustee and group registries and the L2 board are placeholder addresses: nothing is registered on L2 (P1-18 deploys them; verifier 2.1, 2.4 and 3.1 read them)",
  electorate:
    "one Tier 0 group with a placeholder root and size: no registration or membership yet (stage 2, P3-2)",
  membershipKey:
    "membership_vk_hash is a placeholder: no ballot is cast, so no membership proof is checked (P1-17b, stage 4)",
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
const placeholder = (name: string) => label(name).slice(12);

export interface Trustee {
  readonly index: number;
  readonly identitySecret: Uint8Array;
}

export interface Ceremony {
  readonly panel: Panel;
  readonly definition: ElectionDefinition;
  readonly transcript: Uint8Array;
}

export interface Timing {
  readonly l1ChainId: bigint;
  readonly l1Anchor: Uint8Array;
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  readonly inclusionBound: number;
}

/**
 * The profile: plurality, every type from 0x0001 to 0x0009 pinned, with
 * board-entry version 4 since tally-opening version 1 needs it
 * ([[verifier]] 2.3).
 */
function profile(): ElectionDefinition["profile"] {
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: t === RECORD_TYPES.boardEntry ? 4 : 1 });
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

/**
 * Creates the election's stub, runs the key ceremony over it with every seat
 * taking part, and returns the definition that binds the transcript.
 */
export function runCeremony(timing: Timing, text: DisplayText): Ceremony {
  const trustees: Trustee[] = Array.from({ length: PANEL.size }, (_, i) => ({
    index: i + 1,
    identitySecret: crypto.getRandomValues(new Uint8Array(32)),
  }));
  const panel: Panel = {
    threshold: PANEL.threshold,
    keys: trustees.map((t) => identityKey(t.identitySecret)),
  };
  const electionRegistry = placeholder("election-registry");
  const stub: ElectionDefinition = {
    profile: profile(),
    // The registry's first election: the counter starts at 0.
    election_id: electionId(L2_CHAIN_ID, electionRegistry, 0n),
    l2_chain_id: L2_CHAIN_ID,
    l1_chain_id: timing.l1ChainId,
    election_registry: electionRegistry,
    board: placeholder("board"),
    trustee_registry: placeholder("trustee-registry"),
    group_registry: placeholder("group-registry"),
    l1_anchor: timing.l1Anchor,
    l1_relay: placeholder("l1-relay"),
    election_type: 1,
    tally_scheme: 1,
    option_count: 3,
    min_selections: 0,
    max_selections: 1,
    electorate: [{ tier: 0, group_id: 1n, root: 1n, root_l2_block: 1n, group_size: 1n }],
    membership_vk_hash: label("membership-vk"),
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
  const seats = trustees.map((t) => ceremonyKeygen(t.index, t.identitySecret));
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
  return { panel, definition, transcript };
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
