# ADR 0043: The anonymiser on a voter's route to a node's own intake

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-27
- Deciders: agent, owner may veto (rule A); who runs a production relay is the owner's (spending, and naming a party that sees voters' addresses)
- Threats addressed: T-11, T-13, T-25, T-15, T-14, T-37, T-39, T-43, T-52, T-54, T-59 (see [[THREAT_MODEL]])

## Context

[[delivery]]'s Client rule 4 has the ballot client, for a seat that isn't receipted, try at least one route to that seat's intake that doesn't pass through the operator before it treats private delivery as failed: "the trustee node's own intake endpoint, which the release lists with the pinned panel, reached through a network anonymiser so the trustee doesn't learn the voter's address (T-11)". The operator's route exists (`apps/api`'s intake relay, [[P2-8]] part 3c-1b-2b-2b-2a, #528), and so does the node's endpoint (`apps/trustee-node`, `POST /v1/intake`, [[P2-13]] part 4b-1); the anonymiser doesn't, so the ballot client's `delivers` stays `false` and no build sends a ballot ([[P2-8]], Part 3c-1b-2b-2b-2b, Known-weak).

What the route has to give:

- **The trustee doesn't learn the voter's address.** A delivery carries the whole ballot record, whose nullifier links the voter's re-votes, so a node that saw the address beside it would join the two forever (T-11).
- **The operator can't block it selectively.** The route exists because an operator that refuses a seat's delivery while keeping the ballot record can board that ballot itself, outranking the voter's earlier ballot and voiding their vote (T-25). One it can drop for some ballots and not others is no second route.
- **Nobody on the path records the share.** Every intake endpoint negotiates TLS 1.3 with `X25519MLKEM768` only, since `ct_i` recorded in transit is exposed to a later quantum break ([[0002-everlasting-privacy]], Consequences; T-15). Whatever the anonymiser terminates must hold to the same.
- **It runs in a browser.** The client is a static SPA whose only third-party runtime is React and the shadcn/ui runtime (`AGENTS.md`, Dependencies), with a pinned CSP whose `connect-src` lists every origin it may reach (T-43). It can't open raw sockets, so it can't speak Tor's protocol itself, and it can't tell whether the browser it runs in sends through an anonymity network.

What is one-way about it: the format a node opens and the keys it opens it with are fixed in every trustee's node and every release's client; and every relay's operator, once chosen, sees voters' addresses at the moment they deliver, which can't be taken back.

## Options

### A. Oblivious HTTP as published, with a gateway key per node

Oblivious HTTP ([RFC 9458](https://www.rfc-editor.org/rfc/rfc9458)) splits a request between a **relay**, which sees the client's address and an encrypted body, and a **gateway**, which opens the body and never sees the address. The body is a Binary HTTP message ([RFC 9292](https://www.rfc-editor.org/rfc/rfc9292)) sealed with HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)) to the gateway's key configuration, and the response is sealed under a key derived from the request's (RFC 9458 §4.4). Each node would be its own gateway, with a key configuration the deployment record lists, using a post-quantum hybrid KEM (X-Wing, `draft-connolly-cfrg-xwing-kem`, as the HPKE KEM `draft-ietf-hpke-pq` names) to keep the share's protection.

Pros: a published, analysed protocol end to end, with test vectors, so third-party relays work unmodified, and a node's gateway could be any conforming implementation.

Cons: a second long-lived key per node, beside the per-election keys the ceremony registers, that the deployment record must publish, a release must rotate and a node must keep: whoever later takes it opens every delivery recorded in transit while it was used, across elections, where the ceremony's keys are destroyed after each tally (T-15, T-14). Its authenticity is only the release's, where the seat's ceremony key is checked against the transcript the client already checks. And it adds HPKE and Binary HTTP to `packages/crypto` (composed from `@noble/*`), both of which the node and the client then carry for this one route.

### B. A delivery sealed to the seat's registered key, carried by an Oblivious HTTP relay

The client seals the node's existing delivery envelope to seat `i`'s **per-election KEM key**, the `kem_key` of the ceremony's key set that `ct_i` is already sealed to ([[share-encryption]], Trustee KEM key), with [[share-encryption]]'s hybrid KEM (ML-KEM-768 and ristretto255 under an X-Wing-style combiner) under tags of its own, as the summed-share message and the nullifier request already reuse that hybrid ([[tally]], Summed-share message; [[nullifier-transport]]), and sends it to that seat's resource on an RFC 9458 **relay**. The relay forwards the opaque body to the node and the answer back, exactly as it would an OHTTP request; it is content-agnostic, so a standard relay deployment works. The node opens it with the `kem_secret` its intake already holds, runs its intake unchanged, and seals its answer under a key derived from the request's shared secret, as RFC 9458 §4.4 derives its response key, so the client needs no key pair of its own.

Pros: no new key to publish, rotate or keep. The key is authenticated by the ceremony transcript the client checks before it seals anything, never by a server, and it dies with the election's secrets at the tally ([[0002-everlasting-privacy]], Consequences), so a recorded delivery is safe from any later theft of the node, as `ct_i` already is. The hybrid is the one every share already rests on, at the same strength, so the route adds no assumption (T-15). The node's intake, its checks and its bounds don't change; only the envelope's outer layer is new.

Cons: the sealed envelope and its answer are this project's format, not RFC 9458's encapsulation, so a node's gateway is ours to specify and test, with our own vectors. A relay must still be told which node a resource forwards to, as any OHTTP relay is configured per gateway.

### C. The voter's own anonymity network

The client sends to the node's endpoint directly, and the voter supplies the anonymity: Tor Browser, or a VPN. A variant bundles a Tor client compiled to WebAssembly (arti) that tunnels through a WebSocket bridge.

Pros: no relay operator to choose or trust; Tor's anonymity set is large.

Cons: the client can't tell whether the browser is behind Tor, so it can't know the route hides anything, and Client rule 4 asks for one that does; a voter not on Tor would send their address beside the ballot record to every node. The client's `connect-src` would have to list every seat's endpoint. The bundled variant is a large third-party runtime in the one place votes are cast, which the bundle allowlist forbids (T-43, T-59), and its bridge is a relay anyway. None of this stops a voter who uses Tor from using option A or B over it.

## Recommendation

**B.** It gives the property Client rule 4 asks for, a trustee that never sees the voter's address and an operator outside the path, with nothing new to trust: the key is the seat's registered one, checked from the transcript and destroyed at the tally, under the hybrid every share already relies on. A gives the same split with a published encapsulation, at the cost of a long-lived key per node whose theft opens every recorded delivery, which is the exposure the per-election keys were chosen to avoid. C can't promise the voter anything, since the client can't see the network it runs on.

What would change it: a browser API for an anonymity network the client could require and detect, or an OHTTP profile with a key a ceremony registers per election, which would let a node's gateway be off the shelf.

## Consequences

- **[[P2-8]] part 3c-1b-2b-2b-2d-2b-2e splits**: 2e-1 is this ADR; 2e-2, the spec (the sealed delivery and its answer, their tags, the padding, the node's route, the relays in a new deployment-record version), with vectors; 2e-3, sealing and opening in `packages/crypto`; 2e-4, the node's sealed intake in `apps/trustee-node`; 2e-5, a relay for staging and a `ci:` change adding its origin to the client's `connect-src`; 2e-6, the client's route, tried after the operator's for each seat that isn't receipted.
- **`connect-src` gains the relays' origins only.** The client never reaches a node's endpoint itself, so no seat's origin joins the CSP, and a node moving host is a relay's configuration, not a release.
- **Author seats follow.** An author panel's seats have no endpoints the release lists; [[P2-16]] part 7 decides where an author panel publishes them and its relays, under this ADR's rules. Until then an author seat's only route is the operator's relay, as [[delivery]] (Version 2) says.
- **Production waits on the owner for its relays.** Staging runs one relay itself, on its own service, which gives no independence from the operator, as staging's transitional panel gives none from its trustees. A production relay must be run by neither the operator nor any of the pinned panel's trustees, and choosing who runs it, and paying them, is the owner's (rule A); it is listed under Blocked once production nears, and it blocks no part before that.
- **Known-weak: a relay and the operator together.** The operator sees the address that tried its own route for a seat and then stopped; a relay that colludes with it sees the same address deliver moments later, and the node then sees which ballot. Together they recover what the route hides, and the operator could drop that ballot's request at the relay. Independence of the relay's operator is the only mitigation; the client's random delay before the second route (rule 6) widens the window an observer must match, no more (T-13, T-25).
- **Known-weak: a relay learns which election.** The request names the key it is sealed to, so the node can pick the election's secret without trying each one, and a relay reads that name: it learns that an address delivered to a seat for that election, when, and how often, never which ballot or option. Padding hides the record's size to within a bucket, so its size adds nothing (T-13). Hiding the election too would have each node try every open election's key on every request, a cost any sender could multiply (T-52).
- **Known-weak: the transitional panel.** While every default seat is ours ([[0027-trustee-panels-and-live-results]]), a node that sees the ballot record is the operator, so the route removes the operator's address from the delivery but not the operator's knowledge of the ballot; it starts to matter as independent trustees take seats.

## Decision

Under rule A (`AGENTS.md`): option B, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. The rules:

1. **When.** For each qualified seat that isn't receipted after the operator's route and its retries, the client tries this route before it treats private delivery as failed and before any posting offer ([[delivery]], Client rule 4), and keeps it among the routes it retries until its own deadline ([[posting-relay]], The ballot's own deadline).
2. **The key.** The delivery is sealed to seat `i`'s `kem_key` taken from the ceremony transcript the client has checked under a pinned panel, never from a relay, the API or the node (T-37, T-43). A seat the client has no checked key for gets no sealed delivery.
3. **The sealing.** [[share-encryption]]'s hybrid KEM, fresh randomness per request, with tags of its own that no other record shares, and a one-time AEAD under a key derived from the KEM's shared secret, as [[nullifier-transport]] seals its request. The request names, in the clear, which election's key it is sealed to, so the node opens it with one key (T-52). The plaintext is the node's delivery envelope (`apps/trustee-node`, README, Intake endpoint), padded to one of a few fixed lengths the spec sets, so its size tells a relay no more than its bucket. The answer (the receipt, a refusal's code, or busy) is sealed under a key derived from the same shared secret and the request's hash, padded to one fixed length, and always sent as a 200, so the relay can't tell a receipt from a refusal. A request the node can't open gets one fixed status and no body (T-39).
4. **The relay.** It speaks RFC 9458's relay role: it takes a `POST` of the sealed bytes at a resource that names one seat's node, forwards only the body to that node's sealed-intake route on a connection of its own, and returns only the answer's body, with no client header passed on and nothing logged of the request beyond a count. The deployment record lists, for each seat of each pinned panel, the relay resources that reach it, and the client sends only to those, on origins its `connect-src` lists (T-43). A relay's operator is neither the operator nor a trustee of the panel it relays for; that is the release Safe's signers' word, which no record can prove.
5. **The node.** A new route beside `POST /v1/intake` opens the request with the election's `kem_secret`, runs the same intake on the envelope inside, and seals its answer. It keeps the existing endpoint's bounds (the body, the queue, the connections; T-52) and its TLS group (`X25519MLKEM768` only), and logs nothing but an outcome; it never learns an address, since its only peer is the relay.
6. **Timing.** The client waits a uniformly random delay, up to a bound the spec sets, between its last failed attempt through the operator and its first request through a relay, so the two aren't adjacent in time to an observer of both (T-13); the delay is cut short if it would carry the attempt past the client's own deadline.
