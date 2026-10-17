# Staging on Base Sepolia: what the owner sets up

The checklist for putting staging's contracts on Base Sepolia (L2) and Sepolia (L1), so a poll can be created, answered and counted end to end ([[P2-12]]). Agents can't hold funds or keys, so every item here is the owner's; the services that use them read them from Railway variables, never from the repository. Testnet only: nothing here ever holds real funds, and no key below is reused on mainnet or for anything else.

## Not yet possible

There is no deploy script or deployment record yet ([[P1-18]]), and the spec lists conditions that must hold before any registry is deployed: the close rule's contracts ([[P1-18]] part 4, [[close]]), membership-checked intake ([[P1-12c]], [[0002-everlasting-privacy]], Decision) and retiring definition versions 1 and 3 ([[contracts]], Election registry, Known-weak). The anchoring Safe's sender is [[P4-1]] part 2b-2. Until those land, prepare everything below; the deploy itself comes with the script.

## Accounts with providers

- **RPC endpoints**, one for Base Sepolia (chain ID 84532) and one for Sepolia (11155111), from a provider with a free keyed tier. The worker and API read them as `CREATE_L2_RPC_URL`, `TIER0_L2_RPC_URL`, `REGISTRY_SYNC_L2_RPC_URL` (L2) and `CREATE_L1_RPC_URL`, `BALLOT_L1_RPC_URL`, `REGISTRY_SYNC_L1_RPC_URL` (L1). The ballot client uses the public `https://sepolia.base.org` ([[P2-8]]); the servers shouldn't, since it rate-limits.
- **An ERC-4337 bundler** for Base Sepolia that supports EntryPoint v0.8: `TIER0_BUNDLER_URL`, for Tier 0 registration batches ([[P3-2]] part 4d, [[0024-tier0-registration]]).

## Keys

Generate each on a machine you control, record which is which, and never reuse one for another role. Ethereum accounts are secp256k1 keys; the board's receipt keys and the trustees' identity keys are P-256.

| Role                             | Kind                                    | Where it lives                                                                  | Funding                                                 | Pinned at deployment                                                                                                                                                  |
| -------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testnet deployer                 | Ethereum account                        | Your machine, or the GitHub `staging` environment once a deploy workflow exists | Base Sepolia and Sepolia ETH, enough for every contract | No                                                                                                                                                                    |
| Creation key ([[poll-creation]]) | Ethereum account                        | `CREATE_KEY` on the staging `worker`                                            | Base Sepolia ETH for a few days' creations              | No (the creator of each poll)                                                                                                                                         |
| Tier 0 registrars, at least 2    | Ethereum accounts                       | `TIER0_SIGNER_KEYS` on the staging `worker`, with `TIER0_THRESHOLD`             | None (they sign; the paymaster pays)                    | Yes: the group registry pins them ([[contracts]], Group registry)                                                                                                     |
| Registration account owner       | Ethereum account                        | `TIER0_ACCOUNT_KEY` on the staging `worker`                                     | The paymaster's EntryPoint deposit, in Base Sepolia ETH | Yes, as the paymaster's account ([[contracts]], Registration paymaster)                                                                                               |
| Anchoring Safe owners            | Ethereum accounts, as a Safe on Sepolia | Your devices (a hardware wallet for at least one)                               | Sepolia ETH for the hourly anchors                      | Yes: the anchor and the receipt-key registry trust the Safe ([[P4-1]], [[0023-receipt-evidence]])                                                                     |
| Receipt keys, 1 to 4             | P-256                                   | The staging `api`                                                               | None                                                    | Registered on L1 by the anchoring Safe; each poll lists them (`POLL_STUB_RECEIPT_KEYS`)                                                                               |
| Launch panel seats               | P-256 identity key per seat             | One per `apps/trustee-node` host ([[trustee-node]])                             | None                                                    | Yes: the trustee registry pins the panel; polls name it (`POLL_STUB_PANEL_KEYS`, `POLL_STUB_PANEL_THRESHOLD`; the same values as `CREATE_PANEL_*` on `worker-create`) |

Faucets give small amounts per day; start collecting Sepolia and Base Sepolia ETH early, into the deployer, and fund the others from it.

## The launch panel's seats

During launch every seat of the default panel is ours ([[0027-trustee-panels-and-live-results]]). Each seat is an `apps/trustee-node` on its own host, set up by [[trustee-node]]: its own identity key (from a file until hardware tokens are supported), its own write-once store, outbound HTTPS only, to the coordinator the staging `api` serves ([[P2-22]] part 4c). Separate hosts and, where you can, separate providers, so one compromise isn't a quorum. The panel's size and threshold are pinned in the trustee registry at deployment, so decide them before the deploy.

## Order

1. Providers: the RPC endpoints and the bundler.
2. Keys: generate them all, fund the deployer from faucets.
3. The anchoring Safe on Sepolia, with its owners and threshold.
4. The launch panel's hosts, each with its identity key, not yet started.
5. When the deploy script lands: deploy, record the deployment, fund the creation key and the paymaster deposit, register the receipt keys, start the seats, set the staging `worker` and `api` variables listed above, and run [[P2-22]]'s end-to-end check.
