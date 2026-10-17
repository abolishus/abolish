# @abolishus/indexer

Indexes the contracts' events into Postgres with [Ponder](https://ponder.sh) 0.18. Internal and source-only; AGPL-3.0-only. It indexes the deployment's four L2 contracts ([[contracts]]): every log of the election registry, the trustee registry, the group registry and the board, direct-submitted ballots included, and the group registry's records in a shape readers replay. Readers (the API and worker) come in P3-5 part 3.

## What it stores

Public chain data only, as the events carry it (`ponder.schema.ts`):

| Table          | Rows                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group`        | Each `GroupCreated`: the group, its tier, and the block, transaction and log index it was created in.                                                                                             |
| `group_record` | Each `MembersAdded` (`add`) and `MembersRemoved` (`remove`) with its whole record, signatures included; keyed by Ponder's event ID, which sorts in chain order.                                   |
| `contract_log` | Every log the four contracts emit, the constructors' `RegistrarsPinned` and `PanelPinned` included: contract, block number and timestamp, topics and data as emitted, keyed by Ponder's event ID. |

Ponder fetches only the logs of events that have a handler, so `src/events.ts` subscribes to every event of each contract's generated ABI (`@abolishus/contracts/abi`), and a test checks that list against the newest contract-event table `@abolishus/crypto` reads: an event a later contract version adds is indexed without a handler being written for it, and a contract's sequence in `contract_log` stays complete (T-71, T-25).

The indexer judges nothing. `readIndexedGroups` (`src/records.ts`) returns each group's records in chain order, in the shape `@abolishus/crypto`'s `applyGroupRecords` replays, and the reader replays them under the registrars its own release pins, so a row never stands for a member, a count or a root (T-71, T-06). The verifier never reads the index: it rebuilds tier trees from the chain itself ([[verifier]] 2.4).

The index holds nothing that can't be rebuilt: wiping its schema, and Ponder's RPC cache with it, and starting again reindexes every row from the chain (T-66). Ponder treats a block as final once it is 600 seconds older than the head (`reorgWindow`, its maximum), by wall clock rather than the L2's safe or finalized head; rows in later blocks are rolled back if the chain reorganises, but older ones are never rechecked, so a reorganisation of the L2's unsafe chain after that leaves orphaned records in the index. Readers must treat rows above the L2's safe head as provisional.

Replaying catches an altered or reordered row, never a missing one: anyone who can write the index (or a node hiding logs) can drop a removal or a trailing batch of additions, and the shorter history still replays, to another tree. Only the event accumulator's storage proof shows a history complete ([[contracts]], Event accumulator; T-71). `readContractEvents` returns a contract's `contract_log` rows as contract-event records (`0x0008`), each log's `n` its position in chain order, so a deleted row shifts every later one; checked with `@abolishus/crypto`'s `checkEventAccumulatorProof` against the contract's accumulator and count proven at a block, a dropped, added, altered, reordered or moved log fails. The reader proves those two slots itself (an account and storage proof under an output root, [[verifier]] 4.4); the index holds no proof.

## Running

`vp run --filter @abolishus/indexer start` runs `ponder start` with:

- `DATABASE_URL`: Postgres. Ponder creates its tables in `DATABASE_SCHEMA` (required) and its RPC cache in schemas of its own named `ponder_…`. PGlite isn't used.
- `INDEXER_CHAIN_ID`, `INDEXER_RPC_URL` (http or https): the L2 and a node of it.
- `ELECTION_REGISTRY_ADDRESS`, `TRUSTEE_REGISTRY_ADDRESS`, `GROUP_REGISTRY_ADDRESS` and `BOARD_ADDRESS`, each with its `…_START_BLOCK`: the four contracts and the blocks they were deployed in. The four addresses must be distinct.

`src/env.ts` refuses the whole deployment if any of these is missing or malformed. The HTTP server serves only Ponder's `/health`, `/ready`, `/status` and `/metrics`: `src/api/index.ts` mounts no GraphQL and no SQL over HTTP. Ponder 0.18 sends no telemetry.

## Tests

`vp run --filter @abolishus/indexer test` needs `TEST_DATABASE_URL` and Foundry (`anvil`, `forge`; `.github/scripts/install-toolchain.sh`).

- `tests/indexer.test.ts`: deploys the four contracts, built by `forge` from `packages/contracts`, on Anvil under a chain ID of the run's own: the group registry with three of Anvil's unlocked development accounts as registrars (they sign through `eth_signTypedData_v4`, so no key is held in the test), the trustee registry with a made-up panel's public keys, the election registry with forge's `MockL1Block` at the L1Block predeploy, and the board reading its registries through the stubs its own tests use, set from `ballot.json`. Elections are created and `ballot.json`'s ballots submitted straight to the board, before the backfill and live. It creates three groups, adds and removes members, moves the clock past the 600-second reorg window so those blocks reach Ponder's backfill, then adds and removes more live. Each group's indexed records must replay, under the pinned registrars, to exactly the leaves sent, an empty group included. Then the index and the RPC cache are dropped and rebuilt from the chain to the same result, under another registrar set every group's history fails at its first record, a reordered row fails, and a dropped removal still replays. Every indexed log of each contract, from the backfill, live and after the rebuild, frames as a contract-event record, passes the event check under its contract's role, names the events the test caused in order, and replays to the contract's accumulator and count read from Anvil's storage at the head (the slots derived from the spec); the board's logs are exactly the ballots submitted; a dropped, altered or moved log, and a row deleted from the index itself, fail that check.
- `tests/env.test.ts`: the deployment's parser, with property tests.
- `tests/events.test.ts`: the subscribed events are each ABI's, once each, and cover every event of the newest contract-event table for each contract's role.
