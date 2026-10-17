// The simulated election's definition and its key ceremony: a well-formed
// version-4 election definition built from the scenario, listing the board
// operator's receipt key (docs/spec/election-definition.md, Layout (version
// 4), Receipt keys), and the four signed
// rounds of docs/spec/ceremony.md run by every seat through
// @abolishus/crypto's production entry points. The transcript is checked by
// crypto's `checkCeremonyTranscript` with its context rebuilt from the
// definition, never from the transcript, and ballots are encrypted only to
// the keys that check registered, so a run exercises the same binding a
// voter's client and a trustee node rely on (T-37). The election is created
// on the simulated L2's election registry, which gives its identifier, and
// once every seat has checked the transcript and signed the key set that
// check returned, the trustee registry records the ceremony and the election
// registry the definition (./l2.ts; T-37, T-14, T-34). Nothing here
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
  type ElectionDefinitionV4,
  electionDefinitionV4Hash,
  electionDefinitionV4Rule,
  electionStubV4Hash,
  encodeCeremonyTranscript,
  identityKey,
  keySetEntry,
  keySetHash,
  keysMessage,
  membershipVkHash,
  newDisplayTextSalt,
  type Panel,
  panelId,
  RECORD_TYPES,
  type RegisteredKeys,
  revealsMessage,
  type SeatSecrets,
  signCeremonyRegistration,
  TALLY_SCHEMES,
} from "@abolishus/crypto";
import {
  type CeremonyRegistrationRecord,
  l2BlockAt,
  rule7Quorum,
  SIMULATED_REGISTRATION_LEAD,
  SimulatedElectionRegistry,
  type SimulatedDeployment,
  SimulatedTrusteeRegistry,
} from "./l2.ts";
import { type Plan, SIMULATED_CLOSES_AT, SIMULATED_OPENS_AT, selectionRange } from "./plan.ts";
import type { Scenario } from "./scenario.ts";

/**
 * Local chain IDs (Anvil's 31337 for L1, the next for L2), never a public
 * network's, so a simulated definition can't be taken for one on a testnet.
 * Nothing is sent to either.
 */
export const SIMULATED_L2_CHAIN_ID = 31338n;
export const SIMULATED_L1_CHAIN_ID = 31337n;

// Recognisable placeholder values: an L1 address repeats one byte, and a
// tier's root is 2²⁰⁰ plus its tier, so none can be mistaken for a
// deployment's or a real tier tree's root (a Poseidon output).
const PLACEHOLDER_BYTES = Object.freeze({ l1Anchor: 0xb1, l1Relay: 0xb2 } as const);
const placeholder = (name: keyof typeof PLACEHOLDER_BYTES) =>
  new Uint8Array(20).fill(PLACEHOLDER_BYTES[name]);
const placeholderRoot = (tier: number) => (1n << 200n) + BigInt(tier);

/**
 * The account that creates the election and registers its definition. The
 * registry compares it only with the creation's (./l2.ts).
 */
export const SIMULATED_CREATOR = "creator";

/**
 * A fresh deployment: random L2 addresses, so each run's election registry,
 * counting from 0, still gives an identifier no other run has, and the
 * placeholder L1 anchor and relay. The anchoring clock starts at the Unix
 * epoch (./anchor.ts).
 */
export function simulatedDeployment(): SimulatedDeployment {
  const address = () => crypto.getRandomValues(new Uint8Array(20));
  return {
    l2ChainId: SIMULATED_L2_CHAIN_ID,
    electionRegistry: address(),
    board: address(),
    trusteeRegistry: address(),
    groupRegistry: address(),
    l1ChainId: SIMULATED_L1_CHAIN_ID,
    l1Anchor: placeholder("l1Anchor"),
    l1Relay: placeholder("l1Relay"),
    epoch: 0n,
  };
}

export interface SimulatedElection {
  readonly definition: ElectionDefinitionV4;
  readonly definitionHash: Uint8Array;
  readonly transcript: Uint8Array;
  readonly transcriptHash: Uint8Array;
  /** The panel the ceremony ran under, which the definition's `panel_id` names. */
  readonly panel: Panel;
  /** Every seat's secrets, by seat from 1: online, offline and faulty seats all took part. */
  readonly seats: readonly SeatSecrets[];
  /** The keys `checkCeremonyTranscript` registered, by seat. */
  readonly registered: readonly RegisteredKeys[];
  readonly deployment: SimulatedDeployment;
  /** The trustee registry, with the panel pinned and the ceremony recorded. */
  readonly trusteeRegistry: SimulatedTrusteeRegistry;
  /** The election registry, with the election created and its definition registered. */
  readonly electionRegistry: SimulatedElectionRegistry;
  /** The record the trustee registry recorded: every registered seat's approval. */
  readonly registration: CeremonyRegistrationRecord;
}

/** The board-entry version the profile pins: 5, which carries the delivery records and destruction statements ballot version 2 and tally-opening version 1 need ([[verifier]] 2.3), and the close statements, the only one the election registry admits ([[contracts]], Registration, rule 9) and [[verifier]] 2.3 accepts ([[close]], Version). */
export const SIMULATED_BOARD_ENTRY_VERSION = 5;

/** The contract-event version the profile pins: 6, the one that archives every board event, the close rule's, the batches' and the obligation root's, and the group registry's Tier 1 additions ([[contracts]], Contract-event record), and the only one 2.3 accepts ([[close]], Version). */
export const SIMULATED_EVENT_VERSION = 6;

/**
 * The versions the profile pins where they aren't 1: the definition's own
 * (4), ballots that name their cell (2) and the openings of their cores (2),
 * the one combination definition version 4 allows (protocol.ts,
 * `profileCombinationRule`; [[verifier]] 2.3), and the board-entry and
 * contract-event versions the election registry serves (5 and 6).
 */
const PINNED: ReadonlyMap<number, number> = new Map([
  [RECORD_TYPES.electionDefinition, 4],
  [RECORD_TYPES.ballot, 2],
  [RECORD_TYPES.spoiledBallotOpening, 2],
  [RECORD_TYPES.boardEntry, SIMULATED_BOARD_ENTRY_VERSION],
  [RECORD_TYPES.contractEvent, SIMULATED_EVENT_VERSION],
]);

/** The profile: every type from 0x0001 to 0x0009 pinned, at version 1 but those in `PINNED`. */
function profile(): ElectionDefinitionV4["profile"] {
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: PINNED.get(t) ?? 1 });
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
 * Deploys the simulated L2 registries with the panel pinned, creates the
 * election, builds its stub from the scenario and its plan, listing
 * `receiptKey` (a `p256-key`, the board operator's) as its one receipt key,
 * runs the key ceremony over it with every seat taking part, checks the
 * transcript, records the ceremony from every registered seat's approval and
 * registers the definition that binds it, a day before opening. Throws only
 * on a bug: an honest ceremony that doesn't check, a definition that breaks
 * a rule, or a registry refusing either.
 */
export function simulateElection(
  scenario: Scenario,
  plan: Plan,
  receiptKey: Uint8Array,
): SimulatedElection {
  const { panel: n, threshold: k } = scenario.trustees;
  const { min, max } = selectionRange(scenario);
  const identitySecrets = Array.from({ length: n }, () =>
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const panel: Panel = { threshold: k, keys: identitySecrets.map((s) => identityKey(s)) };
  const deployment = simulatedDeployment();
  // The registry pins the panel at deployment, with rule 7's quorum (T-14).
  const trusteeRegistry = new SimulatedTrusteeRegistry(
    deployment.l2ChainId,
    deployment.trusteeRegistry,
    [{ panel, quorum: rule7Quorum(panel) }],
  );
  const electionRegistry = new SimulatedElectionRegistry(deployment, trusteeRegistry);
  const voters = new Map(plan.tiers.map((t) => [t, 0n]));
  for (const v of plan.voters) voters.set(v.tier, (voters.get(v.tier) ?? 0n) + 1n);
  const stub: ElectionDefinitionV4 = {
    profile: profile(),
    // The registry's, from its counter, at a creation finalized before the
    // stub is written (docs/spec/contracts.md, Election identifier).
    election_id: electionRegistry.createElection(SIMULATED_CREATOR),
    l2_chain_id: deployment.l2ChainId,
    l1_chain_id: deployment.l1ChainId,
    election_registry: deployment.electionRegistry,
    board: deployment.board,
    trustee_registry: deployment.trusteeRegistry,
    group_registry: deployment.groupRegistry,
    l1_anchor: deployment.l1Anchor,
    l1_relay: deployment.l1Relay,
    election_type: ELECTION_TYPES[scenario.election],
    tally_scheme: TALLY_SCHEMES.pedersenVss,
    option_count: scenario.options,
    min_selections: min,
    max_selections: max,
    // One group per tier in one region, so each tier is one cell, as
    // version 1's tiers-only partition was (docs/spec/election-definition.md,
    // Regional cells), with a placeholder root: membership isn't simulated
    // yet. Its count is the tier's planned voters (at least 1, as the
    // definition requires), since every planned voter casts.
    electorate: plan.tiers.map((tier) => {
      const members = (voters.get(tier) ?? 0n) > 0n ? (voters.get(tier) as bigint) : 1n;
      return {
        tier,
        root_l2_block: 1n,
        groups: [{ group_id: BigInt(tier + 1), region: 0 }],
        regions: [members],
        cells: [{ root: placeholderRoot(tier), members }],
      };
    }),
    membership_vk_hash: membershipVkHash(),
    panel_id: panelId(panel),
    threshold: k,
    panel_size: n,
    ceremony_transcript_hash: new Uint8Array(32),
    // A one-day voting period in L2 time (./plan.ts).
    opens_at: SIMULATED_OPENS_AT,
    closes_at: SIMULATED_CLOSES_AT,
    l1_inclusion_bound: 3600,
    sequencing_window: 3600n,
    max_sequencer_drift: 1800n,
    display_text_commitment: displayTextCommitment(displayText(scenario)),
    // In the stub, so the key is fixed before the ceremony (T-26).
    receipt_keys: [Uint8Array.from(receiptKey)],
  };
  const params = {
    l2ChainId: stub.l2_chain_id,
    trusteeRegistry: stub.trustee_registry,
    electionId: stub.election_id,
    stubHash: electionStubV4Hash(stub),
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
  const definition: ElectionDefinitionV4 = {
    ...stub,
    ceremony_transcript_hash: ceremonyTranscriptHash(transcript),
  };
  const rule = electionDefinitionV4Rule(definition);
  if (rule !== undefined) throw new Error(`simulation: the definition breaks ${rule}`);
  // Every seat the check registered signs the key set it returned, over the
  // registry's chain and address (docs/spec/trustee-identity.md, Ceremony
  // registration), and anyone submits the record (T-71).
  const keySet = checked.registered.map(keySetEntry);
  const setHash = keySetHash(keySet);
  const registration: CeremonyRegistrationRecord = {
    panelId: definition.panel_id,
    stubHash: params.stubHash,
    ceremonyTranscriptHash: definition.ceremony_transcript_hash,
    seats: keySet,
    approvals: checked.registered.map(({ index }) => ({
      index,
      signature: signCeremonyRegistration(identitySecrets[index - 1] as Uint8Array, panel, {
        l2ChainId: definition.l2_chain_id,
        trusteeRegistry: definition.trustee_registry,
        index,
        stubHash: params.stubHash,
        ceremonyTranscriptHash: definition.ceremony_transcript_hash,
        keySetHash: setHash,
      }),
    })),
  };
  const recorded = trusteeRegistry.registerCeremony(registration);
  if (!recorded.ok)
    throw new Error(`simulation: the trustee registry refused the ceremony (${recorded.refusal})`);
  const accepted = electionRegistry.registerDefinition(
    SIMULATED_CREATOR,
    definition,
    l2BlockAt(definition.opens_at - SIMULATED_REGISTRATION_LEAD),
  );
  if (!accepted.ok)
    throw new Error(
      `simulation: the election registry refused the definition (${accepted.refusal})`,
    );
  return {
    definition,
    definitionHash: electionDefinitionV4Hash(definition),
    transcript,
    transcriptHash: checked.hash,
    panel,
    seats,
    registered: checked.registered,
    deployment,
    trusteeRegistry,
    electionRegistry,
    registration,
  };
}
