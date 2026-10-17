# @abolishus/node

The community node anyone can run with one command: verifier, IPFS and chain reader, with no database or cache (the brief; `docs/status/P4-5.md`). Internal and source-only; AGPL-3.0-only. It checks what it holds with `@abolishus/crypto` and `@abolishus/verifier` and never reimplements a check.

So far it is a mirror and a pinner: it serves every block it holds, by CID, to anyone who asks, and it fetches into that directory every board object the board anchor's checkpoints name on L1. Verifying elections, serving the ballot client and relaying receipt commitments come in later parts (`docs/status/P4-5.md`, Plan).

## Running it

```sh
vp run --filter @abolishus/node start -- serve --blocks <directory> [--port 8080] [--host 127.0.0.1]
```

`<directory>` holds CARv1 files (`*.car`; for example `ipfs dag export <cid> > <name>.car` from any IPFS node). The node reads every one at start (symlinks followed) and prints a line for each, with the blocks it read or why it read none (`not-a-car` or a filesystem error code; the file is skipped), then the address it listens on. It listens on loopback unless `--host` says otherwise. SIGINT or SIGTERM stops it.

To pin every election's board from L1:

```sh
vp run --filter @abolishus/node start -- fetch --blocks <directory> --l1 <url> --anchor <address> --gateway <url>... [--from-block <n>] [--max-bytes <n>]
```

`--l1` is an Ethereum node's JSON-RPC URL (your own is best: it is trusted for which block is finalized, and nothing else); `--anchor` the board anchor's address the release pins; `--gateway` up to 16 IPFS trustless gateways (`apps/node serve` is one), asked in order; `--from-block` the anchor's deployment block, so logs aren't read from genesis; `--max-bytes` the most one election's objects may take (1 GiB by default). It prints the finalized block it read, then a line for each election (its proven checkpoints, or the L1 error that kept them from being proven) and for each object (`pinned`, `held`, `unavailable`, `inconsistent` or `over-budget`), then the logs it refused and its gateway requests. It exits 0 when done, whatever it couldn't fetch, 1 if L1 couldn't be read and 2 on bad usage. A running `serve` reads the directory only at start: restart it to serve what `fetch` added.

## The mirror

| Duty                                                                                                                                                                                                                                                                                                                                      | Spec                                               | Threats    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------- |
| Holds only blocks under a layout CID (`0x01 ‖ raw or dag-pb ‖ sha2-256`) of at most `CHUNK_SIZE` bytes whose SHA-256 is the CID's digest, read with the verifier's block store, so it never serves a corrupt copy; a file cut short still serves the blocks before the cut                                                                | [[content-addressing]]; [[verifier]], Board by CID | T-51, T-52 |
| Answers the raw-block requests of the IPFS trustless gateway API, `GET` or `HEAD /ipfs/{cid}` with `?format=raw` or `Accept: application/vnd.ipld.raw`, with the block, or 404 if it holds none                                                                                                                                           | [[content-addressing]]                             | T-49, T-51 |
| Accepts only a layout CID's canonical text (multibase base32, lowercase), so a block has one URL; no paths below a CID, no CAR or deserialized responses and no page at all, so nothing it serves runs in a browser at its origin                                                                                                         | [[content-addressing]]                             | T-43       |
| Writes nothing about a request: which CIDs a reader fetches can say which election or segment it cares about                                                                                                                                                                                                                              |                                                    | T-11       |
| Bounds its connections: at most 1,024 open (more are closed on accept), headers within 10 s and 8 KiB, a request within 30 s, an idle keep-alive connection 5 s; a request that declares a body is refused and its connection closed, so the body is never read; an error after listening (an accept that fails) is reported, never fatal |                                                    | T-52       |

## The pinner

| Duty                                                                                                                                                                                                                                                                                                                                                                          | Spec                                                                             | Threats          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------- |
| Reads the finalized L1 block's header, refused unless the fields the node gives hash to its block hash, and proves every word it uses against that block's state root with the verifier's own reader (`anchorsFromState`): the lowest-segment word and each segment's checkpoint word, from the lowest anchored segment to the highest logged one                             | [[contracts]], Board anchor, Verification; [[verifier]], Anchors from L1         | T-24, T-36       |
| Finds checkpoints in the anchor's `CheckpointAnchored` logs, decoded only in the one layout the contract emits and only if the checkpoint hashes to the logged hash, and counts one only if its hash is the proven word for its election and segment; a proven word no log matches (a withheld log) leaves that election unpinned and reported (`l1-checkpoint-unknown`)      | [[contracts]], Board anchor, Events                                              | T-24, T-53       |
| Reads each counted checkpoint's segment object and entry-hash list with `packages/crypto`'s bounded reader, the directory's own blocks first, then each gateway in turn, every block hashed against its CID; an object is bounded by the entries of its checkpoint's run (51 bytes plus `MAX_BOARD_PAYLOAD` each, or 32 bytes each for the list) and by a budget per election | [[board]], A copy from L1's CIDs; [[content-addressing]], Reading within a bound | T-49, T-51, T-52 |
| Writes each object as its own canonical CARv1, `<cid>.car`, through a temporary file and a rename, and leaves a file that already holds exactly those bytes alone                                                                                                                                                                                                             | [[content-addressing]]                                                           | T-51             |

A reader trusts the node for availability only: every reader in this repository hashes each block against the CID it asked for, and authenticates what it rebuilds against L1.

## Known-weak

- Each CAR file is held in memory whole, and the directory is read once, at start: a new file needs a restart.
- The connection limit is for all clients together, not per address: one client can hold every slot, so a published node needs a proxy's per-address limits in front (T-52).
- No `format=car` responses, so an IPFS client asking for a whole DAG in one request gets 406 and must fetch block by block.
- `fetch` trusts its L1 node for which block is finalized, as the verifier trusts its header today, and for the logs: a node can hide checkpoints (it can't make the node pin anything else), so an operator should name a node they run.
- `fetch` runs once and stops: pinning continuously needs a scheduler, and `serve` a restart, until the one-command packaging (part 5).
- It reads every log of the anchor from `--from-block` in one `eth_getLogs` request, which hosted nodes may refuse over a long range.
- Each gateway named sees which CIDs, and so which elections, the node pins (T-11). The objects a node pins are public by design.

## Tests

`vp run --filter @abolishus/node test` (`anvil` and `forge` on `PATH`, from `.github/scripts/install-toolchain.sh`): the pinner against the board anchor on Anvil, through an L1 node that lies (forged, withheld and altered logs, a wrong lowest segment, altered proof nodes, a header that doesn't hash to its block) and gateways that withhold or alter blocks; the log decoder (property tests over every checkpoint and every nibble changed); the JSON-RPC client; the CID parser (property tests over every layout CID and arbitrary text), the gateway over loopback (every block of a multi-block object, rebuilt by `readObjectAsync` over HTTP; random sets of objects across files; a corrupt block never served; every refusal) and the command line.
