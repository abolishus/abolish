# @abolishus/api-contract

The public API's contract: the oRPC procedures `apps/api` implements and the ballot client, SDK, CLI and third parties call, with `zod/mini` schemas, and the OpenAPI document generated from them. Internal and source-only (AGPL-3.0-only).

## What it covers

| Procedure                   | Route                           |
| --------------------------- | ------------------------------- |
| `elections.list`            | `GET /elections`                |
| `elections.getDefinition`   | `GET /elections/definition`     |
| `elections.resolveCode`     | `GET /elections/by-code`        |
| `elections.getCode`         | `GET /elections/code`           |
| `board.getHead`             | `GET /board/head`               |
| `board.getEntries`          | `GET /board/entries`            |
| `board.getInclusionProof`   | `GET /board/proofs/inclusion`   |
| `board.getConsistencyProof` | `GET /board/proofs/consistency` |
| `ballots.submit`            | `POST /ballots`                 |
| `moderation.getLog`         | `GET /moderation/log`           |
| `moderation.getStatus`      | `GET /moderation/status`        |
| `moderation.report`         | `POST /moderation/reports`      |

## Rules

- **Bytes are opaque here.** A record, board entry, hash or proof travels as lowercase hex (two digits per byte, no `0x`, the form of `docs/spec/notation.md`), with one spelling per byte string. Its meaning and its strict decoding belong to `@abolishus/crypto` and `docs/spec/`; no schema here defines protocol bytes (T-31).
- **Every answer is a claim.** Callers check returned entries, heads and proofs with `@abolishus/crypto` against the chain and the anchored checkpoints, never trust them because our server sent them (T-23, T-24, T-34).
- **No identity on the ballot path.** No procedure declares authentication, and no field names an account, session, person or plaintext vote; a test asserts both (T-09, T-10). Ballots are submitted without an account.
- **Everything is bounded** (T-52): ballots by `MAX_BOARD_PAYLOAD` (tied by a test to `docs/spec/parameters.md`), pages by count and bytes, proof paths by length.
- **Integers are canonical decimal strings.** Positions and tree sizes are `u64`, which JSON numbers can't carry exactly.
- **No path parameters.** oRPC merges a request's query or body over its path parameters, so a field in both would let the URL name one election while the handler serves another (T-31). Every input comes from the query (GET) or the body (POST) alone; a test asserts it.
- **Strict objects only.** A request with an unknown field is refused; a test checks every object in the generated document.

## Build and test

- `vp run --filter @abolishus/api-contract build` writes `dist/openapi.json` (deterministic; `repro-build` compares two builds).
- `vp run --filter @abolishus/api-contract test` runs the property tests of the wire forms and the contract tests.
