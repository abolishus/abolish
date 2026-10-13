# @abolishus/core

Domain logic and the Postgres schema. Internal and source-only; AGPL-3.0-only.

Postgres is not authoritative: every result is rebuilt from chain + IPFS, and a wiped database loses none. Protocol bytes and hashes come from `@abolishus/crypto`; nothing here reimplements them.

## Database

- `src/db/roles.sql`: the two roles, created once per cluster by an administrator. `abolish_migrator` owns the schema and runs migrations. `abolish_app` is what services use at runtime. Both are `NOLOGIN` group roles: each deployment logs in as its own user, granted one of them. Services never connect as the owner.
- `src/db/migrations/`: forward-only SQL migrations, named `NNNN_name.sql`, applied in order by `migrate(sql, schema)` as `abolish_migrator`. A ledger (`schema_migrations`) records each file's sha256, and `migrate` refuses to run if an applied file changed or is missing. Merged migrations are never edited; a fix is a new migration.
- `src/db/schema/`: the Drizzle view of the migrated tables, and `TABLE_CLASSES`, which sorts every table into board, account or operational (`identity_backups`, `moderation_actions` and `moderation_reports` are operational).

Migrations are written by hand rather than generated: `drizzle-kit` would bring a bundler toolchain (esbuild, tsx) into the dependency tree for SQL that has to be read line by line anyway. A test checks that the Drizzle tables match the migrated ones.

### `board_entries` (T-23)

One append-only, hash-chained board per election ([`docs/spec/board.md`](../../docs/spec/board.md)): `election_id`, `idx`, `segment`, `payload`, plus `entry_hash`, `prev_link` and `link`, which `@abolishus/crypto` computes.

- `abolish_app` holds `SELECT` and `INSERT` only.
- Triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, for every role, the owner included.
- An insert must be the next entry: index 0 chaining from 32 zero bytes, or the index after the last one, with a segment no smaller than the last one's and `prev_link` equal to its `link`.
- Field lengths and ranges follow the board entry's layout, with payloads from 3 bytes (a record header) to `MAX_BOARD_PAYLOAD` whose record type is one the board allows.
- Both trigger functions run with a fixed `search_path` ending in `pg_temp`, so no caller can shadow the table with a temporary one.

### `board_subtrees` (T-52)

The board tree's perfect subtrees: for each election, `level`, `idx` and `hash`, the root of the `2^level` entries from `idx · 2^level`, computed by `@abolishus/crypto` (`appendSubtrees`). Heads and proofs fold O(log n) of them instead of rehashing every entry hash.

- Append-only like the board: `abolish_app` holds `SELECT` and `INSERT` only; triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, for every role.
- An insert must have its entries already: a leaf's entry is on the board, and a parent's two children are stored. The trigger runs with a fixed `search_path`, like the board's.
- The database can't hash, so `auditBoard` recomputes every subtree from the recomputed entry hashes (`subtree-missing`, `subtree-mismatch`).
- The migration refuses to run over a board that already has entries (none can: nothing boards before it); such a board is wiped and rebuilt from chain + IPFS.

### Appending (`src/board.ts`)

`appendEntry(sql, electionId, segment, payload)` appends the next entry of an election's board and returns its index, entry hash and link:

- The entry is encoded, hashed and chained by `@abolishus/crypto` (`encodeBoardEntry`, `boardEntryHash`, `chainLink`), the same code the verifier runs, under the board-entry version the election's stored definition pins. The version byte is in every hash, so an entry under another version matches nothing the verifier recomputes (2.3, `profile-mismatch`). A board starts only once its definition is stored (`no-definition`), and only under a version `@abolishus/crypto` encodes (`unsupported-version` otherwise, including a stored definition it can't decode; T-36). `readBoard`, `readEntries` and `auditBoard` read under the same version.
- In the same transaction it stores the subtrees the entry completes, from the stored ones covering the board before it. A board missing one (rows written around `appendEntry`) can't be appended to.
- Appends to one board are serialised by a transaction-scoped advisory lock on the election, so concurrent callers get consecutive indexes.
- It refuses, with a typed `AppendError`, an entry that doesn't encode (a payload type the board doesn't allow, a bad election ID or segment), a segment below the previous entry's, and an entry that breaks the order of spoiled-ballot openings (within a segment they come last, in increasing byte order; T-42, T-47).
- It checks only the envelope. Whether a payload may be boarded (it must decode strictly under the election's profile) is the caller's to decide, at admission (P2-3).
- `BallotAdmissions` is that caller for ballots. `submit(sql, electionId, ballot, now)` boards a ballot only once `@abolishus/verifier`'s `electionAdmission` admits it (the definition checks, the transcript check against the panel the release pins, then 5.1 to 5.4), only between the definition's `opens_at` and `closes_at` at `now`, and in the anchoring period of `now`. The transcript must be the board's first entry: only that entry is read, never the board. Each election's admission is kept in memory once decided (definitions and the first entry are write-once), admissions and refusals in separate least-recently-used caches; a missing transcript is decided again on the next ballot. The segment is raised to the board's last one if a later-labelled ballot was boarded while this one's proofs ran (`appendEntry`'s `raiseToPrevious` option). Refusals are a typed `SubmitError` (`unknown-election`, `not-open`, `rejected` with the verifier's code), with nothing written.

`readBoard(sql, electionId)` returns the board as encoded entries in index order, the input to `checkBoard` and the verifier, which recompute every hash rather than trusting the stored columns.

### `election_definitions` (T-34)

One definition per election, as the API serves it: `election_id` and `definition` (the encoded record). Write-once like the L2 registry it mirrors: `abolish_app` holds `SELECT` and `INSERT` only, and triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, for every role. Rebuilt from the registry's `DefinitionRegistered` events (P3-5).

`storeDefinition(sql, bytes)` decodes the definition strictly and checks the well-formedness rules with `@abolishus/crypto`, then stores it under the `election_id` it carries. Storing the same bytes again is a no-op; different bytes for a stored election are refused (`conflict`). It checks bytes, not registration: the caller reads definitions from the registry. `readDefinition(sql, electionId)` returns the stored bytes and `hasDefinition` says whether there are any, without reading them. A stored row is permanent, so callers store only definitions registered in a finalized L2 block.

### `election_registrations` (`src/registrations.ts`; T-49, T-53)

Every `DefinitionRegistered` event on L2: `election_id`, the `definition_hash` it carries (unique, so its index serves prefix lookups) and its position, `l2_block` then `log_index`. Public chain data, rebuilt from the registry's events (P3-5). An event is recorded whether or not its definition is stored: `election_definitions` holds only definitions `@abolishus/crypto` accepts, and the registry doesn't check every well-formedness rule, so codes computed from stored definitions alone could differ from a mirror's. Write-once like `election_definitions`, and a trigger refuses a row whose position isn't after every recorded one (under READ COMMITTED only, where the check after its lock sees every committed row), so rows arrive in chain order and a code that resolves never moves to a poll recorded late.

`recordRegistration(sql, { electionId, definitionHash, l2Block, logIndex })` records one event; the same event again is a no-op. It refuses (`RegistrationError`) a hash that isn't the stored definition's when one is stored (`hash-mismatch`), anything else for a recorded election, or a recorded position or hash for another one (`conflict`), and a position before the latest (`out-of-order`). `lookupShortCode(sql, input)` parses the input as `parseShortCode` does and answers `assignShortCodes`' owner without reading every hash: the earliest registration whose hash starts with the code (one index range, `shortCodeRange`, read before ordering so an unknown code never scans the table), which owns the code if it is 7 characters or an earlier registration shares the prefix one character shorter. Anything else is `undefined`. Moderation doesn't change the answer.

### Reading the board (`src/board.ts`)

What the API serves, computed with `@abolishus/crypto`'s tree (`BOARD_TREE`), so a client checks it with the verifier's own functions:

- `readHead`: size, chain head and root (`undefined` head and root while the board is empty).
- `readEntries(sql, id, start, limit, maxBytes)`: up to `limit` encoded entries, at most `maxBytes` unless the page holds one entry. Lengths are read first, so payloads past the budget are never loaded (T-52).
- `readInclusionProof` and `readConsistencyProof`: RFC 9162 paths. `BoardReadError` is `invalid-range` for positions no tree has, and `beyond-board` for a tree larger than the board, checked before any position reaches a query.

The size and head come from the last entry, through the primary key's index; roots and proofs fold the stored subtrees that `@abolishus/crypto`'s `rootSubtrees`, `inclusionProofSubtrees` and `consistencyProofSubtrees` name. So each reads O(log n) rows. Nothing rehashes payloads; a client that checks what it is served catches a stored hash that disagrees with the bytes, and so does `auditBoard`.

### `moderation_actions` (T-68)

The moderation log ([`docs/moderation-policy.md`](../../docs/moderation-policy.md)): one row per decision about a poll, `seq`, `election_id`, `action` (`delist`, `hide`, `restore`), `reason` (a code from the policy, of the action's kind), `moderator` (an opaque handle, not an account) and `decided_at`. Operational: no result reads it, and a wipe loses it without changing any result. Append-only like the board (`abolish_app` holds `SELECT` and `INSERT` only; triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, for every role), so a decision is reversed by a later one, never erased. No column holds free text (T-17).

`src/moderation.ts`:

- `moderate(sql, electionId, decision)` records a decision and returns its sequence number and the poll's new state (`visible`, `delisted`, `hidden`). Decisions are serialised by one advisory lock, so sequence numbers commit in order and each decision is judged against the state it changes, and each is dated by the database clock, never the caller. `ModerationError` refuses a malformed decision (`invalid`), an election with no stored definition (`unknown-election`), hiding a poll before its close plus inclusion bound for a reason outside `OPEN_POLL_HIDE_REASONS` (`open-poll`), and an action that neither changes the state nor cites a reason not yet cited since the state began (`no-change`). Only `moderate` enforces these: the app role can still insert directly, so they bind the tooling, not an insider.
- `moderationStatus(sql, electionId)`: the poll's state and newest decision.
- `readModerationLog(sql, after, limit)`: the public log, by sequence number, without the moderator.

It never reads or writes the board, and only reads a definition, to find the poll and its close (a test checks this).

### `moderation_reports` (T-68, T-52)

Reports of polls to the moderators: one row per election and removal ground, `election_id`, `reason`, `total`, `pending` (not yet reviewed) and `pending_since` (the hour the oldest unreviewed report arrived, null when none is pending; it orders the queue, and reporting again never moves a poll back). Nothing about the reporter, and no text (T-10, T-11, T-17). Counting bounds the table however many anonymous reports arrive (T-52). `abolish_app` holds `SELECT`, `INSERT` and `UPDATE`, never `DELETE` or `TRUNCATE`. Operational: a wipe loses the queue and changes no result.

`src/reports.ts`:

- `report(sql, electionId, reason)` counts one report; `ModerationError` refuses a reason outside `REMOVAL_REASONS` (`invalid`) and an election with no stored definition (`unknown-election`).
- `readReportQueue(sql, limit, after?)`: the pairs with unreviewed reports, longest waiting first, paged by the last row of the previous page. For the moderators only; the API never serves it.
- `reviewReports(sql, electionId, reason, seenTotal)` marks reviewed the first `seenTotal` reports (the `total` the queue showed), so reports counted since stay pending. It records no decision.

Reports never change a poll's state or the public log (a test checks this): report volume is never a ground.

### `identity_backups` (T-20, T-10, T-11, T-52, T-66)

Voting-identity recovery backups (ADR 0017, option A, step 5; `docs/spec/identity-backup.md`): `id` (`H(DS(id-tag, locator))`, 32 bytes), `envelope` (a version-1 envelope, 63 bytes, header checked by the table) and `written_month` (the UTC month of the last write, by the database clock). The locator is never stored, so a copy of the table can't read, replace or delete a row. No account column, address or request time; reads change nothing. `abolish_app` holds `SELECT`, `INSERT`, `UPDATE` and `DELETE`, never `TRUNCATE`. Operational: a wipe loses every backup and changes no result (T-66).

`src/identity-backups.ts`:

- `putIdentityBackup(sql, locator, envelope)` stores or replaces the envelope after decoding it strictly; `IdentityBackupStoreError` carries the decoder's code.
- `readIdentityBackup(sql, locator)` and `deleteIdentityBackup(sql, locator)`.
- `pruneIdentityBackups(sql, now)` deletes backups last written more than `IDENTITY_BACKUP_RETENTION_MONTHS` (24) whole months before `now`'s month. The ballot client rewrites its envelope to keep it (P2-8).

### Accounts (`src/accounts.ts`; T-10, T-11, T-20)

Who someone is to the app (poll creation, moderation, notifications), with better-auth and passkeys. Never a voting identity: that and its recovery passkey live in the ballot client, on its own RP ID ([ADR 0017](../../docs/adr/0017-identity-recovery-backup.md)).

`createAccounts({ sql, secret, origin, rpID, turnstile, log })` returns:

- `handler(request)`: a `Request` → `Response` handler that `apps/web` serves on its own origin under `/auth/`. Only `ACCOUNT_ROUTES` reach better-auth (sessions, sign-out, account deletion, the passkey ceremonies, and listing and deleting passkeys); every other path, including better-auth's password, e-mail, social and profile routes, is 404. POST bodies over `MAX_ACCOUNT_BODY` (64 KiB) are 413.
- `accountOf(headers)`: the account ID behind a request's session cookie, for `apps/web`'s server code.

`pruneAccountVerifications(sql, now)` deletes expired WebAuthn challenges. Anyone can start a ceremony and abandon it, and the passkey plugin never deletes those rows, so a scheduled job (P2-4) must run it (T-52).

How it is set up:

- **Passkeys only.** Signing up is registering a discoverable passkey; a signed-in user's new passkey joins their account, but only from a session of that account less than a day old at verify time: the challenge cookie outlives sign-out, so otherwise the next person at a shared browser could attach a passkey to the last user's account. User verification is required when a passkey is made and when it is used, and checked here: the plugin asks for it but doesn't check it. (At sign-in the plugin only prefers it, so a security key without a PIN is refused rather than asked for one.)
- **Nothing about the person.** No e-mail (a random `@account.invalid` placeholder, since better-auth requires one), name, picture, address or user agent: IP tracking is off, a hook clears both on every session, and the migration's checks refuse them. The passkey's user name is a fixed label. A passkey `name` (clients send device or owner names) and the plugin's `context` parameter are refused with 400, and renaming passkeys isn't routed. The authenticator model (AAGUID) is kept, as the plugin stores it; most platform authenticators report zeros. Passwords and OAuth tokens have a table because better-auth reads it, but every row is refused.
- **Cookies.** `__Secure-abolish-account.*`, host-only, `HttpOnly`, `SameSite=Strict`. Requests with cookies must come from `origin` (better-auth's origin check, pinned on even under a test runner, which would otherwise turn it off).
- **No telemetry.** Off in the options, and `createAccounts` throws if `BETTER_AUTH_TELEMETRY` is set, since that variable switches it on whatever the options say. better-auth's own warnings and errors reach `log` by level only, since their messages can quote input.
- **Turnstile on every ceremony start** (T-01, T-52). Both `GET /auth/passkey/generate-register-options` (signing up, or adding a passkey) and `GET /auth/passkey/generate-authenticate-options` (signing in) write a challenge row for whoever asks, so each needs a Turnstile token in the `x-turnstile-token` header, solved on `origin`'s host for its own action (`passkey-register` or `passkey-authenticate`), before better-auth sees the request. A refused token is 403 `TURNSTILE_REFUSED` and an unreachable Cloudflare 503 `TURNSTILE_UNAVAILABLE` (logged as `{ turnstile: "unavailable" }`); neither writes anything. The verify routes need no token of their own: they finish a ceremony a start paid for.
- better-auth's rate limiter is off: it keys on addresses, which we don't keep. Per-address limits are the proxy's (P2-11).

### Turnstile (`src/turnstile.ts`, also `@abolishus/core/turnstile`; T-01, T-11, T-52)

`createTurnstile({ secretKey, hostname })` checks a token with Cloudflare's siteverify and answers `passed`, `refused` or `unavailable`. Only `success: true` with this `hostname` and the expected `action` passes; a token solved on another site or for another action is refused, and Cloudflare refuses a spent or expired one (each token passes once, within 300 seconds). Network failures, timeouts (5 s), non-200 answers, Cloudflare's `internal-error` and a wrong secret key are `unavailable`, never a pass. Malformed tokens (empty, over 2048 characters, not printable ASCII) are refused without asking. The request carries only the secret and the token: no `remoteip`, since we keep no addresses (T-11). The subpath export has no dependencies, so `apps/web`'s client can take the header name and action names from it. Never used on the ballot path (T-25).

- better-auth reads the clock itself, so session expiry isn't on an injected clock.

### Short codes (`src/short-codes.ts`, also `@abolishus/core/short-codes`; T-49, T-53)

A poll's short link is `abolish.us/p/<code>` (docs/design/sharing.md, "Short links and entry points"): a prefix of its definition hash in lower-case Crockford base32. `shortCode(hash, length)` spells the first `length` characters (7 to 52, the 52nd holding the hash's last bit). `parseShortCode(input)` takes what someone typed or scanned, any case, with `o` read as `0` and `i`/`l` as `1` (ASCII only), and returns the canonical code or `undefined`, never a message made from the input. `assignShortCodes(hashes)` gives each poll, in registration order, the shortest prefix of at least 7 characters that no earlier poll's hash shares, so a code never changes once given, a poll ground to share an earlier one's prefix only lengthens its own, and anyone holding the registered hashes (a mirror, `apps/node`, the verifier) resolves codes without us. `resolveShortCode(code, hashes)` is the position of the poll owning a code, or `undefined` for a prefix that isn't exactly some poll's code.

### Auditing the board (`src/audit.ts`; T-23, T-66)

The table's triggers check order and chaining but never hash, so a writer that bypassed `appendEntry`, or a corrupted or restored database, can store columns the payloads don't produce. `auditBoard(sql, id)` reads the board in one query, recomputes it with the verifier's own `checkBoard`, and compares every row's `entry_hash`, `prev_link` and `link`, then every subtree each entry completes against one recomputed from those entry hashes; it returns the size or throws `BoardAuditError` (`board-unpinned` for entries with no stored definition pinning a version this release reads, `board-invalid`, `entry-hash-mismatch`, `link-mismatch`, `subtree-missing` or `subtree-mismatch`) with the first wrong index. `listBoards(sql)` lists every election with entries. `apps/worker` runs the audit on a schedule. It detects and repairs nothing: Postgres isn't authoritative.

### No joins (T-10)

Accounts and ballots never join. Identity tables (`identity_backups`) are on the ballot side. The tests fail on a table missing from `TABLE_CLASSES`, on any foreign key that starts or ends at a board or identity table or that leaves the account tables, on a board or identity column with an account-like name, on an account column with a ballot-like name, and on any view, or any function naming an account table and a board or identity table.

## Tests

`vp run --filter @abolishus/core test` needs `TEST_DATABASE_URL`, connecting as a user that can create roles and `SET ROLE` to them (the CI service user is a superuser). Each test file migrates its own schema and drops it afterwards. `@abolishus/core/test-db` exports that helper for other packages' database tests. The tests run uncached (`test:db` in `vite.config.ts`).
