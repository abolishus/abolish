import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  ListingError,
  type ListingOrder,
  listPolls,
  MAX_LISTING_PAGE,
  moderate,
  moderationStatus,
  REMOVAL_REASONS,
  recordRegistration,
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

  test("reads only definitions, their registrations and times, and the moderation log, and writes nothing", async () => {
    // T-68: listing is a view for our front ends; it never reaches a board or
    // a result, and never changes what it reads. A read-only session refuses
    // any write, however it is spelt.
    const src = readFileSync(new URL("../src/listing.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/boardEntries|board_entries|appendEntry|storeDefinition/);
    const readOnly = await db.as("abolish_app");
    await readOnly`SET default_transaction_read_only = on`;
    const id = await election();
    expect((await listPolls(readOnly, undefined, MAX_LISTING_PAGE)).map(hex)).toContain(hex(id));
    const open = await timed(100n, 200n, true);
    for (const sort of ["new", "closing"] as const)
      expect(
        (await listPolls(readOnly, undefined, MAX_LISTING_PAGE, { sort, now: 150n })).map(hex),
      ).toContain(hex(open));
  });
});

// The stream's ways in (P2-23): `new` and `closing` list the polls open now,
// ordered by public chain data only, the registry's order and the
// definition's `closes_at`, so the order is the same for everyone and nothing
// a voter or an account does moves a poll (T-68).

/** Positions handed out in increasing order, so the registrations stay in chain order. */
let block = 1_000n;

/** A stored poll open from `opensAt` to `closesAt`, registered at the next position if `registered`. */
async function timed(opensAt: bigint, closesAt: bigint, registered: boolean): Promise<Uint8Array> {
  const { electionId, definitionHash } = await storeDefinition(
    app,
    encodeElectionDefinition({
      ...typical,
      election_id: new Uint8Array(randomBytes(32)),
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
