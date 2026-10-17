import {
  decodeElectionDefinition,
  type ElectionDefinition,
  encodeElectionDefinition,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { addModerator, migrate, newAccountId, storeDefinition } from "../src/index.ts";

// Each test file gets its own schema (AGENTS.md, Testing: Database), migrated
// as abolish_migrator, and clients that act as each role through SET ROLE.
// The connecting user must be able to create roles: the CI service user is a
// superuser.

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL is not set");

export interface TestDb {
  readonly schema: string;
  readonly admin: Sql;
  as(role: "abolish_migrator" | "abolish_app"): Promise<Sql>;
  close(): Promise<void>;
}

export async function testDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(8).toString("hex")}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {}, connection: { search_path: schema } });
  await admin.unsafe(readFileSync(new URL("../src/db/roles.sql", import.meta.url), "utf8"));
  await admin.unsafe(`CREATE SCHEMA "${schema}" AUTHORIZATION abolish_migrator`);
  const clients: Sql[] = [];
  const as = async (role: string) => {
    const c = postgres(url!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: schema },
    });
    await c.unsafe(`SET ROLE ${role}`);
    clients.push(c);
    return c;
  };
  await migrate(await as("abolish_migrator"), schema);
  return {
    schema,
    admin,
    as,
    async close() {
      await Promise.all(clients.map((c) => c.end()));
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

const vector = decodeElectionDefinition(
  Buffer.from(
    (
      JSON.parse(
        readFileSync(
          new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
          "utf8",
        ),
      ).vectors as { id: string; encoding: string }[]
    ).find((v) => v.id === "definition-typical")!.encoding,
    "hex",
  ),
);

const repin = (
  d: ElectionDefinition,
  versions: ReadonlyMap<number, number>,
): ElectionDefinition => ({
  ...d,
  profile: {
    ...d.profile,
    pins: d.profile.pins.map((p) => ({ ...p, version: versions.get(p.record_type) ?? p.version })),
  },
});

/**
 * The typical vector's definition under the profile 2.3 asks of definition
 * version 1: board-entry version 5 and contract-event version 7 in place of
 * the vector's 1s, so `storeDefinition` stores it.
 */
export const typical: ElectionDefinition = repin(
  vector,
  new Map([
    [RECORD_TYPES.boardEntry, 5],
    [RECORD_TYPES.contractEvent, 7],
  ]),
);

/**
 * A fresh election with `typical` stored, so it can have a board: entries
 * are encoded under the board-entry version a stored definition pins,
 * `boardVersion` here (typical's own 5 by default). Any other version is a
 * profile 2.3 fails, which `storeDefinition` refuses, so that definition is
 * inserted around it, as only the board store's handling of the version is
 * under test.
 */
export async function newElection(
  sql: Sql,
  boardVersion = 5,
  /** Another L1 anchor than the vector's. */
  l1Anchor: Uint8Array = typical.l1_anchor,
): Promise<Uint8Array> {
  const electionId = new Uint8Array(randomBytes(32));
  const definition = encodeElectionDefinition({
    ...repin(typical, new Map([[RECORD_TYPES.boardEntry, boardVersion]])),
    election_id: electionId,
    l1_anchor: l1Anchor,
  });
  if (boardVersion === 5) await storeDefinition(sql, definition);
  else
    await sql`INSERT INTO election_definitions (election_id, definition)
      VALUES (${electionId}, ${definition})`;
  return electionId;
}

/** A fresh account, as better-auth stores a passkey account. */
export async function newAccount(sql: Sql): Promise<string> {
  const id = newAccountId();
  await sql`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  return id;
}

/**
 * Gives each of `handles` a fresh account, so `moderate` accepts it, and
 * returns each handle's account.
 */
export async function addModerators(
  sql: Sql,
  ...handles: readonly string[]
): Promise<Map<string, string>> {
  const accounts = new Map<string, string>();
  for (const handle of handles) {
    const account = await newAccount(sql);
    await addModerator(sql, handle, account);
    accounts.set(handle, account);
  }
  return accounts;
}
