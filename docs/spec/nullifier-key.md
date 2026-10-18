# Nullifier key

How the trustee panel creates the Tier 2 keyed nullifier's OPRF key `sk` ([[keyed-nullifier]]): the key context, four rounds that register each seat's registration keys and deal Pedersen VSS sharings with complaints (the first phase of GJKR's DKG, with no public key), the key transcript (record type `0x0011`, version 2, which binds the run's deadline; version 1, without one, is retired before any registry is deployed), the dealt-share message that carries a share privately (record type `0x0012`, version 1), the transcript check that yields the qualified seats, their share commitments and `key_id`, and each seat's approval of the key. This is option A of [[0022-tier2-keyed-nullifier]]. Notation is from [[notation]], ristretto255 and `H` from [[group]], Baby Jubjub, `J` and the share commitments from [[keyed-nullifier]], identity keys and signatures from [[trustee-identity]], and the KEM key from [[share-encryption]]. Threats: T-03, T-13, T-14, T-15, T-29, T-31, T-37, T-39, T-40, T-54.

What this page doesn't cover yet (P3-4 part 2b's later steps):

- **Resharing** the key to a new panel or epoch, and how a later epoch's key succeeds this one, are [[nullifier-reshare]]'s (part 2b-2b). A scope's initial key is made once, here; every later key is a reshare of the one before it.
- **Where approvals are recorded** is the group registry ([[contracts]], Group registry, Nullifier keys), which decides whether a key counts. [[verifier]] 2.4's use of the key, and where transcripts are published: part 2b-4. This page defines the approval statement and the rule an honest seat follows.
- **Queries** ([[nullifier-query]]) and their transport to the registration KEM keys this page registers: part 2b-4.

## Sources

- **The sharing:** Pedersen VSS (T. P. Pedersen, "Non-Interactive and Information-Theoretic Secure Verifiable Secret Sharing", CRYPTO 1991) dealt by every seat, with GJKR's complaint rule and qualified set (R. Gennaro, S. Jarecki, H. Krawczyk and T. Rabin, "Secure Distributed Key Generation for Discrete-Log Based Cryptosystems", J. Cryptology 2007, Fig. 2, steps 1 to 3). Its step 4, which publishes `sk · G`, is never run ([[0022-tier2-keyed-nullifier]], Key).
- **Private channels:** [[share-encryption]]'s hybrid KEM (ML-KEM-768 with Diffie–Hellman in ristretto255) and ChaCha20-Poly1305, as the summed-share message of [[tally]] uses them, under this page's own tags.
- **Signatures:** ECDSA P-256 as [[trustee-identity]] specifies, for the identity key and for the registration signing key.

## Parties and keys

The panel is the scope's **initial panel**, the one the deployment's release pins for the Tier 2 scope's initial key ([[trustee-identity]], Panel identifier). That pin is kept apart from the panel that holds the key today and never changes, even after a reshare hands the key to another panel ([[nullifier-reshare]]); a checker accepts an initial key only under it. The panel has `k`, `n` and the identity keys `Q_1 … Q_n`. Each seat `i` that takes part generates, fresh for this key and this run, from the CSPRNG:

- a **registration KEM key** pair (`kem_key_i`, `kem_secret_i`) ([[share-encryption]], Trustee KEM key). It receives the seat's dealt shares in round 2 and, from part 2b-4, clients' queries. Unlike a per-election KEM key, it lives as long as the seat's share of `sk`;
- a **registration signing key** `P_i = d_i · G` on P-256, `d_i` uniform on 1 to `n_P256 − 1`. It signs the seat's keyed-nullifier answers ([[keyed-nullifier]], Answer record), so the identity key signs only this page's messages and approval, at a ceremony with a person present, and never automatically (T-37).

A **coordinator** relays messages and assembles the transcript, as in [[ceremony]]. It is trusted for nothing but liveness (Security notes).

## Key context

The Tier 2 scope is one group registry on one chain ([[0010-tier2-identity-provider]]: one Tier 2 scope per deployment). The coordinator picks `run_id`, 32 bytes from the CSPRNG, fresh for every run, and the run's `deadline`, an L2 block number by which the key's approvals must be recorded to count (Approval). The deadline lies at most `MAX_KEY_WINDOW = 302,400` blocks (7 days of 2-second blocks, as [[nullifier-reshare]]'s `MAX_RESHARE_WINDOW`), a constant of transcript version 2, ahead of the latest L2 block when the run starts: a seat sends its round-1 message only if the deadline is ahead of the latest block its node has seen by at least one block and at most `MAX_KEY_WINDOW`. Every message of a version-2 run binds

```
key_context = H(DS("abolish/v1/keyed-nullifier/key-context-2",
    u64(l2_chain_id) ‖ group_registry ‖ panel_id ‖ run_id ‖ u64(deadline)))
```

| Field            | Type        | Source                                                                          |
| ---------------- | ----------- | ------------------------------------------------------------------------------- |
| `l2_chain_id`    | `u64`       | The L2 chain ID the deployment's release pins                                   |
| `group_registry` | `bytes[20]` | The group registry's address the release pins ([[contracts]], Group registry)   |
| `panel_id`       | `bytes[32]` | Recomputed from the pinned panel, never taken from data                         |
| `run_id`         | `bytes[32]` | The run identifier, from the transcript                                         |
| `deadline`       | `u64`       | The L2 block by which the key's approvals must be recorded, from the transcript |

A checker rebuilds the context from its own pins and the transcript's `run_id` and `deadline`, so a transcript made for another chain, registry, panel, run or deadline never checks (T-37, T-34). A node refuses to take part in a run whose (`panel_id`, `run_id`) it has seen before, and never reuses a key, a polynomial, a nonce or a KEM message across runs.

**Version 1** (retired before any registry is deployed, kept for its frozen vectors) has no deadline: its context is `H(DS("abolish/v1/keyed-nullifier/key-context", u64(l2_chain_id) ‖ group_registry ‖ panel_id ‖ run_id))`, under its own tag, so no message of a version-1 run checks in a version-2 run, or the reverse. A version-1 key never counts (Approval): with no deadline, approval rule 4 as version 1 wrote it let a seat approve one key per scope ever, so a run stalled by one corrupt seat withholding its dealt share from two honest seats under `q = n − 1` blocked the scope's initial key for good. The rest of this page holds for both versions unless it names one.

## Rounds

The protocol has four rounds, chained as the key ceremony's are ([[ceremony]], Rounds): with `R_r` the list of round `r`'s messages as the transcript encodes it,

```
h_0 = key_context
h_r = H(DS("abolish/v1/keyed-nullifier/key-round", h_{r−1} ‖ u8(r) ‖ encode(R_r)))     for r = 1, 2, 3
```

Seat `i`'s round-`r` message is signed with its pinned identity key `Q_i` under `abolish/v1/sig/nullifier-key-message` over

```
m = u8(r) ‖ h_{r−1} ‖ u8(i) ‖ body
```

where `body` is the encoding of the message's fields between `index` and `signature`, in the order the tables below list them. So a message of round `r` commits to every message of the rounds before it as the transcript lists them, and every seat that signed in round `r` saw the same earlier rounds.

Below, `S_1` is the set of seats with a round-1 message and `S_2` those with a round-2 message, each in increasing seat order.

### Round 1: registration keys

Seat `i` sends:

| Field         | Type       | Meaning                                         |
| ------------- | ---------- | ----------------------------------------------- |
| `index`       | `u8`       | `i`                                             |
| `kem_key`     | `kem_key`  | Its registration KEM key ([[share-encryption]]) |
| `signing_key` | `p256-key` | `P_i`, its registration signing key             |
| `signing_pop` | `p256-sig` | `P_i`'s signature on the entry (below)          |
| `signature`   | `p256-sig` | `Q_i`'s signature on the round-1 message        |

`signing_pop` is `P_i`'s signature under `abolish/v1/sig/nullifier-key-signing-key` over

```
key_context ‖ u8(i) ‖ encode(kem_key) ‖ signing_key
```

(1,282 bytes), so a seat can't register another seat's signing key: its signature would have to name the other's key and this seat.

A node stores its registration secrets before it sends its round-1 message, signs at most one round-1 message per (`panel_id`, `run_id`), and checks dealt shares, complains and deals only with the keys its round-1 message in the transcript carries. A node that lost or regenerated its keys mid-run would otherwise fail to open every honest dealer's share and complain about all of them, and their reveals would publish its shares: with the `k − 1` points the corrupt seats hold, `k` points of every honest polynomial, and so `sk` (Round 3). An in-session review found this.

The KEM key carries no proof of possession, unlike the key ceremony's ([[0018-ceremony-possession]]). There a key nobody holds loses every voter's share to that seat; here each share sent to a seat is that seat's own, so a seat that registers a KEM key it can't open loses only its own shares, and one that copies another seat's KEM key gives that seat its own shares (Security notes).

### Round 2: dealings

After round 1 closes, each seat `d` in `S_1` draws, from the CSPRNG, two polynomials of degree `k − 1` over `F_l`,

```
f_d(z)  = a_{d,0} + a_{d,1} z + … + a_{d,k−1} z^{k−1}
f'_d(z) = b_{d,0} + b_{d,1} z + … + b_{d,k−1} z^{k−1}
```

with every coefficient uniform on 0 to `l − 1`, and computes the coefficient commitments `A_{d,j} = a_{d,j} · G + b_{d,j} · J` ([[keyed-nullifier]], Share commitments), redrawing both coefficients of any `A_{d,j}` that is the identity. For every other seat `i` in `S_1`, in increasing order, it seals `(f_d(i), f'_d(i))` to seat `i`'s round-1 KEM key in a dealt-share message (Dealt share, below), and sends:

| Field          | Type                                | Meaning                                                                                       |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `index`        | `u8`                                | `d`                                                                                           |
| `commitments`  | `list<bjj-point, MAX_TRUSTEES>`     | `A_{d,0}, …, A_{d,k−1}`, exactly `k` of them. Never the identity                              |
| `share_hashes` | `list<bytes[32], MAX_TRUSTEES − 1>` | The dealt-share hash of its message to every `i` in `S_1` other than `d`, in increasing order |
| `signature`    | `p256-sig`                          | `Q_d`'s signature over `h_1`                                                                  |

The dealt-share messages travel to their recipients beside the round-2 message, through the coordinator or directly, and never enter the transcript: only their hashes do, so the transcript stays perfectly hiding (Security notes). A dealer keeps `f_d` and `f'_d` until round 4 closes, then keeps only its own share `(f_d(d), f'_d(d))` and erases the rest.

A seat deals to every seat with a round-1 message, whether or not its signing key's proof passes: the rule is the same for everyone, and a share sent to a seat is that seat's own.

### Round 3: complaints

After round 2 closes, each seat `i` in `S_1` checks the dealt-share message it holds from each other dealer `d` in `S_2` (Dealt-share check, below). It complains about `d` only if it holds a message whose hash equals `d`'s `share_hashes` entry for `i` and whose check then fails at `share-decrypt` or `share-verify`. A seat with no complaint sends no round-3 message. Otherwise it sends:

| Field        | Type                         | Meaning                                                                                          |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `index`      | `u8`                         | `i`                                                                                              |
| `complaints` | `list<u8, MAX_TRUSTEES − 1>` | The dealers it complains about: seats of `S_2` other than `i`, strictly increasing, at least one |
| `signature`  | `p256-sig`                   | `Q_i`'s signature over `h_2`                                                                     |

**A missing message is never a complaint.** A seat that holds no dealt-share message matching `d`'s hash fetches it again from `d`'s node, by any channel (the signed hash authenticates it); if it still has none when it must send its round-3 message, it doesn't complain, and it doesn't approve the key (Approval). A complaint about a missing message would make an honest dealer publish an honest seat's share, so a coordinator that withheld one honest dealer's message from one honest seat would learn a `k`-th point of that dealer's polynomial; with every dealer, `sk` (Security notes).

### Round 4: responses

After round 3 closes, each seat `d` in `S_2` that some round-3 message complains about sends:

| Field       | Type                                     | Meaning                                                                           |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `index`     | `u8`                                     | `d`                                                                               |
| `reveals`   | `list<revealed-share, MAX_TRUSTEES − 1>` | One for every seat whose round-3 message complains about `d`, in increasing order |
| `signature` | `p256-sig`                               | `Q_d`'s signature over `h_3`                                                      |

`revealed-share`:

| Field        | Type         | Meaning                   |
| ------------ | ------------ | ------------------------- |
| `complainer` | `u8`         | `i`, the complaining seat |
| `share`      | `bjj-scalar` | `f_d(i)`                  |
| `blind`      | `bjj-scalar` | `f'_d(i)`                 |

A revealed share is public; the complainer uses it in place of the message it couldn't open. An honest seat, opening with the keys its round-1 message carries (Round 1), never complains about an honest dealer (only a hash collision, or an ML-KEM decryption failure, below 2⁻¹⁶⁴, could make it), so a reveal only ever publishes a corrupt dealer's point or a complaining corrupt seat's own share (GJKR, Lemma 1).

## Dealt share

Record type `0x0012`, version 1. Private: it travels only between trustee nodes and is never put on the board, IPFS, the archive or any store that keeps it after the key is approved; no profile pins it, and the key transcript version fixes it (version 1 of the transcript uses version 1 of this message).

| Field         | Type          | Meaning                                                                         |
| ------------- | ------------- | ------------------------------------------------------------------------------- |
| `key_context` | `bytes[32]`   | The run's key context                                                           |
| `dealer`      | `u8`          | `d`                                                                             |
| `recipient`   | `u8`          | `i`; never `d`                                                                  |
| `ct_mlkem`    | `bytes[1088]` | `ct_M`                                                                          |
| `ct_dh`       | `element`     | `ct_DH`. Never the identity, as in [[share-encryption]]                         |
| `sealed`      | `bytes[80]`   | The AEAD output: `bjj-scalar(f_d(i)) ‖ bjj-scalar(f'_d(i))` and the 16-byte tag |

The message is 1,237 bytes. **Encryption.** With seat `i`'s round-1 `kem_key = (ek_i, dh_i)`, the dealer draws 32 bytes `μ` and a scalar `e`, uniform on 1 to `ℓ − 1`, from the CSPRNG, fresh for every message, and computes:

```
(ss_M, ct_M) = ML-KEM-768.Encaps_internal(ek_i, μ)
ct_DH        = g^e
ss_DH        = dh_i^e
K            = H(DS("abolish/v1/kem/nullifier-key-share", ss_M ‖ encode(ss_DH) ‖ encode(ct_DH) ‖ encode(dh_i)))
aad          = DS("abolish/v1/kem/nullifier-key-share-aad",
                 u16(0x0012) ‖ u8(1) ‖ key_context ‖ u8(d) ‖ u8(i) ‖ encode(commitments))
sealed       = ChaCha20-Poly1305.Seal(K, nonce = 12 zero bytes, aad, bjj-scalar(f_d(i)) ‖ bjj-scalar(f'_d(i)))
```

`K` is [[share-encryption]]'s combiner under its own tag, so a share stays secret in transit while either ML-KEM-768 or discrete logs in ristretto255 hold, and each `K` seals exactly one message. `aad` binds the record type and version, the run, both seats and the dealer's whole list of coefficient commitments (`encode` of the `list<bjj-point, MAX_TRUSTEES>`, count included), so a message opens only for the recipient, run and dealing it was sealed for. Its hash is

```
share_hash = H(DS("abolish/v1/keyed-nullifier/key-share", encode(message)))
```

over the record's full encoding, header included. The message carries no signature: the dealer's identity-signed round-2 message carries its hash, which authenticates it, and a hash that matches is the only way a message reaches decapsulation (below).

**Dealt-share check.** Seat `i`, holding its `kem_secret` and the rounds so far, checks a message it received for dealer `d`, in this order; the first failure is the result:

| Code              | Check                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `share-malformed` | It decodes strictly as version 1 ([[notation]])                                                                                                                  |
| `share-context`   | `key_context` is the run's, `recipient` is `i`, and `dealer` is a seat of `S_2` other than `i`                                                                   |
| `share-hash`      | `share_hash` equals `d`'s `share_hashes` entry for `i`                                                                                                           |
| `share-decrypt`   | `ss_M = ML-KEM-768.Decaps_internal(dk_i, ct_M)`, `ss_DH = ct_DH^{x_i}`, `K` and `aad` as above; the AEAD opens, and its plaintext is two `bjj-scalar`s `(σ, σ')` |
| `share-verify`    | `σ · G + σ' · J = Σ_{j=0}^{k−1} (i^j mod l) · A_{d,j}`                                                                                                           |

A message failing `share-malformed`, `share-context` or `share-hash` isn't `d`'s, or isn't for this run or seat: the seat ignores it and keeps waiting for one that matches. Only a matching message that fails `share-decrypt` or `share-verify` is grounds for a complaint (round 3). Checking the hash first means only a panel seat's signed dealing can make a node decapsulate a chosen `ct_M`, as for the summed-share message ([[tally]], Summed-share message; T-39). Nothing about a decapsulation is ever revealed: a complaint names the dealer only, and the dealer answers with the share itself.

## Transcript

The key transcript is record type `0x0011`, version 2:

| Field        | Type                                  | Meaning                                |
| ------------ | ------------------------------------- | -------------------------------------- |
| `run_id`     | `bytes[32]`                           | The run identifier                     |
| `deadline`   | `u64`                                 | The run's deadline, an L2 block number |
| `keys`       | `list<round-1 message, MAX_TRUSTEES>` | `R_1`, in increasing seat order        |
| `dealings`   | `list<round-2 message, MAX_TRUSTEES>` | `R_2`, in increasing seat order        |
| `complaints` | `list<round-3 message, MAX_TRUSTEES>` | `R_3`, in increasing seat order        |
| `responses`  | `list<round-4 message, MAX_TRUSTEES>` | `R_4`, in increasing seat order        |

Version 1 is the same record without `deadline`. Each message is its table's fields in order, `index` first and `signature` last. `encode(R_r)` in the round chain is the encoding of that list field, count included. The key's identifier is

```
key_id = H(DS("abolish/v1/keyed-nullifier/key", encode(transcript)))
```

over the record's full encoding, header included, under both versions: the header's version byte comes before every field that varies, so a version-1 and a version-2 transcript never hash the same input ([[domain-separation]], Rules). It is the `key_id` every answer and evaluation proof binds ([[keyed-nullifier]], Evaluation), so a proof made under one key or run never verifies under another.

## Transcript check

A checker (a seat, a client, an attester, and from part 2b-4 [[verifier]] 2.4) decodes the transcript under the version it pins (version 2; version 1 only for its frozen vectors), rebuilds `key_context` from its pins and the transcript's `run_id` and, under version 2, `deadline`, and checks, in order. The first three checks, and the last, make the whole transcript invalid: each is something an honest coordinator never produces, or a property of the qualified set as a whole, and none can be attributed to a single seat.

1. **Order** (`key-order`). In each round, seats are strictly increasing and from 1 to `n`. A round-2 or round-3 message comes from a seat in `S_1`; a round-4 message from a seat in `S_2`.
2. **Shape** (`key-shape`). Each round-2 message has exactly `k` `commitments` and one `share_hashes` entry for each seat of `S_1` other than its own. Each round-3 message's `complaints` are strictly increasing, at least one, and each a seat of `S_2` other than its own. A round-4 message comes only from a seat that some round-3 message complains about, and its `reveals` list exactly the seats whose round-3 messages complain about it, in increasing order.
3. **Signatures** (`key-signature`). Every message's `signature` verifies under its seat's pinned identity key over `m` above, with `h_{r−1}` computed from this transcript.
4. **Seats.** Each seat is qualified or not, by the rules below.
5. **Quorum** (`key-quorum`). At least `k` seats are qualified. With fewer, `k` qualified shares never exist and nothing can be evaluated.

A seat `i` is a **qualified dealer** if and only if none of the first six reasons below holds, and **qualified** if, in addition, its share commitment isn't the identity. Each is a reason, reported in this order, and a seat may have several. The first six are attributed to seat `i`, because each rests only on messages `Q_i` signed, or on its absence where the rules required a message; `identity-commitment` is attributed to no one (below).

| Reason                | Holds when                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `absent`              | `i` has no round-1 message                                                                                                                                           |
| `possession`          | `signing_pop` doesn't verify under `signing_key`                                                                                                                     |
| `duplicate-key`       | It passes `possession` and its `signing_key` equals another passing seat's or any seat's pinned identity key                                                         |
| `no-dealing`          | It is in `S_1` and has no round-2 message                                                                                                                            |
| `unanswered`          | Some round-3 message complains about it and it has no round-4 message                                                                                                |
| `bad-reveal`          | One of its reveals fails `share · G + blind · J = Σ_{j=0}^{k−1} (c^j mod l) · A_{i,j}`, with `c` the reveal's `complainer` and `A_{i,j}` its own round-2 commitments |
| `identity-commitment` | It is a qualified dealer and its share commitment `C_i` (below) is the identity                                                                                      |

The qualified dealers are GJKR's `QUAL`: their polynomials make up the key. The qualified seats are those that hold it: a seat must deal, and answer every complaint about it, to hold a share. Then, for each qualified dealer `i`,

```
C_i = Σ_{d qualified} Σ_{j=0}^{k−1} (i^j mod l) · A_{d,j}
```

its share commitment ([[keyed-nullifier]], Share commitments), and seat `i`'s share is `(sk_i, s_i) = Σ_{d qualified dealer} (f_d(i), f'_d(i)) mod l`, with `(f_d(i), f'_d(i))` from `d`'s dealt-share message, from `d`'s reveal where `i` complained, and its own for `d = i`. The OPRF key is `sk = Σ_{d qualified dealer} a_{d,0}`, which no one holds.

The check's output is the **key**: `key_id`, the transcript's version and, under version 2, its `deadline`, `k`, the qualified dealers, and for each qualified seat in increasing order its `index`, registration `kem_key`, registration `signing_key` and `C_i`. A client and an attester take every value [[keyed-nullifier]]'s answer check needs from it, never from an answer: `key_id`, `k`, the seat's `signing_key` (`answer-signature`) and `C_i` (`answer-proof`). A seat that isn't qualified has no share, and its answers fail `answer-seat`. A key is used only once its approvals are counted (Approval; recorded by the group registry, [[contracts]], Group registry, Nullifier keys): the check alone doesn't apply the participation rule.

Why each rule:

- **`possession` and `duplicate-key`** are the key ceremony's rules for the signing key ([[ceremony]], Why each rule): the proof binds the seat, so a seat can't take another's key, and a signing key that is an identity key would fold the two roles that [[trustee-identity]] keeps apart.
- **`no-dealing`**: every holder contributes a polynomial, so `sk` is uniform as long as one qualified seat is honest (GJKR, Theorem 2; T-40), and under the participation rule below at least `max(k, n − 1) − (k − 1)` qualified seats are honest.
- **`unanswered` and `bad-reveal`** are GJKR's: a dealer that doesn't answer a complaint with a share that opens its commitments is disqualified, and its polynomial is dropped from every share. A reveal that checks keeps the dealer, whatever the complainer says, so a corrupt seat can't disqualify an honest dealer.
- **`identity-commitment`**: an honest sharing gives the identity with negligible probability, but a seat can aim for it. A corrupt seat that chooses its polynomials after opening every other seat's share to itself (rushing) can make its own share, and so `C_i`, the identity, with a dealing every honest seat accepts; a corrupt dealer can make an honest seat's `C_i` the identity by withholding that seat's message, so that it can't complain. Either way only seat `i` loses its share: its dealing still counts (a seat that zeroes its own share learns no more of `sk` than one point of each other polynomial, which it holds anyway), and the identity, which the answer check can't take, stays out of the key. That is why the reason is attributed to no one, and why it removes one seat rather than failing the transcript: an in-session review found that, as a transcript-level code, it let one seat fail every run unattributably.

## Approval

Seat `i` approves a version-2 key by signing, with its identity key under `abolish/v1/sig/nullifier-key-approval-3`,

```
m = u64(l2_chain_id) ‖ group_registry ‖ panel_id ‖ u8(i) ‖ key_id ‖ u64(deadline)
```

(101 bytes), with `deadline` the transcript's, only if all of these hold:

1. the transcript passes the check under version 2, with at least `max(k, n − 1)` qualified seats ([[0006-trustees]] rule 7, the quorum attestations use too, [[0022-tier2-keyed-nullifier]], Uniqueness across quorums);
2. seat `i` is qualified, and the share it computed opens its `C_i`: it holds a dealt share or a reveal from every other qualified seat;
3. the transcript holds every message `i` sent, as it sent it, so every round chain it signed over is the transcript's;
4. no key counts for this (`l2_chain_id`, `group_registry`), initial or reshared: the group registry's current key is zero ([[contracts]], Group registry, Nullifier keys), and `i` has approved no successor of any key of it ([[nullifier-reshare]], Approval). A later key is a reshare of the one that counts, approved under that page's own statement and rule, never a second initial key. An in-session review found that a rule allowing one initial key per seat let a later panel, whose seats had approved only reshares, make a second initial key with a fresh `sk`, and so a second nullifier for every document; the initial-panel pin above closes it as well;
5. the run's `deadline` hasn't passed, and lies at most `MAX_KEY_WINDOW` ahead: the L2 chain's latest block is at least `RECORD_MARGIN` below it (Approval, Recording);
6. every other version-2 initial key `i` approved has passed its own deadline without counting. A seat approves **at most one live initial key per Tier 2 scope**: a run that stalls releases its seats at its deadline, so a later run can count. Approvals under version 1's statement never bind a seat, since no version-1 key counts.

A seat judges rules 4 to 6 from its own L2 node, never from a view the coordinator or any other party serves: whether a key counts, and whether a deadline passed without its key counting, are read from the group registry once the deadline's block is final on L1. Under version 1 an honest seat needed no view of the chain, since it approved one key ever; under rules 4 to 6 its view is load-bearing, so a seat shown a stale or forked chain in which a counted key didn't count would approve a second. The registry's rule that records at most one initial key per scope, ever, is the backstop: two quorums' approvals of two keys can both exist, but the registry records only the first submitted and refuses the other for good ([[contracts]], Group registry, Nullifier keys; T-03).

A key **counts** when the group registry records it ([[contracts]], Group registry, Nullifier keys): one record carrying approvals from `q = max(k, n − 1)` **distinct seats** of the initial panel under this statement, each verifying under its seat's pinned identity key, counted per seat, never per signature ([[trustee-identity]], Ceremony registration), submitted in an L2 block at or before the statement's `deadline` while no key is recorded for the scope. A verifier counts it only if, as well, its transcript is version 2, checks with at least `q` qualified seats, hashes to `key_id` and carries the record's `deadline`: the registry can't run the transcript check, so a record a corrupt quorum signed for a transcript that fails is recorded, and stops the scope's chain of keys there (Group registry, Nullifier keys, Known-weak). Whether a key counts is so settled at its deadline. Two such quorums share `2q − n` seats, at least one, and at least one honest seat when `2q − n ≥ k` (as for 4-of-7), so two counted initial keys need an honest seat that approved the second before the first's deadline passed, or while the first counted, which rules 4 and 6 forbid. The group registry records at most one initial key per scope, ever, which covers panels where the shared seats may all be corrupt.

**Recording.** Every approval is sent to every seat of the run, not only the coordinator, so any seat can submit the record ([[contracts]], Group registry, Nullifier keys). `RECORD_MARGIN = 43,200` L2 blocks (24 hours of 2-second blocks) is twice Base's 12-hour sequencing window: a seat holding a quorum's approvals that sees no record by `deadline − 21,600` submits the record itself through the L1 portal, which a sequencer can delay by at most the sequencing window, so a sequencer that censors the record can't push it past the deadline (T-50, T-54). The same margin binds [[nullifier-reshare]]'s approvals and consents. If Base raises its sequencing window, the margin must rise with it before any registry is deployed (Group registry, Known-weak).

**The deadline is in the statement.** `key_id` binds the deadline, but the registry can't read it from `key_id` without the whole transcript, so it takes the deadline from the statement every approving seat signs. Under `abolish/v1/sig/nullifier-key-approval-2`, the same statement without `deadline` (93 bytes), whoever held a quorum's approvals of a run could hold them back past its deadline, until its seats, seeing no key recorded, had erased their shares and approved another run, and then record them under a deadline of its choosing: the registry, which records one initial key ever, would hold for good a key no seat can answer under, and a verifier would refuse it for a deadline its transcript doesn't carry, so the scope would have no key (T-54, T-03). So an approval under that statement never counts, and the tag is retired before any registry is deployed, as is version 1's. A version-2 transcript's deadline is unchanged: only the statement over it gains it.

A version-1 key never counts, and neither does an approval under version 1's statement, `abolish/v1/sig/nullifier-key-approval` over the same 93 bytes: version 1's rule 4 let a seat approve one key per scope ever, whatever the run, so one stalled run (Security notes, Withholding) held its approving seats for good. An earlier draft of [[nullifier-reshare]] had the same flaw for successors, found by `claude-review`; its deadline rule is what this version brings to the initial key.

A run whose key hasn't counted by its deadline is abandoned, its approvals with it: the coordinator starts another with a fresh `run_id` and a later deadline, and every seat generates fresh keys and polynomials. Each seat erases what the abandoned run gave it once its deadline's block is final on L1 and the group registry, read from its own L2 node, hasn't recorded this run's `key_id` (a record can land in the deadline's own block, or on a final chain that differs from the head a sequencer showed it, and a seat that erased a recorded key's shares would cost the key a seat for good), and at once if it refuses to approve: the dealt shares and reveals it received, its share, its polynomials and the run's registration secrets. Unlike an abandoned reshare's, an abandoned run's shares are of an `sk` that never counts, so nothing answers under it; erasing them keeps a seat holding no secrets beyond the key's.

## Security notes

- **Perfectly hiding transcript.** The transcript holds the coefficient commitments (perfectly hiding Pedersen commitments), the hashes of the dealt-share messages, and reveals. A dealt-share message carries `μ` and `e`, over 500 bits of fresh entropy, against a 256-bit hash, so its hash is statistically hiding in the random-oracle model ([[share-encryption]], Hiding). Reveals publish only corrupt dealers' points or corrupt complainers' own shares, at most `k − 1` points of any honest dealer's polynomial. So nothing published fixes `sk`, even to an unbounded adversary ([[0022-tier2-keyed-nullifier]], Key; T-15). The dealt-share messages themselves fall to an adversary who records them and breaks both ML-KEM-768 and discrete logs in ristretto255; they are never archived.
- **Withholding.** The coordinator, or a dealer, can withhold a dealt-share message from a seat, which then lacks a share, can't complain, and doesn't approve. Nothing in the transcript shows it: a seat knows which dealer's message it lacks, but can't prove it. Under rule 7 two seats that don't approve stall the key, so one corrupt seat that withholds its message from one honest seat, and doesn't approve itself, stalls it alone, which under rule 7 otherwise takes two refusing trustees; nothing attributes it, since the honest seat can't prove what it lacks and the corrupt seat's refusal looks like an honest seat's (T-54). The stalled run's approvals expire at its deadline (Approval, rule 6), so the adversary delays the key by a run for as long as it keeps withholding, run after run, and blocks it for good only under version 1, which is why version 1 never counts. It can't learn anything by it: a missing message is never a complaint (Round 3), so withholding never makes an honest dealer reveal. Fetching the message straight from the dealer's node leaves the dealer as the only party that can withhold.
- **Equivocation.** A dealer that sends different seats different round-2 messages, or a coordinator that shows seats different views, leaves seats that saw another view without a matching hash or chain: their round-3 messages and approvals don't check against the transcript, and they don't approve. A seat that holds two round-2 messages signed by one seat keeps both and can show them to the other seats and the panel's operators: they show that seat equivocated, since only it can sign them.
- **Re-signing.** `key_id` hashes the transcript, signatures included, and ECDSA lets a signer make another valid signature on the same message. So a seat with a message in the transcript's last non-empty round, with the coordinator, can make a second transcript of the same sharing with another `key_id`, and split honest seats' approvals between the two. That costs liveness only: both carry the same commitments and the same `sk`, an honest seat approves only one, and once the run's deadline passes neither binds any seat.
- **Rushing.** A dealer may choose its polynomial after seeing every other round-2 message. The commitments are perfectly hiding, so it learns nothing about the other polynomials' constant terms, and `sk` stays uniform with one honest qualified dealer (GJKR, Theorem 2; T-40). No public key is ever computed, so GJKR's bias attack on Pedersen's DKG has nothing to bias.
- **Registration keys.** A seat's registration KEM secret and signing secret live as long as its share. A stolen registration signing key signs answers attributed to its seat: without the share, those answers fail `answer-proof` and frame the seat, and with the share the thief evaluates anyway (T-37, T-29). The identity key, needed only at this ceremony and its approval, stays offline or behind a person's approval between ceremonies, as [[0006-trustees]] rule 6 asks (T-37).
- **The shares are long-lived.** `sk` lives for the Tier 2 scope ([[0022-tier2-keyed-nullifier]], A long-lived key). Each seat keeps `(sk_i, s_i)`, its registration secrets and its approval record; the trustee role description (P1-7) must say so before real documents register (T-14, T-40).
- **Not constant time everywhere.** As in [[keyed-nullifier]] and [[share-encryption]]: scalar multiplications by secrets use `@noble/curves`' constant-time ladder, but polynomial evaluation and share sums are `bigint` arithmetic, and secrets can't be zeroised in JavaScript (T-39, T-14).

## Test vectors

`docs/spec/vectors/nullifier-key.json` ([[vectors/README|vectors]]): a 3-of-5 panel; key contexts and round chains; complete transcripts with each one's result (every seat's reasons, the qualified seats, `C_i`, `key_id`, and each qualified seat's share recomputed from the dealings): an honest run, a run with a corrupt dealer whose reveal checks and one whose reveal fails, an unanswered complaint, a groundless complaint, an absent seat, a seat that doesn't deal, a seat that zeroes its own share (`identity-commitment`), a bad signing-key proof, a duplicate signing key and an identity key used as a signing key, and transcripts failing each transcript-level code (round 1, 3 and 4 order, three shapes, round 1, 3 and 4 signatures and the run identifier); dealt-share messages re-made byte for byte from their randomness, and checks failing each code; approval statements and signatures. Those are version 1's. Under `version2`: an honest version-2 run re-made byte for byte from its seats' secrets and its deadline, with its context, dealt shares, result and shares; an absent seat; too few seats (`key-quorum`); a changed deadline and messages signed under version 1's context of the same run (`key-signature`); version-2 approvals, with an approval of the same key under version 1's statement and one of another key, neither counting; and rejected encodings (truncated, trailing, a truncated deadline, and each version under the other's pin). They are printed by `packages/crypto/scripts/nullifier-key-vectors.py`, which reuses only the independent Baby Jubjub code of `keyed-nullifier-vectors.py`, the ML-KEM-768, ChaCha20-Poly1305 and ristretto255 code of `share-encryption-vectors.py` and `group-vectors.py`, and `trustee-vectors.py`'s P-256 ECDSA; it shares nothing with `packages/crypto` or any `@noble` library. The `version2` approvals are under the retired `abolish/v1/sig/nullifier-key-approval-2`; statements under `abolish/v1/sig/nullifier-key-approval-3`, with the group registry's records, come with `packages/crypto`'s code for them ([[P3-4]] part 2b-4b-2).
