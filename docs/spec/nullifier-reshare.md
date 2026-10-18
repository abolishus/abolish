# Nullifier key resharing

How the holders of a Tier 2 keyed-nullifier key hand the same OPRF key `sk` to a new panel, or to the same panel in a new epoch, without anyone learning it: the reshare context, four rounds in which the predecessor key's qualified seats share their own shares again to the new panel's seats, with complaints and reveals, the reshare transcript (record type `0x0013`, version 1), the reshared-share message (record type `0x0014`, version 1), the transcript check that yields the successor key, the old seats' consent to it and the new seats' approval of it. It is the resharing [[nullifier-key]] leaves to this page ([[0022-tier2-keyed-nullifier]], option A: "reshared on panel changes"). Notation is from [[notation]], ristretto255 and `H` from [[group]], Baby Jubjub, `J` and share commitments from [[keyed-nullifier]], identity keys and signatures from [[trustee-identity]], the KEM key from [[share-encryption]], and the key, its rounds and its registration keys from [[nullifier-key]]. Threats: T-03, T-13, T-14, T-15, T-29, T-37, T-39, T-40, T-54.

Consents and approvals are recorded by the group registry, which decides whether a successor counts ([[contracts]], Group registry, Nullifier keys). What this page doesn't cover yet: how [[verifier]] 2.4 follows a scope's chain of keys, and where transcripts are published, are part 2b-4's, as for the initial key.

## Sources

- **Resharing:** the redistribution of a Shamir sharing by sharing each share again and recombining with Lagrange coefficients (Y. Desmedt and S. Jajodia, "Redistributing Secret Shares to New Access Structures and Its Applications", GMU ISSE-TR-97-01, 1997; A. Herzberg, S. Jarecki, H. Krawczyk and M. Yung, "Proactive Secret Sharing, or How to Cope with Perpetual Leakage", CRYPTO 1995), made verifiable with Pedersen commitments whose constant term is the old share's commitment (T. M. Wong, C. Wang and J. M. Wing, "Verifiable Secret Redistribution for Archive Systems", IEEE SISW 2002, with Pedersen VSS in place of Feldman's so the transcript stays perfectly hiding; T. P. Pedersen, CRYPTO 1991).
- **Complaints and reveals:** GJKR's (R. Gennaro, S. Jarecki, H. Krawczyk and T. Rabin, J. Cryptology 2007, Fig. 2, steps 1 to 3), as in [[nullifier-key]].
- **Private channels and signatures:** as in [[nullifier-key]], under this page's own tags.

## Parties and keys

- The **predecessor**: a key that counts for the Tier 2 scope ([[nullifier-key]], Approval, or this page's Approval for a key that is itself a reshare), with its threshold `k`, its panel (`n` seats, identity keys `Q_1 … Q_n`) and, for each of its qualified seats `i`, the share commitment `C_i`. Seat `i` holds `(sk_i, s_i)` with `sk_i · G + s_i · J = C_i`.
- The **new panel**: the one the deployment's release pins to succeed the predecessor's panel for the Tier 2 scope, and that the old trustees have each verified out of band (Round 2), with `k'`, `n'` and identity keys `Q'_1 … Q'_{n'}`. It may be the predecessor's panel itself (a refresh, which gives each seat a fresh share of the same `sk`) or a different one; a person on both panels has a seat on each, and acts in each under that panel's index and identity key.

Old seats deal; new seats register keys, receive and complain. Each new seat `j` that takes part generates, fresh for this run from the CSPRNG, a registration KEM key and a registration signing key exactly as [[nullifier-key]] (Parties and keys) says; they serve the successor key, never the predecessor. A coordinator relays messages and assembles the transcript, trusted for nothing but liveness.

## Reshare context

The coordinator picks `run_id`, 32 bytes from the CSPRNG, fresh for every run, and the run's `deadline`, an L2 block number by which the successor's approvals must be recorded to count (Approval). The deadline lies at most `MAX_RESHARE_WINDOW = 302,400` blocks (7 days of 2-second blocks), a constant of transcript version 1, ahead of the latest L2 block when the run starts: a new seat sends its round-1 message only if the deadline is ahead of the latest block its node has seen by at least one block and at most `MAX_RESHARE_WINDOW`. Without the bound a coordinator could set a deadline that never passes, and a stalled run would hold its approving seats for good (Approval, rule 6); an in-session review found this. Every message of the run binds

```
reshare_context = H(DS("abolish/v1/keyed-nullifier/reshare-context",
    u64(l2_chain_id) ‖ group_registry ‖ old_panel_id ‖ predecessor ‖ new_panel_id ‖ run_id ‖ u64(deadline)))
```

| Field            | Type        | Source                                                                                |
| ---------------- | ----------- | ------------------------------------------------------------------------------------- |
| `l2_chain_id`    | `u64`       | The L2 chain ID the release pins                                                      |
| `group_registry` | `bytes[20]` | The group registry's address the release pins                                         |
| `old_panel_id`   | `bytes[32]` | Recomputed from the predecessor's pinned panel, never taken from data                 |
| `predecessor`    | `bytes[32]` | The predecessor's `key_id`                                                            |
| `new_panel_id`   | `bytes[32]` | Recomputed from the new pinned panel, never taken from data                           |
| `run_id`         | `bytes[32]` | The run identifier, from the transcript                                               |
| `deadline`       | `u64`       | The L2 block by which the successor's approvals must be recorded, from the transcript |

The tag is not [[nullifier-key]]'s, so no reshare message checks as a message of an initial run, or the reverse, even between the same panels. A node refuses a run whose (`new_panel_id`, `run_id`) it has seen before, and never reuses a key, a polynomial, a nonce or a KEM message across runs.

## Rounds

Four rounds, chained as [[nullifier-key]]'s are, under this page's tag: with `R_r` the list of round `r`'s messages as the transcript encodes it,

```
h_0 = reshare_context
h_r = H(DS("abolish/v1/keyed-nullifier/reshare-round", h_{r−1} ‖ u8(r) ‖ encode(R_r)))     for r = 1, 2, 3
```

New seats send rounds 1 and 3, and old seats rounds 2 and 4. Seat `i`'s round-`r` message is signed under `abolish/v1/sig/nullifier-reshare-message` over

```
m = u8(r) ‖ h_{r−1} ‖ u8(i) ‖ body
```

with `body` the encoding of the message's fields between `index` and `signature`, by the pinned identity key of seat `i` of the panel that sends round `r`: `Q'_i` for rounds 1 and 3, `Q_i` for rounds 2 and 4. `S_1` is the set of new seats with a round-1 message and `S_2` the set of old seats with a round-2 message, each in increasing order.

### Round 1: registration keys

New seat `j` sends [[nullifier-key]]'s round-1 message, field for field (`index`, `kem_key`, `signing_key`, `signing_pop`, `signature`), with `signing_pop` made under `abolish/v1/sig/nullifier-reshare-signing-key` over

```
reshare_context ‖ u8(j) ‖ encode(kem_key) ‖ signing_key
```

(1,282 bytes). As there, a node stores its registration secrets before it sends its round-1 message, signs at most one round-1 message per (`new_panel_id`, `run_id`), and opens and complains only with the keys that message carries: a node that regenerated them would complain about every honest dealer, whose reveals would then publish its shares.

### Round 2: dealings

After round 1 closes, each old seat `i` that is a qualified seat of the predecessor, and holds `(sk_i, s_i)` opening its `C_i`, draws from the CSPRNG two polynomials of degree `k' − 1` over `F_l` with fixed constant terms,

```
g_i(z)  = sk_i + c_{i,1} z + … + c_{i,k'−1} z^{k'−1}
g'_i(z) = s_i  + e_{i,1} z + … + e_{i,k'−1} z^{k'−1}
```

every other coefficient uniform on 0 to `l − 1`, and computes the coefficient commitments `B_{i,t} = c_{i,t} · G + e_{i,t} · J` (with `c_{i,0} = sk_i`, `e_{i,0} = s_i`), so `B_{i,0} = C_i`, redrawing both coefficients of any `B_{i,t}`, `t ≥ 1`, that is the identity. For every seat `j` of `S_1`, in increasing order, it seals `(g_i(j), g'_i(j))` to `j`'s round-1 KEM key in a reshared-share message (below), and sends:

| Field          | Type                            | Meaning                                                                            |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `index`        | `u8`                            | `i`, its seat on the predecessor's panel                                           |
| `commitments`  | `list<bjj-point, MAX_TRUSTEES>` | `B_{i,0}, …, B_{i,k'−1}`, exactly `k'` of them. Never the identity                 |
| `share_hashes` | `list<bytes[32], MAX_TRUSTEES>` | The reshared-share hash of its message to every seat of `S_1`, in increasing order |
| `signature`    | `p256-sig`                      | `Q_i`'s signature over `h_1`                                                       |

A dealer has no message to itself: the recipients are the new panel's seats, a different set of parties even when one person holds a seat on each. An old seat deals at most one round-2 message per run, and only in a run whose predecessor is the key that counts for the scope today and whose new panel is one its trustee has verified independently: the trustee checks `new_panel_id` and every identity key in it out of band, at the ceremony where its own identity key signs, and never deals on a release's pin alone. Its round-2 signature binds `new_panel_id` through `reshare_context`, and once the transcript is complete it signs its **consent to the succession** (Consent, below); a successor counts only with `max(k, n − 1)` old seats' consent, recorded with it (Approval). An old seat deals to **at most one successor panel per predecessor** while a run to that panel is live (its deadline not passed) or its successor counts, and so, like a new seat in round 1, it deals only if the run's deadline is ahead of the latest L2 block its node has seen by at least one block and at most `MAX_RESHARE_WINDOW`: a deadline that never passes would otherwise hold it to one panel for good. An in-session review found that, with the release as the only authority on the new panel, whoever controls a release could pin a panel of its own keys and receive `sk` with no trustee misbehaving. It keeps `g_i` and `g'_i` until round 4 closes, and erases them then.

### Round 3: complaints

After round 2 closes, each new seat `j` of `S_1` checks the message it holds from each dealer of `S_2` (Reshared-share check, below) and complains about dealer `i` only if it holds a message whose hash equals `i`'s `share_hashes` entry for `j` and whose check then fails at `share-decrypt` or `share-verify`. A seat with no complaint sends nothing; otherwise:

| Field        | Type                     | Meaning                                                                             |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------- |
| `index`      | `u8`                     | `j`                                                                                 |
| `complaints` | `list<u8, MAX_TRUSTEES>` | The old seats it complains about: seats of `S_2`, strictly increasing, at least one |
| `signature`  | `p256-sig`               | `Q'_j`'s signature over `h_2`                                                       |

A missing message is never a complaint, as in [[nullifier-key]] (Round 3): it would make an honest dealer publish an honest new seat's share.

### Round 4: responses

After round 3 closes, each dealer `i` of `S_2` that some round-3 message complains about sends:

| Field       | Type                                 | Meaning                                                                               |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `index`     | `u8`                                 | `i`                                                                                   |
| `reveals`   | `list<revealed-share, MAX_TRUSTEES>` | One for every new seat whose round-3 message complains about `i`, in increasing order |
| `signature` | `p256-sig`                           | `Q_i`'s signature over `h_3`                                                          |

with `revealed-share` as in [[nullifier-key]]: `complainer` (`u8`, the new seat `j`), `share` (`g_i(j)`) and `blind` (`g'_i(j)`), both `bjj-scalar`.

## Reshared share

Record type `0x0014`, version 1. Private, as [[nullifier-key]]'s dealt share: it travels only between trustee nodes and is never put on the board, IPFS, the archive or any store that keeps it after the successor counts, or after the run is abandoned (Approval); no profile pins it, and the reshare transcript's version fixes it (version 1 uses version 1).

| Field             | Type          | Meaning                                                                 |
| ----------------- | ------------- | ----------------------------------------------------------------------- |
| `reshare_context` | `bytes[32]`   | The run's reshare context                                               |
| `dealer`          | `u8`          | `i`, a seat of the predecessor's panel                                  |
| `recipient`       | `u8`          | `j`, a seat of the new panel                                            |
| `ct_mlkem`        | `bytes[1088]` | `ct_M`                                                                  |
| `ct_dh`           | `element`     | `ct_DH`. Never the identity                                             |
| `sealed`          | `bytes[80]`   | The AEAD output: `bjj-scalar(g_i(j)) ‖ bjj-scalar(g'_i(j))` and the tag |

The message is 1,237 bytes, and is sealed as [[nullifier-key]]'s dealt share is (Dealt share, Encryption: fresh `μ` and `e`, `K` the combiner, a zero nonce under a one-time key), with recipient `j`'s round-1 `kem_key` and these two tags:

```
K   = H(DS("abolish/v1/kem/nullifier-reshare-share", ss_M ‖ encode(ss_DH) ‖ encode(ct_DH) ‖ encode(dh_j)))
aad = DS("abolish/v1/kem/nullifier-reshare-share-aad",
         u16(0x0014) ‖ u8(1) ‖ reshare_context ‖ u8(i) ‖ u8(j) ‖ encode(commitments))
```

where `commitments` is the dealer's whole round-2 list, count included. Its hash, signed in the dealer's round-2 message, is

```
share_hash = H(DS("abolish/v1/keyed-nullifier/reshare-share", encode(message)))
```

over the record's full encoding, header included.

**Reshared-share check.** New seat `j`, holding its registration `kem_secret` and the rounds so far, checks a message it received for dealer `i`, in this order; the first failure is the result. The codes are [[nullifier-key]]'s, with the same meaning:

| Code              | Check                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `share-malformed` | It decodes strictly as version 1                                                                                                              |
| `share-context`   | `reshare_context` is the run's, `recipient` is `j`, and `dealer` is a seat of `S_2`                                                           |
| `share-hash`      | `share_hash` equals `i`'s `share_hashes` entry for `j`                                                                                        |
| `share-decrypt`   | The KEM decapsulates as in [[nullifier-key]] with this page's `K` and `aad`, the AEAD opens, and its plaintext is two `bjj-scalar`s `(σ, σ')` |
| `share-verify`    | `σ · G + σ' · J = Σ_{t=0}^{k'−1} (j^t mod l) · B_{i,t}`                                                                                       |

Only a message that matched its signed hash and then failed `share-decrypt` or `share-verify` is grounds for a complaint, so only a predecessor seat's signed dealing can make a node decapsulate a chosen `ct_M` (T-39).

## Transcript

The reshare transcript is record type `0x0013`, version 1:

| Field         | Type                                  | Meaning                                |
| ------------- | ------------------------------------- | -------------------------------------- |
| `run_id`      | `bytes[32]`                           | The run identifier                     |
| `predecessor` | `bytes[32]`                           | The predecessor's `key_id`             |
| `deadline`    | `u64`                                 | The run's deadline, an L2 block number |
| `keys`        | `list<round-1 message, MAX_TRUSTEES>` | `R_1`, new seats in increasing order   |
| `dealings`    | `list<round-2 message, MAX_TRUSTEES>` | `R_2`, old seats in increasing order   |
| `complaints`  | `list<round-3 message, MAX_TRUSTEES>` | `R_3`, new seats in increasing order   |
| `responses`   | `list<round-4 message, MAX_TRUSTEES>` | `R_4`, old seats in increasing order   |

Each message is its table's fields in order, `index` first and `signature` last; `encode(R_r)` is that list field's encoding, count included. The successor's identifier is

```
key_id = H(DS("abolish/v1/keyed-nullifier/reshared-key", encode(transcript)))
```

over the record's full encoding, header included. Every answer and evaluation proof under the successor binds it ([[keyed-nullifier]], Evaluation), so an answer under one epoch's key never checks under another's.

## Transcript check

A checker holds the scope's pins, the predecessor's pinned panel and its key (the output of its own check: [[nullifier-key]]'s for the initial key, this one for a reshare), and the new pinned panel. It decodes the transcript under version 1, rebuilds `reshare_context` from those and the transcript's `run_id` and `deadline`, and checks, in order. Checks 1 to 4, 6 and 8 make the whole transcript invalid.

1. **Predecessor** (`key-predecessor`). `predecessor` is the predecessor's `key_id`.
2. **Order** (`key-order`). In each round, seats are strictly increasing: from 1 to `n'` in rounds 1 and 3, from 1 to `n` in rounds 2 and 4. A round-2 message comes from a qualified seat of the predecessor, a round-3 message from a seat of `S_1`, and a round-4 message from a seat of `S_2`.
3. **Shape** (`key-shape`). Each round-2 message has exactly `k'` `commitments` and one `share_hashes` entry per seat of `S_1`. Each round-3 message's `complaints` are strictly increasing, at least one, each a seat of `S_2`. A round-4 message comes only from a dealer some round-3 message complains about, and its `reveals` list exactly the seats whose round-3 messages complain about it, in increasing order.
4. **Signatures** (`key-signature`). Every message's `signature` verifies over `m` above, with `h_{r−1}` computed from this transcript, under the pinned identity key of its seat on the panel that sends its round.
5. **Dealers.** Each old seat of `S_2` is a qualified dealer unless one of these reasons holds, each attributed to it unless it shows a signed message the transcript omits (below), since each rests only on messages `Q_i` signed or on a message it owed:

   | Reason       | Holds when                                                                                                                  |
   | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
   | `constant`   | `B_{i,0} ≠ C_i`: it didn't reshare its own share                                                                            |
   | `unanswered` | Some round-3 message complains about it and it has no round-4 message                                                       |
   | `bad-reveal` | One of its reveals fails `share · G + blind · J = Σ_{t=0}^{k'−1} (c^t mod l) · B_{i,t}`, with `c` the reveal's `complainer` |

   An old seat that sends no round-2 message is not a fault: a reshare needs only `k` of the predecessor's seats.

   Old seats don't approve the successor, so, unlike a seat of [[nullifier-key]], a dealer has no approval to withhold from a transcript that omits its messages. A coordinator that drops an honest dealer's round-4 response (with a corrupt new seat's groundless complaint) or round-2 message gets that dealer charged with `unanswered` or left out of `Q`. That costs attribution and liveness only: `Q` still needs `k` qualified dealers, so at least one honest one, and `sk` doesn't change. The dealer refutes the charge by showing its message signed over the transcript's `h_2` or `h_3`, and an honest new seat refuses to approve a transcript that omits a message it received (Approval, rule 3). An in-session review found this.

6. **Dealer quorum** (`key-dealers`). At least `k` dealers are qualified. Call their set `Q`.
7. **New seats.** For each qualified dealer `i`, `λ_i = Π_{m ∈ Q, m ≠ i} m · (m − i)^{−1} mod l`, the Lagrange coefficient at 0 over `Q`, and each new seat `j` has the share commitment

   ```
   C'_j = Σ_{i ∈ Q} λ_i · Σ_{t=0}^{k'−1} (j^t mod l) · B_{i,t}
   ```

   Each new seat is qualified unless one of these reasons holds, in this order:

   | Reason                | Holds when                                                                                                                                                                                        |
   | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `absent`              | `j` has no round-1 message                                                                                                                                                                        |
   | `possession`          | `signing_pop` doesn't verify under `signing_key`                                                                                                                                                  |
   | `duplicate-key`       | It passes `possession` and its `signing_key` equals another passing new seat's, any pinned identity key of either panel, or the registration signing key of any qualified seat of the predecessor |
   | `identity-commitment` | `C'_j` is the identity                                                                                                                                                                            |

   `absent`, `possession` and `duplicate-key` are attributed to seat `j`; `identity-commitment` to no one, as in [[nullifier-key]].

8. **Quorum** (`key-quorum`). At least `k'` new seats are qualified.

The check's output is the **successor key**, in [[nullifier-key]]'s shape so [[keyed-nullifier]]'s answer check takes it unchanged: `key_id`, `k'`, and for each qualified new seat in increasing order its `index`, registration `kem_key`, registration `signing_key` and `C'_j`; with it, the `predecessor` and the qualified dealers `Q`.

New seat `j`'s share is

```
(sk'_j, s'_j) = Σ_{i ∈ Q} λ_i · (g_i(j), g'_i(j)) mod l
```

with `(g_i(j), g'_i(j))` from `i`'s reshared-share message, or from `i`'s reveal where `j` complained. It opens `C'_j`.

Why each rule:

- **`constant`** is what makes this a reshare of `sk` and not a new key. `Σ_{i ∈ Q} λ_i · C_i = sk · G + s · J` for any `k` qualified seats of the predecessor, with `s` the predecessor's blinding constant, because the `C_i` commit to points of two polynomials of degree `k − 1`. So, with every `B_{i,0} = C_i`, the new shares' constant term commits to `sk` and `s` as well, and since Pedersen commitments are binding (no one knows `log_G J`, [[keyed-nullifier]], Generator `J`), any `k'` qualified new shares interpolate to `sk` itself. A dealer that dealt anything else is caught by its own signed commitments and dropped, and `Q` without it still interpolates to `sk`.
- **`key-dealers`** is the predecessor's threshold: with fewer than `k` dealers the Lagrange combination isn't `sk`. With at most `k − 1` corrupt old seats (the predecessor's own assumption), `Q` holds at least one honest dealer, whose uniform higher coefficients make the new polynomial's uniform too (Rushing, below).
- **`unanswered`, `bad-reveal`, `absent`, `possession`, `identity-commitment`** are [[nullifier-key]]'s rules for the same messages.
- **`duplicate-key`** adds the predecessor's signing keys to [[nullifier-key]]'s rule: a seat on both panels registers fresh keys for the successor, so an answer signed under one epoch's key is never also its seat's signature under the next one's. Earlier epochs' keys aren't checked: every answer binds its `key_id`, so a key reused from two epochs back signs nothing that checks under the successor.

## Approval

New seat `j` approves the successor by signing, with its identity key `Q'_j` under `abolish/v1/sig/nullifier-reshare-approval-2`,

```
m = u64(l2_chain_id) ‖ group_registry ‖ new_panel_id ‖ u8(j) ‖ predecessor ‖ key_id ‖ u64(deadline)
```

(133 bytes), with `deadline` the transcript's, only if all of these hold:

1. the transcript passes the check, with at least `max(k', n' − 1)` qualified new seats ([[0006-trustees]] rule 7, as for the initial key) and at least `max(k, n − 1)` qualified dealers, the old panel's consent under the same rule;
2. seat `j` is qualified, and its share computed above opens its `C'_j`: it holds a reshared share or a reveal from every qualified dealer;
3. the transcript holds every message `j` sent, as it sent it, and every round-2 or round-4 message `j` received from a dealer of the transcript's run, as received;
4. the predecessor is the key that counts for the scope today: the group registry's current key, read from its own L2 node ([[contracts]], Group registry, Nullifier keys);
5. the run's `deadline` hasn't passed, and lies at most `MAX_RESHARE_WINDOW` ahead: the L2 chain's latest block is at least [[nullifier-key]]'s `RECORD_MARGIN` below it, and the seat submits the record itself through the L1 portal as that page says (Approval, Recording);
6. every other successor of this predecessor that `j` approved has passed its own deadline without counting. A new seat approves **at most one live successor of any key**: a run that stalls releases its seats at its deadline, so a later run can count.

A successor **counts** when the group registry records it ([[contracts]], Group registry, Nullifier keys): one record carrying consents from `q = max(k, n − 1)` **distinct old seats** (Consent, below) and approvals from `q' = max(k', n' − 1)` **distinct new seats** under this statement, each verifying under its pinned identity key, counted per seat, never per signature, submitted in an L2 block at or before the statement's `deadline` while the predecessor is the scope's current key. A verifier counts it only if, as well, its predecessor counts (an initial key only under [[nullifier-key]]'s transcript version 2), and its transcript checks with that predecessor, gives at least `max(k, n − 1)` qualified dealers and `q'` qualified new seats, hashes to `key_id` and carries the record's `deadline`. Whether a successor counts is so settled at its deadline. As for the initial key ([[nullifier-key]], Approval, The deadline is in the statement), the statement carries the deadline because the registry can't read it from `key_id`: under `abolish/v1/sig/nullifier-reshare-approval`, the same statement without it (125 bytes), a successor's approvals held back past its run's deadline could be recorded after its new seats had erased their shares, and the key would pass to a panel that holds none. An approval under that statement never counts, and its tag is retired before any registry is deployed. Two such quorums share `2q' − n'` seats, at least one, and at least one honest seat when `2q' − n' ≥ k'` (as for 4-of-7), so two counted successors in one new panel need an honest seat that approved the second before the first's deadline passed, or while the first counted, which rule 6 forbids. The dealer quorum is part of counting, not only an honest approver's precondition (rule 1), because a panel of an insider's own keys has no honest seat to apply rule 1; an in-session review found that, with it only in rule 1, the `k − 1` corrupt old seats and one honest seat shown that panel alone could hand it `sk`. The registry can't count qualified dealers, which takes the transcript check, so it counts the old seats' consents instead, which an honest old seat gives only as a qualified dealer of a transcript with the dealer quorum (Consent). An earlier draft let a seat approve one successor of a key ever, with no expiry; an in-session review found that one corrupt dealer withholding a share from two honest new seats, or a re-signed transcript shown to half the seats, then blocked every later successor of that key for good. So a scope's keys form one chain from its initial key, each link a reshare whose successor counts, and a checker follows the chain in order, each reshare's check taking the key the one before produced. The registry records a successor only of its current key, and recording it makes the successor current, so the chain it holds has one link per key whatever any seat's view of the chain. A scope has only one counted initial key, too: it comes only from the initial panel the release pins ([[nullifier-key]], Parties and keys) under transcript version 2, whose seats approve no initial key once any key counts and at most one live one at a time, and a new seat that approved a successor never approves an initial key ([[nullifier-key]], Approval, rules 4 and 6). The group registry records at most one initial key per scope, ever.

Once a successor counts, the predecessor is retired: its seats stop answering under its `key_id`, and attesters stop accepting its answers (part 2b-4). Each old seat then erases its share `(sk_i, s_i)`, its reshare polynomials and the predecessor's registration secrets, but only once the successor's record is in a block final on L1, read from its own L2 node: a sequencer could show an unsafe block holding the record and never post it, and old seats that erased on it would leave the key with no panel once the new seats, seeing no record on the final chain, erased theirs (T-50, T-54). It keeps them until then, so a run that fails leaves the predecessor whole. A run whose successor hasn't counted by its deadline is abandoned, its approvals with it, and another starts with a fresh `run_id` and a later deadline. **Every new seat erases what an abandoned run gave it** once its deadline's block is final on L1 and the group registry, read from its own L2 node, hasn't recorded this run's `key_id`; a recorded key that is a re-signed copy of this run's transcript (the same `run_id`, and the seat's own `C'_j` among its share commitments, read from its archived transcript) is this run's key for this rule, so the seat keeps its share as a share of the recorded key (Security notes, Re-signing) (whatever else it recorded: a successor of the same predecessor from another run makes this run's shares no less a sharing of `sk`); or sooner, once another run's successor of the same predecessor is recorded in a block final on L1, since the registry can then never record this run's (it is no longer a successor of the current key); and at once if it refuses to approve: the reshared-share messages and reveals it received, its computed share `(sk'_j, s'_j)` and the run's registration secrets; every old seat erases the run's reshare polynomials as round 4 closes, as it would anyway. An abandoned run's shares are a complete `k'`-of-`n'` sharing of `sk` that no later reshare refreshes, so a mobile adversary that gathered `k'` of them over the years would hold `sk`; an in-session review found this (T-14).

## Consent

Old seat `i`, a seat of the predecessor's panel, consents to the successor by signing, with its identity key `Q_i` under `abolish/v1/sig/nullifier-reshare-consent`,

```
m = u64(l2_chain_id) ‖ group_registry ‖ old_panel_id ‖ u8(i) ‖ predecessor ‖ new_panel_id ‖ key_id ‖ u64(deadline)
```

(165 bytes), with `deadline` the transcript's, only if all of these hold:

1. the transcript passes the check, with at least `max(k, n − 1)` qualified dealers and at least `max(k', n' − 1)` qualified new seats;
2. seat `i` is a qualified dealer of it;
3. the transcript holds every message `i` sent, as it sent it;
4. the predecessor is the group registry's current key, read from its own L2 node;
5. the run's `deadline` hasn't passed: the L2 chain's latest block is at least [[nullifier-key]]'s `RECORD_MARGIN` below it;
6. `new_panel_id` is a panel the release pins as a possible successor for the scope (the predecessor's own panel, for a refresh, included), and the panel its trustee verified out of band before dealing (Round 2), in the one run to that panel it dealt in; and it has consented to no other `key_id` of this run (the re-signing note below: both carry one `sk`, and the registry records one, so this only keeps consents aligned with approvals).

Consents and approvals are sent to every old and new seat of the run, so any of them can submit the record. Consent is signed after round 4, with the whole transcript in hand, at the same ceremony as the seat's round-2 and round-4 signatures, so the identity key still signs nothing automatically (T-37). It adds no new trust: rule 1 is what an old seat already required of a run it dealt in, and the statement only shows that to the registry, which can't run the transcript check. An abandoned run's consents bind nothing, since the registry records a successor only by its deadline, and an old seat keeps its share until a successor counts (Approval).

## Security notes

- **Same key, new shares.** The successor's `sk` is the predecessor's (`constant`, above), so every nullifier the scope issued stays the same across epochs and uniqueness ([[0022-tier2-keyed-nullifier]]) holds across a panel change. The shares are new: a new seat's share is a fresh point of a fresh polynomial, independent of the old shares except through `sk`.
- **Erasure is the mitigation for a mobile adversary.** An adversary that holds at most `k − 1` old shares and at most `k' − 1` new shares, in any mix, learns nothing about `sk` (Desmedt–Jajodia; Herzberg et al.), so a resharing bounds what each epoch's corruptions give. That holds only if old seats erase their shares once the successor counts; `k` old shares kept anywhere, by a seat or by whoever seized or compelled one, still give `sk`, and nothing can prove an erasure (T-14, T-40; [[0022-tier2-keyed-nullifier]], A long-lived key). The trustee role description (P1-7) must say so before real documents register.
- **Perfectly hiding transcript.** The transcript holds Pedersen commitments, the `B_{i,0}` of which are the predecessor's `C_i`, already public; hashes of reshared-share messages, statistically hiding as in [[nullifier-key]] (Security notes); and reveals, which publish only a corrupt dealer's points or a complaining corrupt new seat's own share. An honest new seat, opening with the keys its round-1 message carries, never complains about an honest dealer. So nothing published fixes `sk`, even to an unbounded adversary (T-15). The reshared-share messages themselves fall to an adversary who records them and breaks both ML-KEM-768 and discrete logs in ristretto255; they are never archived.
- **Rushing.** A corrupt dealer may choose its polynomial after seeing every other round-2 message, and may drop out of `Q` after seeing the complaints (by not answering one), which changes the Lagrange coefficients. Neither moves `sk`, which `constant` fixes. Each honest dealer's higher coefficients are hidden by its commitments, and its `λ_i` is never zero, so the new polynomial's higher coefficients are uniform as long as `Q` holds an honest dealer, which `key-dealers` gives under the predecessor's threshold.
- **Withholding.** As in [[nullifier-key]] (Security notes): a dealer or the coordinator can withhold a reshared share from a new seat, which then can't approve. Under rule 7 one corrupt dealer that withholds from one honest new seat, with one new seat that refuses to approve, stalls that run's successor, unattributably; the predecessor stays in force, and the stalled run's approvals expire at its deadline (Approval, rule 6), so it delays a panel change by a run for as long as the adversary keeps withholding, and loses nothing (T-54).
- **The release alone can't choose the recipients, and the old panel can't be bypassed.** A successor counts only with `max(k, n − 1)` of the predecessor's seats dealing, each having verified the new panel out of band, and `q'` of the new panel's seats approving. So an insider who controls a release and pins a panel of its own keys still needs the old trustees to agree to it. Two successor panels of one predecessor need two dealer quorums, which share `2·max(k, n − 1) − n` old seats: for 4-of-7, 5 seats, so at least one honest seat (at most `k − 1 = 3` are corrupt), which deals to only one successor panel at a time. For panels where `2·max(k, n − 1) − n < k` the shared seats may all be corrupt; the group registry, which records a successor only of its current key, is then what keeps one successor ([[contracts]], Group registry, Nullifier keys), and the same holds for approvals within one new panel. The residual trust in the release is that it names the panel the trustees are asked to verify (T-37). The cost is liveness, as for opening elections under [[0006-trustees]] rule 7: with `max(k, n − 1)` dealers required, any two of the predecessor's seats that are gone, unavailable or refusing block every panel change, including one that would replace them, and the key stays on a shrinking panel until `n − k + 1` losses end it. So a panel is changed or refreshed while at most one of its seats is missing, and a seat that is leaving deals in a reshare before it goes (T-54). Counting the quorum over the seats still available instead would let a release that also controlled two seats' absence choose the recipients.
- **Re-signing.** As in [[nullifier-key]]: a seat with a message in the last non-empty round can, with the coordinator, make a second transcript of the same resharing with another `key_id`, splitting approvals. That costs liveness only: both carry the same shares and the same `sk`, and once the run's deadline passes neither binds any seat.
- **Registration keys.** As in [[nullifier-key]]: the successor's registration secrets live as long as its shares (T-37, T-29), and an abandoned run's are erased with its shares (Approval).
- **Not constant time everywhere.** Polynomial evaluation, Lagrange coefficients and share sums are `bigint` arithmetic, and secrets can't be zeroised in JavaScript (T-39, T-14).

## Test vectors

`docs/spec/vectors/nullifier-reshare.json` ([[vectors/README|vectors]]): a predecessor key made by [[nullifier-key]]'s rounds on a 2-of-4 panel with seat 4 absent; reshares of it to a 3-of-4 panel and to the same panel (a refresh), each re-made byte for byte from its seats' secrets (round messages, every reshared share and its hash), with every new seat's share recomputed from the reshared shares and shown to interpolate, with any `k'` of the others, to the predecessor's `sk`; transcripts with their results: a dealer whose wrong and unopenable shares draw complaints that its reveals answer, a wrong reveal (`bad-reveal`), no response (`unanswered`), a dealer that shares something other than its own share (`constant`), one dealer too few (`key-dealers`), an absent new seat, a bad signing-key proof, a new seat reusing its predecessor signing key (`duplicate-key`), too few new seats (`key-quorum`), and transcripts failing `key-predecessor`, `key-signature` on a changed deadline, `key-order` (a dealer that isn't a qualified seat of the predecessor, a complaint from an absent seat), `key-shape` and `key-signature` (a message signed by the other panel's key for its seat, the run identifier); reshared-share checks failing each code; approval statements and signatures (under the retired `abolish/v1/sig/nullifier-reshare-approval`; statements under its `-2` and the consent statement come with `packages/crypto`'s code for them, [[P3-4]] part 2b-4b-2); and rejected encodings. They are printed by `packages/crypto/scripts/nullifier-reshare-vectors.py`, which reuses only `nullifier-key-vectors.py`'s independent code (and through it the Baby Jubjub, ML-KEM-768, ChaCha20-Poly1305, ristretto255 and P-256 code it reuses); it shares nothing with `packages/crypto` or any `@noble` library.
