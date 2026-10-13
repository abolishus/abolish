import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { boardEntries } from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The board table's guarantees (migrations/0000_board.sql; T-23): the app role
// can only read and append, nobody (the owner included) can change or remove a
// row, and appends must be contiguous, in segment order and chained by link.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const ZERO = new Uint8Array(32);
const b32 = () => new Uint8Array(randomBytes(32));

interface Row {
  electionId: Uint8Array;
  idx: bigint;
  segment: bigint;
  payload: Uint8Array;
  entryHash: Uint8Array;
  prevLink: Uint8Array;
  link: Uint8Array;
}

/** A well-formed run of `n` entries. Hashes are random: the table never hashes. */
function chain(n: number, electionId = b32()): Row[] {
  const rows: Row[] = [];
  let prevLink = ZERO;
  for (let i = 0; i < n; i++) {
    const link = b32();
    rows.push({
      electionId,
      idx: BigInt(i),
      segment: BigInt(Math.floor(i / 2)),
      payload: Uint8Array.of(0, 2, 1, i & 0xff), // a ballot record header, then a byte
      entryHash: b32(),
      prevLink,
      link,
    });
    prevLink = link;
  }
  return rows;
}

let db: TestDb;
let app: Sql;
let owner: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
});
afterAll(() => db?.close());

/** The Postgres error code a query fails with (Drizzle wraps it in `cause`). */
async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? "no code";
  }
  throw new Error("query succeeded");
}

const insert = (sql: Sql, rows: Row[]) =>
  drizzle({ client: sql }).insert(boardEntries).values(rows);
const count = async (sql: Sql, electionId: Uint8Array) =>
  (await sql`SELECT count(*)::int AS n FROM board_entries WHERE election_id = ${electionId}`)[0]![
    "n"
  ];

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'board_entries' ORDER BY ordinal_position`;
    const config = getTableConfig(boardEntries);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const pk = await db.admin`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`"${db.schema}".board_entries`}::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`;
    expect(pk.map((r) => r["attname"])).toEqual(config.primaryKeys[0]!.columns.map((c) => c.name));
  });

  test("the app role holds SELECT and INSERT on the board and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'board_entries' AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });
});

describe("append-only", () => {
  test("the app role appends and reads a chain", async () => {
    const rows = chain(5);
    await insert(app, rows);
    const back = await drizzle({ client: app }).select().from(boardEntries);
    expect(back.filter((r) => Buffer.from(r.electionId).equals(rows[0]!.electionId))).toHaveLength(
      5,
    );
  });

  const changes = {
    update: (sql: Sql, e: Uint8Array) =>
      sql`UPDATE board_entries SET segment = segment WHERE election_id = ${e}`,
    delete: (sql: Sql, e: Uint8Array) => sql`DELETE FROM board_entries WHERE election_id = ${e}`,
    truncate: (sql: Sql) => sql`TRUNCATE board_entries`,
  };

  for (const [role, client] of [
    ["app", () => app],
    ["owner", () => owner],
  ] as const) {
    for (const [op, run] of Object.entries(changes)) {
      test(`${op} fails as the ${role}`, async () => {
        const rows = chain(2);
        await insert(app, rows);
        expect(await failsWith(run(client(), rows[0]!.electionId))).toBe("42501");
        expect(await count(db.admin, rows[0]!.electionId)).toBe(2);
      });
    }
  }

  test("the owner can't switch triggers off for its session", async () => {
    // session_replication_role = replica skips ordinary triggers; only a
    // superuser may set it.
    expect(await failsWith(owner`SET session_replication_role = replica`)).toBe("42501");
  });

  test("the app role can't disable the triggers or drop the table", async () => {
    expect(await failsWith(app`ALTER TABLE board_entries DISABLE TRIGGER USER`)).toBe("42501");
    expect(await failsWith(app`DROP TABLE board_entries`)).toBe("42501");
  });
});

describe("append order", () => {
  // 23514: check_violation (a CHECK or the append trigger); 23505: unique_violation.
  const bad: [string, string, (rows: Row[]) => Row[]][] = [
    ["entry 0 not chained from zero", "23514", (r) => [{ ...r[0]!, prevLink: b32() }]],
    ["a gap in the index", "23514", (r) => [r[0]!, r[2]!]],
    ["a repeated index", "23505", (r) => [r[0]!, { ...r[1]!, idx: 0n, prevLink: ZERO }]],
    [
      "a decreasing segment",
      "23514",
      (r) => [
        { ...r[0]!, segment: 5n },
        { ...r[1]!, segment: 4n },
      ],
    ],
    ["a broken link", "23514", (r) => [r[0]!, { ...r[1]!, prevLink: b32() }]],
    ["a short election_id", "23514", (r) => [{ ...r[0]!, electionId: new Uint8Array(31) }]],
    ["a segment above u32", "23514", (r) => [{ ...r[0]!, segment: 1n << 32n }]],
    ["a negative index", "23514", (r) => [{ ...r[0]!, idx: -1n }]],
    [
      "a payload shorter than a record header",
      "23514",
      (r) => [{ ...r[0]!, payload: new Uint8Array(2) }],
    ],
    [
      "a payload over MAX_BOARD_PAYLOAD",
      "23514",
      (r) => [{ ...r[0]!, payload: new Uint8Array(1048577) }],
    ],
    ["a short link", "23514", (r) => [{ ...r[0]!, link: new Uint8Array(31) }]],
    [
      "an election definition as payload",
      "23514",
      (r) => [{ ...r[0]!, payload: Uint8Array.of(0, 1, 1) }],
    ],
    [
      "a display-text record as payload",
      "23514",
      (r) => [{ ...r[0]!, payload: Uint8Array.of(0, 9, 1) }],
    ],
  ];
  test.each(bad)("rejects %s", async (_, code, mutate) => {
    const rows = mutate(chain(3));
    expect(await failsWith(insert(app, rows))).toBe(code);
    expect(await count(db.admin, rows[0]!.electionId)).toBe(0);
  });

  test("a temporary table can't stand in for the previous entry", async () => {
    // pg_temp comes first in an unpinned search_path, so this would fake
    // entry 99 if the trigger resolved board_entries through the caller's path.
    const [e, prevLink] = [b32(), b32()];
    await app`CREATE TEMP TABLE board_entries (LIKE ${app(db.schema)}.board_entries)`;
    await app`INSERT INTO pg_temp.board_entries VALUES (${e}, 99, 0, ${Uint8Array.of(0, 2, 1)}, ${ZERO}, ${ZERO}, ${prevLink})`;
    const row = {
      electionId: e,
      idx: 100n,
      segment: 0n,
      payload: Uint8Array.of(0, 2, 1),
      entryHash: b32(),
      prevLink,
      link: b32(),
    };
    expect(
      await failsWith(
        app`INSERT INTO ${app(db.schema)}.board_entries VALUES (${row.electionId}, ${row.idx.toString()}, 0, ${row.payload}, ${row.entryHash}, ${row.prevLink}, ${row.link})`,
      ),
    ).toBe("23514");
    await app`DROP TABLE pg_temp.board_entries`;
    expect(await count(db.admin, e)).toBe(0);
  });

  test("only a well-formed next entry is ever accepted", async () => {
    // Appends one candidate at a time: the next well-formed entry or a mutation
    // of it. The table must accept exactly the well-formed ones.
    const mutations: ((r: Row, prev: Row | undefined) => Row)[] = [
      (r) => ({ ...r, idx: r.idx + 1n }),
      (r) => ({ ...r, prevLink: b32() }),
      (r, p) =>
        p && p.segment > 0n ? { ...r, segment: p.segment - 1n } : { ...r, idx: r.idx + 2n },
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.option(fc.nat({ max: mutations.length - 1 }), { nil: undefined }), {
          minLength: 1,
          maxLength: 8,
        }),
        async (steps) => {
          const rows = chain(steps.length);
          let accepted = 0;
          for (const m of steps) {
            const next = { ...rows[accepted]!, segment: BigInt(accepted) };
            if (accepted > 0) next.prevLink = rows[accepted - 1]!.link;
            if (m === undefined) {
              await insert(app, [next]);
              rows[accepted] = next;
              accepted++;
            } else {
              const prev = accepted > 0 ? rows[accepted - 1] : undefined;
              expect(await failsWith(insert(app, [mutations[m]!(next, prev)]))).toMatch(
                /^235(14|05)$/,
              );
            }
          }
          expect(await count(db.admin, rows[0]!.electionId)).toBe(accepted);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
    // Two hundred runs of database writes can outlast the default timeout on a
    // CI runner shared with the other test files.
  }, 120_000);
});
