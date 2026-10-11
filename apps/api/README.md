# @abolishus/api

The public API: implements the oRPC contract in [`@abolishus/api-contract`](../../packages/api-contract) over `node:http`. Internal and source-only; AGPL-3.0-only.

Every answer is a claim the caller checks with `@abolishus/crypto`: a definition against its hash in the L2 election registry, entries with `checkBoard`, heads and proofs against anchored checkpoints (T-23, T-24, T-34). The handlers parse, call `@abolishus/core` and serialise; no protocol logic lives here.

## Procedures

| Procedure                   | State                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elections.getDefinition`   | Serves a stored definition (`storeDefinition` in core decodes and checks it first).                                                                               |
| `board.getHead`             | Size, chain head and tree root. An empty board answers size 0 with zeros.                                                                                         |
| `board.getEntries`          | Pages of encoded entries, at most `MAX_PAGE_BYTES` unless a page holds one entry.                                                                                 |
| `board.getInclusionProof`   | RFC 9162 audit path. Impossible positions are `BAD_REQUEST`; a tree beyond the board is `OUT_OF_RANGE`.                                                           |
| `board.getConsistencyProof` | RFC 9162 consistency proof, with the same errors.                                                                                                                 |
| `ballots.submit`            | **Fails closed** with `ELECTION_NOT_OPEN`: admission (decoding, proofs, L1 reference, poll window) isn't built, so the server boards no ballot yet (P2-3 part 2). |
| `moderation.getLog`         | The public moderation log by sequence number, without the moderator ([`docs/moderation-policy.md`](../../docs/moderation-policy.md), T-68).                       |
| `moderation.getStatus`      | A poll's moderation state and newest decision, without the moderator.                                                                                             |
| `moderation.report`         | Counts an anonymous report of a poll under a removal ground; changes nothing public.                                                                              |

Board procedures answer only for elections whose definition the server holds.

## Transport

- Inputs come from the query (GET) or a JSON body (POST) alone. A GET with a body, and a POST with a query string, are refused, so nothing keyed on the URL sees a different request (T-31).
- At most `maxInFlight` requests (32 by default) are handled at once, counted from the first byte; past it a request gets 503 before anything is read. A board page can hold 8 MiB and costs several times that in memory, so this bounds memory however many clients connect (T-52). A connection idle in both directions for 15 s is destroyed, a request must arrive within 30 s (headers within 10 s), and a request holding a slot for 60 s is destroyed, so a client that stalls its upload, stops reading its answer or reads it slowly loses its slot. A few sockets can still take every slot for up to a minute at a time; per-address limits belong to the proxy in front (P2-11).
- POST bodies: `application/json` only (oRPC's own reader would accept multipart and files of any size), at most `MAX_REQUEST_BODY` bytes, cut off as soon as they exceed it (T-52).
- `cache-control: no-store` and `x-content-type-options: nosniff` on every response.

## Request log (T-10, T-11)

One line per request: method, the contract route it matched (from a fixed list, never the raw URL), status and duration. Never an address, a header, a query string or a body. Internal errors, including answers that fail the contract's output schema, are logged by their kind only, since messages can quote input. The handlers' context holds the database and nothing else, so no procedure can read a cookie, a token or an address. `tests/api.test.ts` fails if any of these reaches a line.

## Running

`vp run --filter @abolishus/api start` (plain Node, no TypeScript transform: `erasableSyntaxOnly` in `tsconfig.json` and a test that starts `src/main.ts` keep it that way) with `DATABASE_URL` (a user granted `abolish_app`, never the owner), and optionally `API_HOST` (default `127.0.0.1`) and `API_PORT` (default `8787`).

`src/migrate.ts` applies pending migrations to `DATABASE_SCHEMA` (default `abolish`) and exits. It connects with `DATABASE_URL` as a user granted `abolish_migrator` and switches to that role, so the tables belong to the group role rather than the login.

## Image

`vp run build` type-checks, then bundles `main.ts` and `migrate.ts` into `dist/` with every dependency inlined, plus core's migrations (`vite.config.ts`, `pack`). The `Dockerfile` puts `dist/` on the Node base pinned by digest and nothing else, so the image carries no `node_modules`, package manager or test code. Building, deploying and the database setup it expects are in [`docs/runbooks/railway.md`](../../docs/runbooks/railway.md). `tests/image.test.ts` runs the bundle copied away from the repository: `migrate.mjs` against an empty schema, then `main.mjs` as a login granted only `abolish_app`.

## Tests

`vp run --filter @abolishus/api test` needs `TEST_DATABASE_URL`, as `@abolishus/core`'s tests do, and runs uncached. The tests start the server on a free port and check every answer with `@abolishus/crypto`.

## Decisions

- **No Hono yet.** AGENTS.md names Hono + oRPC. Nothing so far needs middleware beyond the body bound and the log, which `node:http` does in a few lines, and adding Hono changes the workspace catalog, which needs the owner's review. It comes in with the first part that needs it (accounts, P2-5).
