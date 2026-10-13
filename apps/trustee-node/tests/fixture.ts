// A version-1 stub, a panel and a coordinator that relays every round
// between seats, dropping what a test tells it to.
import {
  type AnswersMessage,
  type ChallengesMessage,
  type ElectionDefinition,
  electionStubHash,
  encodeCeremonyTranscript,
  encodeElectionDefinition,
  identityKey,
  type KeysMessage,
  type Panel,
  type RevealsMessage,
} from "@abolishus/crypto";
import { expect } from "vite-plus/test";
import { CeremonySeat, type SeatResult, type SeatStore } from "../src/index.ts";
import { localStub } from "../src/local.ts";
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

export function stubFor(
  panel: Panel,
  change: Partial<ElectionDefinition> = {},
): ElectionDefinition {
  return localStub(panel, L2_CHAIN_ID, TRUSTEE_REGISTRY, change);
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
