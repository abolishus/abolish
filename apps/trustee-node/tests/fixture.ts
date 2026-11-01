// A version-1 stub, a version-5 one as the website creates it, a rolling
// version-7 one, a panel and a
// coordinator that relays every round between seats, dropping what a test
// tells it to.
import {
  type AnswersMessage,
  type ChallengesMessage,
  type ElectionDefinition,
  type ElectionDefinitionV5,
  type ElectionDefinitionV7,
  ELECTORATE_MODES,
  electionStubHash,
  electionStubV5Hash,
  electionStubV7Hash,
  encodeCeremonyTranscript,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  encodeElectionDefinitionV7,
  identityKey,
  type KeysMessage,
  type Panel,
  POLL_CLASSES,
  QUESTION_METHODS,
  RECORD_TYPES,
  RESULTS_MODES,
  type RevealsMessage,
} from "@abolishus/crypto";
import type { SummingRule } from "../src/summing.ts";
import { expect } from "vite-plus/test";
import { CeremonySeat, type SeatResult, type SeatStore } from "../src/index.ts";
import { localStub } from "../src/local.ts";
import { MemoryStore } from "../src/store.ts";

export const L2_CHAIN_ID = 31338n;
export const TRUSTEE_REGISTRY = new Uint8Array(20).fill(0xa3);
/** A summed-share rule that allows summing at once: the tally tests' counted sets are given, not read. */
export const AVAILABLE: SummingRule = { check: async () => ({ state: "available" }) };

export interface Panelists {
  readonly panel: Panel;
  readonly secrets: readonly Uint8Array[];
}

export function panelOf(n: number, k: number): Panelists {
  const secrets = Array.from({ length: n }, () => crypto.getRandomValues(new Uint8Array(32)));
  return { panel: { threshold: k, keys: secrets.map((s) => identityKey(s)) }, secrets };
}

export function stubFor(
  panel: Panel,
  change: Partial<ElectionDefinition> = {},
): ElectionDefinition {
  return localStub(panel, L2_CHAIN_ID, TRUSTEE_REGISTRY, change);
}

// The profile `packages/core`'s poll stubs pin: definition 5 with exactly
// the versions the election registry's rule 9 serves for it.
const V5_PINS: ReadonlyMap<number, number> = new Map([
  [RECORD_TYPES.electionDefinition, 5],
  [RECORD_TYPES.ballot, 3],
  [RECORD_TYPES.spoiledBallotOpening, 2],
  [RECORD_TYPES.boardEntry, 5],
  [RECORD_TYPES.contractEvent, 13],
  [RECORD_TYPES.displayText, 2],
]);

/**
 * A definition-version-5 stub over `stubFor`'s chain, contracts and times:
 * two questions (pick one of two, pick any of three), one Tier 0 cell of
 * three members in one region, and one receipt key.
 */
export function stubV5For(
  panel: Panel,
  change: Partial<ElectionDefinitionV5> = {},
): ElectionDefinitionV5 {
  const v1 = stubFor(panel);
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: V5_PINS.get(t) ?? 1 });
  return {
    profile: { protocol_major: 1, pins },
    election_id: v1.election_id,
    l2_chain_id: v1.l2_chain_id,
    l1_chain_id: v1.l1_chain_id,
    election_registry: v1.election_registry,
    board: v1.board,
    trustee_registry: v1.trustee_registry,
    group_registry: v1.group_registry,
    l1_anchor: v1.l1_anchor,
    l1_relay: v1.l1_relay,
    questions: [
      { method: QUESTION_METHODS.selection, option_count: 2, min_selections: 0, max_selections: 1 },
      { method: QUESTION_METHODS.selection, option_count: 3, min_selections: 0, max_selections: 3 },
    ],
    tally_scheme: v1.tally_scheme,
    electorate: [
      {
        tier: 0,
        root_l2_block: 1n,
        groups: [{ group_id: 1n, region: 0 }],
        regions: [3n],
        cells: [{ root: 1n << 200n, members: 3n }],
      },
    ],
    membership_vk_hash: v1.membership_vk_hash,
    panel_id: v1.panel_id,
    threshold: v1.threshold,
    panel_size: v1.panel_size,
    ceremony_transcript_hash: new Uint8Array(32),
    opens_at: v1.opens_at,
    closes_at: v1.closes_at,
    l1_inclusion_bound: v1.l1_inclusion_bound,
    sequencing_window: v1.sequencing_window,
    max_sequencer_drift: v1.max_sequencer_drift,
    display_text_commitment: v1.display_text_commitment,
    receipt_keys: [identityKey(crypto.getRandomValues(new Uint8Array(32)))],
    ...change,
  };
}

// A rolling poll's profile ([[0028-rolling-electorates]]): definition 7,
// ballot 5 and the spoiled-ballot opening that opens its cores.
const ROLLING_PINS: ReadonlyMap<number, number> = new Map([
  [RECORD_TYPES.electionDefinition, 7],
  [RECORD_TYPES.ballot, 5],
  [RECORD_TYPES.spoiledBallotOpening, 3],
  [RECORD_TYPES.boardEntry, 5],
  [RECORD_TYPES.contractEvent, 13],
  [RECORD_TYPES.displayText, 2],
]);

/** A sealed everyday rolling stub without an author panel: one Tier 0 tier over two groups. */
export function rollingStubFor(
  panel: Panel,
  change: Partial<ElectionDefinitionV7> = {},
): ElectionDefinitionV7 {
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: ROLLING_PINS.get(t) ?? 1 });
  return {
    ...stubV5For(panel),
    profile: { protocol_major: 1, pins },
    electorate: [],
    poll_class: POLL_CLASSES.everyday,
    results_mode: RESULTS_MODES.sealed,
    live_every: 0,
    live_batch: 0,
    author_threshold: 0,
    author_keys: [],
    author_transcript_hash: new Uint8Array(32),
    electorate_mode: ELECTORATE_MODES.rolling,
    rolling_electorate: [
      { tier: 0, root_l2_block: 7n, groups: [1n, 2n], root: 1n << 200n, group_size: 3n },
    ],
    ...change,
  };
}

/** What a ceremony between seats needs of an election, whatever its definition version. */
export interface CeremonyElection {
  readonly panelists: Panelists;
  readonly stubBytes: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly seats: readonly CeremonySeat[];
}

export interface Election extends CeremonyElection {
  readonly stub: ElectionDefinition;
}

export interface ElectionV5 extends CeremonyElection {
  readonly stub: ElectionDefinitionV5;
}

interface ElectionOptions {
  stores?: readonly SeatStore[];
  electorate?: () => Promise<boolean>;
}

function seatsFor(panelists: Panelists, options: ElectionOptions): CeremonySeat[] {
  return panelists.secrets.map(
    (identitySecret, i) =>
      new CeremonySeat({
        panel: panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        index: i + 1,
        identitySecret,
        electorate: options.electorate ?? (() => Promise.resolve(true)),
        store: options.stores?.[i] ?? new MemoryStore(),
      }),
  );
}

/** `election` over a version-5 stub (`stubV5For`). */
export function electionV5(
  n: number,
  k: number,
  options: ElectionOptions & { stub?: Partial<ElectionDefinitionV5> } = {},
): ElectionV5 {
  const panelists = panelOf(n, k);
  const stub = stubV5For(panelists.panel, options.stub);
  return {
    panelists,
    stub,
    stubBytes: encodeElectionDefinitionV5(stub),
    stubHash: electionStubV5Hash(stub),
    seats: seatsFor(panelists, options),
  };
}

export interface ElectionV7 extends CeremonyElection {
  readonly stub: ElectionDefinitionV7;
}

/** `election` over a rolling version-7 stub (`rollingStubFor`). */
export function rollingElection(
  n: number,
  k: number,
  options: ElectionOptions & { stub?: Partial<ElectionDefinitionV7> } = {},
): ElectionV7 {
  const panelists = panelOf(n, k);
  const stub = rollingStubFor(panelists.panel, options.stub);
  return {
    panelists,
    stub,
    stubBytes: encodeElectionDefinitionV7(stub),
    stubHash: electionStubV7Hash(stub),
    seats: seatsFor(panelists, options),
  };
}

export function election(
  n: number,
  k: number,
  options: ElectionOptions & { stub?: Partial<ElectionDefinition> } = {},
): Election {
  const panelists = panelOf(n, k);
  const stub = stubFor(panelists.panel, options.stub);
  return {
    panelists,
    stub,
    stubBytes: encodeElectionDefinition(stub),
    stubHash: electionStubHash(stub),
    seats: seatsFor(panelists, options),
  };
}

export function value<T>(result: SeatResult<T>): T {
  if (!result.ok) expect.fail(`refused: ${result.code}`);
  return result.value;
}

/** Which seats' messages the coordinator leaves out of each round (1 to 4). */
export type Drops = Readonly<Partial<Record<1 | 2 | 3 | 4, readonly number[]>>>;

export interface Run {
  readonly runId: Uint8Array;
  readonly keys: readonly KeysMessage[];
  readonly challenges: readonly ChallengesMessage[];
  readonly answers: readonly AnswersMessage[];
  readonly reveals: readonly RevealsMessage[];
  readonly transcript: Uint8Array;
}

/**
 * One run with every seat asked in every round, the coordinator dropping
 * `drops`; a seat whose message was dropped is still asked later (it is
 * refused or answers, as its node decides), and only seats that answer are
 * relayed.
 */
export async function runCeremony(e: CeremonyElection, drops: Drops = {}): Promise<Run> {
  const runId = crypto.getRandomValues(new Uint8Array(32));
  const kept = <M extends { index: number }>(round: 1 | 2 | 3 | 4, results: SeatResult<M>[]) =>
    results
      .flatMap((r) => (r.ok ? [r.value] : []))
      .filter((m) => !(drops[round] ?? []).includes(m.index));
  const keys = kept(1, await Promise.all(e.seats.map((s) => s.keys(e.stubBytes, runId))));
  const challenges = kept(
    2,
    await Promise.all(e.seats.map((s) => s.challenges(e.stubHash, runId, keys))),
  );
  const answers = kept(
    3,
    await Promise.all(e.seats.map((s) => s.answers(e.stubHash, runId, { keys, challenges }))),
  );
  const reveals = kept(
    4,
    await Promise.all(
      e.seats.map((s) => s.reveals(e.stubHash, runId, { keys, challenges, answers })),
    ),
  );
  const transcript = encodeCeremonyTranscript({
    run_id: runId,
    keys,
    challenges,
    answers,
    reveals,
  });
  return { runId, keys, challenges, answers, reveals, transcript };
}
