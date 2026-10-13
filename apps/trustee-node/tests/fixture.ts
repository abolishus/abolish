// A version-1 stub, a panel and a coordinator that relays every round
// between seats, dropping what a test tells it to. Built from
// `@abolishus/crypto` the way the sdk's simulation builds its stub.
import {
  type AnswersMessage,
  type ChallengesMessage,
  displayTextCommitment,
  ELECTION_TYPES,
  type ElectionDefinition,
  electionId,
  electionStubHash,
  encodeCeremonyTranscript,
  encodeElectionDefinition,
  identityKey,
  type KeysMessage,
  membershipVkHash,
  newDisplayTextSalt,
  type Panel,
  panelId,
  RECORD_TYPES,
  type RevealsMessage,
  TALLY_SCHEMES,
} from "@abolishus/crypto";
import { expect } from "vite-plus/test";
import { CeremonySeat, type SeatResult, type SeatStore } from "../src/index.ts";
import { MemoryStore } from "../src/store.ts";

export const L2_CHAIN_ID = 31338n;
export const TRUSTEE_REGISTRY = new Uint8Array(20).fill(0xa3);

export interface Panelists {
  readonly panel: Panel;
  readonly secrets: readonly Uint8Array[];
}

export function panelOf(n: number, k: number): Panelists {
  const secrets = Array.from({ length: n }, () => crypto.getRandomValues(new Uint8Array(32)));
  return { panel: { threshold: k, keys: secrets.map((s) => identityKey(s)) }, secrets };
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export function stubFor(
  panel: Panel,
  change: Partial<ElectionDefinition> = {},
): ElectionDefinition {
  const registry = new Uint8Array(20).fill(0xa1);
  const pins = [];
  for (let t: number = RECORD_TYPES.electionDefinition; t <= RECORD_TYPES.displayText; t++)
    pins.push({ record_type: t, version: t === RECORD_TYPES.boardEntry ? 4 : 1 });
  return {
    profile: { protocol_major: 1, pins },
    election_id: electionId(L2_CHAIN_ID, registry, 7n),
    l2_chain_id: L2_CHAIN_ID,
    l1_chain_id: 31337n,
    election_registry: registry,
    board: new Uint8Array(20).fill(0xa2),
    trustee_registry: TRUSTEE_REGISTRY,
    group_registry: new Uint8Array(20).fill(0xa4),
    l1_anchor: new Uint8Array(20).fill(0xb1),
    l1_relay: new Uint8Array(20).fill(0xb2),
    election_type: ELECTION_TYPES.plurality,
    tally_scheme: TALLY_SCHEMES.pedersenVss,
    option_count: 2,
    min_selections: 0,
    max_selections: 1,
    electorate: [{ tier: 0, group_id: 1n, root: 1n << 200n, root_l2_block: 1n, group_size: 3n }],
    membership_vk_hash: membershipVkHash(),
    panel_id: panelId(panel),
    threshold: panel.threshold,
    panel_size: panel.keys.length,
    ceremony_transcript_hash: new Uint8Array(32),
    opens_at: 1_000_000n,
    closes_at: 1_086_400n,
    l1_inclusion_bound: 3600,
    sequencing_window: 3600n,
    max_sequencer_drift: 1800n,
    display_text_commitment: displayTextCommitment({
      salt: newDisplayTextSalt(),
      translations: [
        {
          language: utf8("en"),
          question: utf8("A test poll."),
          description: utf8(""),
          options: [
            { label: utf8("Yes"), description: utf8("") },
            { label: utf8("No"), description: utf8("") },
          ],
        },
      ],
    }),
    ...change,
  };
}

export interface Election {
  readonly panelists: Panelists;
  readonly stub: ElectionDefinition;
  readonly stubBytes: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly seats: readonly CeremonySeat[];
}

export function election(
  n: number,
  k: number,
  options: { stores?: readonly SeatStore[]; electorate?: () => Promise<boolean> } = {},
): Election {
  const panelists = panelOf(n, k);
  const stub = stubFor(panelists.panel);
  const seats = panelists.secrets.map(
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
  return {
    panelists,
    stub,
    stubBytes: encodeElectionDefinition(stub),
    stubHash: electionStubHash(stub),
    seats,
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
export async function runCeremony(e: Election, drops: Drops = {}): Promise<Run> {
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
