# @abolishus/core

Domain logic and the Postgres schema. Internal and source-only; AGPL-3.0-only.

Postgres is not authoritative: every result is rebuilt from chain + IPFS, and a wiped database loses none. Protocol bytes and hashes come from `@abolishus/crypto`; nothing here reimplements them.

## Database

- `src/db/roles.sql`: the two roles, created once per cluster by an administrator. `abolish_migrator` owns the schema and runs migrations. `abolish_app` is what services use at runtime. Both are `NOLOGIN` group roles: each deployment logs in as its own user, granted one of them. Services never connect as the owner.
- `src/db/migrations/`: forward-only SQL migrations, named `NNNN_name.sql`, applied in order by `migrate(sql, schema)` as `abolish_migrator`. A ledger (`schema_migrations`) records each file's sha256, and `migrate` refuses to run if an applied file changed or is missing. Merged migrations are never edited; a fix is a new migration.
- `src/db/schema/`: the Drizzle view of the migrated tables, and `TABLE_CLASSES`, which sorts every table into board or operational (`moderation_actions` is operational).

Migrations are written by hand rather than generated: `drizzle-kit` would bring a bundler toolchain (esbuild, tsx) into the dependency tree for SQL that has to be read line by line anyway. A test checks that the Drizzle tables match the migrated ones.

### `board_entries` (T-23)

One append-only, hash-chained board per election ([`docs/spec/board.md`](../../docs/spec/board.md)): `election_id`, `idx`, `segment`, `payload`, plus `entry_hash`, `prev_link` and `link`, which `@abolishus/crypto` computes.

- `abolish_app` holds `SELECT` and `INSERT` only.
- Triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, for every role, the owner included.
- An insert must be the next entry: index 0 chaining from 32 zero bytes, or the index after the last one, with a segment no smaller than the last one's and `prev_link` equal to its `link`.
- Field lengths and ranges follow the board entry's layout, with payloads from 3 bytes (a record header) to `MAX_BOARD_PAYLOAD` whose record type is one the board allows.
- Both trigger functions run with a fixed `search_path` ending in `pg_temp`, so no caller can shadow the table with a temporary one.

### Appending (`src/board.ts`)

`appendEntry(sql, electionId, segment, payload)` appends the next entry of an election's board and returns its index, entry hash and link:

- The entry is encoded, hashed and chained by `@abolishus/crypto` (`encodeBoardEntry`, `boardEntryHash`, `chainLink`), the same code the verifier runs.
- Appends to one board are serialised by a transaction-scoped advisory lock on the election, so concurrent callers get consecutive indexes.
- It refuses, with a typed `AppendError`, an entry that doesn't encode (a payload type the board doesn't allow, a bad election ID or segment), a segment below the previous entry's, and an entry that breaks the order of spoiled-ballot openings (within a segment they come last, in increasing byte order; T-42, T-47).
- It checks only the envelope. Whether a payload may be boarded (it must decode strictly under the election's profile) is the caller's to decide, at admission (P2-3).

`readBoard(sql, electionId)` returns the board as encoded entries in index order, the input to `checkBoard` and the verifier, which recompute every hash rather than trusting the stored columns.

### `election_definitions` (T-34)

One definition per election, as the API serves it: `election_id` and `definition` (the encoded record). Write-once like the L2 registry it mirrors: `abolish_app` holds `SELECT` and `INSERT` only, and triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, for every role. Rebuilt from the registry's `DefinitionRegistered` events (P3-5).

`storeDefinition(sql, bytes)` decodes the definition strictly and checks the well-formedness rules with `@abolishus/crypto`, then stores it under the `election_id` it carries. Storing the same bytes again is a no-op; different bytes for a stored election are refused (`conflict`). It checks bytes, not registration: the caller reads definitions from the registry. `readDefinition(sql, electionId)` returns the stored bytes and `hasDefinition` says whether there are any, without reading them. A stored row is permanent, so callers store only definitions registered in a finalized L2 block.

### Reading the board (`src/board.ts`)

What the API serves, computed with `@abolishus/crypto`'s tree (`BOARD_TREE`), so a client checks it with the verifier's own functions:

- `readHead`: size, chain head and root (`undefined` head and root while the board is empty).
- `readEntries(sql, id, start, limit, maxBytes)`: up to `limit` encoded entries, at most `maxBytes` unless the page holds one entry. Lengths are read first, so payloads past the budget are never loaded (T-52).
- `readInclusionProof` and `readConsistencyProof`: RFC 9162 paths. `BoardReadError` is `invalid-range` for positions no tree has, and `beyond-board` for a tree larger than the board, checked before any position reaches a query.

These read the stored `entry_hash` column rather than rehashing every payload; a client that checks what it is served catches a column that disagrees with the bytes.

### `moderation_actions` (T-68)

The moderation log ([`docs/moderation-policy.md`](../../docs/moderation-policy.md)): one row per decision about a poll, `seq`, `election_id`, `action` (`delist`, `hide`, `restore`), `reason` (a code from the policy, of the action's kind), `moderator` (an opaque handle, not an account) and `decided_at`. Operational: no result reads it, and a wipe loses it without changing any result. Append-only like the board (`abolish_app` holds `SELECT` and `INSERT` only; triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, for every role), so a decision is reversed by a later one, never erased. No column holds free text (T-17).

`src/moderation.ts`:

- `moderate(sql, electionId, decision)` records a decision and returns its sequence number and the poll's new state (`visible`, `delisted`, `hidden`). Decisions are serialised by one advisory lock, so sequence numbers commit in order and each decision is judged against the state it changes. `ModerationError` refuses a malformed decision (`invalid`), an election with no stored definition (`unknown-election`), hiding a poll before its close plus inclusion bound for a reason outside `OPEN_POLL_HIDE_REASONS` (`open-poll`), an action that changes nothing (`no-change`) and a decision dated before the log's newest (`out-of-order`).
- `moderationStatus(sql, electionId)`: the poll's state and newest decision.
- `readModerationLog(sql, after, limit)`: the public log, by sequence number, without the moderator.

It never reads or writes the board, and only reads a definition, to find the poll and its close (a test checks this).

### No joins (T-10)

Accounts and ballots never join. The tests fail on a table missing from `TABLE_CLASSES`, on any foreign key that starts or ends at a board table, and on a board column with an account-like name.

## Tests

`vp run --filter @abolishus/core test` needs `TEST_DATABASE_URL`, connecting as a user that can create roles and `SET ROLE` to them (the CI service user is a superuser). Each test file migrates its own schema and drops it afterwards. `@abolishus/core/test-db` exports that helper for other packages' database tests. The tests run uncached (`test:db` in `vite.config.ts`).
