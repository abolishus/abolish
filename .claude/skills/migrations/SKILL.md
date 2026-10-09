---
name: migrations
description: Rules for Postgres schema changes with Drizzle — append-only bulletin-board tables, grants and triggers, account/ballot separation, and the wipe-and-rebuild invariant. Load before changing any database schema or query that writes.
---

# migrations

## Principles

- **Postgres is not authoritative.** Everything that affects a result must be reproducible from chain + IPFS. Wiping Postgres loses no results; the reference election proves this on every PR. A table that can't be rebuilt from public data must hold only operational data (accounts, drafts, moderation, caches).
- **Bulletin-board tables are append-only and hash-chained.** Each row stores `prev_hash` and `entry_hash = H(tag, prev_hash, canonical_entry_bytes)` per `docs/spec/`. Enforcement is in both places:
  - grants: the app role has `SELECT, INSERT` only, with no `UPDATE`, `DELETE` or `TRUNCATE`;
  - triggers: `BEFORE UPDATE OR DELETE OR TRUNCATE` raises an exception, even for the table owner.
    Tests connect as the app role and assert that UPDATE, DELETE and TRUNCATE all fail, and that a trigger-bypass attempt as owner fails too.
- **Accounts and ballots never join.** No table, column, foreign key, log or metric may link an account (better-auth) to a ballot, nullifier, voting identity or poll participation. A test introspects the schema (`information_schema`, `pg_constraint`) and fails on any path from account tables to ballot tables, and on any column name from a deny-list (`voter_id`, `account_id`) in board tables.
- No PII beyond what a tier strictly needs. Document data is never stored.

## Mechanics

- Drizzle schema in `packages/core/src/db/schema/` (or the owning app). Generate migrations with `vp exec drizzle-kit generate`, then **read and hand-review the SQL**. Raw SQL (grants, triggers, roles) goes in the same migration file.
- Migrations are forward-only and immutable once merged. Fix mistakes with a new migration.
- Every migration must be safe on a populated database. Add a column nullable or with a default, then backfill, then constrain. No long locks on hot tables.
- Roles: `abolish_migrator` (owner, DDL) and `abolish_app` (runtime, least privilege). The app never connects as owner.
- Rebuild path: when a migration changes board or chain-index tables, update the rebuild-from-chain+IPFS job and its test in the same PR.

## Tests

- Run every migration from empty against `TEST_DATABASE_URL`, then run the schema assertions above.
- Append-only, no-join and grant tests live with the schema and run in `ci`.
- Rebuild test: populate, wipe, rebuild from chain + IPFS fixtures, and compare results byte for byte.
