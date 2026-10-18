# Trustee node

How a trustee runs `apps/trustee-node` for its seat ([[0006-trustees]], Consequences; [[P2-13]]). The node holds the seat's identity key and, during an election, its per-election keys, so whoever controls the node's host or its software reaches the seat's share of every ballot (T-14, T-61). The app's README has the transport and configuration; this page is what the trustee must do around them.

Status: not deployable yet. Until the node checks the electorate against finalized L2 state ([[verifier]] 2.4, P2-13 part 3), `run` refuses every stub with `stub-electorate`, and intake, the tally and destruction are later parts. `local-ceremony` runs a whole ceremony on one machine to try it.

## Host

- One host per seat, under the trustee's own control, at the hosting provider the panel lists for the seat ([[0006-trustees]]), with full-disk encryption and nothing else running on it.
- Outbound HTTPS to the coordinator only. Nothing listens on the node: open no inbound port.
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

The node writes one JSON event per line to stdout: `sent` and `refused` (with the round, the refusal code, `stub_hash` and `run_id`), `transport` failures, and the availability duty's events above. They hold no secret. A refusal is the node doing its job; a run of `transport` events means the coordinator is unreachable, which only costs liveness (T-54).
