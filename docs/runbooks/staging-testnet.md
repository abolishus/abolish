# Staging on Base Sepolia: what the owner sets up

The checklist for putting staging's contracts on Base Sepolia (L2) and Sepolia (L1), so a poll can be created, answered and counted end to end ([[P2-12]]). Agents can't hold funds or keys, so every item here is the owner's; the services that use them read them from Railway variables, never from the repository. Testnet only: nothing here ever holds real funds, and no key below is reused on mainnet or for anything else.

## Status

Everything the deployment needs from the repository exists ([[P2-32]]): the deploy script (`packages/contracts/script/Deploy.s.sol`), the confirmation against the chain (`script/confirm.ts`), the deployment record and the services' variables (`admin-cli deployment record` and `deployment variables`), and the workflow that runs them in order, `testnet-deploy` (`.github/workflows/testnet-deploy.yml`, below). Nothing is deployed until you run it with `broadcast` on.

The staging deployment, and no other, may go ahead before nine of the spec's pre-deployment conditions are met: definition versions 1 and 3 still admitted, the decoder's gas at the record's limits, Tier 2's addition path, the nullifier-key events' contract-event version, a contract path for tally openings, verifier 1.2's creation-code binding, regions at group creation, the verifier's reading of obligation roots, and `tally-late` ([[0044-testnet-deployments]]; [[contracts]], Testnet deployments). It waits on your decision on [[delivery]]'s three residuals (in [[STATUS]], Waiting on the owner): don't run the workflow with `broadcast` on before you've made it. On the testnet:

- Create polls only through staging's poll creation, which registers version 5.
- Never have the launch seats record a nullifier key.
- Publish one Tier 0 group and serve region 0 only.
- Deploy only through the workflow, which refuses every target but `staging`, and never pin the deployment in a release that isn't built for staging.
- Never serve public polls from it: a public or production deployment, even on a testnet before mainnet, needs every condition met.
- Treat the deployment as disposable: a later one replaces it, and staging's polls stay on the old one.

Also check that Base Sepolia's rollup config still has a sequencing window of at most 3,600 L1 blocks (`MAX_SEQUENCING_WINDOW`), as Base's does. The nullifier-key margins assume it ([[nullifier-key]], Recording).

## Accounts with providers

- **RPC endpoints**, one for Base Sepolia (chain ID 84532) and one for Sepolia (11155111), from a provider with a free keyed tier. The worker and API read them as `CREATE_L2_RPC_URL`, `TIER0_L2_RPC_URL`, `REGISTRY_SYNC_L2_RPC_URL` (L2) and `CREATE_L1_RPC_URL`, `BALLOT_L1_RPC_URL`, `REGISTRY_SYNC_L1_RPC_URL` (L1). The ballot client uses the public `https://sepolia.base.org` ([[P2-8]]); the servers shouldn't, since it rate-limits.
- **An ERC-4337 bundler** for Base Sepolia that supports EntryPoint v0.8: `TIER0_BUNDLER_URL`, for Tier 0 registration batches ([[P3-2]] part 4d, [[0024-tier0-registration]]).

## Keys

Generate each on a machine you control, record which is which, and never reuse one for another role. Ethereum accounts are secp256k1 keys; the board's receipt keys and the trustees' identity keys are P-256.

| Role                             | Kind                                    | Where it lives                                                                                                         | Funding                                                 | Pinned at deployment                                                                                                                                                    |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testnet deployer                 | Ethereum account                        | `TESTNET_DEPLOYER_KEY` in the GitHub `staging` environment (below), and nowhere else once it's set                     | Base Sepolia and Sepolia ETH, enough for every contract | No                                                                                                                                                                      |
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

## The deploy workflow

`testnet-deploy` (Actions, Run workflow, on `main`) runs only from `main`, one run at a time. Its one input, `broadcast`, is off by default, and then the run only rehearses: it deploys to Anvil forks of both chains through your providers, sending as the deployer without its key, confirms both records against the release build and builds the deployment record and the Railway variables, exactly as the real run does. The forks read your real Safes, timelock and EntryPoint, so a wrong pin fails there, before anything is sent. With `broadcast` on, after the rehearsal, it:

1. refuses unless `ci`, `repro-build` and `reference-election` passed on the commit;
2. deploys to Sepolia, then Base Sepolia, with the key, at the deployer's current nonce on each chain;
3. confirms both records against the chains and the release build, waits until both chains have finalized every block they name, then confirms again through your main provider and through the check provider, and requires all three alike ([[P2-32]] part 3b; T-34, T-64);
4. prints the deployment record and each service's Railway variables in the run's summary;
5. verifies every contract's source on Etherscan;
6. commits the confirmed records and `deployments/staging-record.json` to a new branch `deploy/testnet-<run id>` and links it in the summary. Open a PR from it yourself: one the workflow opened with its own token would start no checks.

Every job but the build, the checks and the publish runs in the `staging` environment. If you give it required reviewers, you approve each run's jobs, rehearsals included.

### What it reads

All of these go in the GitHub `staging` environment (Settings, Environments, `staging`), never in the repository or as repository secrets: a run from a PR branch can't read an environment that allows `main` alone ([[railway]], GitHub environments; T-65).

| Name                        | Kind     | What it is                                                                                                                                                                                                                                 |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TESTNET_DEPLOYER_KEY`      | Secret   | The testnet deployer's private key (Keys, above), 32 bytes of hex. Only the deploy job reads it, and it refuses to send unless the key's address is the configuration's `deployer`                                                         |
| `TESTNET_L1_RPC_URL`        | Secret   | Your main provider's Sepolia URL (a secret, since a provider's URL can carry its key)                                                                                                                                                      |
| `TESTNET_L2_RPC_URL`        | Secret   | The same provider's Base Sepolia URL                                                                                                                                                                                                       |
| `TESTNET_L1_CHECK_RPC_URL`  | Secret   | Another provider's Sepolia URL, on another host than the main one: the run refuses the same host. Two hosts can still be one provider, so pick another company                                                                             |
| `TESTNET_L2_CHECK_RPC_URL`  | Secret   | That other provider's Base Sepolia URL                                                                                                                                                                                                     |
| `ETHERSCAN_API_KEY`         | Secret   | An etherscan.io API key. forge verifies through Etherscan's multichain API, so one key covers both chains. A failure there leaves the deployment recorded; verify again by hand later                                                      |
| `TESTNET_DEPLOY_CONFIG`     | Variable | The deploy script's `DEPLOY_CONFIG` (`packages/contracts` README, Deploy script) without `commit`, `l1Nonce` and `l2Nonce`, which the run adds from the checkout and the chains. The run refuses a configuration that has any of the three |
| `TESTNET_DEPLOYMENT_INPUTS` | Variable | `admin-cli deployment`'s inputs (`apps/admin-cli` README, Deployment record) without `l2FromBlock`, which the run takes from the first L2 block the confirmed record names. The run refuses inputs that have it                            |
| `STAGING_COORDINATOR_URL`   | Variable | The staging `api`'s HTTPS address: the seats' coordinator in their printed `TRUSTEE_CONFIG`                                                                                                                                                |

### The configuration

`TESTNET_DEPLOY_CONFIG` is one JSON object. Every value is yours; none is in the repository:

- `target`: `"staging"`. `l1ChainId`: `11155111`. `l2ChainId`: `84532`.
- `deployer`: the deployer key's address.
- `anchor`: `epoch` (a whole hour in Unix seconds), `period` `3600`, `deadline` `43200`, and `authority`, the anchoring Safe's address.
- `portal`: Base Sepolia's `OptimismPortal` on Sepolia, from Base's published contract addresses.
- `panel`: `threshold` (the panel's k), `quorum` (`max(k, n − 1)`: 6 for seven seats with k at most 6), `kind` `2` (transitional: the panel is the operator's alone until independent trustees are named, [[0027-trustee-panels-and-live-results]], Part 3), and the seats' public identity keys as `keys` and `points`. `keygen` prints each key compressed; to get both fields, in seat order, from `packages/crypto`:

  ```sh
  vp node --input-type=module -e '
  import { p256 } from "@noble/curves/nist.js";
  const keys = process.argv.slice(1);
  const points = keys.flatMap((k) => { const { x, y } = p256.Point.fromHex(k).toAffine(); return [String(x), String(y)]; });
  console.log(JSON.stringify({ keys: "0x" + keys.join(""), points }));
  ' <seat 1 key> <seat 2 key> … <seat 7 key>
  ```

  It refuses a key that isn't a point on P-256. The trustee registry checks the points against the keys at deployment, and the confirmation recomputes the panel's identifier from them.

- `registrars`: `threshold` (at least 2) and the Tier 0 registrars' `addresses`, in ascending order.
- `registration`: `entryPoint` (`0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`, EntryPoint v0.8 on Base Sepolia), `serviceOwner` (the registration account owner's address), `admin` (the timelock's address), `safe` (the Base Sepolia Safe behind it) and `maxCost` (the paymaster's cap per operation in wei, a decimal string).

## Deploy day

Before it, the services exist with no variables (Order, steps 1 to 4).

1. On your own machine, run `vp run --filter @abolishus/trustee-node start -- keygen --out seat-<n>.key` once for each seat, 1 to 7. Each prints the seat's public identity key; together, in seat order, they are the configuration's `panel` (above). Keep the key files: step 6 needs them.
2. Set the environment's secrets and variables (What it reads, above). Leave the deployer unused from here until the run ends: the run takes its nonce on each chain at the start, and a transaction sent from it in between makes the deploy script refuse (`WrongNonce`).
3. Run `testnet-deploy` with `broadcast` off. Fix whatever it refuses (each refusal names the value), and run it again until it passes.
4. Run it with `broadcast` on. It takes an hour or two, mostly waiting for finality. If the deploy job fails after the Sepolia run, the `deployment` artifact holds whatever was sent; the next run deploys everything again at the deployer's new nonces, and the earlier contracts are abandoned.
5. Open the PR from the `deploy/testnet-<run id>` branch the summary links. If the repository's rules refused the workflow's push, the run's `confirmed` artifact holds the same files: commit them on a branch of your own instead.
6. Paste the summary's Railway variables, each service's as it is, never retyped (`apps/admin-cli` README, Railway variables). For each seat, paste its key file's contents into that seat's Railway variable `TRUSTEE_IDENTITY_KEY`, and its printed `TRUSTEE_CONFIG`. Give each seat its volume at `/data` and `RAILWAY_RUN_UID=0`. Then delete the local key files, keeping at most one sealed offline copy of each.
7. Fill in the rest each service needs ([[railway]], Services): the URLs, keys and receipt keys the deployment doesn't hold, and the creation blocks the command doesn't print yet (`TIER0_REGISTRY_BLOCK`, `POSTING_BOARD_BLOCK`): the `block` of the group registry and of the board in the confirmed Base Sepolia record (`deployments/84532.json`).
8. Fund the creation key and the paymaster's EntryPoint deposit, and register the receipt keys on L1 through the anchoring Safe.
9. Set the GitHub `staging` variables `RAILWAY_SETUP_WORKER_SERVICE_ID`, `RAILWAY_CREATION_WORKER_SERVICE_ID`, `RAILWAY_POSTING_WORKER_SERVICE_ID` and `RAILWAY_SEAT_SERVICE_IDS` (the seven seats' service IDs, seat 1 first). The next deploy deploys them, the seats one at a time.
10. Once every seat has logged `started`, remove each seat's `TRUSTEE_IDENTITY_KEY` variable: the key is on its volume.
11. Run [[P2-22]]'s end-to-end check.

## Order

1. Providers: the RPC endpoints (two providers, for the workflow's check), the bundler and an Etherscan API key.
2. Keys: generate them all, fund the deployer from faucets.
3. The anchoring Safe on Sepolia, with its owners and a threshold of 2 or more: the deploy script refuses a 1-of-1 Safe, which is one key.
   Also, on Base Sepolia: a Safe of your choosing with a threshold of 2 or more, and an OpenZeppelin `TimelockController` with a non-zero minimum delay (two days, say). The Safe must be its only proposer and canceller. No one else may hold its admin role: renounce it, or give it to the timelock itself. That timelock is the registration paymaster's `admin`, the only party that can withdraw its deposit. The deploy script refuses an admin with no code or no delay, a Safe that isn't a multisig or doesn't hold the proposer and canceller roles, and a deployer that holds any role. It can't tell OpenZeppelin's timelock from one that only answers like it, so use OpenZeppelin's.
4. The launch panel's seats and the workers as Railway services, created with no variables and not yet in the GitHub `staging` variables.
5. Your decision on [[delivery]]'s three residuals (Status, above).
6. Deploy day, above.
