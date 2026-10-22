import {
  decodeElectionDefinitionV5,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { electionSchedules, fillElectionSchedules, storeDefinition } from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// Each stored definition's times (migrations/0023_election_schedules.sql;
// src/definitions.ts), which discovery's `new` and `closing` read (P2-23):
// public chain data copied out of the definition, write-once like it, and
// always the definition's own `opens_at` and `closes_at` (T-53, T-68).

let db: TestDb;
let app: Sql;
let owner: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
});
afterAll(() => db?.close());

const b32 = () => new Uint8Array(randomBytes(32));

// A version-5 definition under the profile 2.3 asks of version 5, as in
// definitions.test.ts.
const typicalV5 = decodeElectionDefinitionV5(
  Buffer.from(
    (
      JSON.parse(
        readFileSync(
          new URL("../../../docs/spec/vectors/verifier-ballots-v3.json", import.meta.url),
          "utf8",
        ),
      ) as { cases: { id: string; definition: string }[] }
    ).cases.find((c) => c.id === "admitted")!.definition,
    "hex",
  ),
);

async function schedule(electionId: Uint8Array) {
  const rows = await app<{ opens_at: string; closes_at: string }[]>`
    SELECT opens_at::text, closes_at::text FROM election_schedules WHERE election_id = ${electionId}`;
  return rows.map((r) => [BigInt(r.opens_at), BigInt(r.closes_at)]);
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
      SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'election_schedules'
      ORDER BY ordinal_position`;
    const config = getTableConfig(electionSchedules);
    expect(
      cols.map((c) => [
        c["column_name"],
        c["data_type"] === "numeric"
          ? `numeric(${c["numeric_precision"]}, ${c["numeric_scale"]})`
          : c["data_type"],
        c["is_nullable"],
      ]),
    ).toEqual(config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]));
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'election_schedules'
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
        sql`UPDATE election_schedules SET closes_at = closes_at + 1 WHERE election_id = ${e}`,
      delete: (sql: Sql, e: Uint8Array) =>
        sql`DELETE FROM election_schedules WHERE election_id = ${e}`,
      truncate: (sql: Sql) => sql`TRUNCATE election_schedules`,
    })) {
      test(`${op} fails as the ${role}`, async () => {
        const { electionId } = await storeDefinition(
          app,
          encodeElectionDefinition({ ...typical, election_id: b32() }),
        );
        expect(await failsWith(run(client(), electionId))).toBe("42501");
        expect(await schedule(electionId)).toEqual([[typical.opens_at, typical.closes_at]]);
      });
    }
  }

  test("refuses times out of order or past a u64", async () => {
    for (const [opens, closes] of [
      [10n, 10n],
      [10n, 9n],
      [-1n, 10n],
      [0n, 1n << 64n],
    ])
      expect(
        await failsWith(
          app`INSERT INTO election_schedules VALUES (${b32()}, ${opens!.toString()}, ${closes!.toString()})`,
        ),
      ).toBe("23514");
  });
});

describe("storeDefinition's schedule", () => {
  test("holds the definition's own times, for version 1 and version 5, up to a u64", async () => {
    const max = (1n << 64n) - 1n;
    const { electionId } = await storeDefinition(
      app,
      encodeElectionDefinition({
        ...typical,
        election_id: b32(),
        opens_at: max - 1n - BigInt(typical.l1_inclusion_bound),
        closes_at: max - BigInt(typical.l1_inclusion_bound),
      }),
    );
    expect(await schedule(electionId)).toEqual([
      [max - 1n - BigInt(typical.l1_inclusion_bound), max - BigInt(typical.l1_inclusion_bound)],
    ]);
    const v5 = encodeElectionDefinitionV5({
      ...typicalV5,
      election_id: b32(),
      closes_at: 1n << 40n,
    });
    const stored = await storeDefinition(app, v5);
    const times = [[typicalV5.opens_at, 1n << 40n]];
    expect(await schedule(stored.electionId)).toEqual(times);
    // Storing the same bytes again changes nothing.
    await storeDefinition(app, v5);
    expect(await schedule(stored.electionId)).toEqual(times);
  });
});

describe("fillElectionSchedules", () => {
  test("writes the schedule of each definition stored without one, once", async () => {
    // As a definition stored before migration 0023, or by an interrupted
    // storeDefinition: the definition row alone.
    const ids = [b32(), b32(), b32()];
    for (const [i, id] of ids.entries())
      await app`INSERT INTO election_definitions (election_id, definition) VALUES (
        ${id}, ${encodeElectionDefinition({ ...typical, election_id: id, closes_at: typical.closes_at + BigInt(i) })})`;
    for (const id of ids) expect(await schedule(id)).toEqual([]);
    expect(await fillElectionSchedules(app)).toBe(ids.length);
    for (const [i, id] of ids.entries())
      expect(await schedule(id)).toEqual([[typical.opens_at, typical.closes_at + BigInt(i)]]);
    expect(await fillElectionSchedules(app)).toBe(0);
    // Storing the definition again writes nothing more either.
    await storeDefinition(
      app,
      encodeElectionDefinition({ ...typical, election_id: ids[0]!, closes_at: typical.closes_at }),
    );
    expect(await schedule(ids[0]!)).toHaveLength(1);
  });

  test("storing a definition again writes its missing schedule", async () => {
    const id = b32();
    const bytes = encodeElectionDefinition({ ...typical, election_id: id });
    await app`INSERT INTO election_definitions (election_id, definition) VALUES (${id}, ${bytes})`;
    await storeDefinition(app, bytes);
    expect(await schedule(id)).toEqual([[typical.opens_at, typical.closes_at]]);
  });
});
