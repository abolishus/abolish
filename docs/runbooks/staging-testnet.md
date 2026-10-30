# Staging on Base Sepolia: what the owner sets up

The checklist for putting staging's contracts on Base Sepolia (L2) and Sepolia (L1), so a poll can be created, answered and counted end to end ([[P2-12]]). Agents can't hold funds or keys, so every item here is the owner's; the services that use them read them from Railway variables, never from the repository. Testnet only: nothing here ever holds real funds, and no key below is reused on mainnet or for anything else.

## Not yet possible

There is no deploy script or deployment record yet ([[P2-32]]). A testnet deployment may go ahead before nine of the spec's pre-deployment conditions are met: definition versions 1 and 3 still admitted, the decoder's gas at the record's limits, Tier 2's addition path, the nullifier-key events' contract-event version, a contract path for tally openings, verifier 1.2's creation-code binding, regions at group creation, the verifier's reading of obligation roots, and `tally-late` ([[0044-testnet-deployments]]; [[contracts]], Testnet deployments). It waits on your decision on [[delivery]]'s three residuals (in [[STATUS]], Waiting on the owner). On the testnet:

- Create polls only through staging's poll creation, which registers version 5.
- Never have the launch seats record a nullifier key.
- Publish one Tier 0 group and serve region 0 only.
- Never pin the deployment in a release for real polls.
- Treat the deployment as disposable: a later one replaces it, and staging's polls stay on the old one.

Also check that Base Sepolia's rollup config still has a sequencing window of at most 3,600 L1 blocks (`MAX_SEQUENCING_WINDOW`), as Base's does. The nullifier-key margins assume it ([[nullifier-key]], Recording). Until the script lands, prepare everything below.

## Accounts with providers

- **RPC endpoints**, one for Base Sepolia (chain ID 84532) and one for Sepolia (11155111), from a provider with a free keyed tier. The worker and API read them as `CREATE_L2_RPC_URL`, `TIER0_L2_RPC_URL`, `REGISTRY_SYNC_L2_RPC_URL` (L2) and `CREATE_L1_RPC_URL`, `BALLOT_L1_RPC_URL`, `REGISTRY_SYNC_L1_RPC_URL` (L1). The ballot client uses the public `https://sepolia.base.org` ([[P2-8]]); the servers shouldn't, since it rate-limits.
- **An ERC-4337 bundler** for Base Sepolia that supports EntryPoint v0.8: `TIER0_BUNDLER_URL`, for Tier 0 registration batches ([[P3-2]] part 4d, [[0024-tier0-registration]]).

## Keys

Generate each on a machine you control, record which is which, and never reuse one for another role. Ethereum accounts are secp256k1 keys; the board's receipt keys and the trustees' identity keys are P-256.

| Role                             | Kind                                    | Where it lives                                                                                                         | Funding                                                 | Pinned at deployment                                                                                                                                                    |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testnet deployer                 | Ethereum account                        | Your machine, or the GitHub `staging` environment once a deploy workflow exists                                        | Base Sepolia and Sepolia ETH, enough for every contract | No                                                                                                                                                                      |
| Creation key ([[poll-creation]]) | Ethereum account                        | `CREATE_KEY` on the staging `creation-worker`                                                                          | Base Sepolia ETH for a few days' creations              | No (the creator of each poll)                                                                                                                                           |
| Tier 0 registrars, at least 2    | Ethereum accounts                       | `TIER0_SIGNER_KEYS` on the staging `setup-worker`, with `TIER0_THRESHOLD`                                              | None (they sign; the paymaster pays)                    | Yes: the group registry pins them ([[contracts]], Group registry)                                                                                                       |
| Registration account owner       | Ethereum account                        | `TIER0_ACCOUNT_KEY` on the staging `setup-worker`                                                                      | The paymaster's EntryPoint deposit, in Base Sepolia ETH | Yes, as the paymaster's account ([[contracts]], Registration paymaster)                                                                                                 |
| Anchoring Safe owners            | Ethereum accounts, as a Safe on Sepolia | Your devices (a hardware wallet for at least one)                                                                      | Sepolia ETH for the hourly anchors                      | Yes: the anchor and the receipt-key registry trust the Safe ([[P4-1]], [[0023-receipt-evidence]])                                                                       |
| Receipt keys, 1 to 4             | P-256                                   | The staging `api`                                                                                                      | None                                                    | Registered on L1 by the anchoring Safe; each poll lists them (`POLL_STUB_RECEIPT_KEYS`)                                                                                 |
| Launch panel seats               | P-256 identity key per seat             | `TRUSTEE_IDENTITY_KEY` on its staging `seat-n` service, then on its volume only ([[trustee-node]], Staging on Railway) | None                                                    | Yes: the trustee registry pins the panel; polls name it (`POLL_STUB_PANEL_KEYS`, `POLL_STUB_PANEL_THRESHOLD`; the same values as `CREATE_PANEL_*` on `creation-worker`) |

Faucets give small amounts per day; start collecting Sepolia and Base Sepolia ETH early, into the deployer, and fund the others from it.

## The launch panel's seats

During launch every seat of the default panel is ours ([[0027-trustee-panels-and-live-results]]). On staging the seven seats run as Railway services, `seat-1` to `seat-7`, from the trustee node's image ([[railway]], Services; [[trustee-node]], Staging on Railway): each with its own identity key, its own volume holding its write-once store, and outbound HTTPS only, to the coordinator the staging `api` serves ([[P2-22]] part 4c). That puts every seat at one provider, in one project whose token reads every key: a staging relaxation only. Production seats keep separate hosts at separate providers, so one compromise isn't a quorum ([[trustee-node]]). The panel's size and threshold are pinned in the trustee registry at deployment, so decide them before the deploy.

## The workers

One image, two services ([[railway]], Services): `creation-worker` holds the creation key and the `CREATE_*` variables and nothing else ([[poll-creation]]); `setup-worker` holds the ballot, Tier 0, Tier 1, registry-sync, roots and stub variables. Each job starts only once every one of its variables is set, so both services can exist, empty, before the contracts do.

## Deploy day

The deploy workflow builds and signs the worker and seat images on every push to `main`, and deploys each service only once its ID is set in the GitHub `staging` environment ([[railway]], GitHub environments). Once the contracts are deployed and recorded:

1. On your own machine, run `vp run --filter @abolishus/trustee-node start -- keygen --out seat-<n>.key` once for each seat, 1 to 7. Each prints the seat's public identity key: the panel's keys, in seat order, for the trustee registry, `POLL_STUB_PANEL_KEYS` and `CREATE_PANEL_KEYS`.
2. For each seat, paste its key file's contents into that seat's Railway variable `TRUSTEE_IDENTITY_KEY`, and set `TRUSTEE_CONFIG` to its `run` configuration: the panel, its `panelId` as the deployment record gives it, `l2ChainId`, the deployment's `trusteeRegistry`, its `seat` number, the `coordinator` (the staging `api`'s HTTPS address) and `pollSeconds`, without `identityKeyFile` or `store`. Give each service its volume at `/data` and `RAILWAY_RUN_UID=0`. Then delete the local key files, keeping at most one sealed offline copy of each.
3. Fill in `creation-worker`'s and `setup-worker`'s variables ([[railway]], Services).
4. Set the GitHub `staging` variables `RAILWAY_SETUP_WORKER_SERVICE_ID`, `RAILWAY_CREATION_WORKER_SERVICE_ID` and `RAILWAY_SEAT_SERVICE_IDS` (the seven seats' service IDs, seat 1 first). The next deploy deploys them, the seats one at a time.
5. Once every seat has logged `started`, remove each seat's `TRUSTEE_IDENTITY_KEY` variable: the key is on its volume.

## Order

1. Providers: the RPC endpoints and the bundler.
2. Keys: generate them all, fund the deployer from faucets.
3. The anchoring Safe on Sepolia, with its owners and threshold.
4. The launch panel's seats and the two workers as Railway services, created with no variables and not yet in the GitHub `staging` variables.
5. When the deploy script lands: deploy, record the deployment, fund the creation key and the paymaster deposit, register the receipt keys, follow Deploy day above for the seats and workers, set the staging `api` variables, and run [[P2-22]]'s end-to-end check.
