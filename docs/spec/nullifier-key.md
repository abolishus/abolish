# Nullifier key

How the trustee panel creates the Tier 2 keyed nullifier's OPRF key `sk` ([[keyed-nullifier]]): the key context, four rounds that register each seat's registration keys and deal Pedersen VSS sharings with complaints (the first phase of GJKR's DKG, with no public key), the key transcript (record type `0x0011`, version 1), the dealt-share message that carries a share privately (record type `0x0012`, version 1), the transcript check that yields the qualified seats, their share commitments and `key_id`, and each seat's approval of the key. This is option A of [[0022-tier2-keyed-nullifier]]. Notation is from [[notation]], ristretto255 and `H` from [[group]], Baby Jubjub, `J` and the share commitments from [[keyed-nullifier]], identity keys and signatures from [[trustee-identity]], and the KEM key from [[share-encryption]]. Threats: T-03, T-13, T-14, T-15, T-29, T-31, T-37, T-39, T-40, T-54.

What this page doesn't cover yet (P3-4 part 2b's later steps):

- **Resharing** the key to a new panel or epoch (Herzberg, Jarecki, Krawczyk and Yung; Desmedt and Jajodia), and how a later epoch's key succeeds this one: part 2b-2b. Until then a key is created once per Tier 2 scope and never changes.
- **Where approvals are recorded** (the group registry) and [[verifier]] 2.4's use of the key: part 2b-4. This page defines the approval statement and the rule an honest seat follows.
- **Queries** sent to the registration KEM keys this page registers: part 2b-3.

## Sources

- **The sharing:** Pedersen VSS (T. P. Pedersen, "Non-Interactive and Information-Theoretic Secure Verifiable Secret Sharing", CRYPTO 1991) dealt by every seat, with GJKR's complaint rule and qualified set (R. Gennaro, S. Jarecki, H. Krawczyk and T. Rabin, "Secure Distributed Key Generation for Discrete-Log Based Cryptosystems", J. Cryptology 2007, Fig. 2, steps 1 to 3). Its step 4, which publishes `sk · G`, is never run ([[0022-tier2-keyed-nullifier]], Key).
- **Private channels:** [[share-encryption]]'s hybrid KEM (ML-KEM-768 with Diffie–Hellman in ristretto255) and ChaCha20-Poly1305, as the summed-share message of [[tally]] uses them, under this page's own tags.
- **Signatures:** ECDSA P-256 as [[trustee-identity]] specifies, for the identity key and for the registration signing key.

## Parties and keys

The panel is the one the deployment's release pins for the Tier 2 scope ([[trustee-identity]], Panel identifier): `k`, `n` and the identity keys `Q_1 … Q_n`. Each seat `i` that takes part generates, fresh for this key and this run, from the CSPRNG:

- a **registration KEM key** pair (`kem_key_i`, `kem_secret_i`) ([[share-encryption]], Trustee KEM key). It receives the seat's dealt shares in round 2 and, from part 2b-3, clients' queries. Unlike a per-election KEM key, it lives as long as the seat's share of `sk`;
- a **registration signing key** `P_i = d_i · G` on P-256, `d_i` uniform on 1 to `n_P256 − 1`. It signs the seat's keyed-nullifier answers ([[keyed-nullifier]], Answer record), so the identity key signs only this page's messages and approval, at a ceremony with a person present, and never automatically (T-37).

A **coordinator** relays messages and assembles the transcript, as in [[ceremony]]. It is trusted for nothing but liveness (Security notes).

## Key context

The Tier 2 scope is one group registry on one chain ([[0010-tier2-identity-provider]]: one Tier 2 scope per deployment). The coordinator picks `run_id`, 32 bytes from the CSPRNG, fresh for every run. Every message of the run binds

```
key_context = H(DS("abolish/v1/keyed-nullifier/key-context",
    u64(l2_chain_id) ‖ group_registry ‖ panel_id ‖ run_id))
```

| Field            | Type        | Source                                                                        |
| ---------------- | ----------- | ----------------------------------------------------------------------------- |
| `l2_chain_id`    | `u64`       | The L2 chain ID the deployment's release pins                                 |
| `group_registry` | `bytes[20]` | The group registry's address the release pins ([[contracts]], Group registry) |
| `panel_id`       | `bytes[32]` | Recomputed from the pinned panel, never taken from data                       |
| `run_id`         | `bytes[32]` | The run identifier, from the transcript                                       |

A checker rebuilds the context from its own pins and the transcript's `run_id`, so a transcript made for another chain, registry, panel or run never checks (T-37, T-34). A node refuses to take part in a run whose (`panel_id`, `run_id`) it has seen before, and never reuses a key, a polynomial, a nonce or a KEM message across runs.

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

The key transcript is record type `0x0011`, version 1:

| Field        | Type                                  | Meaning                         |
| ------------ | ------------------------------------- | ------------------------------- |
| `run_id`     | `bytes[32]`                           | The run identifier              |
| `keys`       | `list<round-1 message, MAX_TRUSTEES>` | `R_1`, in increasing seat order |
| `dealings`   | `list<round-2 message, MAX_TRUSTEES>` | `R_2`, in increasing seat order |
| `complaints` | `list<round-3 message, MAX_TRUSTEES>` | `R_3`, in increasing seat order |
| `responses`  | `list<round-4 message, MAX_TRUSTEES>` | `R_4`, in increasing seat order |

Each message is its table's fields in order, `index` first and `signature` last. `encode(R_r)` in the round chain is the encoding of that list field, count included. The key's identifier is

```
key_id = H(DS("abolish/v1/keyed-nullifier/key", encode(transcript)))
```

over the record's full encoding, header included. It is the `key_id` every answer and evaluation proof binds ([[keyed-nullifier]], Evaluation), so a proof made under one key or run never verifies under another.

## Transcript check

A checker (a seat, a client, an attester, and from part 2b-4 [[verifier]] 2.4) decodes the transcript under version 1, rebuilds `key_context` from its pins and the transcript's `run_id`, and checks, in order. The first three checks, and the last, make the whole transcript invalid: each is something an honest coordinator never produces, or a property of the qualified set as a whole, and none can be attributed to a single seat.

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

The check's output is the **key**: `key_id`, `k`, the qualified dealers, and for each qualified seat in increasing order its `index`, registration `kem_key`, registration `signing_key` and `C_i`. A client and an attester take every value [[keyed-nullifier]]'s answer check needs from it, never from an answer: `key_id`, `k`, the seat's `signing_key` (`answer-signature`) and `C_i` (`answer-proof`). A seat that isn't qualified has no share, and its answers fail `answer-seat`. A key is used only once its approvals are counted (Approval; where, part 2b-4): the check alone doesn't apply the participation rule.

Why each rule:

- **`possession` and `duplicate-key`** are the key ceremony's rules for the signing key ([[ceremony]], Why each rule): the proof binds the seat, so a seat can't take another's key, and a signing key that is an identity key would fold the two roles that [[trustee-identity]] keeps apart.
- **`no-dealing`**: every holder contributes a polynomial, so `sk` is uniform as long as one qualified seat is honest (GJKR, Theorem 2; T-40), and under the participation rule below at least `max(k, n − 1) − (k − 1)` qualified seats are honest.
- **`unanswered` and `bad-reveal`** are GJKR's: a dealer that doesn't answer a complaint with a share that opens its commitments is disqualified, and its polynomial is dropped from every share. A reveal that checks keeps the dealer, whatever the complainer says, so a corrupt seat can't disqualify an honest dealer.
- **`identity-commitment`**: an honest sharing gives the identity with negligible probability, but a seat can aim for it. A corrupt seat that chooses its polynomials after opening every other seat's share to itself (rushing) can make its own share, and so `C_i`, the identity, with a dealing every honest seat accepts; a corrupt dealer can make an honest seat's `C_i` the identity by withholding that seat's message, so that it can't complain. Either way only seat `i` loses its share: its dealing still counts (a seat that zeroes its own share learns no more of `sk` than one point of each other polynomial, which it holds anyway), and the identity, which the answer check can't take, stays out of the key. That is why the reason is attributed to no one, and why it removes one seat rather than failing the transcript: an in-session review found that, as a transcript-level code, it let one seat fail every run unattributably.

## Approval

Seat `i` approves a key by signing, with its identity key under `abolish/v1/sig/nullifier-key-approval`,

```
m = u64(l2_chain_id) ‖ group_registry ‖ panel_id ‖ u8(i) ‖ key_id
```

(93 bytes), only if all of these hold:

1. the transcript passes the check, with at least `max(k, n − 1)` qualified seats ([[0006-trustees]] rule 7, the quorum attestations use too, [[0022-tier2-keyed-nullifier]], Uniqueness across quorums);
2. seat `i` is qualified, and the share it computed opens its `C_i`: it holds a dealt share or a reveal from every other qualified seat;
3. the transcript holds every message `i` sent, as it sent it, so every round chain it signed over is the transcript's;
4. `i` hasn't approved another key for this (`l2_chain_id`, `group_registry`). A seat approves **at most one key per Tier 2 scope**, whatever the run (resharing, part 2b-2b, is how a later key succeeds it).

A key counts only with approvals from `q = max(k, n − 1)` **distinct seats**, each verifying under its seat's pinned identity key; signatures are counted per seat, never per signature ([[trustee-identity]], Ceremony registration). Two such quorums share `2q − n` seats, at least one, so a second key for one scope needs a seat that broke rule 4. Where the approvals are recorded and checked is part 2b-4's.

A run that doesn't reach a quorum is abandoned: the coordinator starts another with a fresh `run_id`, and every seat generates fresh keys and polynomials.

## Security notes

- **Perfectly hiding transcript.** The transcript holds the coefficient commitments (perfectly hiding Pedersen commitments), the hashes of the dealt-share messages, and reveals. A dealt-share message carries `μ` and `e`, over 500 bits of fresh entropy, against a 256-bit hash, so its hash is statistically hiding in the random-oracle model ([[share-encryption]], Hiding). Reveals publish only corrupt dealers' points or corrupt complainers' own shares, at most `k − 1` points of any honest dealer's polynomial. So nothing published fixes `sk`, even to an unbounded adversary ([[0022-tier2-keyed-nullifier]], Key; T-15). The dealt-share messages themselves fall to an adversary who records them and breaks both ML-KEM-768 and discrete logs in ristretto255; they are never archived.
- **Withholding.** The coordinator, or a dealer, can withhold a dealt-share message from a seat, which then lacks a share, can't complain, and doesn't approve. Nothing in the transcript shows it: a seat knows which dealer's message it lacks, but can't prove it. Under rule 7 two seats that don't approve stall the key, so one corrupt seat that withholds its message from one honest seat, and doesn't approve itself, stalls it alone, which under rule 7 otherwise takes two refusing trustees; nothing attributes it, since the honest seat can't prove what it lacks and the corrupt seat's refusal looks like an honest seat's (T-54). It can't learn anything by it: a missing message is never a complaint (Round 3), so withholding never makes an honest dealer reveal. Fetching the message straight from the dealer's node leaves the dealer as the only party that can withhold.
- **Equivocation.** A dealer that sends different seats different round-2 messages, or a coordinator that shows seats different views, leaves seats that saw another view without a matching hash or chain: their round-3 messages and approvals don't check against the transcript, and they don't approve. A seat that holds two round-2 messages signed by one seat keeps both and can show them to the other seats and the panel's operators: they show that seat equivocated, since only it can sign them.
- **Re-signing.** `key_id` hashes the transcript, signatures included, and ECDSA lets a signer make another valid signature on the same message. So a seat with a message in the transcript's last non-empty round, with the coordinator, can make a second transcript of the same sharing with another `key_id`, and split honest seats' approvals between the two. That costs liveness only: both carry the same commitments and the same `sk`, and an honest seat approves only one.
- **Rushing.** A dealer may choose its polynomial after seeing every other round-2 message. The commitments are perfectly hiding, so it learns nothing about the other polynomials' constant terms, and `sk` stays uniform with one honest qualified dealer (GJKR, Theorem 2; T-40). No public key is ever computed, so GJKR's bias attack on Pedersen's DKG has nothing to bias.
- **Registration keys.** A seat's registration KEM secret and signing secret live as long as its share. A stolen registration signing key signs answers attributed to its seat: without the share, those answers fail `answer-proof` and frame the seat, and with the share the thief evaluates anyway (T-37, T-29). The identity key, needed only at this ceremony and its approval, stays offline or behind a person's approval between ceremonies, as [[0006-trustees]] rule 6 asks (T-37).
- **The shares are long-lived.** `sk` lives for the Tier 2 scope ([[0022-tier2-keyed-nullifier]], A long-lived key). Each seat keeps `(sk_i, s_i)`, its registration secrets and its approval record; the trustee role description (P1-7) must say so before real documents register (T-14, T-40).
- **Not constant time everywhere.** As in [[keyed-nullifier]] and [[share-encryption]]: scalar multiplications by secrets use `@noble/curves`' constant-time ladder, but polynomial evaluation and share sums are `bigint` arithmetic, and secrets can't be zeroised in JavaScript (T-39, T-14).

## Test vectors

`docs/spec/vectors/nullifier-key.json` ([[vectors/README|vectors]]): a 3-of-5 panel; key contexts and round chains; complete transcripts with each one's result (every seat's reasons, the qualified seats, `C_i`, `key_id`, and each qualified seat's share recomputed from the dealings): an honest run, a run with a corrupt dealer whose reveal checks and one whose reveal fails, an unanswered complaint, a groundless complaint, an absent seat, a seat that doesn't deal, a seat that zeroes its own share (`identity-commitment`), a bad signing-key proof, a duplicate signing key and an identity key used as a signing key, and transcripts failing each transcript-level code (round 1, 3 and 4 order, three shapes, round 1, 3 and 4 signatures and the run identifier); dealt-share messages re-made byte for byte from their randomness, and checks failing each code; approval statements and signatures. They are printed by `packages/crypto/scripts/nullifier-key-vectors.py`, which reuses only the independent Baby Jubjub code of `keyed-nullifier-vectors.py`, the ML-KEM-768, ChaCha20-Poly1305 and ristretto255 code of `share-encryption-vectors.py` and `group-vectors.py`, and `trustee-vectors.py`'s P-256 ECDSA; it shares nothing with `packages/crypto` or any `@noble` library.
