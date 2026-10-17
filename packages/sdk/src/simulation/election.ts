// The simulated election's definition and its key ceremony: a well-formed
// election definition built from the scenario, version 4 for one question
// or version 5 for several (docs/spec/election-definition.md, Layout
// (version 5)), listing the board operator's receipt key (Layout (version
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
// registry the definition (./l2.ts; T-37, T-14, T-34). Every planned voter
// has a fresh identity secret, and each tier's cell root is the tier tree of
// their commitments, so a ballot's membership proof is against the root the
// definition names (T-10). Nothing here reimplements a check the verifier
// makes (AGENTS.md, Architecture).

import {
  answersMessage,
  ceremonyKeygen,
  ceremonyTranscriptHash,
  challengesMessage,
  checkCeremonyTranscript,
  type DisplayText,
  displayTextCommitment,
  type DisplayTextV2,
  displayTextV2Commitment,
  ELECTION_TYPES,
  type ElectionDefinitionV4,
  type ElectionDefinitionV5,
  encodeCeremonyTranscript,
  identityCommitment,
  identityKey,
  keySetEntry,
  keySetHash,
  keysMessage,
  membershipVkHash,
  newDisplayTextSalt,
  newIdentitySecret,
  type Panel,
  panelId,
  QUESTION_METHODS,
  RECORD_TYPES,
  type RegisteredKeys,
  revealsMessage,
  type SeatSecrets,
  signCeremonyRegistration,
  TALLY_SCHEMES,
  tierTreeRoot,
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
import type { Scenario, SimulatedTier } from "./scenario.ts";
import {
  definitionHashOf,
  definitionRuleOf,
  type SimulatedDefinition,
  stubHashOf,
} from "./versions.ts";

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
  /** Version 4 for a one-question scenario, version 5 for `questions`. */
  readonly definition: SimulatedDefinition;
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
  /** Every planned voter's identity secret, by the voter's plan index; it stays in the voter's client. */
  readonly identities: readonly Uint8Array[];
  /** Each tier's leaves, in tier-tree order: its one cell's tree, whose root the definition names. */
  readonly leaves: ReadonlyMap<SimulatedTier, readonly bigint[]>;
}

/** The board-entry version the profile pins: 5, which carries the delivery records and destruction statements ballot version 2 and tally-opening version 1 need ([[verifier]] 2.3), and the close statements, the only one the election registry admits ([[contracts]], Registration, rule 9) and [[verifier]] 2.3 accepts ([[close]], Version). */
export const SIMULATED_BOARD_ENTRY_VERSION = 5;

/** The contract-event version the profile pins: 7, the one that archives every board event, the close rule's, the batches' and the obligation root's, and the group registry's Tier 1 and self-paid additions ([[contracts]], Contract-event record), and the only one 2.3 accepts ([[close]], Version). */
export const SIMULATED_EVENT_VERSION = 7;

/**
 * The versions the profile pins where they aren't 1: the definition's own
 * (4), ballots that name their cell (2) and the openings of their cores (2),
 * the one combination definition version 4 allows (protocol.ts,
 * `profileCombinationRule`; [[verifier]] 2.3), and the board-entry and
 * contract-event versions the election registry serves (5 and 7).
 */
const PINNED: ReadonlyMap<number, number> = new Map([
  [RECORD_TYPES.electionDefinition, 4],
  [RECORD_TYPES.ballot, 2],
  [RECORD_TYPES.spoiledBallotOpening, 2],
  [RECORD_TYPES.boardEntry, SIMULATED_BOARD_ENTRY_VERSION],
  [RECORD_TYPES.contractEvent, SIMULATED_EVENT_VERSION],
]);

/**
 * Version 5's: its own, ballot version 3 with the same openings, and
 * display-text version 2, which carries its questions, the one combination
 * definition version 5 allows and the registry serves for it ([[contracts]],
 * Registration, rule 9).
 */
const PINNED_V5: ReadonlyMap<number, number> = new Map([
  ...PINNED,
  [RECORD_TYPES.electionDefinition, 5],
  [RECORD_TYPES.ballot, 3],
  [RECORD_TYPES.displayText, 2],
]);

/** The profile: every type from 0x0001 to 0x0009 pinned, at version 1 but those in `pinned`. */
function profile(pinned: ReadonlyMap<number, number>): ElectionDefinitionV4["profile"] {
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: pinned.get(t) ?? 1 });
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
        options: optionText(scenario.options),
      },
    ],
  };
}

const optionText = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    label: utf8(`Option ${i + 1}`),
    description: utf8(""),
  }));

function questionsText(questions: NonNullable<Scenario["questions"]>): DisplayTextV2 {
  return {
    salt: newDisplayTextSalt(),
    translations: [
      {
        language: utf8("en"),
        title: utf8("Simulated election: it counts for nothing."),
        description: utf8(""),
        questions: questions.map((q, i) => ({
          question: utf8(`Question ${i + 1}`),
          description: utf8(""),
          options: optionText(q.options),
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
  // Each voter's identity secret, its commitment added to its tier's group
  // in voter order. A tier no voter is planned in still has a member, since
  // a cell has at least one (docs/spec/election-definition.md): one whose
  // secret no client holds, so it never votes.
  const identities: Uint8Array[] = [];
  const leaves = new Map<SimulatedTier, bigint[]>(plan.tiers.map((t) => [t, []]));
  for (const v of [...plan.voters].sort((a, b) => a.index - b.index)) {
    const secret = newIdentitySecret();
    identities[v.index] = secret;
    leaves.get(v.tier)?.push(identityCommitment(secret));
  }
  for (const group of leaves.values())
    if (group.length === 0) group.push(identityCommitment(newIdentitySecret()));
  const common = {
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
    tally_scheme: TALLY_SCHEMES.pedersenVss,
    // One group per tier in one region, so each tier is one cell, as
    // version 1's tiers-only partition was (docs/spec/election-definition.md,
    // Regional cells), whose root is the tier tree of its members'
    // commitments and whose count is theirs.
    electorate: plan.tiers.map((tier) => {
      const group = leaves.get(tier) ?? [];
      const members = BigInt(group.length);
      return {
        tier,
        root_l2_block: 1n,
        groups: [{ group_id: BigInt(tier + 1), region: 0 }],
        regions: [members],
        cells: [{ root: tierTreeRoot(group), members }],
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
    // In the stub, so the key is fixed before the ceremony (T-26).
    receipt_keys: [Uint8Array.from(receiptKey)],
  };
  const { questions, election } = scenario;
  // A scenario built without parseScenario must still be one shape or the
  // other: `options` drives the plan and the tally's sums.
  if (
    (election === "questions") !== (questions !== undefined) ||
    (questions !== undefined && questions.reduce((n, q) => n + q.options, 0) !== scenario.options)
  )
    throw new TypeError("simulation: questions go with election questions and sum to options");
  let stub: SimulatedDefinition;
  if (questions !== undefined) {
    const v5: ElectionDefinitionV5 = {
      ...common,
      profile: profile(PINNED_V5),
      questions: questions.map((q) => ({
        method: QUESTION_METHODS.selection,
        option_count: q.options,
        min_selections: q.min,
        max_selections: q.max,
      })),
      display_text_commitment: displayTextV2Commitment(questionsText(questions)),
    };
    stub = v5;
  } else {
    if (election === "questions")
      throw new TypeError("simulation: a questions scenario lists them");
    const { min, max } = selectionRange(scenario);
    const v4: ElectionDefinitionV4 = {
      ...common,
      profile: profile(PINNED),
      election_type: ELECTION_TYPES[election],
      option_count: scenario.options,
      min_selections: min,
      max_selections: max,
      display_text_commitment: displayTextCommitment(displayText(scenario)),
    };
    stub = v4;
  }
  const params = {
    l2ChainId: stub.l2_chain_id,
    trusteeRegistry: stub.trustee_registry,
    electionId: stub.election_id,
    stubHash: stubHashOf(stub),
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
  const definition: SimulatedDefinition = {
    ...stub,
    ceremony_transcript_hash: ceremonyTranscriptHash(transcript),
  };
  const rule = definitionRuleOf(definition);
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
    definitionHash: definitionHashOf(definition),
    transcript,
    transcriptHash: checked.hash,
    panel,
    seats,
    registered: checked.registered,
    deployment,
    trusteeRegistry,
    electionRegistry,
    registration,
    identities,
    leaves,
  };
}
