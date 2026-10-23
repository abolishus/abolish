import {
  COMPLAINT_WINDOW,
  DELIVERY_WINDOW,
  encodeElectionDefinition,
  PARAMETERS,
} from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION, PINNED_MARGIN } from "@abolishus/verifier";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  POSTING_DEPOSIT_SPAN,
  POSTING_HEAD_AGE,
  POSTING_INDEX_LAG,
  postingCapacityIntervals,
  postingIndexLagFits,
  type PostingRegistration,
  PostgresPostingElections,
  recordRegistration,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// The registered elections the forced path weighs (docs/spec/posting-relay.md,
// Forced through L1; T-54): every registration in the route's index with its
// definition's times, none of them past its `c_K`; nothing at all while a
// registration's definition is missing or the index misses a registration
// the registry's events show older than POSTING_INDEX_LAG.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const CONSTANTS = { forcedInclusion: PINNED_FORCED_INCLUSION, margin: PINNED_MARGIN };
const NOW = 1_900_000_000;
const b32 = () => new Uint8Array(randomBytes(32));

const opened: TestDb[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((d) => d.close()));
});

/** A fresh index in a schema of its own: the registrations table is append-only. */
async function index(): Promise<Sql> {
  const db = await testDb();
  opened.push(db);
  return db.as("abolish_app");
}

let block = 1_000n;
/** Stores a definition closing at `closesAt` with bound `bound`, and records its registration. */
async function register(
  app: Sql,
  closesAt: bigint,
  bound = 600,
  options: { readonly stored?: boolean } = {},
): Promise<{ readonly definitionHash: Uint8Array; readonly l2Block: bigint }> {
  const l2Block = block++;
  if (options.stored === false) {
    const definitionHash = b32();
    await recordRegistration(app, { electionId: b32(), definitionHash, l2Block, logIndex: 0 });
    return { definitionHash, l2Block };
  }
  const definition = encodeElectionDefinition({
    ...typical,
    election_id: b32(),
    opens_at: closesAt - 86_400n,
    closes_at: closesAt,
    l1_inclusion_bound: bound,
  });
  const { electionId, definitionHash } = await storeDefinition(app, definition);
  await recordRegistration(app, { electionId, definitionHash, l2Block, logIndex: 0 });
  return { definitionHash, l2Block };
}

/** The registry's events as a node shows them at a finalized head of time `finalizedTime`, and the `from` each ask gave. */
function registry(events: PostingRegistration[] = [], finalizedTime = BigInt(NOW) - 60n) {
  const asked: bigint[] = [];
  return {
    events,
    asked,
    log: {
      registered: async (from: bigint) => {
        asked.push(from);
        return { finalizedTime, events: events.filter((e) => e.l2Block >= from) };
      },
    },
  };
}

function elections(app: Sql, log: ReturnType<typeof registry>["log"], now = NOW) {
  return new PostgresPostingElections({ sql: app, registry: log, now: () => now });
}

describe("the lag", () => {
  test("POSTING_INDEX_LAG fits the pinned windows with a landing span and the sequencer's drift", () => {
    expect(postingIndexLagFits(POSTING_INDEX_LAG, CONSTANTS)).toBe(true);
    // The bound is exact: one second more than the windows leave doesn't fit.
    const room =
      DELIVERY_WINDOW -
      CONSTANTS.forcedInclusion -
      CONSTANTS.margin -
      POSTING_DEPOSIT_SPAN -
      BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT);
    expect(postingIndexLagFits(room, CONSTANTS)).toBe(true);
    expect(postingIndexLagFits(room + 1n, CONSTANTS)).toBe(false);
  });

  test("no election registered after a lagging index's last one has an interval a span signed now meets", () => {
    // By property: a definition registered at `t` opens after `t` (the
    // registry's AlreadyOpen), so its first interval starts past any span
    // signed by `t + POSTING_INDEX_LAG` on an L1 head up to the drift behind.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_700_000_000n, max: 2_000_000_000n }),
        fc.bigInt({ min: 1n, max: 10n ** 7n }),
        fc.bigInt({ min: 1n, max: 10n ** 7n }),
        fc.integer({ min: 0, max: PARAMETERS.MAX_INCLUSION_BOUND }),
        fc.bigInt({ min: 0n, max: POSTING_INDEX_LAG }),
        (registeredAt, untilOpen, open, bound, waited) => {
          const closesAt = registeredAt + untilOpen + open;
          const [receipt, complaint] = postingCapacityIntervals(
            { closesAt, l1InclusionBound: BigInt(bound) },
            CONSTANTS,
          );
          const T = registeredAt - BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT) + waited;
          const end = T + POSTING_DEPOSIT_SPAN;
          return end <= receipt.from && end <= complaint.from;
        },
      ),
      { numRuns },
    );
  });

  test("refuses F and R the lag, or a finalized head as old as F, doesn't fit", () => {
    const r = registry();
    expect(
      () =>
        new PostgresPostingElections({
          sql: {} as Sql,
          registry: r.log,
          now: () => NOW,
          forcedInclusion: DELIVERY_WINDOW - POSTING_INDEX_LAG,
          margin: 0n,
        }),
    ).toThrow(RangeError); // An F the index's lag fits but a finalized head as old as F doesn't.
    const F = 84_000n;
    expect(
      postingIndexLagFits(POSTING_INDEX_LAG, { forcedInclusion: F, margin: PINNED_MARGIN }),
    ).toBe(true);
    expect(
      () =>
        new PostgresPostingElections({
          sql: {} as Sql,
          registry: r.log,
          now: () => NOW,
          forcedInclusion: F,
          margin: PINNED_MARGIN,
        }),
    ).toThrow(RangeError);
  });
});

describe("the elections' times", () => {
  test("gives every registered election's times, read from its definition", async () => {
    const app = await index();
    await register(app, 1_900_100_000n, 600);
    await register(app, 1_900_200_000n, 3_600);
    const times = await elections(app, registry().log).times();
    expect(times).toEqual(
      expect.arrayContaining([
        { closesAt: 1_900_100_000n, l1InclusionBound: 600n },
        { closesAt: 1_900_200_000n, l1InclusionBound: 3_600n },
      ]),
    );
    expect(times).toHaveLength(2);
  });

  test("leaves out an election past its c_K by the clock less POSTING_HEAD_AGE, and keeps one at it", async () => {
    const app = await index();
    const bound = 600n;
    // c_K as Capacity takes it: the complaint interval's end.
    const cK = (closesAt: bigint) =>
      postingCapacityIntervals({ closesAt, l1InclusionBound: bound }, CONSTANTS)[1].to;
    const floor = BigInt(NOW) - BigInt(POSTING_HEAD_AGE);
    // closes_at such that c_K is exactly the floor, then a second before it.
    const at = floor - cK(0n);
    expect(cK(at)).toBe(floor);
    await register(app, at, Number(bound));
    await register(app, at - 1n, Number(bound));
    expect(await elections(app, registry().log).times()).toEqual([
      { closesAt: at, l1InclusionBound: bound },
    ]);
  });

  test("leaves out an election closed long ago, by its schedule, without reading its definition", async () => {
    const app = await index();
    const long = BigInt(NOW) - COMPLAINT_WINDOW - 10n ** 6n;
    await register(app, long);
    expect(await elections(app, registry().log).times()).toEqual([]);
  });

  test("judges nothing while a registration's definition isn't stored, whenever it closes", async () => {
    const app = await index();
    await register(app, 1_900_100_000n);
    await register(app, 0n, 600, { stored: false });
    expect(await elections(app, registry().log).times()).toBeUndefined();
  });
});

describe("the index's progress", () => {
  test("asks the registry's events from the latest recorded registration's block", async () => {
    const app = await index();
    const r = registry();
    await elections(app, r.log).times();
    await register(app, 1_900_100_000n);
    const { l2Block } = await register(app, 1_900_100_000n);
    await elections(app, r.log).times();
    expect(r.asked).toEqual([0n, l2Block]);
  });

  test("judges on while the index holds every registration the events show", async () => {
    const app = await index();
    const a = await register(app, 1_900_100_000n);
    const r = registry([{ ...a, timestamp: BigInt(NOW) - POSTING_INDEX_LAG * 10n }]);
    expect(await elections(app, r.log).times()).toHaveLength(1);
  });

  test("judges on while a registration the index misses is younger than POSTING_INDEX_LAG", async () => {
    const app = await index();
    const a = await register(app, 1_900_100_000n);
    const r = registry([
      {
        definitionHash: b32(),
        l2Block: a.l2Block + 1n,
        timestamp: BigInt(NOW) - POSTING_INDEX_LAG + 1n,
      },
    ]);
    expect(await elections(app, r.log).times()).toHaveLength(1);
  });

  test("judges nothing once a registration the index misses is POSTING_INDEX_LAG old", async () => {
    const app = await index();
    const a = await register(app, 1_900_100_000n);
    const r = registry([
      {
        definitionHash: b32(),
        l2Block: a.l2Block + 1n,
        timestamp: BigInt(NOW) - POSTING_INDEX_LAG,
      },
    ]);
    expect(await elections(app, r.log).times()).toBeUndefined();
    // So does an empty index whose registry has one.
    const empty = await index();
    expect(await elections(empty, r.log).times()).toBeUndefined();
  });

  test("judges nothing on a finalized head more than F behind the clock, or ahead of it", async () => {
    const app = await index();
    await register(app, 1_900_100_000n);
    const F = PINNED_FORCED_INCLUSION;
    expect(await elections(app, registry([], BigInt(NOW) - F).log).times()).toHaveLength(1);
    expect(await elections(app, registry([], BigInt(NOW) - F - 1n).log).times()).toBeUndefined();
    expect(await elections(app, registry([], BigInt(NOW)).log).times()).toHaveLength(1);
    expect(await elections(app, registry([], BigInt(NOW) + 1n).log).times()).toBeUndefined();
  });

  test("a registration above a finalized head within F can't hide an interval a span signed now meets", () => {
    // The head's age bound fits the windows as the index's lag does.
    expect(postingIndexLagFits(PINNED_FORCED_INCLUSION, CONSTANTS)).toBe(true);
  });

  test("rejects when the node does, and refuses events out of form", async () => {
    const app = await index();
    const failing = {
      registered: async () => {
        throw new Error("unreachable");
      },
    };
    await expect(elections(app, failing).times()).rejects.toThrow("unreachable");
    const head = BigInt(NOW) - 60n;
    for (const bad of [
      { definitionHash: new Uint8Array(31), l2Block: 1n, timestamp: 1n },
      { definitionHash: b32(), l2Block: 1n, timestamp: -1n },
      { definitionHash: b32(), l2Block: 1n, timestamp: 1 },
      // Dated past the head it was read at.
      { definitionHash: b32(), l2Block: 1n, timestamp: head + 1n },
    ])
      await expect(
        elections(app, registry([bad as PostingRegistration], head).log).times(),
      ).rejects.toThrow(TypeError);
    for (const finalizedTime of [-1n, 1, undefined])
      await expect(
        elections(app, {
          registered: async () => ({ finalizedTime, events: [] }) as never,
        }).times(),
      ).rejects.toThrow(TypeError);
  });
});
