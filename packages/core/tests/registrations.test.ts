import {
  decodeElectionDefinition,
  electionDefinitionHash,
  encodeElectionDefinition,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  assignShortCodes,
  electionRegistrations,
  lookupShortCode,
  MAX_SHORT_CODE_LENGTH,
  recordRegistration,
  RegistrationError,
  type Registration,
  type RegistrationErrorCode,
  resolveShortCode,
  SHORT_CODE_LENGTH,
  shortCode,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// Registrations and short-code lookup in Postgres
// (migrations/0007_election_registrations.sql and src/registrations.ts;
// P2-18): registrations are recorded once, in chain order, and a code
// resolves to the poll `assignShortCodes` gives it over the recorded hashes
// in that order, so a poll ground to share a prefix never takes an earlier
// poll's code (T-49, T-53).

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
let owner: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
});
afterAll(() => db?.close());

/** Positions handed out in increasing order, so tests sharing the table stay in chain order. */
let block = 1_000n;
const next = () => ({ l2Block: block++, logIndex: 0 });
const b32 = () => new Uint8Array(randomBytes(32));

/** A stored definition under a fresh election ID, with its hash. */
async function stored(client: Sql = app) {
  const definition = encodeElectionDefinition({ ...typical, election_id: b32() });
  const { electionId, definitionHash } = await storeDefinition(client, definition);
  return { electionId, definitionHash };
}

/** A registration of a stored definition at the next position. */
async function registered(client: Sql = app): Promise<Registration> {
  return { ...(await stored(client)), ...next() };
}

async function refusedWith(p: Promise<unknown>): Promise<RegistrationErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RegistrationError) return e.code;
    throw e;
  }
  throw new Error("record succeeded");
}

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'election_registrations'
      ORDER BY ordinal_position`;
    const config = getTableConfig(electionRegistrations);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const indexes = await db.admin`
      SELECT i.indisprimary AS pk, array_agg(a.attname ORDER BY k.n) AS cols
      FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = ${`"${db.schema}".election_registrations`}::regclass AND i.indisunique
      GROUP BY i.indexrelid, i.indisprimary ORDER BY 2`;
    expect(indexes.map((r) => [r["pk"], r["cols"]])).toEqual([
      [false, ["definition_hash"]],
      [true, ["election_id"]],
      [false, ["l2_block", "log_index"]],
    ]);
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'election_registrations'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });

  for (const [role, client] of [
    ["app", () => app],
    ["owner", () => owner],
  ] as const) {
    for (const [op, run] of Object.entries({
      update: (sql: Sql, e: Uint8Array) =>
        sql`UPDATE election_registrations SET l2_block = l2_block WHERE election_id = ${e}`,
      delete: (sql: Sql, e: Uint8Array) =>
        sql`DELETE FROM election_registrations WHERE election_id = ${e}`,
      truncate: (sql: Sql) => sql`TRUNCATE election_registrations`,
    })) {
      test(`${op} fails as the ${role}`, async () => {
        const r = await registered();
        await recordRegistration(app, r);
        expect(await failsWith(run(client(), r.electionId))).toBe("42501");
        const code = shortCode(r.definitionHash);
        expect((await lookupShortCode(app, code))?.electionId).toEqual(r.electionId);
      });
    }
  }

  const insert = (sql: Sql, r: Registration) =>
    sql`INSERT INTO election_registrations
      VALUES (${r.electionId}, ${r.definitionHash}, ${r.l2Block.toString()}, ${r.logIndex})`;

  test("a row needs 32-byte hashes and a position after every recorded one", async () => {
    const fresh = () => ({ electionId: b32(), definitionHash: b32(), ...next() });
    const a = fresh();
    expect(
      await failsWith(insert(app, { ...a, definitionHash: a.definitionHash.subarray(1) })),
    ).toBe("23514");
    expect(await failsWith(insert(app, { ...a, electionId: a.electionId.subarray(1) }))).toBe(
      "23514",
    );
    // No stored definition is needed: the event alone is recorded.
    await insert(app, a);
    const b = { ...fresh(), l2Block: a.l2Block, logIndex: a.logIndex };
    // The same position, and one before it, are out of chain order.
    expect(await failsWith(insert(app, b))).toBe("23514");
    expect(await failsWith(insert(app, { ...b, l2Block: a.l2Block - 1n, logIndex: 9 }))).toBe(
      "23514",
    );
    expect(await failsWith(insert(app, { ...b, l2Block: -1n }))).toBe("23514");
    // A later log in the same block is after it.
    await insert(app, { ...b, logIndex: a.logIndex + 1 });
  });

  test("refuses inserts in a REPEATABLE READ or SERIALIZABLE transaction", async () => {
    // A snapshot taken before the order lock could miss a row committed while
    // waiting for it (T-53).
    for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
      await app.unsafe(`BEGIN ISOLATION LEVEL ${level}`);
      try {
        expect(
          await failsWith(insert(app, { electionId: b32(), definitionHash: b32(), ...next() })),
        ).toBe("25000");
      } finally {
        await app`ROLLBACK`;
      }
    }
  });
});

describe("recordRegistration", () => {
  test("records the event's hash, which must be the stored definition's if there is one", async () => {
    const r = await registered();
    expect(await refusedWith(recordRegistration(app, { ...r, definitionHash: b32() }))).toBe(
      "hash-mismatch",
    );
    await recordRegistration(app, r);
    const [row] = await app`SELECT definition_hash FROM election_registrations
      WHERE election_id = ${r.electionId}`;
    expect(new Uint8Array(row!["definition_hash"] as Uint8Array)).toEqual(r.definitionHash);
    expect(r.definitionHash).toEqual(
      electionDefinitionHash(
        decodeElectionDefinition(
          (
            await app`SELECT definition FROM election_definitions WHERE election_id = ${r.electionId}`
          )[0]!["definition"] as Uint8Array,
        ),
      ),
    );
  });

  test("records an event whose definition isn't stored, so it still owns its codes", async () => {
    // A definition the registry accepted but storeDefinition refuses (T-49).
    const r = { electionId: b32(), definitionHash: b32(), ...next() };
    await recordRegistration(app, r);
    expect(await lookupShortCode(app, shortCode(r.definitionHash))).toEqual({
      electionId: r.electionId,
      code: shortCode(r.definitionHash),
    });
  });

  test("recording the same event again is a no-op; anything else for it is a conflict", async () => {
    const r = await registered();
    await recordRegistration(app, r);
    await recordRegistration(app, r);
    for (const other of [
      { ...r, ...next() },
      { ...r, logIndex: r.logIndex + 1 },
      { ...r, electionId: b32() },
    ])
      expect(await refusedWith(recordRegistration(app, other))).toBe("conflict");
  });

  test("a position recorded for another election is a conflict", async () => {
    const a = await registered();
    const b = await registered();
    await recordRegistration(app, a);
    expect(
      await refusedWith(
        recordRegistration(app, { ...b, l2Block: a.l2Block, logIndex: a.logIndex }),
      ),
    ).toBe("conflict");
  });

  test("refuses a position before the latest recorded", async () => {
    const a = await registered();
    const b = await registered();
    await recordRegistration(app, b);
    expect(await refusedWith(recordRegistration(app, a))).toBe("out-of-order");
  });

  test("refuses malformed arguments", async () => {
    const r = await registered();
    for (const bytes of [new Uint8Array(31), new Uint8Array(33), "00".repeat(32)]) {
      for (const field of ["electionId", "definitionHash"])
        await expect(
          recordRegistration(app, { ...r, [field]: bytes as Uint8Array }),
        ).rejects.toThrow(TypeError);
    }
    for (const position of [
      { l2Block: -1n, logIndex: 0 },
      { l2Block: 1n << 63n, logIndex: 0 },
      { l2Block: 1, logIndex: 0 },
      { l2Block: 1n, logIndex: -1 },
      { l2Block: 1n, logIndex: 1.5 },
      { l2Block: 1n, logIndex: 2 ** 31 },
    ])
      await expect(
        recordRegistration(app, { ...r, ...(position as { l2Block: bigint; logIndex: number }) }),
      ).rejects.toThrow(TypeError);
  });
});

/**
 * Runs `body` in a transaction that is always rolled back, so each property
 * run starts from a table of its own while sharing the schema. Drizzle can't
 * take postgres.js's transaction handle, so this is BEGIN and ROLLBACK on a
 * client of one connection.
 */
let txClient: Sql | undefined;
async function isolated(body: (tx: Sql) => Promise<void>): Promise<void> {
  txClient ??= await db.as("abolish_app");
  await txClient`BEGIN`;
  try {
    await body(txClient);
  } finally {
    await txClient`ROLLBACK`;
  }
}

/**
 * Registrations whose hashes collide on purpose, as polls ground to match
 * earlier codes would: each starts with one of a few shared prefixes. Their
 * definitions aren't stored, as for an event whose definition we refuse.
 */
const collidingHashes = fc
  .tuple(
    fc.array(fc.uint8Array({ minLength: 0, maxLength: 12 }), { minLength: 1, maxLength: 4 }),
    fc.array(fc.tuple(fc.nat(), fc.uint8Array({ minLength: 32, maxLength: 32 })), {
      minLength: 1,
      maxLength: 24,
    }),
  )
  .map(([prefixes, picks]) =>
    picks.map(([i, tail]) => {
      const h = tail.slice();
      h.set(prefixes[i % prefixes.length]!); // i % length is in range
      return h;
    }),
  )
  .filter((hs) => new Set(hs.map((h) => Buffer.from(h).toString("hex"))).size === hs.length);

describe("lookupShortCode", () => {
  test("agrees with resolveShortCode over adversarially colliding hashes", async () => {
    await fc.assert(
      fc.asyncProperty(collidingHashes, fc.array(fc.nat(3), { maxLength: 24 }), async (hs, gaps) =>
        isolated(async (tx) => {
          const ids: Uint8Array[] = [];
          // Rolled back, so the shared counter needn't move.
          let position = { l2Block: block, logIndex: 0 };
          for (const [i, h] of hs.entries()) {
            // Several registrations to a block, or a new block, at random.
            const gap = gaps[i] ?? 0;
            position =
              gap === 0
                ? { ...position, logIndex: position.logIndex + 1 }
                : { l2Block: position.l2Block + BigInt(gap), logIndex: 0 };
            const electionId = b32();
            await recordRegistration(tx, { electionId, definitionHash: h, ...position });
            ids.push(electionId);
          }
          const codes = assignShortCodes(hs);
          for (const [i, code] of codes.entries()) {
            const found = await lookupShortCode(tx, code.toUpperCase());
            expect(found).toEqual({ electionId: ids[i], code });
            // The prefixes next to each code, 7 characters and one either side.
            for (const n of [SHORT_CODE_LENGTH, code.length - 1, code.length + 1]) {
              if (n < SHORT_CODE_LENGTH || n > MAX_SHORT_CODE_LENGTH) continue;
              const prefix = shortCode(hs[i]!, n); // entries() index
              const index = resolveShortCode(prefix, hs);
              expect(await lookupShortCode(tx, prefix)).toEqual(
                index === undefined ? undefined : { electionId: ids[index], code: prefix },
              );
            }
          }
        }),
      ),
      // Each run writes to the database, so the run count is capped like the
      // other database-backed properties.
      { numRuns: Math.min(numRuns, 50) },
    );
    // Fifty runs of database writes outlast the default timeout on a slow
    // runner, and a property left running keeps writing on `isolated`'s shared
    // connection under the tests after it.
  }, 120_000);

  test("a poll ground to an earlier poll's 7-character prefix gets 8 characters", async () => {
    await isolated(async (tx) => {
      const first = await stored(tx);
      const ground = b32();
      const h = first.definitionHash;
      const collided = h.slice();
      collided[31] = (h[31] ?? 0) ^ 1; // the same first 255 bits
      await recordRegistration(tx, { ...first, l2Block: block, logIndex: 0 });
      await recordRegistration(tx, {
        electionId: ground,
        definitionHash: collided,
        l2Block: block,
        logIndex: 1,
      });
      expect(await lookupShortCode(tx, shortCode(h))).toEqual({
        electionId: first.electionId,
        code: shortCode(h),
      });
      // The two share 51 characters; the later one's code is all 52.
      for (let n = SHORT_CODE_LENGTH + 1; n < MAX_SHORT_CODE_LENGTH; n++)
        expect(await lookupShortCode(tx, shortCode(collided, n))).toBeUndefined();
      expect(await lookupShortCode(tx, shortCode(collided, MAX_SHORT_CODE_LENGTH))).toEqual({
        electionId: ground,
        code: shortCode(collided, MAX_SHORT_CODE_LENGTH),
      });
    });
  });

  test("forgives case and lookalikes, and refuses anything else without reading", async () => {
    await isolated(async (tx) => {
      const electionId = b32();
      const definitionHash = new Uint8Array(32); // code 0000000, typed with o and O
      definitionHash[31] = 1;
      await recordRegistration(tx, { electionId, definitionHash, l2Block: block, logIndex: 0 });
      for (const input of ["0000000", "oOo0000", "OOOOOOO"])
        expect(await lookupShortCode(tx, input)).toEqual({ electionId, code: "0000000" });
      for (const input of ["000000", "000000u", "000-000", "0000000 ", "", "0".repeat(53)])
        expect(await lookupShortCode(tx, input)).toBeUndefined();
    });
  });

  test("a stored definition with no recorded registration has no code", async () => {
    const { definitionHash } = await stored();
    expect(await lookupShortCode(app, shortCode(definitionHash))).toBeUndefined();
  });
});
