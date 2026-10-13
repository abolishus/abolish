# @abolishus/admin-cli

The operator's command line. Internal and source-only; AGPL-3.0-only. Commands parse their arguments, call `@abolishus/core` and print one JSON object per line on stdout (refusals on stderr), so a person or an agent can drive it. No domain logic lives here.

## Moderation

`docs/moderation-policy.md` (T-68, T-52). Until the owner names moderators, the operator of the deployment is the only one, so the tooling is this command line on the operator's own database connection, not a page anyone can reach.

| Command                                                                                 | What it does                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moderation queue [--limit 1..1000] [--after <next>]`                                   | Polls and grounds with unreviewed reports, longest waiting first (`readReportQueue`). A full page ends with `{ "next": … }`; pass it as `--after` for the next page.                                              |
| `moderation review <election-id> <reason> <seen-total>`                                 | Marks reviewed the first `seen-total` reports, the `total` the queue showed (`reviewReports`), so a report counted since stays pending. Records no decision.                                                      |
| `moderation decide <election-id> <delist\|hide\|restore> <reason> --moderator <handle>` | Records a decision (`moderate`). Core refuses, with nothing written: `invalid`, `unknown-election`, `open-poll` (hiding an open poll on a ground other than `illegal`, `personal-data` or `threat`), `no-change`. |
| `moderation status <election-id>`                                                       | The poll's state and its newest decision, without the moderator.                                                                                                                                                  |
| `moderation log [--after <seq>] [--limit 1..1000]`                                      | The public log, as `GET /moderation/log` serves it: no moderator.                                                                                                                                                 |

Election IDs are 64 lowercase hex digits, their one spelling (T-31). Exit codes: 0 done, 1 refused by core (`{ "error": code }`), 2 malformed arguments (with the usage), 3 any other failure, such as an unreachable database (`{ "error": "internal", "kind": … }`, the error's name only, since its message can name the database's address).

## Simulations

`docs/status/P1-21.md`. A scenario is JSON (see `@abolishus/sdk`'s README), given inline or as a file; these commands need no database.

| Command                                                            | What it does                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simulation plan (--scenario <json> \| --file <path>)`             | The plan the seed fixes: ballots cast (re-votes' earlier ballots included), how many went direct during the outage, how many the re-vote rule supersedes, how many voters challenge an attempt first, and each tier's expected counts. No cryptography; instant.                                                          |
| `simulation run (--scenario <json> \| --file <path>) [--progress]` | Runs the election through the protocol code and prints the report (`ok`, the definition's and ceremony transcript's hashes, the ballots cast, direct, superseded and challenged, each cell's outcome and counts against the plan, and the stubs). With `--progress`, about a hundred `{ "progress": … }` lines before it. |

A malformed scenario is a usage error naming the field (exit 2). A run whose cells differ from the plan prints the report, then `{ "error": "simulation-mismatch" }` (exit 1).

## Running

From `apps/admin-cli`: `vp node src/main.ts moderation queue` with `DATABASE_URL` (a user granted `abolish_app`, never the owner). Only the moderation commands read it; a missing or malformed one is refused as `{ "error": "database-url" }` (exit 1).

## Tests

`vp run --filter @abolishus/admin-cli test` needs `TEST_DATABASE_URL`, and runs uncached. Each run gets its own schema.

## Known-weak

- The policy's rule that a moderator doesn't decide on a poll they created or have a stake in isn't checked: nothing records who created a poll yet (P2-9), and handles aren't tied to accounts (T-10).
- `--moderator` is whatever the operator types; mapping handles to people is the operator's.
