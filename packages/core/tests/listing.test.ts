import { decodeElectionDefinition, encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  listPolls,
  MAX_LISTING_PAGE,
  moderate,
  moderationStatus,
  REMOVAL_REASONS,
  RESTORE_REASONS,
  storeDefinition,
} from "../src/index.ts";
import { addModerators, type TestDb, testDb } from "./db.ts";

// Discovery (src/listing.ts; docs/moderation-policy.md, Actions; T-68): the
// listing holds every stored poll whose moderation state is `visible`, in
// order of election ID, and a cursor visits each once.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const typical = decodeElectionDefinition(
  Buffer.from(
    JSON.parse(
      readFileSync(
        new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
        "utf8",
      ),
    ).vectors.find((v: { id: string }) => v.id === "definition-typical").encoding,
    "hex",
  ),
);

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

/** Every listed poll, a page of `limit` at a time, as hex. */
async function listAll(limit = MAX_LISTING_PAGE): Promise<string[]> {
  const all: string[] = [];
  let after: Uint8Array | undefined;
  for (;;) {
    const page = await listPolls(app, after, limit);
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

  test("reads only definitions and the moderation log, and writes nothing", async () => {
    // T-68: listing is a view for our front ends; it never reaches a board or
    // a result, and never changes what it reads. A read-only session refuses
    // any write, however it is spelt.
    const src = readFileSync(new URL("../src/listing.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/boardEntries|board_entries|appendEntry|storeDefinition/);
    const readOnly = await db.as("abolish_app");
    await readOnly`SET default_transaction_read_only = on`;
    const id = await election();
    expect((await listPolls(readOnly, undefined, MAX_LISTING_PAGE)).map(hex)).toContain(hex(id));
  });
});
