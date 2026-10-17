# @abolishus/node

The community node anyone can run with one command: verifier, IPFS and chain reader, with no database or cache (the brief; `docs/status/P4-5.md`). Internal and source-only; AGPL-3.0-only. It checks what it holds with `@abolishus/crypto` and `@abolishus/verifier` and never reimplements a check.

So far it is a mirror: it serves every block it holds, by CID, to anyone who asks. Fetching what to hold from L1 and IPFS, verifying elections, serving the ballot client and relaying receipt commitments come in later parts (`docs/status/P4-5.md`, Plan).

## Running it

```sh
vp run --filter @abolishus/node start -- serve --blocks <directory> [--port 8080] [--host 127.0.0.1]
```

`<directory>` holds CARv1 files (`*.car`; for example `ipfs dag export <cid> > <name>.car` from any IPFS node). The node reads every one at start (symlinks followed) and prints a line for each, with the blocks it read or why it read none (`not-a-car` or a filesystem error code; the file is skipped), then the address it listens on. It listens on loopback unless `--host` says otherwise. SIGINT or SIGTERM stops it.

## The mirror

| Duty                                                                                                                                                                                                                                                                                                                                      | Spec                                               | Threats    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------- |
| Holds only blocks under a layout CID (`0x01 ‖ raw or dag-pb ‖ sha2-256`) of at most `CHUNK_SIZE` bytes whose SHA-256 is the CID's digest, read with the verifier's block store, so it never serves a corrupt copy; a file cut short still serves the blocks before the cut                                                                | [[content-addressing]]; [[verifier]], Board by CID | T-51, T-52 |
| Answers the raw-block requests of the IPFS trustless gateway API, `GET` or `HEAD /ipfs/{cid}` with `?format=raw` or `Accept: application/vnd.ipld.raw`, with the block, or 404 if it holds none                                                                                                                                           | [[content-addressing]]                             | T-49, T-51 |
| Accepts only a layout CID's canonical text (multibase base32, lowercase), so a block has one URL; no paths below a CID, no CAR or deserialized responses and no page at all, so nothing it serves runs in a browser at its origin                                                                                                         | [[content-addressing]]                             | T-43       |
| Writes nothing about a request: which CIDs a reader fetches can say which election or segment it cares about                                                                                                                                                                                                                              |                                                    | T-11       |
| Bounds its connections: at most 1,024 open (more are closed on accept), headers within 10 s and 8 KiB, a request within 30 s, an idle keep-alive connection 5 s; a request that declares a body is refused and its connection closed, so the body is never read; an error after listening (an accept that fails) is reported, never fatal |                                                    | T-52       |

A reader trusts the node for availability only: every reader in this repository hashes each block against the CID it asked for, and authenticates what it rebuilds against L1.

## Known-weak

- Each CAR file is held in memory whole, and the directory is read once, at start: a new file needs a restart.
- The connection limit is for all clients together, not per address: one client can hold every slot, so a published node needs a proxy's per-address limits in front (T-52).
- No `format=car` responses, so an IPFS client asking for a whole DAG in one request gets 406 and must fetch block by block.

## Tests

`vp run --filter @abolishus/node test`: the CID parser (property tests over every layout CID and arbitrary text), the gateway over loopback (every block of a multi-block object, rebuilt by `readObjectAsync` over HTTP; random sets of objects across files; a corrupt block never served; every refusal) and the command line.
