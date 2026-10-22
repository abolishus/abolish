import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { TABLE_CLASSES } from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// Accounts and ballots never join (.claude/skills/migrations; T-10): every
// table is classified, no foreign key touches a board or identity table or
// leaves the account tables, no board or identity table has a column that
// could name an account or a person (identity tables hold voting-identity
// backups, which must never meet an account: T-20), and no account table has one that could name a ballot, a voting
// identity or a poll.

const ACCOUNT_LIKE = /account|user|voter|person|email|phone|session|passkey|device|ip_?addr|name/;
const BALLOT_LIKE =
  /ballot|vote|nullifier|election|poll|tier|commit|identity|semaphore|receipt|board|entry|segment|share|tally|definition/;

let db: TestDb;
beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db?.close());

test("every table is classified", async () => {
  const tables = await db.admin`
    SELECT table_name FROM information_schema.tables WHERE table_schema = ${db.schema} ORDER BY table_name`;
  const classified = [
    ...TABLE_CLASSES.board,
    ...TABLE_CLASSES.account,
    ...TABLE_CLASSES.identity,
    ...TABLE_CLASSES.operational,
  ].sort();
  expect(tables.map((t) => t["table_name"])).toEqual(classified);
});

test("no foreign key starts or ends at a board or identity table", async () => {
  const fks = await db.admin`
    SELECT conrelid::regclass::text AS src, confrelid::regclass::text AS dst FROM pg_constraint
    WHERE contype = 'f' AND connamespace = ${db.schema}::regnamespace`;
  const ballotSide = new Set<string>([...TABLE_CLASSES.board, ...TABLE_CLASSES.identity]);
  const bare = (t: string) => t.split(".").pop()!.replaceAll('"', "");
  expect(
    fks.filter((f) => ballotSide.has(bare(f["src"])) || ballotSide.has(bare(f["dst"]))),
  ).toEqual([]);
});

test("every foreign key from or to an account table stays among the account tables", async () => {
  const fks = await db.admin`
    SELECT conrelid::regclass::text AS src, confrelid::regclass::text AS dst FROM pg_constraint
    WHERE contype = 'f' AND connamespace = ${db.schema}::regnamespace`;
  const account = new Set<string>(TABLE_CLASSES.account);
  const bare = (t: string) => t.split(".").pop()!.replaceAll('"', "");
  const touching = fks.filter((f) => account.has(bare(f["src"])) || account.has(bare(f["dst"])));
  expect(touching.length).toBeGreaterThan(0);
  expect(
    touching.filter((f) => !account.has(bare(f["src"])) || !account.has(bare(f["dst"]))),
  ).toEqual([]);
});

test("the runtime role can't act as the owner", async () => {
  const [r] = await db.admin`
    SELECT pg_has_role('abolish_app', 'abolish_migrator', 'MEMBER') AS member,
      rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin AS elevated
    FROM pg_roles WHERE rolname = 'abolish_app'`;
  expect(r).toEqual({ member: false, elevated: false });
});

test("no board or identity column looks like an account or a person", async () => {
  const tables = [...TABLE_CLASSES.board, ...TABLE_CLASSES.identity];
  const cols = await db.admin`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = ${db.schema} AND table_name = ANY(${tables})`;
  expect(new Set(cols.map((c) => c["table_name"]))).toEqual(new Set(tables));
  expect(cols.filter((c) => ACCOUNT_LIKE.test(c["column_name"]))).toEqual([]);
});

// The allowances, by table and column: the creator record of ADR 0032,
// rule 15, names the election its author created (P2-22 part 3a), a
// creator's appeal names that record (P2-10 part 3b), a reaction names
// the poll it is on (P2-25 part 5), and a profile's choice names the record
// of a poll it shows (P2-27 part 1b). They say whose poll an election is, who
// reacted to it and whether its author shows it, never who answered it.
const ACCOUNT_ALLOWED = [
  { table_name: "account_appeals", column_name: "poll_id" },
  { table_name: "account_polls", column_name: "election_id" },
  { table_name: "account_profile_polls", column_name: "poll_id" },
  { table_name: "account_reactions", column_name: "election_id" },
];

test("no account column looks like a ballot, a voting identity or a poll", async () => {
  const cols = await db.admin`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = ${db.schema} AND table_name = ANY(${[...TABLE_CLASSES.account]})`;
  expect(new Set(cols.map((c) => c["table_name"]))).toEqual(new Set(TABLE_CLASSES.account));
  const flagged = cols
    .filter((c) => BALLOT_LIKE.test(c["column_name"]))
    .map((c) => ({ table_name: c["table_name"], column_name: c["column_name"] }))
    .sort((a, b) => a.table_name.localeCompare(b.table_name));
  expect(flagged).toEqual(ACCOUNT_ALLOWED);
});

test("no view, function or trigger reads an account table and a board or identity table", async () => {
  // A join can live in a view or a function as well as in a foreign key.
  const views = await db.admin`
    SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = ${db.schema}`;
  expect(views).toEqual([]);
  const fns = await db.admin`
    SELECT p.proname, p.prosrc FROM pg_proc p WHERE p.pronamespace = ${db.schema}::regnamespace`;
  const names = (re: readonly string[]) => new RegExp(`\\b(${re.join("|")})\\b`);
  const both = fns.filter(
    (f) =>
      names(TABLE_CLASSES.account).test(f["prosrc"]) &&
      names([...TABLE_CLASSES.board, ...TABLE_CLASSES.identity]).test(f["prosrc"]),
  );
  expect(both).toEqual([]);
});
