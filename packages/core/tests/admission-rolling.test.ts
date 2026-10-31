import {
  type BoardEntryVersion,
  checkBoard,
  decodeBallot,
  decodeBoardEntry,
  decodeElectionDefinitionV7,
  type ElectionDefinitionV7Record,
  type Panel,
  pinnedVersion,
  RECORD_TYPES,
  type RollingBallotChain,
  type RollingTierEvent,
  rootClockBoundary,
} from "@abolishus/crypto";
import { rollingChain, type RollingChainRelease, splitEntries } from "@abolishus/verifier";
import { drizzle } from "drizzle-orm/postgres-js";
import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { definitionRegistered } from "../../verifier/tests/registration-logs.ts";
import { release, rolling, rollingTree } from "../../verifier/tests/registry-logs.ts";
import { electionDefinitions } from "../src/db/schema/index.ts";
import {
  appendEntry,
  BallotAdmissions,
  readBoard,
  type RollingChainRead,
  type RollingChains,
  rollingChains,
  SubmitError,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// BallotAdmissions (src/admission.ts) for a rolling poll: definition version
// 7 under `electorate_mode` 2 and ballot version 5, each ballot judged by
// @abolishus/verifier's admission against the root of the step it names,
// from the chain the caller's proven records give (`rollingChains`), never
// a root the ballot or the submitter gives; and a ballot whose step the
// records haven't settled yet judged not at all (P2-17 part 7a; T-08, T-17,
// T-25, T-52). The fixtures are docs/spec/vectors/verifier-ballots-v5.json,
// whose verdicts and step roots come from an independent implementation.
// storeDefinition doesn't take version 7 yet (no client shows one), so the
// definition row is written directly, as the registry sync will once it does.

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly ballots: {
    readonly admitted: number;
    readonly rejected: readonly { readonly entry: number; readonly code: string }[];
  };
}

const file = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/verifier-ballots-v5.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly clock: { readonly epoch: string; readonly period: string };
  readonly panels: Readonly<Record<string, { threshold: string; keys: string[] }>>;
  readonly events: readonly {
    readonly block: string;
    readonly timestamp: string;
    readonly group: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  }[];
  readonly registeredAt: string;
  readonly cases: readonly Case[];
};
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const c = file.cases.find((x) => x.id === "board") as Case;
const p = file.panels[c.panel] as { threshold: string; keys: string[] };
const panel: Panel = { threshold: Number(p.threshold), keys: p.keys.map(hex) };
const clock = { epoch: BigInt(file.clock.epoch), period: BigInt(file.clock.period) };
const events: RollingTierEvent[] = file.events.map((e) => {
  const at = {
    blockNumber: BigInt(e.block),
    timestamp: BigInt(e.timestamp),
    groupId: BigInt(e.group),
  };
  return e.remove === undefined
    ? { ...at, kind: "add", commitments: (e.add ?? []).map(BigInt) }
    : { ...at, kind: "remove", indices: e.remove.map(BigInt) };
});
const chain: RollingBallotChain = { events, registeredAt: BigInt(file.registeredAt) };

const definitionBytes = hex(c.definition);
const definition = decodeElectionDefinitionV7(definitionBytes);
const electionId = definition.election_id;
const during = definition.opens_at + 60n;
const VERSION = pinnedVersion(definition, RECORD_TYPES.boardEntry) as BoardEntryVersion;
const entries = splitEntries(hex(c.board)).entries.map((e) => decodeBoardEntry(e, VERSION));
const ballots = entries.slice(1).map((e) => e.payload);
const rejected = new Map(c.ballots.rejected.map((r) => [r.entry, r.code] as const));
// The step a ballot names, where it decodes as version 5.
const stepOf = (b: Uint8Array) => {
  try {
    return decodeBallot(b, 5).step;
  } catch {
    return undefined;
  }
};
const lastEvent = events.reduce((m, e) => (e.timestamp > m ? e.timestamp : m), 0n);
// Past every event and every step the poll accepts: everything is settled.
const allSettled =
  definition.closes_at + 1n > lastEvent ? definition.closes_at + 1n : lastEvent + 1n;

/** A `RollingChains` giving the vectors' chain, settled at `settledAt()`, and counting its reads. */
function chains(
  settledAt: () => bigint,
  outcome: RollingChainRead["outcome"] = { status: "pass", chain },
) {
  const asked: ElectionDefinitionV7Record[] = [];
  const source: RollingChains = {
    read: async (d) => {
      asked.push(d);
      return { settledAt: settledAt(), outcome };
    },
  };
  return { source, asked };
}

let dbs: TestDb[] = [];
afterEach(async () => {
  await Promise.all(dbs.map((d) => d.close()));
  dbs = [];
});

async function election(): Promise<Sql> {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  await drizzle({ client: app })
    .insert(electionDefinitions)
    .values({ electionId, definition: definitionBytes });
  const transcript = entries[0]!;
  await appendEntry(app, electionId, transcript.segment, transcript.payload);
  return app;
}

async function verdict(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof SubmitError)
      return e.admission === undefined ? e.code : `${e.code}:${e.admission}`;
    throw e;
  }
  return "boarded";
}

describe("a rolling poll", { timeout: 120_000 }, () => {
  test("the fixtures are a rolling version-7 definition and version-5 ballots naming several steps", () => {
    expect(definition.electorate_mode).toBe(2);
    expect(pinnedVersion(definition, RECORD_TYPES.ballot)).toBe(5);
    const steps = new Set(ballots.map(stepOf).filter((s) => s !== undefined));
    expect(steps.size).toBeGreaterThan(1);
  });

  test("without a chain source no ballot is judged", async () => {
    const app = await election();
    const a = new BallotAdmissions({ panels: [panel], clock });
    for (const b of ballots.slice(0, 3))
      expect(await verdict(a.submit(app, electionId, b, during))).toBe("not-open");
    expect(await readBoard(app, electionId)).toHaveLength(1);
  });

  test("with every step settled, each ballot is boarded or refused with the verifier's code", async () => {
    const app = await election();
    const { source } = chains(() => allSettled);
    const a = new BallotAdmissions({ panels: [panel], clock, rolling: source });
    let size = 1;
    for (const [i, b] of ballots.entries()) {
      const code = rejected.get(i + 1);
      const got = await verdict(a.submit(app, electionId, b, during));
      if (code === undefined) {
        expect(got, String(i + 1)).toBe("boarded");
        size++;
      } else if (code === "repeat")
        // 5.7: boarded once, whether the repeat is byte-identical or not.
        expect(["boarded", "rejected:repeat"], String(i + 1)).toContain(got);
      else expect(got, String(i + 1)).toBe(`rejected:${code}`);
      expect(await readBoard(app, electionId)).toHaveLength(size);
    }
    expect(size - 1).toBe(c.ballots.admitted);
    const board = await readBoard(app, electionId);
    expect(() => checkBoard(electionId, board, VERSION)).not.toThrow();
  });

  test("a ballot naming a step not settled yet is judged not at all, and the same bytes pass once it is", async () => {
    const app = await election();
    // Settled just up to the newest admitted ballot's step: that step's
    // boundary is not before `settledAt`, so it isn't settled.
    const admitted = ballots.filter((_, i) => !rejected.has(i + 1));
    const newest = Math.max(...admitted.map((b) => stepOf(b) ?? 0));
    let settledAt = rootClockBoundary(BigInt(newest));
    const { source } = chains(() => settledAt);
    const a = new BallotAdmissions({ panels: [panel], clock, rolling: source });
    const waiting = admitted.filter((b) => stepOf(b) === newest);
    const older = admitted.filter((b) => (stepOf(b) ?? 0) < newest);
    expect(waiting.length).toBeGreaterThan(0);
    expect(older.length).toBeGreaterThan(0);
    for (const b of waiting)
      expect(await verdict(a.submit(app, electionId, b, during))).toBe("not-open:step-unsettled");
    expect(await readBoard(app, electionId)).toHaveLength(1);
    for (const b of older)
      expect(await verdict(a.submit(app, electionId, b, during))).toBe("boarded");
    settledAt += 1n;
    for (const b of waiting)
      expect(await verdict(a.submit(app, electionId, b, during))).toBe("boarded");
    expect(await readBoard(app, electionId)).toHaveLength(1 + admitted.length);
  });

  test("a step past the close is rejected whatever has settled, never left unsettled", async () => {
    const app = await election();
    const past = ballots.filter(
      (b, i) =>
        rejected.get(i + 1) === "root-step-range" &&
        rootClockBoundary(BigInt(stepOf(b) ?? 0)) > definition.closes_at,
    );
    expect(past.length).toBeGreaterThan(0);
    const { source } = chains(() => chain.registeredAt + 1n);
    const a = new BallotAdmissions({ panels: [panel], clock, rolling: source });
    for (const b of past)
      expect(await verdict(a.submit(app, electionId, b, during))).toBe("rejected:root-step-range");
  });

  test("a chain the verifier's checks stop judges no ballot", async () => {
    const app = await election();
    const { source } = chains(() => allSettled, {
      check: "2.4",
      outcome: { status: "fail", code: "electorate", at: { tier: 0 } },
    });
    const a = new BallotAdmissions({ panels: [panel], clock, rolling: source });
    for (const b of ballots.slice(0, 3))
      expect(await verdict(a.submit(app, electionId, b, during))).toBe("not-open");
    expect(await readBoard(app, electionId)).toHaveLength(1);
  });

  test("a chain whose opening state isn't the definition's judges no ballot", async () => {
    const app = await election();
    const { source } = chains(() => allSettled, {
      status: "pass",
      chain: { ...chain, events: events.slice(1) },
    });
    const a = new BallotAdmissions({ panels: [panel], clock, rolling: source });
    expect(await verdict(a.submit(app, electionId, ballots[0]!, during))).toBe("not-open");
    expect(await readBoard(app, electionId)).toHaveLength(1);
  });

  test("submitAll gives each ballot submit's verdict, unsettled ones in their places", async () => {
    const batched = await election();
    const alone = await election();
    const admitted = ballots.filter((_, i) => !rejected.has(i + 1));
    const newest = Math.max(...admitted.map((b) => stepOf(b) ?? 0));
    const { source } = chains(() => rootClockBoundary(BigInt(newest)));
    const outcomes = await new BallotAdmissions({
      panels: [panel],
      clock,
      rolling: source,
    }).submitAll(batched, electionId, ballots, during);
    const a = new BallotAdmissions({ panels: [panel], clock, rolling: source });
    const expected: string[] = [];
    for (const b of ballots) expected.push(await verdict(a.submit(alone, electionId, b, during)));
    const got = outcomes.map((o) =>
      o.ok
        ? "boarded"
        : o.error.admission === undefined
          ? o.error.code
          : `${o.error.code}:${o.error.admission}`,
    );
    expect(got).toEqual(expected);
    expect(got).toContain("not-open:step-unsettled");
    expect(await readBoard(batched, electionId)).toEqual(await readBoard(alone, electionId));
  });

  test("the chain is read again for each submission, once per batch", async () => {
    const app = await election();
    const { source, asked } = chains(() => allSettled);
    const a = new BallotAdmissions({ panels: [panel], clock, rolling: source });
    await a.submitAll(app, electionId, ballots.slice(0, 2), during);
    await a.submit(app, electionId, ballots[2]!, during);
    expect(asked).toHaveLength(2);
    expect(asked[0]?.value.election_id).toEqual(electionId);
  });
});

// rollingChains over the registries' records as they log them: each poll's
// chain is the verifier's `rollingChain` over the read, computed again only
// once the read's block moves (T-08, T-71). The records are the verifier's
// test logs of rolling-tier-tree.json's trees, from an independent generator.
describe("rollingChains", () => {
  const t = rollingTree("chain-order");
  const d = rolling([t.tier], t.closesAt);
  const pinned: RollingChainRelease = { ...release, electionRegistry: d.value.election_registry };
  const records = [
    ...t.records,
    definitionRegistered(d, undefined, undefined, 99n, t.registeredAt),
  ];

  test("gives the verifier's chain over the records, settled at their block's timestamp", async () => {
    const at = t.closesAt + 1n;
    const read = await rollingChains({ read: async () => ({ at, records }) }, pinned).read(d);
    expect(read).toEqual({ settledAt: at, outcome: rollingChain(d, records, pinned) });
    expect("status" in read.outcome && read.outcome.status).toBe("pass");
  });

  test("keeps a poll's chain while the block stays, and computes it again when it moves", async () => {
    let at = t.closesAt + 1n;
    const chains = rollingChains({ read: async () => ({ at, records }) }, pinned);
    const first = await chains.read(d);
    expect(await chains.read(d)).toBe(first);
    at += 1n;
    const moved = await chains.read(d);
    expect(moved).not.toBe(first);
    expect(moved.settledAt).toBe(at);
  });

  test("records the recount doesn't pass give no chain", async () => {
    const read = await rollingChains(
      { read: async () => ({ at: t.closesAt + 1n, records: records.slice(1) }) },
      pinned,
    ).read(d);
    expect("status" in read.outcome).toBe(false);
  });
});
