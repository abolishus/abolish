import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  ANSWERED_WINDOW_SECONDS,
  answeredByTier,
  answeredByTiers,
  answeredWindow,
  appendEntry,
  countListedPolls,
  insertPollTags,
  listedPlaces,
  ListingError,
  type ListingOrder,
  listPolls,
  listPollsBefore,
  MAX_ANSWERED_ELECTIONS,
  MAX_LISTED_PLACES,
  MAX_LISTING_PAGE,
  moderate,
  moderationStatus,
  placeKey,
  REMOVAL_REASONS,
  recordRegistration,
  refilePoll,
  RESTORE_REASONS,
  storeDefinition,
} from "../src/index.ts";
import { addModerators, type TestDb, testDb, typical } from "./db.ts";

// Discovery (src/listing.ts; docs/moderation-policy.md, Actions; T-68): the
// listing holds every stored poll whose moderation state is `visible`, in
// order of election ID, and a cursor visits each once.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  await addModerators(app, "mod-1", "mod-2");
});
afterAll(() => db?.close());

/** A stored poll under `id` (a fresh one by default). The typical vector's poll has closed. */
async function election(id = new Uint8Array(randomBytes(32))): Promise<Uint8Array> {
  await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: id }));
  return id;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Every listed poll in `order`, a page of `limit` at a time, as hex. */
async function listAll(
  limit = MAX_LISTING_PAGE,
  order: ListingOrder = { sort: "id" },
): Promise<string[]> {
  const all: string[] = [];
  let after: Uint8Array | undefined;
  for (;;) {
    const page = await listPolls(app, after, limit, order);
    expect(page.length).toBeLessThanOrEqual(limit);
    all.push(...page.map(hex));
    if (page.length < limit) return all;
    after = page.at(-1);
  }
}

describe("listPolls", () => {
  test("pages through every stored poll once, in order of election ID", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(hex(await election()));
    const listed = (await listAll()).filter((id) => ids.includes(id));
    expect(listed).toEqual([...ids].sort());
    for (const limit of [1, 2, 3, 7]) {
      expect((await listAll(limit)).filter((id) => ids.includes(id))).toEqual(listed);
    }
  });

  test("starts after the cursor, which need not be a stored poll", async () => {
    const low = await election(new Uint8Array(32).fill(0x10));
    const high = await election(new Uint8Array(32).fill(0xf0));
    const between = new Uint8Array(32).fill(0x80);
    const page = (await listPolls(app, between, MAX_LISTING_PAGE)).map(hex);
    expect(page).toContain(hex(high));
    expect(page).not.toContain(hex(low));
    expect(page.every((id) => id > hex(between))).toBe(true);
    // Strictly after: the cursor's own poll is never repeated.
    expect((await listPolls(app, high, MAX_LISTING_PAGE)).map(hex)).not.toContain(hex(high));
    expect(await listPolls(app, new Uint8Array(32).fill(0xff), 1)).toEqual([]);
  });

  test("leaves out delisted and hidden polls, and lists them again once restored", async () => {
    const delisted = await election();
    const hidden = await election();
    const visible = await election();
    await moderate(app, delisted, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, hidden, { action: "hide", reason: "threat", moderator: "mod-1" });
    let listed = await listAll();
    expect(listed).toContain(hex(visible));
    expect(listed).not.toContain(hex(delisted));
    expect(listed).not.toContain(hex(hidden));
    await moderate(app, hidden, { action: "restore", reason: "error", moderator: "mod-2" });
    listed = await listAll();
    expect(listed).toContain(hex(hidden));
    expect(listed).not.toContain(hex(delisted));
    // Still served by ID: delisting only takes a poll out of discovery.
    expect((await moderationStatus(app, delisted)).state).toBe("delisted");
  });

  test("lists exactly the polls whose newest decision restores them, whatever the log holds", async () => {
    // A model over arbitrary logs, written directly as the app role can
    // (bypassing `moderate`'s rules, as an insider could; T-68): repeated
    // decisions, removals under any ground, restores of a visible poll. The
    // newest decision alone decides.
    const decision = fc.oneof(
      fc.record({
        action: fc.constantFrom("delist", "hide"),
        reason: fc.constantFrom(...REMOVAL_REASONS),
      }),
      fc.record({ action: fc.constant("restore"), reason: fc.constantFrom(...RESTORE_REASONS) }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(decision, { maxLength: 4 }), { minLength: 1, maxLength: 5 }),
        async (logs) => {
          const expected: string[] = [];
          const mine = new Set<string>();
          for (const log of logs) {
            const id = await election();
            mine.add(hex(id));
            for (const { action, reason } of log)
              await app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
                VALUES (${id}, ${action}, ${reason}, 'mod-1', now())`;
            if (log.length === 0 || log.at(-1)!.action === "restore") expected.push(hex(id));
          }
          const listed = (await listAll(3)).filter((id) => mine.has(id));
          expect(listed).toEqual(expected.sort());
        },
      ),
      // Each run stores definitions, so the run count is capped like the
      // other database-backed properties.
      { numRuns: Math.min(numRuns, 50) },
    );
    // Fifty runs of database writes can outlast the default timeout on a CI
    // runner shared with the other test files.
  }, 60_000);

  test("never lists an election with no stored definition", async () => {
    const orphan = new Uint8Array(randomBytes(32));
    await app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
      VALUES (${orphan}, 'restore', 'error', 'mod-1', now())`;
    expect(await listAll()).not.toContain(hex(orphan));
  });

  test("refuses a cursor that isn't 32 bytes and a page size outside its bounds", async () => {
    for (const after of [new Uint8Array(31), new Uint8Array(33), "00".repeat(32), [0]])
      await expect(listPolls(app, after as Uint8Array, 1)).rejects.toThrow(TypeError);
    for (const limit of [0, -1, 1.5, MAX_LISTING_PAGE + 1, Number.NaN])
      await expect(listPolls(app, undefined, limit)).rejects.toThrow(TypeError);
  });

  test("reads only public data and the moderation log, and writes nothing", async () => {
    // T-68: listing is a view for our front ends; it never reaches a result,
    // and never changes what it reads. It reads the board only to count
    // `answered`'s voters. A read-only session refuses any write, however it
    // is spelt.
    const src = readFileSync(new URL("../src/listing.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(
      /appendEntry|storeDefinition|\baccount[A-Z_]|\.insert\(|\.update\(|\.delete\(/,
    );
    const readOnly = await db.as("abolish_app");
    await readOnly`SET default_transaction_read_only = on`;
    const id = await election();
    expect((await listPolls(readOnly, undefined, MAX_LISTING_PAGE)).map(hex)).toContain(hex(id));
    const open = await timed(100n, 200n, true);
    for (const sort of ["new", "closing"] as const)
      expect(
        (await listPolls(readOnly, undefined, MAX_LISTING_PAGE, { sort, now: 150n })).map(hex),
      ).toContain(hex(open));
    expect(
      (
        await listPolls(readOnly, undefined, MAX_LISTING_PAGE, {
          sort: "answered",
          now: 150n,
          clock: { epoch: 0n, period: 10n },
        })
      ).map(hex),
    ).toContain(hex(open));
  });
});

// The register's previous page (P2-19 part 49): the `id` order read
// backward from a cursor gives the page before it, in the same order, so a
// reader can turn back as well as on (T-68).

/** Above every election ID: a backward read from here starts at the last poll. */
const PAST_END = new Uint8Array(32).fill(0xff);

/** Every listed poll, a page of `limit` at a time read backward from the end, as hex. */
async function listAllBackward(limit: number): Promise<string[]> {
  const pages: string[][] = [];
  let before: Uint8Array = PAST_END;
  for (;;) {
    const page = await listPollsBefore(app, before, limit);
    expect(page.length).toBeLessThanOrEqual(limit);
    pages.unshift(page.map(hex));
    if (page.length < limit) return pages.flat();
    before = page[0]!; // a full page holds at least one poll
  }
}

describe("listPollsBefore", () => {
  test("pages back through every listed poll once, in the order listPolls pages forward", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(hex(await election()));
    const forward = (await listAll()).filter((id) => ids.includes(id));
    expect(forward).toEqual([...ids].sort());
    for (const limit of [1, 2, 3, 7, MAX_LISTING_PAGE])
      expect((await listAllBackward(limit)).filter((id) => ids.includes(id))).toEqual(forward);
  });

  test("is the page listPolls reads forward to the cursor, for any cursor and page size", async () => {
    for (let i = 0; i < 5; i++) await election();
    const all = await listAll();
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.integer({ min: 1, max: 12 }),
        async (cursor, limit) => {
          const below = all.filter((id) => id < hex(cursor));
          expect((await listPollsBefore(app, cursor, limit)).map(hex)).toEqual(
            below.slice(Math.max(0, below.length - limit)),
          );
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("ends strictly before the cursor, which need not be a stored poll", async () => {
    const low = await election(new Uint8Array(32).fill(0x11));
    const high = await election(new Uint8Array(32).fill(0xef));
    const between = new Uint8Array(32).fill(0x80);
    const page = (await listPollsBefore(app, between, MAX_LISTING_PAGE)).map(hex);
    expect(page).toContain(hex(low));
    expect(page).not.toContain(hex(high));
    expect(page.every((id) => id < hex(between))).toBe(true);
    expect((await listPollsBefore(app, low, MAX_LISTING_PAGE)).map(hex)).not.toContain(hex(low));
    expect(await listPollsBefore(app, new Uint8Array(32), 1)).toEqual([]);
  });

  test("leaves out delisted and hidden polls, and lists them again once restored", async () => {
    const delisted = await election();
    const hidden = await election();
    const visible = await election();
    await moderate(app, delisted, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, hidden, { action: "hide", reason: "threat", moderator: "mod-1" });
    let listed = await listPollsBefore(app, PAST_END, MAX_LISTING_PAGE).then((p) => p.map(hex));
    expect(listed).toContain(hex(visible));
    expect(listed).not.toContain(hex(delisted));
    expect(listed).not.toContain(hex(hidden));
    await moderate(app, hidden, { action: "restore", reason: "error", moderator: "mod-2" });
    listed = await listPollsBefore(app, PAST_END, MAX_LISTING_PAGE).then((p) => p.map(hex));
    expect(listed).toContain(hex(hidden));
    expect(listed).not.toContain(hex(delisted));
  });

  test("refuses a cursor that isn't 32 bytes, a page size outside its bounds and bad filters", async () => {
    for (const before of [new Uint8Array(31), new Uint8Array(33), "00".repeat(32), [0], undefined])
      await expect(listPollsBefore(app, before as Uint8Array, 1)).rejects.toThrow(TypeError);
    for (const limit of [0, -1, 1.5, MAX_LISTING_PAGE + 1, Number.NaN])
      await expect(listPollsBefore(app, PAST_END, limit)).rejects.toThrow(TypeError);
    await expect(listPollsBefore(app, PAST_END, 1, [""])).rejects.toThrow(TypeError);
    await expect(
      listPollsBefore(app, PAST_END, 1, [], { topic: "nonsense" } as never),
    ).rejects.toThrow(TypeError);
  });

  test("reads in a read-only session", async () => {
    const readOnly = await db.as("abolish_app");
    await readOnly`SET default_transaction_read_only = on`;
    const id = await election();
    expect((await listPollsBefore(readOnly, PAST_END, MAX_LISTING_PAGE)).map(hex)).toContain(
      hex(id),
    );
  });
});

// The stream's ways in (P2-23): `new` and `closing` list the polls open now,
// ordered by public chain data only, the registry's order and the
// definition's `closes_at`, so the order is the same for everyone and nothing
// a voter or an account does moves a poll (T-68).

/** Positions handed out in increasing order, so the registrations stay in chain order. */
let block = 1_000n;

/** A stored poll open from `opensAt` to `closesAt`, registered at the next position if `registered`. */
async function timed(
  opensAt: bigint,
  closesAt: bigint,
  registered: boolean,
  id = new Uint8Array(randomBytes(32)),
): Promise<Uint8Array> {
  const { electionId, definitionHash } = await storeDefinition(
    app,
    encodeElectionDefinition({
      ...typical,
      election_id: id,
      opens_at: opensAt,
      closes_at: closesAt,
    }),
  );
  if (registered)
    await recordRegistration(app, { electionId, definitionHash, l2Block: block++, logIndex: 0 });
  return electionId;
}

describe("listPolls, new and closing", () => {
  // Times far from every other test's, so `now` picks out this block's polls.
  const T = 5_000_000_000n;

  test("list only the polls open now, from opens_at up to but not at closes_at", async () => {
    const before = await timed(T + 10n, T + 20n, true);
    const open = await timed(T, T + 20n, true);
    const closing = await timed(T - 5n, T + 1n, true);
    const closed = await timed(T - 10n, T, true);
    for (const sort of ["new", "closing"] as const) {
      const listed = await listAll(MAX_LISTING_PAGE, { sort, now: T });
      expect(listed).toContain(hex(open));
      expect(listed).toContain(hex(closing));
      expect(listed).not.toContain(hex(before));
      expect(listed).not.toContain(hex(closed));
    }
    // The `id` order lists every listed poll, open or not.
    const all = await listAll();
    for (const id of [before, open, closing, closed]) expect(all).toContain(hex(id));
  });

  test("new lists the latest registration first, and only registered polls", async () => {
    const now = T + 1_000n;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(hex(await timed(now - 1n, now + 100n - BigInt(i), true)));
    const unregistered = await timed(now - 1n, now + 1n, false);
    for (const limit of [1, 2, 4, MAX_LISTING_PAGE]) {
      const listed = (await listAll(limit, { sort: "new", now })).filter(
        (id) => ids.includes(id) || id === hex(unregistered),
      );
      expect(listed).toEqual([...ids].reverse());
    }
  });

  test("closing lists the soonest closes_at first, ties by election ID, a page at a time", async () => {
    // Few distinct times over many polls, so ties and page edges inside a
    // tie are both exercised; every page size gives the same order.
    const now = T + 2_000n;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 5 }),
        async (offsets, limit) => {
          const mine = new Map<string, bigint>();
          for (const o of offsets) {
            const closesAt = now + BigInt(o);
            mine.set(hex(await timed(now, closesAt, false)), closesAt);
          }
          const listed = (await listAll(limit, { sort: "closing", now })).filter((id) =>
            mine.has(id),
          );
          const expected = [...mine.keys()].sort((a, b) => {
            const d = mine.get(a)! - mine.get(b)!;
            return d < 0n ? -1 : d > 0n ? 1 : a < b ? -1 : 1;
          });
          expect(listed).toEqual(expected);
        },
      ),
      { numRuns: Math.min(numRuns, 30) },
    );
  }, 60_000);

  test("leave out delisted and hidden polls, but page on from one", async () => {
    const now = T + 3_000n;
    const first = await timed(now, now + 1n, true);
    const delisted = await timed(now, now + 2n, true);
    const last = await timed(now, now + 3n, true);
    await moderate(app, delisted, { action: "delist", reason: "spam", moderator: "mod-1" });
    const mine = [first, delisted, last].map(hex);
    const closing = { sort: "closing", now } as const;
    expect((await listAll(MAX_LISTING_PAGE, closing)).filter((id) => mine.includes(id))).toEqual([
      hex(first),
      hex(last),
    ]);
    expect((await listPolls(app, delisted, MAX_LISTING_PAGE, closing)).map(hex)).toContain(
      hex(last),
    );
    const fresh = { sort: "new", now } as const;
    expect((await listAll(MAX_LISTING_PAGE, fresh)).filter((id) => mine.includes(id))).toEqual([
      hex(last),
      hex(first),
    ]);
    expect((await listPolls(app, delisted, MAX_LISTING_PAGE, fresh)).map(hex)).toContain(
      hex(first),
    );
  });

  test("a cursor may be a poll that has since closed", async () => {
    const now = T + 4_000n;
    const early = await timed(now - 10n, now + 5n, true);
    const late = await timed(now - 10n, now + 50n, true);
    for (const sort of ["new", "closing"] as const) {
      const page = (await listPolls(app, early, MAX_LISTING_PAGE, { sort, now: now + 10n })).map(
        hex,
      );
      expect(page.includes(hex(late))).toBe(sort === "closing");
    }
  });

  test("closing pages past a closes_at of 2^63 and over, up to a u64", async () => {
    // Any u64 a definition's `timing` rule allows, whose times are past
    // int8's range, so the cursor must keep them exact.
    const now = T + 5_000n;
    const top = (1n << 64n) - 1n - BigInt(typical.l1_inclusion_bound);
    const mine = [
      await timed(now, 1n << 63n, false),
      await timed(now, (1n << 63n) + 1n, false),
      await timed(now, top, false),
    ].map(hex);
    expect((await listAll(1, { sort: "closing", now })).filter((id) => mine.includes(id))).toEqual(
      mine,
    );
  });

  test("refuse a cursor the order can't place, and a now that isn't a u64", async () => {
    const stray = new Uint8Array(randomBytes(32));
    const unregistered = await timed(T, T + 1n, false);
    for (const [after, sort] of [
      [stray, "new"],
      [stray, "closing"],
      [unregistered, "new"],
    ] as const)
      await expect(listPolls(app, after, 1, { sort, now: T })).rejects.toThrow(ListingError);
    for (const now of [-1n, 1n << 64n, 5, undefined])
      await expect(
        listPolls(app, undefined, 1, { sort: "closing", now } as unknown as ListingOrder),
      ).rejects.toThrow(TypeError);
    await expect(
      listPolls(app, undefined, 1, { sort: "popular" } as unknown as ListingOrder),
    ).rejects.toThrow(TypeError);
  });
});

// "Most answered this week" (P2-23 part 1b): the polls open now by the
// distinct voters whose ballots were boarded in the last week's whole
// anchoring periods. The count is of the public board alone, where every
// entry carries its segment, so it keeps no time of its own (T-11), and a
// re-vote never counts twice (T-01).

const MAX_U32 = 2n ** 32n - 1n;

// The register's counts (P2-19 part 46): the listing's polls, those open now
// and those not open yet, by the same rules as the orders, so a count never
// holds a poll the listing leaves out (T-68).
describe("countListedPolls", () => {
  // Times far from every other test's, so `now` picks out this block's polls.
  const T = 7_000_000_000n;

  /** What adding polls did to the counts at `now`: each count's rise. */
  async function rise(now: bigint, add: () => Promise<unknown>) {
    const before = await countListedPolls(app, now);
    await add();
    const after = await countListedPolls(app, now);
    return {
      listed: after.listed - before.listed,
      open: after.open - before.open,
      scheduled: after.scheduled - before.scheduled,
    };
  }

  test("counts every listed poll, those open from opens_at up to but not at closes_at, and those not open yet", async () => {
    expect(
      await rise(T, async () => {
        await timed(T + 1n, T + 20n, true);
        await timed(T + 10n, T + 20n, false);
        await timed(T, T + 20n, true);
        await timed(T - 5n, T + 1n, false);
        await timed(T - 10n, T, true);
      }),
    ).toEqual({ listed: 5n, open: 2n, scheduled: 2n });
  });

  test("counts open exactly the polls the closing order lists", async () => {
    const now = T + 1_000n;
    await timed(now - 1n, now + 1n, false);
    const counts = await countListedPolls(app, now);
    expect(counts.open).toBe(
      BigInt((await listAll(MAX_LISTING_PAGE, { sort: "closing", now })).length),
    );
    expect(counts.listed).toBe(BigInt((await listAll()).length));
    expect(counts.open + counts.scheduled).toBeLessThanOrEqual(counts.listed);
  });

  test("leaves out delisted and hidden polls, and counts them again once restored", async () => {
    const now = T + 2_000n;
    const open = await timed(now, now + 10n, true);
    const scheduled = await timed(now + 5n, now + 10n, true);
    expect(
      await rise(now, async () => {
        await moderate(app, open, { action: "delist", reason: "spam", moderator: "mod-1" });
        await moderate(app, scheduled, { action: "hide", reason: "threat", moderator: "mod-1" });
      }),
    ).toEqual({ listed: -2n, open: -1n, scheduled: -1n });
    expect(
      await rise(now, () =>
        moderate(app, scheduled, { action: "restore", reason: "error", moderator: "mod-2" }),
      ),
    ).toEqual({ listed: 1n, open: 0n, scheduled: 1n });
  });

  test("reads in a read-only session, and refuses a now that isn't a u64", async () => {
    const readOnly = await db.as("abolish_app");
    await readOnly`SET default_transaction_read_only = on`;
    const counts = await countListedPolls(readOnly, T);
    expect(counts.listed).toBeGreaterThan(0n);
    // Every u64 is a clock it counts at, past an int8's range too.
    const U64_MAX = (1n << 64n) - 1n;
    for (const now of [1n << 63n, U64_MAX]) {
      const late = await countListedPolls(app, now);
      expect(late.listed).toBe((await countListedPolls(app, T)).listed);
      expect(late.scheduled).toBe(0n);
    }
    for (const now of [-1n, 1n << 64n, 5, undefined])
      await expect(countListedPolls(app, now as bigint)).rejects.toThrow(TypeError);
  });
});

describe("listedPlaces", () => {
  // A place no other test files a poll at, so its spellings are this test's.
  const fresh = () => `Place ${randomBytes(6).toString("hex")}`;

  /** A stored, listed poll filed at `place`. */
  async function filed(place: string): Promise<Uint8Array> {
    const id = await election();
    expect(await insertPollTags(app, id, { place })).toBe(true);
    return id;
  }

  test("suggests each place once, in the spelling most of its polls carry, the first by code point on a tie", async () => {
    // The commonest spelling sorts last by code point, so the first by code
    // point (a `min`) would pick another.
    const common = fresh();
    await filed(common.toUpperCase());
    await filed(common);
    await filed(common.toLowerCase());
    await filed(common.toLowerCase());
    const tied = fresh();
    await filed(tied.toLowerCase());
    await filed(tied);
    const places = await listedPlaces(app);
    expect(places.filter((p) => p.toLowerCase() === common.toLowerCase())).toEqual([
      common.toLowerCase(),
    ]);
    // "P" (U+0050) sorts before "p" (U+0070) whatever the database's collation.
    expect(places.filter((p) => p.toLowerCase() === tied.toLowerCase())).toEqual([tied]);
  });

  test("leaves out a place filed only on delisted or hidden polls, and suggests it again once restored", async () => {
    const delisted = fresh();
    const hidden = fresh();
    const d = await filed(delisted);
    const h = await filed(hidden);
    expect(await listedPlaces(app)).toEqual(expect.arrayContaining([delisted, hidden]));
    await moderate(app, d, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, h, { action: "hide", reason: "threat", moderator: "mod-1" });
    const out = await listedPlaces(app);
    expect(out).not.toContain(delisted);
    expect(out).not.toContain(hidden);
    await moderate(app, h, { action: "restore", reason: "error", moderator: "mod-2" });
    expect(await listedPlaces(app)).toContain(hidden);
  });

  test("follows a refiling, and suggests no poll filed under a topic alone", async () => {
    const was = fresh();
    const now = fresh();
    const id = await filed(was);
    await refilePoll(app, id, { tags: { place: now }, reason: "misfiled", moderator: "mod-1" });
    const topicOnly = await election();
    await insertPollTags(app, topicOnly, { topic: "food" });
    const places = await listedPlaces(app);
    expect(places).toContain(now);
    expect(places).not.toContain(was);
    expect(places.every((p) => typeof p === "string" && p !== "")).toBe(true);
  });

  test("returns at most MAX_LISTED_PLACES, the places with the most polls, in order of key", async () => {
    // More places than fit, each filed once, and one filed twice whose key
    // sorts after every other: it fits only by its count.
    const once = Array.from({ length: MAX_LISTED_PLACES + 1 }, fresh);
    for (const place of once) await filed(place);
    const twice = `zzz ${fresh()}`;
    await filed(twice);
    await filed(twice);
    const places = await listedPlaces(app);
    expect(places).toHaveLength(MAX_LISTED_PLACES);
    expect(places.at(-1)).toBe(twice);
    expect(once.filter((p) => !places.includes(p)).length).toBeGreaterThan(0);
    const keys = places.map((p) => placeKey(p)!);
    const byCodePoint = (a: string, b: string) => {
      const [x, y] = [Array.from(a), Array.from(b)];
      for (let i = 0; i < Math.min(x.length, y.length); i++)
        if (x[i] !== y[i]) return x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
      return x.length - y.length;
    };
    expect([...keys].sort(byCodePoint)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("reads in a read-only session", async () => {
    // Filed often enough to fit among the places the cap keeps.
    const place = fresh();
    for (let i = 0; i < 5; i++) await filed(place);
    const readOnly = await db.as("abolish_app");
    await readOnly`SET default_transaction_read_only = on`;
    expect(await listedPlaces(readOnly)).toContain(place);
  });
});

describe("answeredWindow", () => {
  const HOUR = { epoch: 0n, period: 3600n };

  test("is the whole periods of the last week before now's own", () => {
    const now = 1_000n * 3600n + 17n;
    expect(answeredWindow(now, HOUR)).toEqual({ from: 1_000n - 168n, to: 999n });
    // A period that doesn't divide the week rounds the window up.
    expect(answeredWindow(100n * 7n * 3600n, { epoch: 0n, period: 7n * 3600n })).toEqual({
      from: 100n - 24n,
      to: 99n,
    });
  });

  test("is empty before the epoch and in its first period, and short just after", () => {
    const clock = { epoch: 10_000n, period: 3600n };
    for (const now of [0n, 9_999n, 10_000n, 13_599n]) {
      const { from, to } = answeredWindow(now, clock);
      expect(from > to).toBe(true);
    }
    expect(answeredWindow(10_000n + 3n * 3600n, clock)).toEqual({ from: 0n, to: 2n });
  });

  test("covers at least the week before now's period, by at most a period more, and never now's period", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 10n }),
        fc.bigInt({ min: 0n, max: 10n ** 10n }),
        fc.bigInt({ min: 1n, max: 2n * ANSWERED_WINDOW_SECONDS }),
        (now, epoch, period) => {
          const { from, to } = answeredWindow(now, { epoch, period });
          if (now < epoch + period) {
            expect(from > to).toBe(true);
            return;
          }
          const current = (now - epoch) / period;
          // Past the last u32 segment the window stops there; a case below.
          if (current - 1n > MAX_U32) return;
          expect(to).toBe(current - 1n);
          const start = epoch + from * period;
          const end = epoch + (to + 1n) * period;
          expect(end).toBeLessThanOrEqual(now);
          if (from > 0n) {
            expect(end - start).toBeGreaterThanOrEqual(ANSWERED_WINDOW_SECONDS);
            expect(end - start).toBeLessThan(ANSWERED_WINDOW_SECONDS + period);
          }
        },
      ),
      { numRuns },
    );
  });

  test("stops at the last u32 segment, and is empty past it", () => {
    const tick = { epoch: 0n, period: 1n };
    expect(answeredWindow(MAX_U32 + 10n, tick)).toEqual({
      from: MAX_U32 + 10n - ANSWERED_WINDOW_SECONDS,
      to: MAX_U32,
    });
    const { from, to } = answeredWindow(MAX_U32 + ANSWERED_WINDOW_SECONDS + 2n, tick);
    expect(from > to).toBe(true);
  });

  test("refuses a now or a clock outside the u64s, and a zero period", () => {
    for (const [now, clock] of [
      [-1n, HOUR],
      [1n << 64n, HOUR],
      [5, HOUR],
      [0n, { epoch: -1n, period: 1n }],
      [0n, { epoch: 0n, period: 0n }],
      [0n, { epoch: 0n, period: 1 }],
      [0n, null],
    ] as const)
      expect(() =>
        answeredWindow(now as bigint, clock as unknown as { epoch: bigint; period: bigint }),
      ).toThrow(TypeError);
  });
});

describe("listPolls, answered", () => {
  const clock = { epoch: 0n, period: 3600n };
  // Far from every other test's times, so `now` picks out this block's polls.
  const now = 6_000_000_000n;
  const current = now / clock.period;
  const answered = { sort: "answered", now, clock } as const;

  /** Boards one ballot for `electionId` in `segment` from voter (`tier`, `nullifier`). */
  async function cast(electionId: Uint8Array, segment: bigint, nullifier: bigint, tier = 0) {
    await appendEntry(
      app,
      electionId,
      Number(segment),
      Uint8Array.of(0x00, 0x02, 1, ...randomBytes(8)),
      {
        ballot: {
          tier,
          nullifier,
          message: new Uint8Array(randomBytes(32)),
          ballotHash: new Uint8Array(randomBytes(32)),
        },
      },
    );
  }

  test("orders the polls open now by distinct voters in the window, then by election ID", async () => {
    const three = await timed(now - 10n, now + 100n, true);
    for (const v of [1n, 2n, 3n]) await cast(three, current - 5n, v);
    // One voter re-voting is one voter.
    const revoted = await timed(now - 10n, now + 100n, true);
    for (let i = 0n; i < 5n; i++) await cast(revoted, current - 10n + i, 9n);
    // Ballots outside the window: before it, and in the period now is in.
    const outside = await timed(now - 10n, now + 100n, true);
    for (const v of [1n, 2n]) await cast(outside, current - 169n, v);
    for (const v of [3n, 4n, 5n, 6n]) await cast(outside, current, v);
    const quiet = await timed(now - 10n, now + 100n, false);
    // Not open now: never listed, however answered.
    const closed = await timed(now - 100n, now, true);
    for (const v of [1n, 2n, 3n, 4n]) await cast(closed, current - 1n, v);
    const mine = [three, revoted, outside, quiet, closed].map(hex);
    const zeros = [hex(outside), hex(quiet)].sort();
    for (const limit of [1, 2, MAX_LISTING_PAGE])
      expect((await listAll(limit, answered)).filter((id) => mine.includes(id))).toEqual([
        hex(three),
        hex(revoted),
        ...zeros,
      ]);
  });

  test("counts a voter once per tier, at the window's edges", async () => {
    // `tiers` has the higher election ID, so it lists first only by its
    // count: two, if both tiers and both edges count, against `one`'s one.
    const low = new Uint8Array(randomBytes(32));
    low[0] = 0x00;
    const high = new Uint8Array(randomBytes(32));
    high[0] = 0xff;
    const tiers = await timed(now - 10n, now + 100n, false, high);
    await cast(tiers, current - 168n, 1n, 0);
    await cast(tiers, current - 1n, 1n, 1);
    const one = await timed(now - 10n, now + 100n, false, low);
    await cast(one, current - 1n, 1n);
    const mine = [tiers, one].map(hex);
    expect((await listAll(MAX_LISTING_PAGE, answered)).filter((id) => mine.includes(id))).toEqual(
      mine,
    );
  });

  test("lists every page size in one order, by count then election ID", async () => {
    // Few distinct counts over many polls, so ties and page edges inside a
    // tie are both exercised.
    const at = now + 7n * 24n * 3600n * 10n;
    const seg = at / clock.period - 1n;
    const order = { sort: "answered", now: at, clock } as const;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 5 }),
        async (counts, limit) => {
          const mine = new Map<string, number>();
          for (const n of counts) {
            const id = await timed(at - 1n, at + 1n, false);
            for (let v = 0; v < n; v++) await cast(id, seg, BigInt(v + 1));
            mine.set(hex(id), n);
          }
          const listed = (await listAll(limit, order)).filter((id) => mine.has(id));
          const expected = [...mine.keys()].sort((a, b) => {
            const d = mine.get(b)! - mine.get(a)!;
            return d !== 0 ? d : a < b ? -1 : 1;
          });
          expect(listed).toEqual(expected);
        },
      ),
      { numRuns: Math.min(numRuns, 20) },
    );
  }, 120_000);

  test("leaves out delisted polls, but pages on from one or from a poll since closed", async () => {
    const at = now + 7n * 24n * 3600n * 20n;
    const seg = at / clock.period - 1n;
    const order = { sort: "answered", now: at, clock } as const;
    const first = await timed(at - 1n, at + 10n, false);
    for (const v of [1n, 2n, 3n]) await cast(first, seg, v);
    const delisted = await timed(at - 1n, at + 10n, false);
    for (const v of [1n, 2n]) await cast(delisted, seg, v);
    const last = await timed(at - 1n, at + 10n, false);
    await cast(last, seg, 1n);
    await moderate(app, delisted, { action: "delist", reason: "spam", moderator: "mod-1" });
    const mine = [first, delisted, last].map(hex);
    expect((await listAll(MAX_LISTING_PAGE, order)).filter((id) => mine.includes(id))).toEqual([
      hex(first),
      hex(last),
    ]);
    expect((await listPolls(app, delisted, MAX_LISTING_PAGE, order)).map(hex)).toContain(hex(last));
    const shut = await timed(at - 1n, at, false);
    for (const v of [1n, 2n]) await cast(shut, seg, v);
    const page = (await listPolls(app, shut, MAX_LISTING_PAGE, order)).map(hex);
    expect(page).toContain(hex(last));
    expect(page).not.toContain(hex(first));
  });

  test("refuses a cursor that names no stored poll, and a malformed clock", async () => {
    await expect(listPolls(app, new Uint8Array(randomBytes(32)), 1, answered)).rejects.toThrow(
      ListingError,
    );
    await expect(
      listPolls(app, undefined, 1, {
        sort: "answered",
        now,
        clock: { epoch: 0n, period: 0n },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      listPolls(app, undefined, 1, { sort: "answered", now } as unknown as ListingOrder),
    ).rejects.toThrow(TypeError);
  });
});

// A card's count (P2-23 part 2c): how many have answered a poll so far, tier
// by tier, never summed across tiers (T-01), of the public board alone.
describe("answeredByTier", () => {
  async function cast(electionId: Uint8Array, nullifier: bigint, tier = 0, segment = 0) {
    await appendEntry(app, electionId, segment, Uint8Array.of(0x00, 0x02, 1, ...randomBytes(8)), {
      ballot: {
        tier,
        nullifier,
        message: new Uint8Array(randomBytes(32)),
        ballotHash: new Uint8Array(randomBytes(32)),
      },
    });
  }

  test("counts each tier's distinct voters, a re-vote once, in tier order", async () => {
    const id = await election();
    expect(await answeredByTier(app, id)).toEqual([]);
    await cast(id, 7n, 2);
    for (const v of [1n, 2n, 3n]) await cast(id, v, 0);
    // The same nullifier in another tier is another voter there.
    await cast(id, 1n, 1);
    // The same voter again, in a later period: a re-vote.
    await cast(id, 2n, 0, 3);
    expect(await answeredByTier(app, id)).toEqual([
      { tier: 0, voters: 3n },
      { tier: 1, voters: 1n },
      { tier: 2, voters: 1n },
    ]);
    // Another poll's ballots never count here.
    const other = await election();
    await cast(other, 9n, 0);
    expect(await answeredByTier(app, id)).toEqual([
      { tier: 0, voters: 3n },
      { tier: 1, voters: 1n },
      { tier: 2, voters: 1n },
    ]);
  });

  test("matches a model of the cast ballots", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 1, max: 4 })), {
          maxLength: 12,
        }),
        async (ballots) => {
          const id = await election();
          const voters = new Map<number, Set<number>>();
          for (const [tier, nullifier] of ballots) {
            await cast(id, BigInt(nullifier), tier);
            voters.set(tier, (voters.get(tier) ?? new Set()).add(nullifier));
          }
          const expected = [...voters.entries()]
            .sort(([a], [b]) => a - b)
            .map(([tier, set]) => ({ tier, voters: BigInt(set.size) }));
          expect(await answeredByTier(app, id)).toEqual(expected);
        },
      ),
      { numRuns: Math.min(numRuns, 20) },
    );
  }, 120_000);

  test("counts a delisted or hidden poll's voters, as its board stays served", async () => {
    const id = await election();
    await cast(id, 1n);
    await moderate(app, id, { action: "hide", reason: "spam", moderator: "mod-1" });
    expect(await answeredByTier(app, id)).toEqual([{ tier: 0, voters: 1n }]);
  });

  test("is undefined for an election with no stored definition, and refuses a malformed ID", async () => {
    expect(await answeredByTier(app, new Uint8Array(randomBytes(32)))).toBeUndefined();
    await expect(answeredByTier(app, new Uint8Array(31))).rejects.toThrow(TypeError);
    await expect(answeredByTier(app, "00" as unknown as Uint8Array)).rejects.toThrow(TypeError);
  });

  test("reads in a read-only session", async () => {
    const readOnly = await db.as("abolish_app");
    await readOnly`SET default_transaction_read_only = on`;
    const id = await election();
    await cast(id, 1n);
    expect(await answeredByTier(readOnly, id)).toEqual([{ tier: 0, voters: 1n }]);
  });
  // An account's list of polls (P2-19 part 58): every poll's count in one read (T-52).
  test("reads several elections at once, each as it would be read alone, in the asked order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 1, max: 3 })), {
            maxLength: 5,
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.boolean(),
        async (polls, unknownFirst) => {
          const ids: Uint8Array[] = [];
          for (const ballots of polls) {
            const id = await election();
            for (const [tier, nullifier] of ballots) await cast(id, BigInt(nullifier), tier);
            ids.push(id);
          }
          const unknown = new Uint8Array(randomBytes(32));
          const asked = unknownFirst ? [unknown, ...ids.reverse()] : [...ids, unknown];
          const alone = await Promise.all(asked.map((id) => answeredByTier(app, id)));
          expect(await answeredByTiers(app, asked)).toEqual(alone);
          expect(alone[unknownFirst ? 0 : asked.length - 1]).toBeUndefined();
        },
      ),
      { numRuns: Math.min(numRuns, 10) },
    );
  }, 120_000);

  test("refuses no IDs, too many, a repeated one and a malformed one", async () => {
    const id = await election();
    await expect(answeredByTiers(app, [])).rejects.toThrow(TypeError);
    await expect(answeredByTiers(app, [id, new Uint8Array(id)])).rejects.toThrow(TypeError);
    await expect(answeredByTiers(app, [id, new Uint8Array(31)])).rejects.toThrow(TypeError);
    await expect(answeredByTiers(app, "00" as unknown as readonly Uint8Array[])).rejects.toThrow(
      TypeError,
    );
    const many = Array.from(
      { length: MAX_ANSWERED_ELECTIONS + 1 },
      () => new Uint8Array(randomBytes(32)),
    );
    await expect(answeredByTiers(app, many)).rejects.toThrow(TypeError);
    // The bound itself is read, every unknown ID undefined.
    expect(await answeredByTiers(app, many.slice(1))).toEqual(many.slice(1).map(() => undefined));
  });
});
