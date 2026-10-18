# Trustee node

How a trustee runs `apps/trustee-node` for its seat ([[0006-trustees]], Consequences; [[P2-13]]). The node holds the seat's identity key and, during an election, its per-election keys, so whoever controls the node's host or its software reaches the seat's share of every ballot (T-14, T-61). The app's README has the transport and configuration; this page is what the trustee must do around them.

Status: not deployable yet. Until the node checks the electorate against finalized L2 state ([[verifier]] 2.4, P2-13 part 3), `run` refuses every stub with `stub-electorate`, and intake, the tally and destruction are later parts. `local-ceremony` runs a whole ceremony on one machine to try it. The node's image (`ghcr.io/abolishus/abolish-trustee-node`, built and signed by the deploy workflow) runs staging's launch-panel seats on Railway (Staging on Railway, below).

## Host

- One host per seat, under the trustee's own control, at the hosting provider the panel lists for the seat ([[0006-trustees]]), with full-disk encryption and nothing else running on it.
- Outbound HTTPS to the coordinator. Inbound, only the ports you configure: the intake endpoint's (below) and the availability duty's `serve` gateway. Open no other port.
- Keep the clock synchronized (NTP); deadlines are the coordinator's, but logs are only useful with a sane clock.

## Identity key

- The identity secret key is 64 hex digits in a file owned by the user the node runs as, mode `0600` or `0400`, not a symbolic link; the node refuses any other, and a key that isn't the configured seat's. Its public key is the seat's key in the panel registered on chain ([[trustee-identity]]).
- Generate it on the host with `trustee-node keygen --out <file>`, which writes a new `0600` file and prints only the public key to register for the seat. Any copy anyone else holds can sign the seat's approvals (T-37), so keep at most one sealed offline backup; losing every copy loses the seat until the panel is re-registered.

## Store

The store (`store` in the configuration) holds the write-once records every ceremony duty rests on: a run seen, one message per round, at most one round-4 message per run, at most one approval per stub (T-14, T-37).

- **Never restore it from a backup or snapshot, and never run one seat from two hosts.** Either lets a coordinator get a second round-4 message, rejoin a run, or get a second approval, and the node can't detect it. If the store is lost or suspect, stop the node and tell the panel; the seat sits out runs and approvals until the stub it was working on is settled, rather than starting again from an older store.
- Keep it on the encrypted disk, owned by the node's user, mode `0700` (the node refuses a root others can reach). It holds per-election secrets unencrypted until destruction is built (P2-13 part 5).

## Configuration

The JSON file the README describes, with the panel copied from the registered panel and its `panelId` compared out of band with the other trustees: the node refuses a panel whose keys don't hash to that identifier. The coordinator URL must be HTTPS.

## Intake endpoint

With an `intake` section the node serves its seat's intake endpoint (README, Intake endpoint): voters' clients deliver to it directly through a network anonymiser when the operator's route fails, and the operator's relay delivers through it too ([[delivery]], Client rules; T-11). Until the node approves stubs (part 3) it refuses every delivery with `intake-unapproved`.

- **TLS on the node.** Give `tlsCertFile` and `tlsKeyFile` (PEM) and a public `host`: the node then takes TLS 1.3 only, with the hybrid post-quantum group `X25519MLKEM768` and no classical fallback, as [[0002-everlasting-privacy]] requires of every intake endpoint (a recorded share ciphertext is otherwise exposed to a later quantum break). Hold the key as the identity key is (owner-only, never a link): whoever reads it can pose as the endpoint and read each ballot record delivered to it, with the voter's network address, though never a share. A client too old for the group can't connect; it falls back to the operator's route.
- **Or a proxy on the host.** Without the TLS files the node listens only on loopback; a TLS proxy on the same host must then negotiate `X25519MLKEM768` only, and keep no log of addresses or bodies.
- **Publish the URL** (`https://<host>:<port>/v1/intake`) for the release record's panel listing.
- **The queue** (`queue`, 16 by default) bounds the deliveries held at once; past it the node answers 503 with `Retry-After`. Each delivery is checked one at a time, so raise it only with the CPU to drain it.

## Availability duty

With an `availability` section the node also attests, or complains about, each approved election's ballot extent ([[availability]], What a seat does; T-24, T-54). What it needs:

- **Your own nodes.** An L2 node you run, deriving its chain from L1 (its finalized head is what the seat trusts for recorded records, T-71), and an L1 node. A provider's URL may hold its key; the node never prints either URL. An L1 and an L2 URL at one provider trust that provider for everything the seat reads.
- **The deployment's pins**, copied from the release record and compared out of band with the other trustees like the panel: the board anchor with its deployment block and clock (`epoch`, `period`, `deadline`), the election registry and the board with their deployment blocks, and the L2's `OptimismPortal`. A wrong clock or contract makes the seat refuse the election (`availability-error`, `L1AnchorError`) or spend its one attestation on a checkpoint the verifier doesn't count.
- **A paying account.** Its secp256k1 key in its own file, held as the identity key is (owner-only, never a link), and never the identity key itself (the node refuses that). It grants no authority over the board, but whoever reads it can drain it and so keep the seat's records off chain (T-50). Fund it on both chains, enough for one call and one deposit per election at the fee caps; a transaction pays at most `l1MaxFeePerGas` or `l2MaxFeePerGas` a unit of gas, and a pending one's fee is never raised. Run one node per account.
- **Block sources.** Gateways (IPFS, the archive, other seats' `apps/node` mirrors and other seats' nodes), optional, and the `blocks` directory of CAR files, read at start and asked first. Every block is checked against its CID, so a source can only withhold. Each gateway sees which election's objects the seat asks for (T-11).
- **Serving what you attest.** Before it attests, the seat writes every segment object and entry-hash list of the extent to `blocks` as `<cid>.car`, and from then serves them at `serve` (`port`, `host` loopback by default) as an IPFS trustless gateway: raw blocks by CID, nothing else, no request logged. You owe this from the moment you attest, to the other seats and publicly, until the archive confirms them and through the verification period after the seal ([[availability]], What a seat does, 4): publish the port (a reverse proxy may terminate TLS), give its URL to the other seats, and keep the files. To announce them on IPFS, run an IPFS node and import the directory's files (`ipfs dag import`); the trustee node doesn't announce them itself. A disk the seat can't write to stops the node before it attests.
- **The margins.** `sendMarginSeconds` before `c_I` the seat complains if it can't read the extent; `forceAfterSeconds` a record may wait outside an L2 block before it is deposited through L1; from `forceLeadSeconds` before `c_I` every unrecorded record is deposited. The deposit must reach an L1 block by `c_I`, so `forceLeadSeconds` must cover L1's inclusion time at your fee cap, with room to spare.

At start the node checks both nodes' chains and that the board and portal have code, and exits 2 on a mismatch or a `serve` address it can't listen on, or 1 when a node can't be read; a supervisor restarting it covers a node that was briefly down. Events: `serving` (the address it listens on), `availability` (each election's state when it changes: `waiting`, `fetching`, `sent`, `complained`, `recorded`, `past-cutoff`, and the alarms `board-failed`, `no-checkpoint`, `unrecorded`, `foreign-record`) `availability-error` (a node's failure, retried each poll, or a refusal for good) and `availability-abandoned` (`t_A` passed before the election could be read: it was never registered, or your nodes never showed it final). `unrecorded` means a record that can no longer count was never recorded, and `foreign-record` that the seat's per-election key signed bytes this node never stored: tell the panel at once.

## Releases

Rule 6 of [[0006-trustees]] applies in full (T-61):

- No auto-update. Rebuild the signed, reproducible release yourself (P0-3), check it matches the published one, and publish which release your seat runs.
- Releases roll out one trustee at a time, with a delay between them, so no release reaches `k` nodes before trustees and the public have had time to inspect it.
- Stop the node (`SIGTERM`) between polls to upgrade; the store carries every duty across the restart.

## Logs

The node writes one JSON event per line to stdout: `started` (with the intake endpoint's URL when it serves one), `sent` and `refused` (with the round, the refusal code, `stub_hash` and `run_id`), `transport` failures, `intake-error` (an intake that threw, by the error's name only), and the availability duty's events above. They hold no secret. A refusal is the node doing its job; a run of `transport` events means the coordinator is unreachable, which only costs liveness (T-54).

## Staging on Railway

Staging's launch panel runs as seven Railway services, `seat-1` to `seat-7`, from the node's image ([[railway]], Services; [[staging-testnet]]). **This is a staging relaxation, not acceptable for production seats:** the identity key sits in a Railway variable that the project's token and every project member can read, and all seven seats share one provider and one project, so one compromise there is a quorum. Production seats follow Host and Identity key above, on their trustees' own hosts.

What stays: the store rules (Store, above), outbound HTTPS only, and one host per seat.

- **One service, one volume, one replica per seat.** The volume is mounted at `/data` and holds the key file (`/data/identity.key`) and the store (`/data/store`). Never attach it to another service, never restore it from a Railway backup or copy it, and keep the service at one replica: either would run the seat from two stores or roll its store back. A redeploy doesn't overlap two processes on the store: Railway's volume documentation says it never runs two deployments of a service with a volume at once, stopping the old one first (a few seconds' downtime), and the node takes no lock of its own, so that rule is what holds. Losing or replacing the volume is losing the store: stop the seat, remove its service ID from `RAILWAY_SEAT_SERVICE_IDS` and tell the panel. `run-env` refuses a key whose store is gone, but a replacement volume that is empty while `TRUSTEE_IDENTITY_KEY` is still set looks like a first start, which is one more reason for the step below. Railway mounts volumes owned by root, so the service sets `RAILWAY_RUN_UID=0` or the node can't write to it.
- **No inbound.** No public domain and no TCP proxy. The configuration's coordinator is the `api`'s public HTTPS address (the node refuses plain HTTP off loopback); leave out `intake` (it needs an inbound port and TLS) and `availability` (`run-env` can't supply its account key file, and its `blocks` directory must outlive a redeploy).
- **The default command is `run-env --data /data`.** It reads `TRUSTEE_CONFIG` (the `run` configuration above as JSON, without `identityKeyFile` or `store`, which are the volume's) and `TRUSTEE_IDENTITY_KEY` (the key file's contents exactly as `keygen` wrote them), checks the configuration as `run` does and that the key is the configured seat's, then writes the key to `/data/identity.key`, owner-only, only if no key is there yet, and runs `run`. It never replaces a key on the volume: a variable holding another key stops the seat (exit 2), as do a missing `/data` (a seat without its volume would start from an empty store) and a key with no store beside it. Both variables are unset in the process once read, so nothing it spawns inherits them, and neither is ever printed; the kernel keeps the process's initial environment, readable only by its own user or root, as the key file is.
- **Remove the key variable once the seat has started.** The key is then on the volume only, and `run-env` runs from it; a later deployment with the variable unset starts the same seat. Until it is removed, the key is readable by anyone who can read the project's variables.
- **Releases** reach the seats one at a time: the deploy workflow deploys each seat after Railway reports the one before live, and stops at a deployment Railway reports failed ([[railway]], Deploying). With no port or health check, Railway reports a seat live once its container starts, so one that exits a moment later may not stop the next. Rule 6's delay between trustees (Releases, above) doesn't hold here: a release reaches all seven seats in one run, so a malicious one isn't contained, another part of the staging relaxation.
