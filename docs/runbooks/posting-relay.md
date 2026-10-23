# Posting relay

How the operator runs the posting key, its store and the `posting-worker` deployment that sends voters' share postings to the board and pays their gas ([[0042-posting-relay]], option A; [[posting-relay]]; [[P2-8]]). The posting key only pays: it has no role in any contract, and a posting it sends passes the board only if its `m_i` and ballot do, which only the voter's client can make ([[posting-relay]], Roles). So whoever holds the key can spend its balance and nothing more; whoever reads the store or the worker's database while a posting is queued or in flight reads its `m_i` (T-18). Threats: T-13, T-18, T-52, T-65, T-69.

Status: not deployable on staging yet. The worker (`node posting.mjs`, `apps/worker` README, Posting relay) runs the queue, the ledger's tending, the forced path's deposits on L1 ([[posting-relay]], Forced through L1) and the pruning, so the key needs a float on L1 as well as on L2. The deploy workflow doesn't deploy `posting-worker` yet: that waits on a `ci:` change adding its service ID ([[railway]], Deploying).

## The key

- One externally owned account, used for nothing but `submitPosting` on the deployment's board, `depositTransaction` on the L2's portal on L1, and the 0-wei transfers to itself that cancel a deposit. Never the testnet deployer, the creation key, a registrar, the registration account's owner, the Tier 1 relay's key, an anchoring key or a trustee seat's key, so losing one never costs another.
- Generate it on the operator's own machine (`cast wallet new`, Foundry 1.8.3), never in a session, a CI job or a shared host. Put the private key straight into the `posting-worker` service's Railway variable `POSTING_KEY` for that environment, and record only its address, in the environment's deployment notes. Keep no other copy: losing it loses no result (Loss, below).
- The worker refuses to start if the key's account holds code on either chain, an EIP-7702 delegation among them: another contract could then spend from it, and a deposit's sender must be the externally owned account itself, or the board sees an aliased caller ([[posting-relay]], Forced through L1). Never sign a delegation with it.
- `posting-worker` holds the key and nothing else secret beside its own database login and the store's password: `node posting.mjs` refuses to start beside `REDIS_URL` or any other job's variable (T-69). Railway's project token can read every variable, so it stays in GitHub environments only (T-65).

## The store

The relay's queue and outcomes: one Redis, its own, never the workers' Dragonfly, whose BullMQ queues outlive a restart ([[posting-relay]], Queue; T-18). The API refuses an `API_POSTING_REDIS_URL` on the same host and port as its `REDIS_URL`; an alias of the same host gets through, so this setup is what keeps them apart.

1. A Railway service from the official `redis` image, version 7, pinned by digest, started with `redis-server --save "" --appendonly no --maxmemory 64mb --maxmemory-policy noeviction --requirepass <generated password>`: no snapshot and no append-only file, so nothing reaches a disk, and no eviction, so a full store refuses writes (the route answers busy) rather than dropping a queued pair or an outcome. 64 MB holds `POSTING_QUEUE_MAX` (64) pairs at the largest size several times over.
2. No volume, no public domain: the private network only. Never enable Railway's backups for it, never attach a volume later, and never point a monitoring or export tool at it that copies keys.
3. Its URL, with the password, is the `api` service's `API_POSTING_REDIS_URL` and the `posting-worker`'s `POSTING_REDIS_URL`. A restart empties it, which costs nothing: a pair lost before it was sent was never answered `sent`, and its client sends it again.

## The deployment

`posting-worker` ([[railway]], Services): the worker image started as `node posting.mjs`, one replica, with:

| Variable                  | Value                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | The `abolish_posting_worker` login ([[railway]], Postgres): the ledger's tables and the registered elections, as `abolish_app`.                                                  |
| `POSTING_REDIS_URL`       | The store's URL (above). Secret: it carries the password.                                                                                                                        |
| `POSTING_L2_RPC_URL`      | The L2 node the worker reads, simulates against and sends to (HTTP). Treat it as a secret: a provider's API key often sits in its path.                                          |
| `POSTING_CHAIN_ID`        | The L2's chain ID.                                                                                                                                                               |
| `POSTING_BOARD`           | The board our definitions name.                                                                                                                                                  |
| `POSTING_BOARD_BLOCK`     | Its deployment block.                                                                                                                                                            |
| `POSTING_KEY`             | Secret: the posting key, 64 hex digits, `0x` optional. Removed from the environment once read.                                                                                   |
| `POSTING_FEE_CAP`         | The fee cap, in wei per L2 gas: no call is signed to pay more. Set it at ten times the L2's usual max fee, so a fee spike delays postings rather than spending the float on one. |
| `POSTING_ELECTION_BUDGET` | The election budget, in wei: the most the relay spends on one election's postings, L1 data fees and deposits included ([[posting-relay]], Caps). Sizing below.                   |
| `POSTING_L1_RPC_URL`      | The L1 node the forced path reads, estimates against and sends deposits to (HTTP), on the L1 the election registry names. A secret, as `POSTING_L2_RPC_URL`.                     |
| `POSTING_L1_FEE_CAP`      | The L1 fee cap, in wei per L1 gas: no deposit is signed to pay more, and no cancellation more than twice it. Set it at ten times L1's usual max fee, as the L2's.                |
| `BALLOT_PINNED_PANELS`    | As the `setup-worker`'s: the release's pinned trustee panels, which the worker's admission judges each pair's ballot under.                                                      |
| `BALLOT_ANCHOR_EPOCH`     | As the `setup-worker`'s.                                                                                                                                                         |
| `BALLOT_ANCHOR_PERIOD`    | As the `setup-worker`'s.                                                                                                                                                         |

At startup the worker checks that the node is on `POSTING_CHAIN_ID`, that `POSTING_BOARD` is a board whose election registry names it back at the finalized block, that the finalized head is at or past `POSTING_BOARD_BLOCK`, and that the key's account holds no code; then that the L1 node is on the chain the registry names, that the registry's L1 relay names `POSTING_BOARD` at L1's finalized block, that the portal it names holds code (deposits go to that portal, which no variable sets), and that the key's L1 account holds no code. It refuses to start otherwise, naming the mismatch and never the key or a URL.

The forced path's log lines are `{"queue":"{posting}","step":"deposit", …}`, every L1 slot when something moved. `unjudged` there means a posting was due a deposit but a registered election's times couldn't be read, or the index has missed a registration for `POSTING_INDEX_LAG` (six hours): check the registry sync's log (`{registry-sync}` lines) and that every registered definition is stored, since until then postings ride the sequencer alone ([[posting-relay]], Known-weak). The step reports `failing` while it lasts.

One replica: within a process the rounds never overlap, and the ledger's lock keeps a deploy's overlap from paying for a posting twice, but two replicas would judge the same pairs twice over. Turn the relay on in this order, so the route never queues what nothing judges:

1. The store, then `posting-worker` with its variables. Its log shows `{"queue":"{posting}", …}` lines only when something moved or a step starts failing (`"outcome":"failing"`) or recovers.
2. The `api` service's `API_POSTING_REDIS_URL` and `BALLOT_PINNED_PANELS`. The route answers `RELAY_UNAVAILABLE` whenever the worker's index is more than a minute old, so a stopped worker turns the relay off by itself.

To turn it off, remove the `api` service's two variables first, then stop the worker once `SELECT count(*) FROM posting_in_flight` is 0, or leave it running: what is in flight is tended and pruned only while it runs.

## Sizing the budget and the float

- A posting's cost is its gas limit at the fee cap plus its L1 data fee, and, if it may still be forced when first sent, its deposit's reserve: the deposit's L1 gas limit at the L1 fee cap plus 21,000 gas at twice it, released once it can't be forced any more. So a budget sized for L2 alone holds postings back `budget` early. The largest pair's gas limit is at most about 7.1 million ([[posting-relay]], Values), an ordinary one's about 550,000 to 700,000; read what postings actually cost from the worker's `tend` lines and the key's transactions on the explorer, not from estimates.
- An election's budget should cover its honest voters: about one posting for each seat a voter couldn't deliver to directly, which the delivery check's own counts show for past polls. The caps bound what a few members can spend within it (`2 · s · M` postings in an election of `s` seats and `M` members), so a budget sized for that bound never runs out but costs the most; one sized for honest voters can be spent first by members who make up ballots, sending later voters to their own wallets ([[posting-relay]], Known-weak).
- The key's L1 float covers the deposits the forced path may send while a sequencer censors: the reserves above, for the postings in flight at once. Deposits are rare in normal operation, so a float of a few deposits at the L1 fee cap does, topped up when a `deposit` line counts any. Without it the L1 node refuses the deposit and then its cancellation, nothing is spent, and that nonce holds every later deposit back, its posting riding the sequencer and the client's own rules, until the float is topped up and a rebroadcast lands.
- The key's L2 float covers the budgets of the elections open at once, for a few days. Top it up by hand from a funding account; check the balance on the explorer daily while polls are open (nothing alerts on it yet, and a status command is still to come). Testnet: the chain's faucet or a transfer from the deployer, sent from GitHub Actions, never from a session. Mainnet: owner-only, since it spends real funds; nothing here applies until the owner signs off on mainnet.
- Never fund it above the float. A thief takes at most the balance.

## Rotation

The ledger tends every transaction it sent at the key's nonces, so the key changes only once nothing is in flight.

1. Remove the `api` service's `API_POSTING_REDIS_URL` and `BALLOT_PINNED_PANELS` and redeploy it: the route answers `RELAY_UNAVAILABLE`, and clients fall back to the voter's own wallet ([[0042-posting-relay]], rule 6).
2. Leave `posting-worker` running until `SELECT count(*) FROM posting_in_flight` is 0. An entry leaves once its posting's event is final, or once its election's `t_D` is final, so a posting the budget holds back can keep it until then.
3. Stop `posting-worker` once nothing is pending on L1 either (`SELECT count(*) FROM posting_deposits` is 0). On the operator's own machine, read the old key from the Railway variable and send its balance on each chain, less the transfer's fee, to the funding account (`cast send`), then delete every copy of it there. Set the new key in `POSTING_KEY` and start the worker, then restore the `api` service's variables.

Rotate yearly, whenever someone who could read the variable leaves, and on any suspicion of compromise (next section).

## Compromise

Signs: the key's nonce consumed by transactions the worker didn't send (`tend` lines counting `posted`, `resent` or `held` with no relay traffic to explain them), or a balance drop the logs don't explain.

1. Remove `POSTING_KEY` from `posting-worker` and stop it, and remove the `api` service's posting variables. Sweep the balance to the funding account from the operator's machine at once; the thief can race the sweep, and losing it costs only the float.
2. Review who could read the variable (Railway project members, the project token's holders) and rotate those credentials too (T-65). Anyone who could read `POSTING_KEY` could read `POSTING_REDIS_URL` and the database login as well: treat every `m_i` queued or in flight while they had access as read, which costs the voters concerned what a stolen `m_i` costs (T-18), and say so in the incident notes.
3. Generate a new key and start again as in Rotation, step 3. Entries the old key had in flight are tended with the new key's nonce, which no longer matches: clear them first with `DELETE FROM posting_in_flight` as the owner user, so the new key starts with nothing to tend; their clients see no posting and fall back to the voter's own wallet. Their caps rows stay, so none of their postings is paid for twice.
4. What the thief could do with the key: spend its balance. It can't post anything a voter's client didn't make, change or remove anything on the board, or link a posting to anyone beyond what the chain already shows.
5. Record the incident in T-69's history.

## Loss

Losing the key (a deleted variable, a Railway account loss) loses no result: every posting already on the board stays, and nothing else needs the key. Postings in flight are no longer tended; clear them as in Compromise, step 3, and start again with a new key.

## Database backups and wipes

The worker's database holds each sent posting, `m_i` included, in `posting_in_flight` until its event is final or its election's `t_D` passes, and a Railway backup taken meanwhile keeps it for as long as the backup is kept (T-18). Most of them become public on the board within minutes; the ones that don't are those the sequencer drops past the send cutoff or the budget holds back. So keep the environment's Postgres backups at Railway's shortest retention, never copy one off Railway, and delete a restored database's `posting_in_flight` rows whose postings are already on the board before turning the relay back on. That a backup holds `m_i` for its lifetime is known-weak ([[P2-8]]).

Wiping Postgres loses no result, but it loses the caps: every election's spend and paid-for postings start again from nothing, so an election's budget can be spent once more. After a wipe, turn the relay off (Rotation, step 1) until every election open at the wipe has passed its `t_D`, or accept that bound. Before turning it on again, check that the key has no pending transaction (`cast nonce` at `latest` and `pending` agree): the ledger has no record of what it sent, so a pending one would hold a nonce the next send signs at.

## Under seizure

If our hosting or domains are seized (T-49), the relay stops with the API: its index ages out, clients stop relying on it once `POSTING_PATIENCE` passes and fall back to the voter's own wallet, and the board's direct path is open to anyone ([[0042-posting-relay]], rule 6).
