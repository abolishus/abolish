// The simulated election's definition and its key ceremony: a well-formed
// version-1 election definition built from the scenario, and the four signed
// rounds of docs/spec/ceremony.md run by every seat through
// @abolishus/crypto's production entry points. The transcript is checked by
// crypto's `checkCeremonyTranscript` with its context rebuilt from the
// definition, never from the transcript, and ballots are encrypted only to
// the keys that check registered, so a run exercises the same binding a
// voter's client and a trustee node rely on (T-37, T-15). Nothing here
// reimplements a check the verifier makes (AGENTS.md, Architecture).

import {
  answersMessage,
  ceremonyKeygen,
  ceremonyTranscriptHash,
  challengesMessage,
  checkCeremonyTranscript,
  type DisplayText,
  displayTextCommitment,
  ELECTION_TYPES,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  electionId,
  electionStubHash,
  encodeCeremonyTranscript,
  identityKey,
  keysMessage,
  membershipVkHash,
  newDisplayTextSalt,
  type Panel,
  panelId,
  RECORD_TYPES,
  type RegisteredKeys,
  revealsMessage,
  type SeatSecrets,
  TALLY_SCHEMES,
} from "@abolishus/crypto";
import { type Plan, selectionRange } from "./plan.ts";
import type { Scenario } from "./scenario.ts";

/** Base Sepolia and Sepolia ([[0004-l2-choice]]): the chains the definition names. Nothing is sent to either. */
export const SIMULATED_L2_CHAIN_ID = 84532n;
export const SIMULATED_L1_CHAIN_ID = 11155111n;

// Recognisable placeholder values: an address repeats one byte, and a tier's
// root is 2²⁰⁰ plus its tier, so none can be mistaken for a deployment's or a
// real tier tree's root (a Poseidon output).
const PLACEHOLDER_BYTES = Object.freeze({
  electionRegistry: 0xa1,
  board: 0xa2,
  trusteeRegistry: 0xa3,
  groupRegistry: 0xa4,
  l1Anchor: 0xb1,
  l1Relay: 0xb2,
} as const);
const placeholder = (name: keyof typeof PLACEHOLDER_BYTES) =>
  new Uint8Array(20).fill(PLACEHOLDER_BYTES[name]);
const placeholderRoot = (tier: number) => (1n << 200n) + BigInt(tier);

export interface SimulatedElection {
  readonly definition: ElectionDefinition;
  readonly definitionHash: Uint8Array;
  readonly transcript: Uint8Array;
  readonly transcriptHash: Uint8Array;
  /** Every seat's secrets, by seat from 1: online, offline and faulty seats all took part. */
  readonly seats: readonly SeatSecrets[];
  /** The keys `checkCeremonyTranscript` registered, by seat. */
  readonly registered: readonly RegisteredKeys[];
}

/**
 * The profile: every type from 0x0001 to 0x0009 pinned, with board-entry
 * version 4, which ballot and tally-opening version 1 need ([[verifier]] 2.3).
 */
function profile(): ElectionDefinition["profile"] {
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: t === RECORD_TYPES.boardEntry ? 4 : 1 });
  return { protocol_major: 1, pins };
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function displayText(scenario: Scenario): DisplayText {
  return {
    salt: newDisplayTextSalt(),
    translations: [
      {
        language: utf8("en"),
        question: utf8("Simulated election: it counts for nothing."),
        description: utf8(""),
        options: Array.from({ length: scenario.options }, (_, i) => ({
          label: utf8(`Option ${i + 1}`),
          description: utf8(""),
        })),
      },
    ],
  };
}

/**
 * Builds the election's stub from the scenario and its plan, runs the key
 * ceremony over it with every seat taking part, checks the transcript and
 * returns the definition that binds it. Throws only on a bug: an honest
 * ceremony that doesn't check, or a definition that breaks a rule.
 */
export function simulateElection(scenario: Scenario, plan: Plan): SimulatedElection {
  const { panel: n, threshold: k } = scenario.trustees;
  const { min, max } = selectionRange(scenario);
  const identitySecrets = Array.from({ length: n }, () =>
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const panel: Panel = { threshold: k, keys: identitySecrets.map((s) => identityKey(s)) };
  const electionRegistry = placeholder("electionRegistry");
  const voters = new Map(plan.tiers.map((t) => [t, 0n]));
  for (const v of plan.voters) voters.set(v.tier, (voters.get(v.tier) ?? 0n) + 1n);
  const stub: ElectionDefinition = {
    profile: profile(),
    // A fresh counter per run: two runs never share an election identifier.
    election_id: electionId(
      SIMULATED_L2_CHAIN_ID,
      electionRegistry,
      crypto.getRandomValues(new BigUint64Array(1))[0] as bigint,
    ),
    l2_chain_id: SIMULATED_L2_CHAIN_ID,
    l1_chain_id: SIMULATED_L1_CHAIN_ID,
    election_registry: electionRegistry,
    board: placeholder("board"),
    trustee_registry: placeholder("trusteeRegistry"),
    group_registry: placeholder("groupRegistry"),
    l1_anchor: placeholder("l1Anchor"),
    l1_relay: placeholder("l1Relay"),
    election_type: ELECTION_TYPES[scenario.election],
    tally_scheme: TALLY_SCHEMES.pedersenVss,
    option_count: scenario.options,
    min_selections: min,
    max_selections: max,
    // One group per tier, with a placeholder root: membership isn't simulated
    // yet. Its size is the tier's planned voters (at least 1, as the
    // definition requires), since every planned voter casts.
    electorate: plan.tiers.map((tier) => ({
      tier,
      group_id: BigInt(tier + 1),
      root: placeholderRoot(tier),
      root_l2_block: 1n,
      group_size: (voters.get(tier) ?? 0n) > 0n ? (voters.get(tier) as bigint) : 1n,
    })),
    membership_vk_hash: membershipVkHash(),
    panel_id: panelId(panel),
    threshold: k,
    panel_size: n,
    ceremony_transcript_hash: new Uint8Array(32),
    // A one-day voting period in L2 time; nothing reads the clock yet.
    opens_at: 1_000_000n,
    closes_at: 1_086_400n,
    l1_inclusion_bound: 3600,
    sequencing_window: 3600n,
    max_sequencer_drift: 1800n,
    display_text_commitment: displayTextCommitment(displayText(scenario)),
  };
  const params = {
    l2ChainId: stub.l2_chain_id,
    trusteeRegistry: stub.trustee_registry,
    electionId: stub.election_id,
    stubHash: electionStubHash(stub),
    panel,
  };
  const run = { ...params, runId: crypto.getRandomValues(new Uint8Array(32)) };
  const seats = identitySecrets.map((s, i) => ceremonyKeygen(i + 1, s));
  const keys = seats.map((s) => keysMessage(run, s));
  const challenges = seats.map((s) => challengesMessage(run, s, keys));
  const round2 = challenges.map((c) => c.message);
  const answers = seats.map((s) => answersMessage(run, s, keys, round2));
  const reveals = seats.map((s, i) =>
    revealsMessage(run, s, { keys, challenges: round2, answers }, challenges[i]?.secrets ?? []),
  );
  const transcript = encodeCeremonyTranscript({
    run_id: run.runId,
    keys,
    challenges: round2,
    answers,
    reveals,
  });
  // The context is rebuilt from the stub's fields, as a trustee node and the
  // verifier rebuild it (3.2), never read from the transcript (T-37).
  const checked = checkCeremonyTranscript(params, transcript, 1);
  if (!checked.ok) throw new Error(`simulation: the ceremony failed its check (${checked.code})`);
  if (checked.registered.length !== n)
    throw new Error("simulation: an honest seat wasn't registered by the ceremony");
  const definition: ElectionDefinition = {
    ...stub,
    ceremony_transcript_hash: ceremonyTranscriptHash(transcript),
  };
  const rule = electionDefinitionRule(definition);
  if (rule !== undefined) throw new Error(`simulation: the definition breaks ${rule}`);
  return {
    definition,
    definitionHash: electionDefinitionHash(definition),
    transcript,
    transcriptHash: checked.hash,
    seats,
    registered: checked.registered,
  };
}
