# Sealed delivery

How a ballot client delivers a ballot to a trustee node's own intake without the node learning the voter's address, under [[0043-intake-anonymiser]]: the delivery envelope the node's intake takes and its padding, the sealed delivery (record type `0x0027`, version 1), which seals the padded envelope to the seat's per-election KEM key, the sealed answer (record type `0x0028`, version 1), sealed under a key derived from the request's, the node's route, the relay between them, and the client's rules. Intake itself, and the receipt it returns, are [[share-encryption]]'s (Intake and receipts); the hybrid KEM, its key and its combiner are [[share-encryption]]'s too; when the client tries this route is [[delivery]]'s Client rule 4. Notation is from [[notation]]. Threats: T-11, T-13, T-25, T-15, T-14, T-37, T-39, T-43, T-52, T-54.

What this page doesn't cover yet ([[P2-8]] part 3c-1b-2b-2b-2d-2b-2e):

- **Which relays reach which seat.** The deployment record's next version lists, for each seat of each pinned panel, the relay resources that reach its node (part 2e-2b). Until a release names one, a client has no relay and doesn't use this route.
- **Building it.** Sealing and opening in `packages/crypto` (2e-3), the node's route in `apps/trustee-node` (2e-4), a relay for staging (2e-5) and the client's route (2e-6).
- **Author seats.** An author panel's seats publish no endpoint a release lists, so they get no sealed delivery until [[P2-16]] part 7 says where an author panel publishes its relays.

## Sources

- **The KEM:** [[share-encryption]]'s hybrid of ML-KEM-768 (FIPS 203) and Diffie–Hellman in ristretto255, with its X-Wing-style combiner (D. Connolly, P. Schwabe and B. Westerbaan, `draft-connolly-cfrg-xwing-kem`) under this page's own tags.
- **The AEAD:** ChaCha20-Poly1305, RFC 8439 §2.8, one message per key under a zero nonce.
- **KEM–DEM:** a KEM that is IND-CCA with a one-time AEAD gives an IND-CCA public-key encryption (R. Cramer and V. Shoup, SIAM J. Comput. 2003, §7), as [[nullifier-transport]] (Sources) relies on, which is what lets a node say whether a request opened.
- **The relay and the answer's key:** Oblivious HTTP, [RFC 9458](https://www.rfc-editor.org/rfc/rfc9458): the relay's role (§2, §5.2) and its media types (§9), and the response key derived from the request's secret, the request and a fresh response nonce (§4.4). The encapsulation is this page's, not RFC 9458's ([[0043-intake-anonymiser]], option B), so an RFC 9458 relay carries it unmodified, but an RFC 9458 gateway can't open it.

## Values

| Name                  | Value                       | Meaning                                                                                                                                                           |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_DELIVERY_FIELD`  | 1,048,576                   | 2²⁰: the largest field of the delivery envelope                                                                                                                   |
| `MAX_DELIVERY`        | 4,194,320                   | The largest envelope: four fields of `MAX_DELIVERY_FIELD` bytes and their lengths, the node's `POST /v1/intake` bound                                             |
| `PAD_BUCKETS`         | 2¹⁴, 2¹⁵, …, 2²², 4,194,320 | The lengths a padded envelope may have, in bytes: the powers of two from 16 KiB to 4 MiB, then `MAX_DELIVERY`                                                     |
| `MAX_SEALED_REQUEST`  | 4,195,495                   | The longest sealed delivery: 1,159 bytes before the sealed envelope, then `MAX_DELIVERY` and the tag                                                              |
| `ANSWER_PLAINTEXT`    | 256                         | The length of every answer's plaintext                                                                                                                            |
| `MAX_ANSWER_BODY`     | 251                         | The longest body an answer carries: `ANSWER_PLAINTEXT` less the outcome and the body's length. A share receipt record is 164 bytes (version 1) or 165 (version 2) |
| `MAX_REFUSAL_CODE`    | 64                          | The longest refusal code an answer carries                                                                                                                        |
| `SEALED_DELAY_MAX_MS` | 30,000                      | The longest random delay before the first sealed request of a cast's delivery (Client rules)                                                                      |

## Delivery envelope

What a node's intake takes for one ballot, through `POST /v1/intake` (`apps/trustee-node`'s README, Intake endpoint) or sealed:

| Field        | Type                        | Meaning                                                                                                                          |
| ------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `stub`       | `bytes<MAX_DELIVERY_FIELD>` | The election's stub ([[election-definition]], Stub hash and the ceremony), the definition with `ceremony_transcript_hash` zeroed |
| `transcript` | `bytes<MAX_DELIVERY_FIELD>` | The ceremony transcript the seat approved for that stub ([[ceremony]])                                                           |
| `record`     | `bytes<MAX_DELIVERY_FIELD>` | The ballot record (`0x0002`), its membership proof included ([[ballot-validity]], Ballot record)                                 |
| `ciphertext` | `bytes<MAX_DELIVERY_FIELD>` | `ct_i`, the seat's share ciphertext ([[share-encryption]], Ciphertext)                                                           |

The envelope has no record header: it is a transport's body, and the sealed delivery's version fixes its layout. Its fields are opaque here; intake decodes and checks each ([[share-encryption]], Intake and receipts). It is at least 16 bytes and at most `MAX_DELIVERY`.

**Padding.** The plaintext the client seals is the envelope followed by zero bytes up to the smallest length in `PAD_BUCKETS` at or above the envelope's length. One envelope has one padded form: a node refuses another bucket, or a padding byte that isn't zero (Request check, `sealed-envelope`). Within one election `stub` and `transcript` are the same for every voter and `ciphertext` has one length, so envelopes differ only in the ballot record's length, which the bucket hides; a relay already knows the election (Security notes).

## Sealed delivery

Record type `0x0027`, version 1. Never on the board, the chain or the archive, and never pinned by a profile: a client release and the nodes agree on its version, and a node refuses any other.

| Field          | Type                       | Meaning                                                                                                                                     |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `kem_key_hash` | `bytes[32]`                | The hash of the seat's `kem_key` the request is sealed to, as [[ceremony]] (Key set hash) computes it, so the node opens it with one secret |
| `ct_mlkem`     | `bytes[1088]`              | `ct_M`                                                                                                                                      |
| `ct_dh`        | `element`                  | `ct_DH`. Never the identity, as in [[share-encryption]]                                                                                     |
| `sealed`       | `bytes<MAX_DELIVERY + 16>` | The AEAD output: the padded envelope and the 16-byte tag. Its length is a length in `PAD_BUCKETS` plus 16; any other is a decode error      |

A request is 1,159 bytes and its sealed envelope: 17,559 bytes at the smallest bucket, `MAX_SEALED_REQUEST` at the largest.

**Encryption.** With seat `i`'s `kem_key = (ek_i, dh_i)` from the ceremony transcript the client has checked under a pinned panel ([[election-definition]], The panel is checked before any share exists), never from a relay, the API or the node (T-37, T-43), the client draws 32 bytes `μ` and a scalar `e`, uniform on 1 to `ℓ − 1`, from its CSPRNG, fresh for every request, and computes:

```
kem_key_hash = H(DS("abolish/v1/kem-key", encode(kem_key)))
(ss_M, ct_M) = ML-KEM-768.Encaps_internal(ek_i, μ)
ct_DH        = g^e
ss_DH        = dh_i^e
K            = H(DS("abolish/v1/kem/sealed-delivery", ss_M ‖ encode(ss_DH) ‖ encode(ct_DH) ‖ encode(dh_i)))
aad          = DS("abolish/v1/kem/sealed-delivery-aad", u16(0x0027) ‖ u8(1) ‖ kem_key_hash)
sealed       = ChaCha20-Poly1305.Seal(K, nonce = 12 zero bytes, aad, padded_envelope)
```

`K` is [[share-encryption]]'s combiner under this page's tag, so a request opens only with that seat's `kem_secret` for that election, and each `K` seals one message. Its own tags keep a sealed delivery from opening as a share ciphertext, a summed-share message, a nullifier request or any other message sealed under the hybrid KEM, and the reverse, though the same `kem_secret` opens several of them (Security notes). `aad` binds the record type and version and the key named in the clear.

The request's hash, which the answer's key binds, is

```
request_hash = H(DS("abolish/v1/sealed-delivery/request", encode(request)))
```

over the record's full encoding, header included.

### Request check

Seat `i`'s node, holding the `kem_secret` of each election whose secrets it hasn't destroyed ([[share-encryption]], Trustee KEM key), checks a request in this order, and the first failure is the result:

| Code               | Check                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealed-malformed` | It decodes strictly as version 1 ([[notation]], Strict decoding): `ct_dh` isn't the identity, and `sealed`'s length is a length in `PAD_BUCKETS` plus 16              |
| `sealed-key`       | `kem_key_hash` is the hash of a `kem_key` whose `kem_secret` the node holds                                                                                           |
| `sealed-decrypt`   | `ss_M = ML-KEM-768.Decaps_internal(dk, ct_M)`, `ss_DH = ct_DH^x`, with `(dk, x)` from that `kem_secret`, and `K` and `aad` as above; the AEAD opens                   |
| `sealed-envelope`  | The plaintext is an envelope that decodes strictly, followed only by zero bytes, and its length is the smallest in `PAD_BUCKETS` at or above the envelope's (Padding) |

A request failing `sealed-malformed`, `sealed-key` or `sealed-decrypt` gets no answer record: the node answers 400 with no body, the same for all three, and never `ss_M`, `ss_DH`, `K` or anything of the plaintext. Saying only whether a request opened is what an IND-CCA public-key encryption allows its decryption oracle to say, as for [[nullifier-transport]]'s Request check (T-39). A request failing `sealed-envelope` opened, so it gets a sealed answer refusing it with the code `sealed-envelope`.

Then the node runs its intake on the envelope's four fields, exactly as `POST /v1/intake` does, and answers with a sealed answer: its share receipt, its refusal's code, or busy (Sealed answer). Nothing ties the envelope's election to the key the request is sealed to: intake opens `ct_i` under the secret of the stub the envelope names, and anyone may seal any envelope to any published key, so tying them would prove nothing.

## Sealed answer

Record type `0x0028`, version 1, under the sealed delivery's rules: never on the board, the chain or the archive, and never pinned by a profile.

| Field          | Type         | Meaning                                                                                |
| -------------- | ------------ | -------------------------------------------------------------------------------------- |
| `answer_nonce` | `bytes[32]`  | Fresh for every answer, from the node's CSPRNG                                         |
| `sealed`       | `bytes[272]` | The AEAD output: the answer's plaintext (`ANSWER_PLAINTEXT` bytes) and the 16-byte tag |

Every answer is 307 bytes. Its plaintext, also with no header (the answer's version fixes it), is `ANSWER_PLAINTEXT` bytes:

| Field     | Type                     | Meaning                                                                                                                                               |
| --------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome` | `enum8<1, 2, 3>`         | 1: `receipt`, 2: `refused`, 3: `busy`                                                                                                                 |
| `body`    | `bytes<MAX_ANSWER_BODY>` | For `receipt`, the share receipt record (`0x000c`, [[delivery]], Records), never empty; for `refused`, the refusal's code in ASCII; for `busy`, empty |

then zero bytes to `ANSWER_PLAINTEXT`. A refusal's code is 1 to `MAX_REFUSAL_CODE` bytes of `a` to `z`, `0` to `9` and `-`, neither starting nor ending with `-` and with no two together: an intake code ([[share-encryption]], Intake and receipts; the node's own, such as `intake-unapproved`), or `sealed-envelope`. `busy` means the node opened the request but can't run its intake on it now, its queue of opened deliveries being full; the client asks again later.

**Encryption.** With the request's `K` and `request_hash`, the node draws `answer_nonce` and computes:

```
answer_key = H(DS("abolish/v1/kem/sealed-delivery-answer", K ‖ request_hash ‖ answer_nonce))
aad        = DS("abolish/v1/kem/sealed-delivery-answer-aad", u16(0x0028) ‖ u8(1) ‖ request_hash)
sealed     = ChaCha20-Poly1305.Seal(answer_key, nonce = 12 zero bytes, aad, plaintext)
```

As RFC 9458 §4.4 derives its response key, `answer_key` depends on the request's secret, so only the node that opened the request and the client that sealed it can make or open the answer, and the client needs no key pair of its own. `request_hash` binds the answer to the request it answers, and the fresh `answer_nonce` gives each answer its own key: a node answering the same request again, as it does when a relay replays it, never seals two plaintexts under one key and nonce.

### Answer check

The client checks the answer to the request it sent, in this order, and the first failure is the result:

| Code               | Check                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answer-malformed` | It decodes strictly as version 1: exactly 307 bytes with the header `0x0028`, version 1                                                                                                                                 |
| `answer-decrypt`   | `answer_key` and `aad` from the client's own `K` and `request_hash` for that request and the answer's `answer_nonce`; the AEAD opens                                                                                    |
| `answer-body`      | The plaintext decodes strictly: `outcome` is 1, 2 or 3, `body` no longer than `MAX_ANSWER_BODY` and followed only by zero bytes, a `receipt`'s body not empty, a `refused` body a refusal code, and a `busy` body empty |

A receipt that passes goes on to Client rule 1's `share-receipt` check against the exact ballot the client casts ([[delivery]], Client rules), and counts only if it passes it: the answer's seal says that the holder of the seat's `kem_secret` sent it, not that the receipt is good. An answer that fails any check is no answer: the client treats that attempt as failed and may try again.

## The node's route

`POST /v1/sealed-intake` beside `POST /v1/intake`, taking a sealed delivery as `message/ohttp-req` (RFC 9458 §9.2) and answering a sealed answer as `message/ohttp-res`, the media types an RFC 9458 relay forwards:

| Answer               | When                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 200, a sealed answer | The request opened (Request check): a receipt, a refusal, `sealed-envelope` included, or busy                    |
| 400, no body         | `sealed-malformed`, `sealed-key` or `sealed-decrypt`                                                             |
| 413, no body         | A declared length past `MAX_SEALED_REQUEST`, before any of the body is read, or a streamed one once it passes it |
| 415, no body         | Another media type                                                                                               |
| 503, no body         | The node can't hold another body, before reading it, as `POST /v1/intake` answers                                |

The route keeps `POST /v1/intake`'s bounds, with `MAX_SEALED_REQUEST` in place of `MAX_DELIVERY` (the bodies held at once, the headers' and the request's timeouts, the connections per place; T-52, T-54), and its TLS: 1.3 only, with `X25519MLKEM768` and no other group, or plain HTTP on a loopback address for a TLS proxy on the same host that holds to the same group. The sealed envelope is already protected while either half of the KEM holds; TLS keeps the relay's connection as strong as every other path a share takes ([[0002-everlasting-privacy]], Consequences; T-15). It allows no browser origin (no CORS header): its only peers are relays. It logs an outcome and nothing else, never a body, a key hash or an address, and caches nothing (`cache-control: no-store`).

## The relay

A relay plays RFC 9458's relay role and nothing more ([[0043-intake-anonymiser]], Decision, rule 4). For each resource it serves, it is configured with one seat's node, and it:

- takes `POST` of a `message/ohttp-req` body no longer than `MAX_SEALED_REQUEST` at that resource, and refuses anything else;
- sends the body alone to that node's `POST /v1/sealed-intake`, on a connection of its own, with no header of the client's (no address, `Forwarded`, `Via`, cookie, user agent or language);
- returns the node's status and, for a 200, its body as `message/ohttp-res`, with no header of the node's but the media type and `cache-control: no-store`;
- logs a count of requests per resource and nothing of any one request: no address, time, size, body or answer.

The client reaches a relay over HTTPS, which hides the request from the network but not from the relay. A relay's operator is neither the deployment's operator nor a trustee of the panel the seat belongs to; a release lists only relays its signers have that word for ([[0043-intake-anonymiser]], Decision, rule 4, and Consequences), which no record proves.

## Client rules

The ballot client, for each qualified seat `i` of a cast that isn't receipted ([[delivery]], Client rule 4):

1. **When.** It tries this route after the operator's route and its retries have failed for that seat, before it treats private delivery as failed and before any posting offer, and keeps it among the routes it retries until its own deadline for the cast ([[posting-relay]], The ballot's own deadline).
2. **The key.** It seals only to seat `i`'s `kem_key` from the ceremony transcript it has checked under a pinned panel, and only to a seat that has one: a seat it has no checked key for gets no sealed delivery (T-37).
3. **The relay.** It sends only to a relay resource its release lists for that seat (part 2e-2b), on an origin its `connect-src` lists (T-43), never to the node's own origin.
4. **Fresh every time.** Each attempt is a new request with fresh `μ` and `e`, so no two attempts share bytes beyond `kem_key_hash` and the length, and no `K` seals twice.
5. **Timing.** Before its first sealed request for a cast it waits a whole number of milliseconds drawn uniformly from 0 to `SEALED_DELAY_MAX_MS` from its CSPRNG (by rejection, never by a modulus), so its last attempt through the operator and its first through a relay aren't adjacent in time to an observer of both (T-13). The delay is cut short where it would carry the request past the client's deadline (rule 1). The seats it sends for after the delay are sent together.
6. **Outcomes.** A receipt that passes rule 1's check receipts the seat. A refusal is handled as the same refusal through the operator's route is. Busy, a 400, 413, 415 or 503, a network failure, no answer within its timeout, and an answer that fails the Answer check are a failed attempt, retried by rule 1.

## Retention

- **The client** keeps `K` and `request_hash` for a request only until its answer passes the Answer check or the attempt fails, then erases them; the request itself only while it is being sent. What it keeps of `ct_i` and `m_i` is [[delivery]]'s Client rule 4's, unchanged.
- **The node** keeps the request, `ss_M`, `ss_DH`, `K` and the plaintext only until it has answered, and of the delivery only what intake keeps ([[share-encryption]], Intake and receipts).
- **Neither** record is put on the board, the chain, IPFS or the archive, or in any log or analytics event, at the client, the relay or the node (T-15).

## Security notes

- **What each party sees.** The relay sees the client's address, the time, `kem_key_hash` and the bucket, so it learns that this address delivered for that seat of that election, and when, never the ballot or its options. The node sees the ballot record and the relay's address, never the client's (T-11). A network observer of the client sees a connection to the relay; one of both sides can match them by time and size.
- **The confidentiality of the share.** The envelope carries `ct_i`, itself sealed to the same seat, and the ballot record, whose nullifier links the voter's re-votes. Recorded in transit, the sealed envelope stays secret while either ML-KEM-768 or discrete logs in ristretto255 hold ([[share-encryption]], Ciphertext, The combiner), and it opens only with the per-election `kem_secret`, which the node destroys after the tally, so a later theft of the node opens nothing recorded (T-15, T-14).
- **One secret, several messages.** The `kem_secret` that opens a sealed delivery also opens the seat's share ciphertexts and summed-share messages. A ciphertext's `ct_M` and `ct_DH` copied into a sealed delivery give a `K` under this page's tag that no one but the node knows, so the AEAD fails and the node answers 400: the node never reveals a decapsulation's output, and the tags keep each message's key apart from every other's (T-39). The node answers whether a request opened, which an IND-CCA public-key encryption allows (Request check).
- **The relay can't forge or read an answer.** It doesn't know `K`, so it can't make an answer that opens; a replayed or reordered answer fails, since `answer_key` binds the request's hash. It can drop, delay or replay a request, which costs liveness only: the node's intake of the same delivery gives the same receipt ([[share-encryption]], Intake and receipts, Notes) under a fresh `answer_nonce`, and the client retries by other routes (T-25).
- **Anyone can send requests.** The key is public, so anyone can make a request that opens, and intake then checks a membership proof, the costliest step; the route's bounds are `POST /v1/intake`'s, and a relay doesn't change who can reach them (T-52, T-54).
- **Not constant time everywhere.** As [[share-encryption]]: the ristretto255 multiplications by secrets use `@noble/curves`' constant-time ladder and ML-KEM is `@noble/post-quantum`'s, but secrets can't be zeroised in JavaScript (T-39).

## Known-weak

- **A relay that colludes with the operator** recovers the voter's address beside the ballot, and can drop that ballot's request: the operator sees the address try its own route and stop, the relay sees it deliver moments later. Rule 5's delay widens the window an observer must match, no more (T-13, T-25; [[0043-intake-anonymiser]], Consequences).
- **The relay learns which election and seat**, from `kem_key_hash`, and when an address delivered (T-13). Hiding them would have each node try every open election's key on every request, a cost any sender could multiply (T-52).
- **The relay sees how long intake took.** A refusal before the membership proof comes back sooner than a receipt, so the relay can guess the outcome from the answer's timing, though not read it (T-13). Holding every answer to a fixed time would hold every voter's delivery to the slowest case.
- **Under the transitional panel the node is the operator**, so the route hides the voter's address from a node that already sees the operator's route; it starts to matter as independent trustees take seats ([[0043-intake-anonymiser]], Consequences).

## Test vectors

`docs/spec/vectors/sealed-delivery.json` ([[vectors/README|vectors]], Sealed-delivery vectors): the three seats of `intake.json` with their KEM keys and secrets and each key's `kem_key_hash`; deliveries of `intake.json`'s `ok-seat-1` and `ok-seat-2` ballots and ciphertexts to their seats, beside a stand-in stub and transcripts of two lengths, padded to the 16 KiB and 32 KiB buckets, each re-made byte for byte from its `μ` and `e` with `ss_M`, `ss_DH`, `K`, `aad`, the record and `request_hash`, and each with a sealed receipt (the case's receipt as a version-1 record), a refusal and busy, re-made from their `answer_nonce`s with `answer_key` and `aad`; a version-2 receipt from `intake-v4.json` in an answer; the padded length of envelopes at every bucket's edge; requests failing each code (a trailing byte, one byte short, another record type and version, an identity and a non-canonical `ct_dh`, a sealed length off the buckets, an unknown key hash, a request at another seat's node, relabelled with another seat's key hash, an `aad` over another key hash, bits flipped in `ct_mlkem`, `sealed` and the tag, an envelope padded to a larger bucket, a padding byte that isn't zero, a field over `MAX_DELIVERY_FIELD`, and fields running past the plaintext's end); and answers failing each code (a trailing byte, one byte short, another record type and version, the nonce changed, a bit flipped, an answer to another request and one sealed under another request hash, outcomes 0 and 4, a body over the bound, an empty receipt, refusal codes empty, in upper case, too long and ending in `-`, busy with a body, and a padding byte that isn't zero). They are printed by `packages/crypto/scripts/sealed-delivery-vectors.py`, which reuses `share-encryption-vectors.py`'s ML-KEM-768, ChaCha20-Poly1305 and ristretto255 code (checked against Go's accumulated FIPS 203 vectors and RFC 8439 §2.8.2 first) and takes its keys, ballots, ciphertexts and receipts from `intake.json` and `intake-v4.json`; it shares nothing with `packages/crypto` or any `@noble` library.
