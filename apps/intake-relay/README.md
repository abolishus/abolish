# @abolishus/intake-relay

The relay a ballot client sends a sealed delivery through to a trustee node's own intake, so the node never learns the voter's address ([[sealed-delivery]], The relay; [[0043-intake-anonymiser]], Decision, rule 4; `docs/status/P2-8.md`). Internal and source-only; AGPL-3.0-only. It plays RFC 9458's relay role and nothing more: the request and the answer are sealed between the client and the node, so the relay can't read or forge either (T-25), and it reads neither. Its only use of `@abolishus/crypto` is the two lengths it bounds bodies by.

Staging runs one, on its own service, which gives no independence from the operator ([[0043-intake-anonymiser]], Consequences). A production relay is run by neither the operator nor a trustee of the panel it relays for, which the owner chooses ([[STATUS]], Blocked, once production nears).

## What it does

For each resource it serves, at `/<path>` exactly as the deployment record lists it ([[deployment]], `relay`; T-31), it is configured with one node and:

| Request                                                         | Answer                                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` of a `message/ohttp-req` body up to `MAX_SEALED_REQUEST` | The body alone sent to the node's `POST /v1/sealed-intake`, then the node's status, with its body as `message/ohttp-res` for a 200 and no body for an error |
| The node unreachable, timed out, or answering anything else     | 502, no body                                                                                                                                                |
| A declared length past `MAX_SEALED_REQUEST`, or a streamed one  | 413, no body, before the node is asked                                                                                                                      |
| Another media type; another method; another path or a query     | 415; 405 (`OPTIONS` is a browser's preflight, 204); 404                                                                                                     |
| `queue` bodies already held; an address past `rate`'s limit     | 503 or 429, with `retry-after: 5`                                                                                                                           |

- **No header of the client's reaches the node** (T-11): it sends only `content-type` and `content-length`, on its own connection, never the client's address, `Forwarded`, `Via`, cookie, user agent or language. The node answers to the relay's address.
- **No header of the node's reaches the client** but the media type; every answer carries `cache-control: no-store` and `access-control-allow-origin: *`, since the client is a page on the ballot's origin and a request carries no credential.
- **TLS to the node is 1.3 only, with `X25519MLKEM768` and no other group**, as the node's route requires, so the leg a share takes from the relay is as strong as every other (T-15). A node whose certificate no public CA signs is pinned with `ca`. Plain HTTP goes only to a loopback address, for a TLS proxy on the same host.
- **It keeps nothing of any one request** (T-13): it logs, once an hour, each resource's count of requests and of those the node gave no answer to, and an internal error by name. A rate limit's addresses are held in memory for one window, never logged, and dropped when it ends; at most `MAX_TRACKED_ADDRESSES` (65,536) per window, past which a new address goes unlimited until the next, so addresses enough to fill the table can't hold every other client off (T-54). The node never sees an address, so it can't limit by one.
- **Its bounds** are the node route's (T-52): `queue` bodies held at once across every resource, 4 connections per place, 10 s for headers and 30 s for a request, and `timeoutSeconds` for the whole exchange with the node, a deadline rather than an idle timeout, so a node trickling its answer can't stretch it. One resource holds at most half the queue's places, so a stalled or unreachable node can't take every seat's sealed route with it (T-25).

It listens in plain HTTP: the host's edge terminates the client's TLS. The client's leg is HTTPS, which hides the request from the network but not from the relay or the edge; the envelope inside is sealed to the seat either way.

## Configuration

`RELAY_CONFIG`, JSON (`src/config.ts`; unknown fields are refused, and an error names the field and the rule, never its value):

| Field            | Meaning                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`, `port`   | Where it listens                                                                                                                                                                                                                                                                                                                                |
| `queue`          | Bodies held at once, 1 to 1024 (16)                                                                                                                                                                                                                                                                                                             |
| `timeoutSeconds` | How long the exchange with the node may take, 1 to 300 (60)                                                                                                                                                                                                                                                                                     |
| `resources`      | 1 to 128 of `{ path, node, ca? }`: `path` empty or by [[release]]'s path grammar, each once; `node` the node's origin, `https://`, or `http://` on a loopback address only; `ca` a PEM                                                                                                                                                          |
| `rate`           | Optional `{ requests, windowSeconds, addressHeader? }`: at most `requests` per address per fixed window. `addressHeader` names the header the host's edge sets to the client's address, whose last value is the edge's; without it, or when that value isn't an IP address, the socket's peer is the address. An IPv6 address counts by its /64 |

## Scripts

- `vp run --filter @abolishus/intake-relay build`: the bundle in `dist/` the image runs (`Dockerfile`).
- `vp run --filter @abolishus/intake-relay test`: the relay against stand-in nodes, over TLS too, the configuration's rules and the packed bundle.
