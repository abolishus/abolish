# Nullifier transport

How a client's Tier 2 query reaches each seat and each seat's answer comes back, encrypted end to end ([[0022-tier2-keyed-nullifier]], Consequences, Channels): the nullifier request (record type `0x0022`, version 1), which seals one query to one seat's registration KEM key and names a fresh client key for the reply, the nullifier reply (record type `0x0023`, version 1), which seals that seat's answer to the client key, and the checks each side makes before it opens or uses either. The query and its checks are [[nullifier-query]]'s, the answer and its check [[keyed-nullifier]]'s, the registration KEM keys [[nullifier-key]]'s (and [[nullifier-reshare]]'s for a successor key), and the hybrid KEM, its key format and its combiner [[share-encryption]]'s. Notation is from [[notation]]. Threats: T-15, T-13, T-21, T-30, T-31, T-39.

What this page doesn't cover yet (P3-4 part 2b-4's later steps): the identity chain behind `comm_in` and its checks, the output's transport to the attesters with the attestation's position and quorum, the delivery of `N` to every seat, the published probe counts, and [[verifier]] 2.4's count of attested additions.

## Sources

- **The KEM:** [[share-encryption]]'s hybrid of ML-KEM-768 (FIPS 203) and Diffie–Hellman in ristretto255, with its X-Wing-style combiner (D. Connolly, P. Schwabe and B. Westerbaan, `draft-connolly-cfrg-xwing-kem`) under this page's own tags, as the dealt share of [[nullifier-key]] uses it.
- **The AEAD:** ChaCha20-Poly1305, RFC 8439 §2.8, one message per key under a zero nonce.
- **KEM–DEM:** a KEM that is IND-CCA with a one-time AEAD gives an IND-CCA public-key encryption (R. Cramer and V. Shoup, "Design and Analysis of Practical Public-Key Encryption Schemes Secure against Adaptive Chosen Ciphertext Attack", SIAM J. Comput. 2003, §7), which is what lets a seat say whether a request opened (Request check).

## Why the channel

A query and its answers are, to an adversary who later solves discrete logs in Baby Jubjub's group, a pair `(B, Z_i = sk_i · B)` that gives `sk_i`, and `k` such pairs give `sk` and every document's `N` from its chip data ([[keyed-nullifier]], Security notes; T-15). The query also carries the identity commitment and `comm_in`, and its proof's witness the salted hashes of `dg1` ([[nullifier-query]], What it reveals). Sent in the clear, all of it would be harvested by whoever relays or watches the traffic. Sealed under the hybrid KEM it is readable only by the seat it was sent to and by the client, while either ML-KEM-768 or discrete logs in ristretto255 hold ([[0022-tier2-keyed-nullifier]]: "encrypting every message of the protocol under the hybrid KEM narrows it to clients and trustees").

Requests go to the seats' **registration** KEM keys, which live as long as the seat's share of `sk` ([[nullifier-key]], Parties and keys), not to a per-election key, which is destroyed after each tally while registration happens between elections. Replies go to a **client key** made fresh for each query, so nothing the client holds after a query can open another query's replies.

## Client key

For each query (each `query_id`, [[nullifier-query]], The query) the client generates a fresh KEM key pair as [[share-encryption]] (Trustee KEM key) generates one, from its CSPRNG: `reply_key = (ek_c, dh_c)` and its secret `(seed_c, x_c)`. It names the same `reply_key` in the request to every seat of that query, and never in any other query's. It keeps the secret only until it has combined `k` checked answers or abandons the query, then erases it.

One key per query, rather than one per seat, links nothing the query doesn't: every seat already receives the same query, under the same `query_id`, `query_hash` and `B`. A key reused across queries would link them to whoever sees requests in transit, and would let anyone who later took the client's secret open every reply it ever received.

## Request

Record type `0x0022`, version 1. Never on the board, the chain or the archive, and never pinned by a profile: the Tier 2 key fixes its version (versions 1 and 2 of the key transcript, [[nullifier-key]], and version 1 of the reshare transcript, [[nullifier-reshare]], fix version 1), as it fixes the query's.

| Field       | Type                        | Meaning                                                                                                                       |
| ----------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `key_id`    | `bytes[32]`                 | The key the query is asked under ([[nullifier-key]], Transcript; [[nullifier-reshare]] for a successor key)                   |
| `seat`      | `u8`                        | `i`, the qualified seat of that key it is sealed to                                                                           |
| `reply_key` | `kem_key`                   | The client key for this query ([[share-encryption]], Trustee KEM key: the modulus check on `ek`, and `dh` never the identity) |
| `ct_mlkem`  | `bytes[1088]`               | `ct_M`                                                                                                                        |
| `ct_dh`     | `element`                   | `ct_DH`. Never the identity, as in [[share-encryption]]                                                                       |
| `sealed`    | `bytes<MAX_REQUEST_SEALED>` | The AEAD output: the query record's full encoding ([[nullifier-query]], Query record), header included, and the 16-byte tag   |

`MAX_REQUEST_SEALED = 65,787` bytes: the longest query record version 1 can encode (3 bytes of header, 228 bytes of fields before the proof, and the proof's 4-byte length and at most 65,536 bytes) and the tag. A query with a proof of the proving system's length (14,656 bytes, [[nullifier-query]], Keys and proofs) seals to 14,907 bytes, and its request is 17,283 bytes.

**Encryption.** With seat `i`'s registration `kem_key = (ek_i, dh_i)`, taken from the checked key ([[nullifier-key]], Transcript check: the key's output lists each qualified seat's `kem_key`; for a successor key, [[nullifier-reshare]], Transcript check), never from the seat or a relay, the client draws 32 bytes `μ` and a scalar `e`, uniform on 1 to `ℓ − 1`, from its CSPRNG, fresh for every request, and computes:

```
(ss_M, ct_M) = ML-KEM-768.Encaps_internal(ek_i, μ)
ct_DH        = g^e
ss_DH        = dh_i^e
K            = H(DS("abolish/v1/kem/nullifier-request", ss_M ‖ encode(ss_DH) ‖ encode(ct_DH) ‖ encode(dh_i)))
aad          = DS("abolish/v1/kem/nullifier-request-aad",
                 u16(0x0022) ‖ u8(1) ‖ key_id ‖ u8(i) ‖ encode(reply_key))
sealed       = ChaCha20-Poly1305.Seal(K, nonce = 12 zero bytes, aad, encode(query))
```

`K` is [[share-encryption]]'s combiner under this page's tag, so a request opens only with seat `i`'s registration secret, and each `K` seals one message. `aad` binds the record type and version, the key, the seat and the client key, so a relay that swaps in a reply key of its own, or moves the request to another seat or key, makes it fail to open: only someone who knows the query can name a reply key for it. The query's own `key_id` must be the request's (Request check).

The request's hash, which the reply binds, is

```
request_hash = H(DS("abolish/v1/keyed-nullifier/request", encode(request)))
```

over the record's full encoding, header included.

### Request check

Seat `i`'s node, holding the registration secret of each key it holds a share of, checks a request in this order, and the first failure is the result:

| Code                | Check                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request-malformed` | It decodes strictly as version 1 ([[notation]], Strict decoding); `reply_key` passes the modulus check and its `dh` isn't the identity, and `ct_dh` isn't the identity                             |
| `request-key`       | `key_id` is a key the seat holds a share of, and not a retired one ([[nullifier-reshare]], Approval: a predecessor is retired once its successor counts), and `seat` is the seat's own index in it |
| `request-decrypt`   | `ss_M = ML-KEM-768.Decaps_internal(dk_i, ct_M)`, `ss_DH = ct_DH^{x_i}`, with `(dk_i, x_i)` the seat's registration secret for `key_id`, and `K` and `aad` as above; the AEAD opens                 |
| `request-query`     | The plaintext decodes strictly as a query record of the version the key fixes ([[nullifier-query]], Query record), and its `key_id` is the request's                                               |

Then the seat runs the query check on the query ([[nullifier-query]], Query check), and answers only if it passes ([[keyed-nullifier]], Evaluation).

A request that fails gets no reply record: the node answers the transport with the failing code alone, and with the query check's code for a query that fails it. The codes say which check failed and nothing else; in particular the node never returns `ss_M`, `ss_DH`, `K` or the plaintext of a request that failed (ML-KEM's implicit rejection makes `Decaps` return a pseudorandom secret for a malformed `ct_M`, and revealing it would leak `dk_i`, [[share-encryption]], Decryption). Saying only whether the AEAD opened is what an IND-CCA public-key encryption allows its decryption oracle to say (Sources, KEM–DEM): the hybrid KEM is IND-CCA while either half is, ML-KEM-768 by its Fujisaki–Okamoto transform and the Diffie–Hellman half, whose shared secret the combiner hashes with both public values, under the strong Diffie–Hellman assumption in the random-oracle model, as for DHIES. Its registration key is long-lived and anyone can send it requests, so this is what keeps those requests from teaching anyone about it (T-39).

The order puts the cheap checks first: decoding and a lookup, then one decapsulation and one ristretto255 multiplication, then the query check, whose last step, the query proof, is the costly one ([[nullifier-query]], Query check). Anyone can make a request that passes `request-decrypt` (the KEM key is public), so a node bounds the rate at which it runs query proofs, whoever relays the requests (T-13).

## Reply

Record type `0x0023`, version 1, under the same rules as the request: never on the board, the chain or the archive, never pinned by a profile, and fixed by the Tier 2 key.

| Field          | Type          | Meaning                                                                                                        |
| -------------- | ------------- | -------------------------------------------------------------------------------------------------------------- |
| `request_hash` | `bytes[32]`   | The request answered                                                                                           |
| `seat`         | `u8`          | `i`, the answering seat; the request's `seat`                                                                  |
| `ct_mlkem`     | `bytes[1088]` | `ct_M`                                                                                                         |
| `ct_dh`        | `element`     | `ct_DH`. Never the identity                                                                                    |
| `sealed`       | `bytes[372]`  | The AEAD output: the answer record's full encoding (356 bytes, [[keyed-nullifier]], Answer record) and the tag |

The reply is 1,528 bytes. **Encryption.** With the request's `reply_key = (ek_c, dh_c)`, seat `i` draws 32 bytes `μ` and a scalar `e`, uniform on 1 to `ℓ − 1`, from its CSPRNG, fresh for every reply, and computes:

```
(ss_M, ct_M) = ML-KEM-768.Encaps_internal(ek_c, μ)
ct_DH        = g^e
ss_DH        = dh_c^e
K            = H(DS("abolish/v1/kem/nullifier-reply", ss_M ‖ encode(ss_DH) ‖ encode(ct_DH) ‖ encode(dh_c)))
aad          = DS("abolish/v1/kem/nullifier-reply-aad", u16(0x0023) ‖ u8(1) ‖ request_hash ‖ u8(i))
sealed       = ChaCha20-Poly1305.Seal(K, nonce = 12 zero bytes, aad, encode(answer))
```

Its own tags keep a reply from ever opening as a request, or as any other message sealed under the hybrid KEM, and the reverse. `aad` binds the request it answers, and through `request_hash` the key, the seat, the client key and the sealed query, so a reply opens only as the answer to that request. A seat answering the same request again seals afresh: the answer is the same statement (its evaluation proof's nonce may differ), and the client takes whichever arrives.

### Reply check

The client checks a reply to the request it sent to seat `i`, in this order, and the first failure is the result:

| Code              | Check                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reply-malformed` | It decodes strictly as version 1; `ct_dh` isn't the identity                                                                                                     |
| `reply-request`   | `request_hash` is the hash of the request the client sent to seat `i`, and `seat` is `i`                                                                         |
| `reply-decrypt`   | `ss_M = ML-KEM-768.Decaps_internal(dk_c, ct_M)`, `ss_DH = ct_DH^{x_c}`, with `(dk_c, x_c)` the query's client secret, and `K` and `aad` as above; the AEAD opens |
| `reply-answer`    | The plaintext decodes strictly as an answer record of the version the key fixes ([[keyed-nullifier]], Answer record)                                             |

Then the client runs the answer check ([[keyed-nullifier]], Answer check) with its own query's `query_hash` and `B` and the key it checked, never values the reply supplies, and combines only answers that pass. A reply that fails any check is dropped, and the client may ask that seat again with the same request, or ask another qualified seat with a request of its own. The answer's signature, not the channel, is what attributes an answer to its seat (T-29): the client key is unauthenticated, so the channel says only that whoever sealed the reply read the request.

## Path

The client sends each request to its seat's node either through the API's relay or straight to the node, and takes the reply from the same path. The channel needs no trust in the path: a relay sees `key_id`, the seat, the client key, the sizes and the timing, never the query, its commitment, `comm_in`, `B`, the proof or the answers. It can withhold, delay or drop a request or a reply (which costs liveness; the client asks again or by another path), and can replay a request to its seat, which seals a fresh reply to the same client key, readable only by the client. Moving a request to another seat or key, or naming another client key, fails `request-decrypt`; changing a reply fails `reply-decrypt`.

## Retention

- **The seat** keeps the request, its plaintext query and proof, `ss_M`, `ss_DH` and `K` only until it has replied or refused, then erases them ([[nullifier-query]], What it reveals: the proof's witness holds the salted hashes of `dg1`; T-15). What it keeps of a query for the published probe counts is part 2b-4's, and never the query, its proof or `B`.
- **The client** keeps each request only until its reply passes or it abandons that seat, and the client secret until it has combined `k` answers or abandons the query (Client key). It never posts a request or a reply anywhere.
- **Neither** record is put on the board, the chain, IPFS or the archive, or in any log, request log or analytics event: the API's relay logs no request body and no reply body, as for every route that carries secrets ([[0022-tier2-keyed-nullifier]], Consequences, Channels; T-15).

## Security notes

- **What the channel protects.** A request or reply recorded in transit stays secret while either ML-KEM-768 or discrete logs in ristretto255 hold ([[share-encryption]], Ciphertext, The combiner). An adversary who later breaks both reads it, and so learns that query's `(B, Z_i)` pairs as the seats and the client always could; one who breaks only Baby Jubjub's discrete logs, but neither half of the KEM, learns nothing from traffic and must make its own query, which needs a document and a query proof ([[nullifier-query]], Security notes). This narrows [[0022-tier2-keyed-nullifier]]'s second limit from anyone who watched the traffic to the clients and the seats (T-15).
- **A seat sees its own requests.** Seat `i` opens every request sent to it, and so holds the query and its `(B, Z_i)` until it erases them. A corrupt seat that keeps them breaks the retention rule, and a later break of the assumptions behind the query proof's zero knowledge shows it the holder's `x` ([[nullifier-query]], What it reveals). A corrupt seat can also seal a query it received to another seat with a client key of its own and learn that seat's `(B, Z_j)`: the query proof binds the query to its key, scope, group and commitment, not to a client key, so nothing stops it. It gains pairs for queries it already holds, which no more than its own registration would give a discrete-log adversary ([[0022-tier2-keyed-nullifier]], second limit), and the answer is useless without `r` (T-21).
- **No sender authentication.** Neither record says who sent it. The request needs none: the query proof shows its client holds a document's `x` inside an identity-chain commitment, and the answers go only to whoever chose the client key. The reply needs none: the answer's own signature and proof attribute it to its seat, and the client checks both ([[keyed-nullifier]], Answer check).
- **Traffic analysis.** Requests and replies have fixed lengths for a given proving system (the proof's length is fixed, [[nullifier-query]], Keys and proofs), so their sizes say nothing beyond "a Tier 2 query". Their timing, and the network address they come from, are visible to the relay and the nodes, and a registration's timing can be compared with the attestation that later reaches the board (T-13). Sending through an anonymising network is the client's choice; nothing here requires it.
- **One key, one message.** Each `K` hashes a fresh 256-bit `μ` and a fresh `e`, so the zero nonce never repeats under a key. `packages/crypto` draws both itself and accepts them from a caller only in its tests ([[share-encryption]], Ciphertext, Notes).
- **Not constant time everywhere.** As [[share-encryption]]: the ristretto255 multiplications by secrets use `@noble/curves`' constant-time ladder and ML-KEM is `@noble/post-quantum`'s, but secrets can't be zeroised in JavaScript (T-39).

## Test vectors

`docs/spec/vectors/nullifier-transport.json` ([[vectors/README|vectors]]): the key and the two queries of `nullifier-query.json`, each seat with a registration KEM key made from fixed seeds; for each query, a client key, and a request to every seat re-made byte for byte from its `μ` and `e`, with `ss_M`, `ss_DH`, `K`, `aad`, the record and `request_hash`, and each seat's reply to it carrying that seat's answer from `nullifier-query.json`, re-made the same way; requests failing each code (a trailing byte, an identity `ct_dh`, a `reply_key` whose `dh` is the identity or whose `ek` fails the modulus check, a sealed length over its bound, another key, another seat, a reply key swapped after sealing, a bit flipped in `sealed`, a request opened with another seat's secret, a plaintext that isn't a query record, and a query under another `key_id`) and replies failing each code (a trailing byte, an identity `ct_dh`, another request, another seat, a bit flipped in `sealed`, a reply opened with another query's client secret, and a plaintext that isn't an answer record). They are printed by `packages/crypto/scripts/nullifier-transport-vectors.py`, which reuses `share-encryption-vectors.py`'s ML-KEM-768, ChaCha20-Poly1305 and ristretto255 code (checked against Go's accumulated FIPS 203 vectors and RFC 8439 §2.8.2 first) and takes its queries and answers from `nullifier-query.json`; it shares nothing with `packages/crypto` or any `@noble` library.
