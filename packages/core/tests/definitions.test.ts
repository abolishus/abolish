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
  DefinitionError,
  type DefinitionErrorCode,
  electionDefinitions,
  hasDefinition,
  readDefinition,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// Election definitions (migrations/0001_election_definitions.sql and
// src/definitions.ts; T-34): only definitions @abolishus/crypto decodes and
// accepts as well formed are stored, each election has one for good, and
// nobody, the owner included, can change or remove it.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface Vector {
  id: string;
  encoding: string;
  hash?: string;
  error?: string;
  illFormed?: string;
}
const vectors: Vector[] = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
    "utf8",
  ),
).vectors;
const vector = (id: string) => vectors.find((v) => v.id === id)!;
const typical = decodeElectionDefinition(Buffer.from(vector("definition-typical").encoding, "hex"));

/** The typical vector's definition under a fresh election ID. */
const fresh = (electionId = new Uint8Array(randomBytes(32))) =>
  encodeElectionDefinition({ ...typical, election_id: electionId });

let db: TestDb;
let app: Sql;
let owner: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
});
afterAll(() => db?.close());

async function refusedWith(p: Promise<unknown>): Promise<DefinitionErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DefinitionError) return e.code;
    throw e;
  }
  throw new Error("store succeeded");
}

const rows = async () =>
  (await app`SELECT count(*)::int AS n FROM election_definitions`)[0]!["n"] as number;

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
      WHERE table_schema = ${db.schema} AND table_name = 'election_definitions'
      ORDER BY ordinal_position`;
    const config = getTableConfig(electionDefinitions);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const pk = await db.admin`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`"${db.schema}".election_definitions`}::regclass AND i.indisprimary`;
    expect(pk.map((r) => r["attname"])).toEqual(
      config.columns.filter((c) => c.primary).map((c) => c.name),
    );
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'election_definitions'
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
        sql`UPDATE election_definitions SET definition = definition WHERE election_id = ${e}`,
      delete: (sql: Sql, e: Uint8Array) =>
        sql`DELETE FROM election_definitions WHERE election_id = ${e}`,
      truncate: (sql: Sql) => sql`TRUNCATE election_definitions`,
    })) {
      test(`${op} fails as the ${role}`, async () => {
        const { electionId } = await storeDefinition(app, fresh());
        expect(await failsWith(run(client(), electionId))).toBe("42501");
        expect(await readDefinition(app, electionId)).toBeDefined();
      });
    }
  }

  test("rows must carry a definition record and a 32-byte election ID", async () => {
    const id = new Uint8Array(randomBytes(32));
    const insert = (definition: Uint8Array, electionId = id) =>
      app`INSERT INTO election_definitions VALUES (${electionId}, ${definition})`;
    expect(await failsWith(insert(Uint8Array.of(0, 2, 1)))).toBe("23514");
    expect(await failsWith(insert(Uint8Array.of(0, 1)))).toBe("23514");
    expect(await failsWith(insert(fresh(), id.subarray(1)))).toBe("23514");
  });
});

describe("storeDefinition", () => {
  test("stores a definition under its own election ID, with the verifier's hash", async () => {
    const id = new Uint8Array(randomBytes(32));
    const bytes = fresh(id);
    const stored = await storeDefinition(app, bytes);
    expect(stored.electionId).toEqual(id);
    expect(stored.definitionHash).toEqual(electionDefinitionHash(decodeElectionDefinition(bytes)));
    expect(await readDefinition(app, id)).toEqual(bytes);
  });

  test("matches the published vector's hash", async () => {
    const v = vector("definition-typical");
    const bytes = Buffer.from(v.encoding, "hex");
    const id = decodeElectionDefinition(bytes).election_id;
    // The vector's election ID may already be stored by another test run in
    // this schema; a repeat of the same bytes is a no-op either way.
    const stored = await storeDefinition(app, new Uint8Array(bytes));
    expect(Buffer.from(stored.definitionHash).toString("hex")).toBe(v.hash);
    expect(await readDefinition(app, id)).toEqual(new Uint8Array(bytes));
  });

  test("storing the same bytes again is a no-op", async () => {
    const bytes = fresh();
    const a = await storeDefinition(app, bytes);
    const b = await storeDefinition(app, bytes);
    expect(b).toEqual(a);
  });

  test("refuses a second, different definition for the same election", async () => {
    const id = new Uint8Array(randomBytes(32));
    await storeDefinition(app, fresh(id));
    const other = encodeElectionDefinition({ ...typical, election_id: id, opens_at: 1n });
    expect(await refusedWith(storeDefinition(app, other))).toBe("conflict");
    expect(await readDefinition(app, id)).toEqual(fresh(id));
  });

  test("refuses every vector that fails decoding, with nothing stored", async () => {
    const bad = vectors.filter((v) => v.error !== undefined);
    expect(bad.length).toBeGreaterThan(0);
    const before = await rows();
    for (const v of bad) {
      const e = await storeDefinition(app, new Uint8Array(Buffer.from(v.encoding, "hex"))).catch(
        (x: unknown) => x,
      );
      expect(e, v.id).toBeInstanceOf(DefinitionError);
      expect((e as DefinitionError).code, v.id).toBe("decode");
    }
    expect(await rows()).toBe(before);
  });

  test("refuses every vector that decodes but is ill formed, with nothing stored", async () => {
    const bad = vectors.filter((v) => v.illFormed !== undefined);
    expect(bad.length).toBeGreaterThan(0);
    for (const v of bad) {
      // Under a fresh election ID, so no other test's row stands in for it.
      const id = new Uint8Array(randomBytes(32));
      const decoded = decodeElectionDefinition(new Uint8Array(Buffer.from(v.encoding, "hex")));
      const bytes = encodeElectionDefinition({ ...decoded, election_id: id });
      const e = await storeDefinition(app, bytes).catch((x: unknown) => x);
      expect((e as DefinitionError).code, v.id).toBe("ill-formed");
      expect((e as DefinitionError).cause, v.id).toBe(v.illFormed);
      expect(await readDefinition(app, id), v.id).toBeUndefined();
    }
  });

  test("refuses anything but real bytes", async () => {
    for (const x of ["00", [0, 1], null, new Uint16Array(4)])
      await expect(storeDefinition(app, x as unknown as Uint8Array)).rejects.toThrow(TypeError);
  });

  test("a definition with any byte flipped is refused or stored under its own bytes", async () => {
    // Strict decoding means no other bytes can stand for a stored definition:
    // a mutated encoding either fails, or is a different definition stored
    // (and served) exactly as given.
    const base = fresh();
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: base.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        async (at, flip) => {
          const bytes = base.slice();
          bytes[at]! ^= flip;
          let stored;
          try {
            stored = await storeDefinition(app, bytes);
          } catch (e) {
            if (e instanceof DefinitionError) return;
            throw e;
          }
          expect(await readDefinition(app, stored.electionId)).toEqual(bytes);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  });
});

describe("readDefinition and hasDefinition", () => {
  test("an unknown election has none", async () => {
    const id = new Uint8Array(randomBytes(32));
    expect(await readDefinition(app, id)).toBeUndefined();
    expect(await hasDefinition(app, id)).toBe(false);
    await storeDefinition(app, fresh(id));
    expect(await hasDefinition(app, id)).toBe(true);
  });

  test("refuses an election ID that isn't 32 bytes", async () => {
    await expect(readDefinition(app, new Uint8Array(31))).rejects.toThrow(TypeError);
    await expect(hasDefinition(app, new Uint8Array(31))).rejects.toThrow(TypeError);
  });
});
