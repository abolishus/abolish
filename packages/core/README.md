# @abolishus/core

Domain logic and the Postgres schema. Internal and source-only; AGPL-3.0-only.

Postgres is not authoritative: every result is rebuilt from chain + IPFS, and a wiped database loses none. Protocol bytes and hashes come from `@abolishus/crypto`; nothing here reimplements them.

## Database

- `src/db/roles.sql`: the two roles, created once per cluster by an administrator. `abolish_migrator` owns the schema and runs migrations. `abolish_app` is what services use at runtime. Both are `NOLOGIN` group roles: each deployment logs in as its own user, granted one of them. Services never connect as the owner.
- `src/db/migrations/`: forward-only SQL migrations, named `NNNN_name.sql`, applied in order by `migrate(sql, schema)` as `abolish_migrator`. A ledger (`schema_migrations`) records each file's sha256, and `migrate` refuses to run if an applied file changed or is missing. Merged migrations are never edited; a fix is a new migration.
- `src/db/schema/`: the Drizzle view of the migrated tables, and `TABLE_CLASSES`, which sorts every table into board or operational.

Migrations are written by hand rather than generated: `drizzle-kit` would bring a bundler toolchain (esbuild, tsx) into the dependency tree for SQL that has to be read line by line anyway. A test checks that the Drizzle tables match the migrated ones.

### `board_entries` (T-23)

One append-only, hash-chained board per election ([`docs/spec/board.md`](../../docs/spec/board.md)): `election_id`, `idx`, `segment`, `payload`, plus `entry_hash`, `prev_link` and `link`, which `@abolishus/crypto` computes.

- `abolish_app` holds `SELECT` and `INSERT` only.
- Triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, for every role, the owner included.
- An insert must be the next entry: index 0 chaining from 32 zero bytes, or the index after the last one, with a segment no smaller than the last one's and `prev_link` equal to its `link`.
- Field lengths and ranges follow the board entry's layout, with payloads from 3 bytes (a record header) to `MAX_BOARD_PAYLOAD`.

### No joins (T-10)

Accounts and ballots never join. The tests fail on a table missing from `TABLE_CLASSES`, on any foreign key that starts or ends at a board table, and on a board column with an account-like name.

## Tests

`vp run --filter @abolishus/core test` needs `TEST_DATABASE_URL`, connecting as a user that can create roles and `SET ROLE` to them (the CI service user is a superuser). Each test file migrates its own schema and drops it afterwards. The tests run uncached (`test:db` in `vite.config.ts`).
