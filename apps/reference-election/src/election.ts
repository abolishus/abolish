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
  deriveTierCells,
  type DisplayText,
  displayTextCommitment,
  type DisplayTextV2,
  displayTextV2Commitment,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  type ElectionDefinitionV5,
  electionId,
  electionStubHash,
  electionStubV5Hash,
  encodeBoardEntry,
  encodeCeremonyTranscript,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  identityKey,
  keysMessage,
  type KemSecretKey,
  membershipVkHash,
  newDisplayTextSalt,
  type Panel,
  panelId,
  pinnedVersion,
  QUESTION_METHODS,
  type Question,
  RECORD_TYPES,
  revealsMessage,
  TALLY_SCHEMES,
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
    "one Tier 0 group whose root is the tier tree of the fixture's voters' commitments, computed by the fixture: no group is created in the group registry and no voter registers (stages 2 and 3, P2-6, P3-2)",
  panel:
    "the panel's identity keys are fresh random keys, given to the verifier as a local file: no release pins a panel yet ([[0006-trustees]], P1-7)",
  anchorAuthority:
    "the anchoring authority is a one-byte contract Anvil lets the fixture send from, not the Safe (P4-1 part 2)",
  seal: "lastSegment is four segments after the ceremony's: the tally's opening follows the counted extent's floor, period(closes_at) + 1, by one segment and the destruction statements follow it by one, not tally.md's windows, since no seal is derived from the definition yet (P1-13, P1-15, P1-18)",
  l1References:
    "ballots name the newest blocks the fixture mines on the L1 Anvil during the window, not a block seen 2 deep as revoting.md's Client rules have a client name, and the poll's receipt keys are read at the latest block, not the latest finalized one; the verifier doesn't judge references from a format-4 bundle (5.8, P1-19)",
  casting:
    "ballots are made by the fixture through @abolishus/crypto and the client's prover in Node, not by apps/ballot, and boarded directly: no API admission (P2-8, P2-3); the poll's receipts are signed by the fixture as operator, not by the API's board service",
  seats:
    "the elections of one question run their ceremony and intake in apps/trustee-node's own code (CeremonySeat, IntakeSeat), one node per seat over its own store, with the fixture as coordinator and handing each ballot to every seat in memory, not over the intake endpoint (P2-13 part 4b); the nodes' electorate check compares the stub with the fixture's voters' tree and their registration check reads Anvil's latest L2 block, not finalized state through packages/verifier (P2-13 part 3); their clock is the fixture's L1 time; the summed shares, openings and destruction statements are made by the fixture through @abolishus/crypto with the nodes' per-election keys, summed-share messages passed in memory (P2-13 part 5); the poll of questions (definition version 5, which the node doesn't read yet) keeps the fixture's own ceremony and intake",
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

/** A definition the fixture writes: version 1 (one question) or version 5 (questions). */
export type FixtureDefinition =
  | { readonly version: 1; readonly value: ElectionDefinition }
  | { readonly version: 5; readonly value: ElectionDefinitionV5 };

/** The definition's encoding, as the registry and the bundle take it. */
export function definitionBytes(d: FixtureDefinition): Uint8Array {
  return d.version === 1 ? encodeElectionDefinition(d.value) : encodeElectionDefinitionV5(d.value);
}

/** The hash the election registry holds for the definition once registered. */
export function definitionHash(d: FixtureDefinition): Uint8Array {
  return d.version === 1 ? electionDefinitionHash(d.value) : electionDefinitionV5Hash(d.value);
}

/** The stub hash every seat's registration signs (docs/spec/election-definition.md, Stub hash and the ceremony). */
export function stubHash(d: FixtureDefinition): Uint8Array {
  return d.version === 1 ? electionStubHash(d.value) : electionStubV5Hash(d.value);
}

/**
 * A seat's per-election secrets from the ceremony, as its duties after it
 * read them: intake, its summed shares and its statements.
 */
export interface SeatKeys {
  readonly index: number;
  readonly kemSecret: KemSecretKey;
  readonly signingSecret: Uint8Array;
}

export interface Ceremony<D extends FixtureDefinition = FixtureDefinition> {
  readonly panel: Panel;
  readonly definition: D;
  readonly transcript: Uint8Array;
  /** The seats that took part. */
  readonly seats: readonly Trustee[];
  /**
   * Each seat's per-election secrets from the ceremony, in seat order: the
   * fixture holds every trustee node's keys, to take ballots' shares, tally
   * and state destruction as each node would (stages 4 and 6).
   */
  readonly secrets: readonly SeatKeys[];
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
 * ([[verifier]] 2.3) and the close statements, and contract-event version 8,
 * which archives every board event, the close rule's, the batches', the
 * obligation root's and the availability records', and the group registry's
 * Tier 1 and self-paid additions. The election registry
 * registers no other profile for a version-1 definition ([[contracts]],
 * Election registry, Registration, rule 9).
 */
const PINNED: ReadonlyMap<number, number> = new Map([
  [RECORD_TYPES.boardEntry, 5],
  [RECORD_TYPES.contractEvent, 8],
]);

/**
 * A version-5 definition's pins, as rule 9 serves them: ballot version 3 (one
 * range proof per question), the spoiled-ballot opening version 2 that opens
 * its cores, and display-text version 2, which carries the questions' text;
 * the board entry and contract event as version 1's (T-34, T-53).
 */
const PINNED_V5: ReadonlyMap<number, number> = new Map([
  [RECORD_TYPES.electionDefinition, 5],
  [RECORD_TYPES.ballot, 3],
  [RECORD_TYPES.spoiledBallotOpening, 2],
  [RECORD_TYPES.boardEntry, 5],
  [RECORD_TYPES.contractEvent, 8],
  [RECORD_TYPES.displayText, 2],
]);

/** The profile: every type from 0x0001 to 0x0009 pinned, at version 1 but those in `pinned`. */
function profile(pinned: ReadonlyMap<number, number>): ElectionDefinition["profile"] {
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: pinned.get(t) ?? 1 });
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

const selection = (option_count: number, min_selections: number, max_selections: number) => ({
  method: QUESTION_METHODS.selection,
  option_count,
  min_selections,
  max_selections,
});

/**
 * The multi-question poll's questions, one of each method a version-5
 * definition expresses as limits ([[0026-multi-question-ballots]]): pick one
 * `(0, 1)`, pick any `(0, m)` and pick exactly 2 `(2, 2)`, 11 options in all.
 */
export const QUESTIONS: readonly Question[] = Object.freeze([
  selection(3, 0, 1),
  selection(4, 0, 4),
  selection(4, 2, 2),
]);

/** The multi-question poll's display text: a title, then each question's text and options. */
export function questionsDisplayText(): DisplayTextV2 {
  const names = ["pick one", "pick any", "pick exactly two"];
  return {
    salt: newDisplayTextSalt(),
    translations: [
      {
        language: utf8("en"),
        title: utf8("Reference election: a poll of three questions"),
        description: utf8(
          "A fixture run by the reference election (P1-20, P2-14). It counts for nothing.",
        ),
        questions: QUESTIONS.map((q, i) => ({
          question: utf8(`Question ${i + 1}: ${names[i] ?? ""}`),
          description: utf8(""),
          options: Array.from({ length: q.option_count }, (_, j) => ({
            label: utf8(`Option ${String.fromCharCode(65 + j)}`),
            description: utf8(""),
          })),
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
  /** The Tier 0 group's root and size. */
  readonly electorate: { readonly root: bigint; readonly size: bigint };
}

/** The fields every definition version here shares, in the stub, before the ceremony. */
function stubFields(timing: Timing, l2: L2Deployment, panel: Panel, counter: bigint) {
  return {
    election_id: electionId(l2.l2ChainId, l2.electionRegistry, counter),
    l2_chain_id: l2.l2ChainId,
    l1_chain_id: timing.l1ChainId,
    election_registry: l2.electionRegistry,
    board: l2.board,
    trustee_registry: l2.trusteeRegistry,
    group_registry: l2.groupRegistry,
    l1_anchor: timing.l1Anchor,
    l1_relay: l2.l1Relay,
    tally_scheme: TALLY_SCHEMES.pedersenVss,
    // The pinned key, which verifier 1.3 requires and every ballot is proved under.
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
  } as const;
}

/**
 * The key ceremony over `stub`, whose stub hash is `hash`, with all but `absent` of
 * `trustees` taking part, through the four rounds of docs/spec/ceremony.md.
 */
function keyCeremony(
  stub: Pick<ElectionDefinition, "l2_chain_id" | "trustee_registry" | "election_id">,
  hash: Uint8Array,
  trustees: Trustees,
  absent: number,
): {
  readonly transcript: Uint8Array;
  readonly seats: readonly Trustee[];
  readonly secrets: readonly SeatKeys[];
} {
  const params = {
    l2ChainId: stub.l2_chain_id,
    trusteeRegistry: stub.trustee_registry,
    electionId: stub.election_id,
    stubHash: hash,
    panel: trustees.panel,
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
  return {
    transcript,
    seats: present,
    secrets: seats.map((s) => ({
      index: s.index,
      kemSecret: s.kem.secretKey,
      signingSecret: s.signingSecret,
    })),
  };
}

/** The stub of the election `l2` created as number `counter`: one question of three options. */
export function singleStub(
  timing: Timing,
  l2: L2Deployment,
  panel: Panel,
  text: DisplayText,
  { counter, electorate }: Omit<CeremonyOptions, "absent">,
): ElectionDefinition {
  return {
    profile: profile(PINNED),
    ...stubFields(timing, l2, panel, counter),
    election_type: 1,
    option_count: 3,
    min_selections: 0,
    max_selections: 1,
    electorate: [
      {
        tier: 0,
        group_id: 1n,
        root: electorate.root,
        root_l2_block: 1n,
        group_size: electorate.size,
      },
    ],
    display_text_commitment: displayTextCommitment(text),
  };
}

/** The definition that binds `transcript` to `stub`, once it passes the well-formedness rule. */
export function boundDefinition(
  stub: ElectionDefinition,
  transcript: Uint8Array,
): { readonly version: 1; readonly value: ElectionDefinition } {
  const definition = { ...stub, ceremony_transcript_hash: ceremonyTranscriptHash(transcript) };
  const rule = electionDefinitionRule(definition);
  if (rule !== undefined) throw new Error(`the fixture's definition breaks ${rule}`);
  return { version: 1, value: definition };
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
  { counter, absent, electorate }: CeremonyOptions,
): Ceremony<{ readonly version: 1; readonly value: ElectionDefinition }> {
  const { panel } = trustees;
  const stub = singleStub(timing, l2, panel, text, { counter, electorate });
  const { transcript, seats, secrets } = keyCeremony(
    stub,
    electionStubHash(stub),
    trustees,
    absent,
  );
  return { panel, definition: boundDefinition(stub, transcript), transcript, seats, secrets };
}

export interface QuestionCeremonyOptions {
  /** The election registry's counter of the election's creation. */
  readonly counter: bigint;
  /** The Tier 0 group's leaves, in tier-tree order. */
  readonly leaves: readonly bigint[];
  /** The receipt keys the anchor registered before the poll opens (verifier 2.9). */
  readonly receiptKeys: readonly Uint8Array[];
}

/**
 * `runCeremony` for the multi-question poll: a version-5 definition with
 * `QUESTIONS`, its one Tier 0 group in one region and so one cell, whose
 * count, members and root `deriveTierCells` gives from the group's leaves
 * as 2.4 and 2.8 are to recompute them (P1-19), and `receiptKeys` in the stub,
 * fixed before the ceremony (T-26). Every seat takes part.
 */
export function runQuestionCeremony(
  timing: Timing,
  l2: L2Deployment,
  trustees: Trustees,
  text: DisplayTextV2,
  { counter, leaves, receiptKeys }: QuestionCeremonyOptions,
): Ceremony<{ readonly version: 5; readonly value: ElectionDefinitionV5 }> {
  const { panel } = trustees;
  const groups = [{ group_id: 1n, region: 0 }];
  const derived = deriveTierCells({ groups, regions: [0n] }, new Map([[1n, leaves]]), new Map());
  const stub: ElectionDefinitionV5 = {
    profile: profile(PINNED_V5),
    ...stubFields(timing, l2, panel, counter),
    questions: [...QUESTIONS],
    electorate: [
      {
        tier: 0,
        root_l2_block: 1n,
        groups,
        regions: derived.regions,
        cells: derived.cells.map((c) => ({ root: c.root, members: c.members })),
      },
    ],
    display_text_commitment: displayTextV2Commitment(text),
    // In ascending order of their encodings (the rule `receipt-keys`).
    receipt_keys: [...receiptKeys].sort((a, b) => compare(a, b)),
  };
  const { transcript, seats, secrets } = keyCeremony(stub, electionStubV5Hash(stub), trustees, 0);
  const definition = { ...stub, ceremony_transcript_hash: ceremonyTranscriptHash(transcript) };
  const failure = electionDefinitionV5Rule(definition);
  if (failure !== undefined) throw new Error(`the fixture's definition breaks ${failure.rule}`);
  return { panel, definition: { version: 5, value: definition }, transcript, seats, secrets };
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/** The board-entry version the definition pins. */
export function boardEntryVersion(d: FixtureDefinition): BoardEntryVersion {
  const v = pinnedVersion(d.value, RECORD_TYPES.boardEntry);
  if (v === undefined || !(v in BOARD_ENTRY.versions))
    throw new Error("the definition pins no board-entry version");
  return v as BoardEntryVersion;
}

/** One board entry carrying `payload` at `index`, in `segment`. */
export function boardEntry(
  d: FixtureDefinition,
  index: bigint,
  segment: number,
  payload: Uint8Array,
): Uint8Array {
  return encodeBoardEntry(
    { election_id: d.value.election_id, index, segment, payload },
    boardEntryVersion(d),
  );
}
