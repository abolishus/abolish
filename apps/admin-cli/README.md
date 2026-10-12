# @abolishus/admin-cli

The operator's command line. Internal and source-only; AGPL-3.0-only. Commands parse their arguments, call `@abolishus/core` and print one JSON object per line on stdout (refusals on stderr), so a person or an agent can drive it. No domain logic lives here. Simulations (P1-21) come later.

## Moderation

`docs/moderation-policy.md` (T-68, T-52). Until the owner names moderators, the operator of the deployment is the only one, so the tooling is this command line on the operator's own database connection, not a page anyone can reach.

| Command                                                                                 | What it does                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moderation queue [--limit 1..1000] [--after <next>]`                                   | Polls and grounds with unreviewed reports, longest waiting first (`readReportQueue`). A full page ends with `{ "next": … }`; pass it as `--after` for the next page.                                              |
| `moderation review <election-id> <reason> <seen-total>`                                 | Marks reviewed the first `seen-total` reports, the `total` the queue showed (`reviewReports`), so a report counted since stays pending. Records no decision.                                                      |
| `moderation decide <election-id> <delist\|hide\|restore> <reason> --moderator <handle>` | Records a decision (`moderate`). Core refuses, with nothing written: `invalid`, `unknown-election`, `open-poll` (hiding an open poll on a ground other than `illegal`, `personal-data` or `threat`), `no-change`. |
| `moderation status <election-id>`                                                       | The poll's state and its newest decision, without the moderator.                                                                                                                                                  |
| `moderation log [--after <seq>] [--limit 1..1000]`                                      | The public log, as `GET /moderation/log` serves it: no moderator.                                                                                                                                                 |

Election IDs are 64 lowercase hex digits, their one spelling (T-31). Exit codes: 0 done, 1 refused by core (`{ "error": code }`), 2 malformed arguments (with the usage).

## Running

From `apps/admin-cli`: `vp node src/main.ts moderation queue` with `DATABASE_URL` (a user granted `abolish_app`, never the owner).

## Tests

`vp run --filter @abolishus/admin-cli test` needs `TEST_DATABASE_URL`, and runs uncached. Each run gets its own schema.

## Known-weak

- The policy's rule that a moderator doesn't decide on a poll they created or have a stake in isn't checked: nothing records who created a poll yet (P2-9), and handles aren't tied to accounts (T-10).
- `--moderator` is whatever the operator types; mapping handles to people is the operator's.
