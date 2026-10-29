import {
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  electionDefinitionHash,
  electionDefinitionV5Hash,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  profileCombinationRule,
  RECORD_TYPES,
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
import { type TestDb, testDb, typical } from "./db.ts";

// Election definitions (migrations/0001_election_definitions.sql and
// src/definitions.ts; T-34): only definitions @abolishus/crypto decodes and
// accepts as well formed, under a profile 2.3 passes, are stored, each
// election has one for good, and nobody, the owner included, can change or
// remove it.

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

const readVectors = (name: string): Vector[] =>
  JSON.parse(readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8"))
    .vectors;
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

// A version-5 definition of three questions under the profile 2.3 asks of
// version 5 (verifier-ballots-v3.json's, from an independent implementation).
const typicalV5 = decodeElectionDefinitionV5(
  unhex(
    (
      JSON.parse(
        readFileSync(
          new URL("../../../docs/spec/vectors/verifier-ballots-v3.json", import.meta.url),
          "utf8",
        ),
      ) as { cases: { id: string; definition: string }[] }
    ).cases.find((c) => c.id === "admitted")!.definition,
  ),
);
const freshV5 = (electionId = new Uint8Array(randomBytes(32))) =>
  encodeElectionDefinitionV5({ ...typicalV5, election_id: electionId });

/** `typical` (the typical vector under a profile 2.3 passes) under a fresh election ID. */
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

  test("refuses the published vectors, whose profiles 2.3 fails, with nothing stored", async () => {
    // No well-formed version-1 vector pins board-entry version 5 and
    // contract-event version 12, so none has close statements and the full
    // event archive on its board (verifier 2.3; T-35, T-50); the maximal
    // one's pins are versions this release doesn't read.
    const good = vectors.filter((v) => v.hash !== undefined && v.illFormed === undefined);
    expect(good.length).toBeGreaterThan(0);
    for (const v of good) {
      const decoded = decodeElectionDefinition(new Uint8Array(Buffer.from(v.encoding, "hex")));
      const id = new Uint8Array(randomBytes(32));
      const e = await storeDefinition(
        app,
        encodeElectionDefinition({ ...decoded, election_id: id }),
      ).catch((x: unknown) => x);
      expect((e as DefinitionError).code, v.id).toBe("profile");
      expect((e as DefinitionError).cause, v.id).toBe(
        v.id === "definition-maximal" ? "unsupported-version" : "profile-combination",
      );
      expect(await readDefinition(app, id), v.id).toBeUndefined();
    }
  });

  test("refuses a profile 2.3 fails or can't read, naming the rule", async () => {
    // Version 1's profile is board-entry 5, contract-event 8, ballot,
    // spoiled-ballot opening, tally-opening and display-text 1 (verifier 2.3).
    const cases: [number, number, string][] = [
      [RECORD_TYPES.boardEntry, 1, "profile-combination"],
      [RECORD_TYPES.boardEntry, 4, "profile-combination"],
      [RECORD_TYPES.boardEntry, 6, "profile-combination"],
      [RECORD_TYPES.boardEntry, 7, "profile-combination"],
      [RECORD_TYPES.boardEntry, 9, "unsupported-version"],
      [RECORD_TYPES.contractEvent, 7, "profile-combination"],
      [RECORD_TYPES.contractEvent, 14, "unsupported-version"],
      [RECORD_TYPES.ballot, 2, "profile-combination"],
      [RECORD_TYPES.spoiledBallotOpening, 2, "profile-combination"],
      [RECORD_TYPES.tallyOpening, 2, "profile-combination"],
      [RECORD_TYPES.displayText, 2, "profile-combination"],
    ];
    const before = await rows();
    for (const [type, version, rule] of cases) {
      const pins = typical.profile.pins.map((p) =>
        p.record_type === type ? { ...p, version } : p,
      );
      const bytes = encodeElectionDefinition({
        ...typical,
        election_id: new Uint8Array(randomBytes(32)),
        profile: { ...typical.profile, pins },
      });
      const e = await storeDefinition(app, bytes).catch((x: unknown) => x);
      expect((e as DefinitionError).code, `${type}@${version}`).toBe("profile");
      expect((e as DefinitionError).cause, `${type}@${version}`).toBe(rule);
    }
    expect(await rows()).toBe(before);
  });

  test("stores a definition exactly when 2.3 passes its profile", async () => {
    // The definition's own pin is fixed by decoding, so it never reaches 2.3.
    const types = typical.profile.pins
      .map((p) => p.record_type)
      .filter((t) => t !== RECORD_TYPES.electionDefinition);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...types),
        fc.integer({ min: 1, max: 0xff }),
        async (type, version) => {
          const pins = typical.profile.pins.map((p) =>
            p.record_type === type ? { ...p, version } : p,
          );
          const decoded = {
            ...typical,
            election_id: new Uint8Array(randomBytes(32)),
            profile: { ...typical.profile, pins },
          };
          const rule = profileCombinationRule(decoded);
          const stored = await storeDefinition(app, encodeElectionDefinition(decoded)).then(
            () => undefined,
            (e: unknown) => e,
          );
          if (rule === undefined) expect(stored).toBeUndefined();
          else {
            expect((stored as DefinitionError).code).toBe("profile");
            expect((stored as DefinitionError).cause).toBe(rule);
          }
          expect(await hasDefinition(app, decoded.election_id)).toBe(rule === undefined);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
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

describe("storeDefinition under definition version 5 (several questions, P2-14)", () => {
  test("stores one under its own election ID, with version 5's hash", async () => {
    expect(typicalV5.questions.length).toBeGreaterThan(1);
    const id = new Uint8Array(randomBytes(32));
    const bytes = freshV5(id);
    const stored = await storeDefinition(app, bytes);
    expect(stored.electionId).toEqual(id);
    expect(stored.definitionHash).toEqual(
      electionDefinitionV5Hash(decodeElectionDefinitionV5(bytes)),
    );
    expect(await readDefinition(app, id)).toEqual(bytes);
    expect((await storeDefinition(app, bytes)).definitionHash).toEqual(stored.definitionHash);
    const other = encodeElectionDefinitionV5({ ...typicalV5, election_id: id, opens_at: 1n });
    expect(await refusedWith(storeDefinition(app, other))).toBe("conflict");
  });

  test("refuses every version-5 vector that fails decoding, with nothing stored", async () => {
    const bad = readVectors("election-definition-v5.json").filter((v) => v.error !== undefined);
    expect(bad.length).toBeGreaterThan(0);
    const before = await rows();
    for (const v of bad) {
      const e = await storeDefinition(app, unhex(v.encoding)).catch((x: unknown) => x);
      expect((e as DefinitionError).code, v.id).toBe("decode");
      expect(((e as DefinitionError).cause as { code: string }).code, v.id).toBe(v.error);
    }
    expect(await rows()).toBe(before);
  });

  test("refuses every version-5 vector that is ill formed, naming the rule", async () => {
    const bad = readVectors("election-definition-v5.json").filter((v) => v.illFormed !== undefined);
    expect(bad.length).toBeGreaterThan(0);
    for (const v of bad) {
      const id = new Uint8Array(randomBytes(32));
      const decoded = decodeElectionDefinitionV5(unhex(v.encoding));
      const bytes = encodeElectionDefinitionV5({ ...decoded, election_id: id });
      const e = await storeDefinition(app, bytes).catch((x: unknown) => x);
      expect((e as DefinitionError).code, v.id).toBe("ill-formed");
      expect((e as DefinitionError).cause, v.id).toBe(v.illFormed);
      expect(await readDefinition(app, id), v.id).toBeUndefined();
    }
  });

  test("stores one exactly when 2.3 passes its profile", async () => {
    const types = typicalV5.profile.pins
      .map((p) => p.record_type)
      .filter((t) => t !== RECORD_TYPES.electionDefinition);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...types),
        fc.integer({ min: 1, max: 0xff }),
        async (type, version) => {
          const pins = typicalV5.profile.pins.map((p) =>
            p.record_type === type ? { ...p, version } : p,
          );
          const decoded = {
            ...typicalV5,
            election_id: new Uint8Array(randomBytes(32)),
            profile: { ...typicalV5.profile, pins },
          };
          const rule = profileCombinationRule(decoded);
          const stored = await storeDefinition(app, encodeElectionDefinitionV5(decoded)).then(
            () => undefined,
            (e: unknown) => e,
          );
          if (rule === undefined) expect(stored).toBeUndefined();
          else {
            expect((stored as DefinitionError).code).toBe("profile");
            expect((stored as DefinitionError).cause).toBe(rule);
          }
          expect(await hasDefinition(app, decoded.election_id)).toBe(rule === undefined);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  });

  test("refuses versions 3, 4 and 6 as unknown, which no client shows yet", async () => {
    const before = await rows();
    for (const name of [
      "election-definition-v3.json",
      "election-definition-v4.json",
      "election-definition-v6.json",
    ]) {
      const good = readVectors(name).filter((v) => v.hash !== undefined);
      expect(good.length, name).toBeGreaterThan(0);
      for (const v of good) {
        const e = await storeDefinition(app, unhex(v.encoding)).catch((x: unknown) => x);
        expect((e as DefinitionError).code, v.id).toBe("decode");
        expect((e as DefinitionError).cause, v.id).toMatchObject({
          code: "unknown-version",
          offset: 2,
        });
      }
    }
    expect(await rows()).toBe(before);
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
