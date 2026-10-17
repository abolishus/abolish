# Poll creation

How the operator runs the creation key and the `worker-create` deployment that sets up polls made on the website ([[0032-poll-creation-operations]]; [[P2-22]]). The creation key creates and registers every website poll on L2, so whoever holds it can spend its balance and create elections in our name; it can register only definitions a quorum of the pinned panel approved for elections it created ([[contracts]], Registration, rules 5 and 8). Threats: T-65, T-69, T-72, T-52.

Status: not deployable yet. The worker's creation jobs are [[P2-22]] parts 3 to 5; until they merge, nothing reads the variables below.

## The key

- One externally owned account, used for nothing but `createElection()` and `registerDefinition()` on the deployment's election registry. Never the testnet deployer, a registrar, the registration account's owner or a trustee seat's key, so losing one never costs another.
- Generate it on the operator's own machine (`cast wallet new`, Foundry 1.8.3), never in a session, a CI job or a shared host. Put the private key straight into the `worker-create` service's Railway variable `CREATE_KEY` for that environment, and record only its address, in the environment's deployment notes and the release notes of the release that first uses it. Keep no other copy: losing it costs only the polls in setup (Loss, below), so a backup adds risk and protects little.
- `worker-create` is the `apps/worker` image run with only the poll-creation queues enabled. Its variables hold the creation key and the L2 RPC URL and nothing else secret: no registrar or registration-account key, no database migrator login. Railway's project token can read every variable, so it stays in GitHub environments only (T-65).

## Funding

- The key holds a float of a few days' creations: about `CREATE_DAILY_CEILING` × (gas of one creation and one registration) × the current fee × 3. Measure the gas from the worker's own logs of landed transactions, not from estimates.
- Top it up by hand from a funding account when the worker's balance alert fires (below a day's ceiling). Testnet: the chain's faucet or a transfer from the deployer, sent from GitHub Actions, never from a session. Mainnet: owner-only, since it spends real funds; nothing here applies until the owner signs off on mainnet.
- Never fund it above the float. A thief takes at most the balance.

## Rotation

The creator of an election is fixed when it is created, so a poll created by one key can only be registered by that key ([[0032-poll-creation-operations]], rule 4).

1. Generate the new key as above and add it as `CREATE_KEY_NEXT`. The worker then creates new polls with the new key and keeps the old one only to register polls it already created.
2. Wait until no poll whose `creator_address` is the old key is in `created`, `rooted` or `ceremony` (the worker's status command lists them; a poll stuck there past its deadline moves to `failed` by itself).
3. Move `CREATE_KEY_NEXT` to `CREATE_KEY`, sweep the old key's balance to the funding account with the worker's sweep command, and delete the old value.

Rotate yearly, whenever someone who could read the variable leaves, and on any suspicion of compromise (next section).

## Compromise

Signs: transactions from the key the worker didn't record, a balance drop the logs don't explain, or an `ElectionCreated` from its address with no poll row.

1. Stop the creation queues, run the worker's sweep command once (it sends the key's whole balance to the funding account, [[P2-22]] part 3), then stop `worker-create` and remove `CREATE_KEY` from Railway. The thief can race the sweep; losing it costs only the float. Polls in setup stop where they are; their state is kept.
2. Review who could read the variable (Railway project members, the project token's holders) and rotate those credentials too (T-65).
3. Generate a new key, set it, and restart. Polls the old key created and hadn't registered can't be finished by the new key: mark them `failed` with the reason "set up again", and the authors can retry, which creates a new election.
4. What the thief could do with the key: create elections (gas and shared event-sequence space only, [[contracts]], Events), and register, for an election it created, a definition a quorum of the pinned panel approved. Our seats approve only stubs our coordinator handed them, and the coordinator hands out only stubs the worker built from a submitted draft, so check the registry's `DefinitionRegistered` events for the old address: any registration that isn't one of our poll rows is reported in the public moderation log and the environment's incident notes. It could not change any registered definition or register under anyone else's identifier.
5. Record the incident in T-72's history (what happened, not who or how they got in, if that is a legal matter, which is the owner's).

## Loss

Losing the key (a deleted variable, a Railway account loss) loses no result. Registered polls are on chain and need the key for nothing. Polls created and not yet registered can't be finished: generate a new key and fail them as in Compromise, step 3.

## Database wipe

Wiping Postgres loses the creator records and the polls in setup, never a result ([[0032-poll-creation-operations]], rule 16). Registered polls are rebuilt from chain and IPFS. Elections created but never registered stay on chain as unused identifiers; the key's balance is unaffected.

## Under seizure

If our hosting or domains are seized (T-49), poll creation stops: it needs our worker, our coordinator and, during launch, our seats. Existing polls keep running through the direct-submit path and verify without us.
