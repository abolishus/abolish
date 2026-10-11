# @abolishus/worker

Background jobs on BullMQ, over Redis in development and CI and Dragonfly in deployment. Internal and source-only; AGPL-3.0-only. Handlers parse, call `@abolishus/core` and log; no protocol logic lives here.

## Queues

| Queue           | Side  | Data | Job                                                                                                                                                                                                                                                                      |
| --------------- | ----- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{board-audit}` | board | `{}` | Every `AUDIT_EVERY_MS` (10 minutes by default, and once at start): core's `auditBoard` over every stored board. Each bad board, and each board whose audit failed for another reason (`audit-error`), is a finding line; the job then fails with `board-audit-findings`. |

Proof batch verification, IPFS pinning and tally coordination come with the parts that build what they run: ballot admission (P2-3 part 2), the archive (P4-3) and the tally (P1-15).

## No joins (T-10)

- **Sides.** Every queue in `src/queues.ts` is a board queue or an account queue. A board queue's data names no account, session or person; an account queue's names no ballot, nullifier, poll or election. No job crosses sides. `tests/no-join.test.ts` checks every queue's fields against both deny-lists, so a renamed field would pass; review of each new queue still has to catch that.
- **Strict data.** Job data is a `z.strictObject`, parsed again by the worker before a handler sees it; data with a field the schema doesn't name fails as `invalid-job-data` without being handled. Job IDs are BullMQ's counters, never derived from data.
- **Nothing kept.** A job's data, error and stack trace leave Redis as soon as it finishes (`removeOnComplete` and `removeOnFail` on the worker, so a producer can't opt out by omission). BullMQ also writes every failure's message to the queue's events stream, which those options don't clear, so the worker turns any error into a `JobError` whose message is its fixed kind. Two tests fail if anything reaches a log line or any Redis key, the events stream included: one queues an account field on a board queue, the other makes a handler throw a message that quotes data.
- **Producers.** None exists yet. The first one (ballot admission) gets a helper that parses the data, forces `JOB_OPTIONS` and refuses a custom job ID.
- **Log.** One line per job: queue, outcome, error kind from a fixed list, duration. Never the data, the job ID or an error message, since messages can quote data. An audit finding adds the election ID and entry index, both public on the board, and no person's request leads to an audit.

## Keys (Dragonfly)

Every key is `abolish:{<queue>}:…`. The braces are a hash tag: BullMQ's Lua scripts touch several keys of one queue, which Dragonfly (with `--cluster_mode=emulated --lock_on_hashtags`) and Redis Cluster need in one slot, while separate queues can live on separate threads or shards. A test checks every key the worker creates.

## Running

`vp run --filter @abolishus/worker start` (plain Node, as `apps/api`; `erasableSyntaxOnly` keeps it that way) with `DATABASE_URL` (a user granted `abolish_app`, never the owner), `REDIS_URL` and optionally `AUDIT_EVERY_MS` (at least 60000).

## Tests

`vp run --filter @abolishus/worker test` needs `TEST_DATABASE_URL` and `REDIS_URL`, and runs uncached. Each run uses its own key prefix and removes its keys afterwards.

## Decisions

- **ioredis as BullMQ's client.** BullMQ 6 takes ioredis or node-redis; ioredis is the one BullMQ's own tests pin and the one its Dragonfly guidance uses.
- **`msgpackr-extract` isn't installed** (`ignoredOptionalDependencies`). msgpackr, which BullMQ uses, loads this optional prebuilt native binary whenever it is present, install scripts or not; without it msgpackr uses its pure-JS codec. A test checks it doesn't resolve and that msgpackr's native acceleration is off.
