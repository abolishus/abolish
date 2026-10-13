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

## Releases

Rule 6 of [[0006-trustees]] applies in full (T-61):

- No auto-update. Rebuild the signed, reproducible release yourself (P0-3), check it matches the published one, and publish which release your seat runs.
- Releases roll out one trustee at a time, with a delay between them, so no release reaches `k` nodes before trustees and the public have had time to inspect it.
- Stop the node (`SIGTERM`) between polls to upgrade; the store carries every duty across the restart.

## Logs

The node writes one JSON event per line to stdout: `sent` and `refused` (with the round, the refusal code, `stub_hash` and `run_id`) and `transport` failures. They hold no secret. A refusal is the node doing its job; a run of `transport` events means the coordinator is unreachable, which only costs liveness (T-54).
