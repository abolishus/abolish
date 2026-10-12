# Keyed nullifier

A Tier 2 member's nullifier `N` is keyed by the trustees: the 2HashDH OPRF `N = H2(x, sk · H1(x))`, with `sk` shared `k`-of-`n` across the panel by Pedersen VSS and no public key, so neither the chip data alone nor fewer than `k` trustees recompute it ([[0022-tier2-keyed-nullifier]], option A, and its Amendment). This page fixes the group, its encodings, the second generator `J`, the seats' share commitments, a seat's evaluation of a query with its proof, the answer record, and how a client and every attester check and combine answers. Notation and decoding rules are from [[notation]]. Threats: T-03, T-13, T-14, T-15, T-21, T-30, T-31, T-39, T-40.

What this page doesn't yet specify is P3-4 part 2b's later steps, and nothing registers at Tier 2 through the panel until they are:

- **2b-2:** the key's sharing and resharing transcripts (which dealers qualify, and so the share commitments below), the key identifier `key_id`, and the registration KEM keys.
- **2b-3:** `H1` and `H2`, the query and output records and the statements of their circuits (and so `query_hash`), with the diff of TACEO's gadgets against the audited code ([[0022-tier2-keyed-nullifier]], Amendment).
- **2b-4:** the attestation's group position and quorum, the delivery of `N` to every seat, and [[verifier]] 2.4's count of attested additions.

## Sources

- 2HashDH: Jarecki, Kiayias and Krawczyk, "Round-Optimal Password-Protected Secret Sharing and T-PAKE in the Password-Only Model", ASIACRYPT 2014; its threshold form, Jarecki, Kiayias, Krawczyk and Xu, "TOPPSS", ACNS 2017. Its single-server form is [RFC 9497](https://www.rfc-editor.org/rfc/rfc9497)'s OPRF mode.
- Pedersen commitments and VSS: Pedersen, CRYPTO 1991; the sharing is the first phase of Gennaro, Jarecki, Krawczyk and Rabin's DKG, J. Cryptology 2007.
- The evaluation proof is a Fiat–Shamir proof of knowledge of a representation (Okamoto, CRYPTO 1992) composed with a Chaum–Pedersen equality (Chaum and Pedersen, CRYPTO 1992), as in [[share-encryption]]'s complaint proof.
- Baby Jubjub: [EIP-2494](https://eips.ethereum.org/EIPS/eip-2494). `@noble/curves`' `babyjubjub` has the same parameters.
- `hash_to_field` and `expand_message_xmd`: [RFC 9380](https://www.rfc-editor.org/rfc/rfc9380) §5.2 and §5.3.1.

## Group

The group `𝔾` is the prime-order subgroup of Baby Jubjub (EIP-2494), the twisted Edwards curve

```
a·x² + y² = 1 + d·x²·y²      over F_p, with a = 168700, d = 168696
p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
  = r, the BN254 scalar field order ([[notation]], field<bn254>)
```

The curve has `8·l` points, and `𝔾` has prime order

```
l = 2736030358979909402780800718157159386076813972158567259200215660948447373041
  = 0x060c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1
```

`G` is EIP-2494's base point `B8 = 8 · G_EIP`, which generates `𝔾`:

```
G.x = 5299619240641551281634865583518297030282874472190772894086521144482721001553
G.y = 16950150798460657717958625567821834550301663161624707787222815936182638968203
```

The identity is `(0, 1)`. This page writes the group additively (`a · P`, `P + Q`), unlike [[group]]'s ristretto255, which the protocol writes multiplicatively; the two groups never meet. The base field is BN254's scalar field, so every coordinate is native in our Noir circuits over BN254 and the output proof can take points as public inputs at no extra cost ([[0022-tier2-keyed-nullifier]], Consequences).

**Security level.** `l` has 251 bits, so a generic discrete-log attack takes about 2¹²⁵ operations, about 1 bit below ristretto255. That is the level of `N`'s key for the life of the Tier 2 scope.

## Encodings

| Type         | Encoding                                                                                         | Rejected (`non-canonical`)                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bjj-scalar` | 32 bytes, big-endian, the integer value below `l`.                                               | A value at or above `l`. It is never reduced.                                                                                                              |
| `bjj-point`  | 64 bytes: `field<bn254>(x) ‖ field<bn254>(y)`, the affine coordinates, each 32 bytes big-endian. | A coordinate at or above `p`; a pair not on the curve; a point outside `𝔾` (`l · P` isn't the identity); the identity, unless the field allows it (below). |

- **Own types.** `bjj-scalar` is big-endian like every other integer in [[notation]], and unlike ristretto255's little-endian `scalar`. Neither type is ever read as the other, nor as a `field<bn254>`: `l < p`, and a scalar's value and a coordinate's value mean different things.
- **One encoding per value.** Affine coordinates are unique, so every point has exactly one encoding, and `encode(decode(b)) = b` for every accepted `b` (T-31). No square root is taken when decoding, and there is no sign bit to fix.
- **Subgroup check.** The curve has cofactor 8, so a decoder checks `l · P = (0, 1)` for every point, not only that it lies on the curve. A query point with a small-order component would make a seat's answer `sk_i · B` reveal `sk_i mod 2`, `mod 4` or `mod 8` (Lim and Lee, CRYPTO 1997), and an answer with one would combine to a wrong `Z` (T-39). `@noble/curves`' Edwards decoding doesn't check the subgroup; `packages/crypto` calls `isTorsionFree()` on every decoded point.
- **Identity.** A `bjj-point` field rejects the identity unless its table says otherwise. Only prover commitments in a Fiat–Shamir input allow it. The vector type descriptor is `{ "kind": "bjj-point", "identity": "allowed" | "rejected" }`, and `{ "kind": "bjj-scalar" }` for scalars.

## Hash to scalar

```
HashToScalarBJJ(m, DST) = hash_to_field(m, 1)
```

with RFC 9380 §5.2's `hash_to_field` over the prime field of order `l`, `m = 1`, `k = 128` (so `L = 48`), and `expand_message_xmd` (§5.3.1) over SHA-256. That is: `OS2IP(expand_message_xmd(m, DST, 48)) mod l`, big-endian, within about 2⁻¹³² of uniform. A Fiat–Shamir challenge in this group is `HashToScalarBJJ(t, DST = tag)`, under a tag registered with the primitive Fiat–Shamir (Baby Jubjub), and `t` is not framed with `DS` ([[domain-separation]], Applying a tag). A Fiat–Shamir (Baby Jubjub) tag is never used with [[group]]'s `HashToScalar`, nor the reverse.

SHA-256 rather than [[group]]'s SHA-512: [[0022-tier2-keyed-nullifier]]'s Amendment names SHA-256 for this proof's Fiat–Shamir hash, and RFC 9380 sizes `L` for the field, so the hash's output length doesn't change the bias.

## Generator `J`

The share commitments need a second generator whose discrete log relative to `G` no one knows: whoever knew `log_G J` could open a seat's commitment to any share, and so prove a wrong answer ([[0022-tier2-keyed-nullifier]], Key; T-15). `J` is derived by trying counters in order:

```
for ctr = 0, 1, …, 255:
    y  = OS2IP(H(DS("abolish/v1/keyed-nullifier/generator-j", u8(ctr)))) mod p
    u  = 1 − y²,  v = a − d·y²                         (mod p)
    if v = 0, or u · v⁻¹ is not a square mod p: next ctr
    x  = the square root of u · v⁻¹ that is even (as an integer below p)
    J  = 8 · (x, y)
    if J is the identity: next ctr
    return J
```

`H` is SHA-256 and `DS` the framing of [[domain-separation]]. The first counter that succeeds is `ctr = 0`, and

```
J.x = 2729791346298376594286702773082314553988706267762452133097017861478834045283
J.y = 10553488570390859937420497111327893599154543854763640328936151110745772360683
```

(`keyed-nullifier.json` publishes each step). Multiplying by the cofactor puts `J` in `𝔾`. A counter loop rather than RFC 9380's `hash_to_curve`, because RFC 9380 has no Baby Jubjub suite and this page writes no map of its own ([[0022-tier2-keyed-nullifier]], Consequences): `y` is a hash output no one chose, `x` is fixed by `y` and the parity rule, and so finding `log_G J` is a discrete-log problem in `𝔾`. `y mod p` is not uniform (`2²⁵⁶` isn't a multiple of `p`), which doesn't matter for a generator: no one can steer a hash output towards a point whose discrete log they know. `J` is neither `G`, `−G` nor the identity, and a test checks it.

## Share commitments

Seats are numbered `1` to `n` as in [[trustee-identity]], with `n ≤ MAX_TRUSTEES` ([[parameters]]) and `1 ≤ k ≤ n`. The key's sharing transcript (part 2b-2) gives, for each qualified dealer `d`, the coefficient commitments

```
A_{d,j} = a_{d,j} · G + b_{d,j} · J,    j = 0, …, k − 1
```

of its polynomials `f_d(z) = Σ_j a_{d,j} z^j` and `f'_d(z) = Σ_j b_{d,j} z^j`. Seat `i`'s **share commitment** is

```
C_i = Σ_{d ∈ QUAL} Σ_{j=0}^{k−1} (i^j mod l) · A_{d,j}
```

and its secret share is the pair `(sk_i, s_i) = (Σ_d f_d(i), Σ_d f'_d(i)) mod l`, so `C_i = sk_i · G + s_i · J`. The OPRF key is `sk = Σ_d f_d(0)`, which no one holds. Anyone recomputes `C_i` from the transcript; a client and an attester take it from the transcript they checked, never from an answer. `C_i` is perfectly hiding, so nothing published fixes `sk` even to an unbounded adversary; Pedersen binding, which rests on no one knowing `log_G J`, is what makes `sk_i` the only first half of an opening a seat can prove knowledge of (T-15, T-40).

`C_i` is the identity only if `sk_i · G = −s_i · J`, which happens with negligible probability for an honest sharing; part 2b-2's transcript check rejects it.

## Evaluation

A query names the key by `key_id` (32 bytes, part 2b-2), is named itself by `query_hash` (32 bytes, part 2b-3) and carries the blinded point `B = r · H1(x)`, a `bjj-point` that isn't the identity. A seat answers only after checking the query proof (part 2b-3), and never for a `B` it can't decode. Seat `i` answers with

```
Z_i = sk_i · B
```

and a proof of knowledge of `(α, β)` such that `Z_i = α · B` and `C_i = α · G + β · J`. Proving, with `w_1` and `w_2` uniform on `1` to `l − 1` from the CSPRNG:

```
T_1 = w_1 · B
T_2 = w_1 · G + w_2 · J
c   = HashToScalarBJJ(t, DST = "abolish/v1/fs/keyed-nullifier/evaluation")
z_1 = w_1 + c · sk_i  mod l
z_2 = w_2 + c · s_i   mod l
```

The proof is `(c, z_1, z_2)`. Checking recomputes

```
T_1 = z_1 · B − c · Z_i
T_2 = z_1 · G + z_2 · J − c · C_i
t   = encode(G) ‖ encode(J) ‖ key_id ‖ query_hash ‖ u8(i) ‖ encode(C_i) ‖ encode(B) ‖ encode(Z_i) ‖ encode(T_1) ‖ encode(T_2)
```

and accepts if the recomputed `c` equals the proof's. Every point is a `bjj-point`; `T_1` and `T_2` allow the identity and nothing else does. `t` is 513 bytes. It carries both generators, the key (through `key_id`, which binds the panel and the transcript, so a proof can't move to another key or epoch), the query and registration (through `query_hash`), the proof's position (the seat), the statement (`C_i`, `B`, `Z_i`) and every prover commitment ([[domain-separation]], Fiat–Shamir; T-30, T-21).

- **What it proves.** Two accepting transcripts with one `(T_1, T_2)` and different challenges give `α` and `β` (special soundness), so the proof is a proof of knowledge in the random-oracle model (Pointcheval and Stern, J. Cryptology 2000). A prover that knows an opening `(α, β)` of `C_i` with `α ≠ sk_i` knows `log_G J`, so an accepting answer has `Z_i = sk_i · B`. The statement alone is true for every `Z_i`, because `C_i` is perfectly hiding: soundness comes only from knowledge, which is why the proof is of knowledge ([[0022-tier2-keyed-nullifier]], Evaluation).
- **What it reveals.** It is honest-verifier zero-knowledge, and zero-knowledge in the random-oracle model, so the answer reveals `Z_i` and nothing else about `(sk_i, s_i)`.
- **Nonces.** `w_1` and `w_2` are fresh for every answer. Two answers with one nonce and different challenges give `sk_i` and `s_i` to anyone who sees both.

## Answer record

A seat's answer is a record, never on the board, never in the archive and never pinned by a profile: the Tier 2 key fixes its version (part 2b-2). It travels to the client encrypted (part 2b-2's registration KEM), and the client forwards the `k` it combined to every attester (part 2b-4).

Record type `0x0010`, version 1:

| Field        | Type         | Meaning                                                                 |
| ------------ | ------------ | ----------------------------------------------------------------------- |
| `key_id`     | `bytes[32]`  | The key the seat answered under (part 2b-2)                             |
| `query_hash` | `bytes[32]`  | The query it answered (part 2b-3)                                       |
| `seat`       | `u8`         | The answering seat `i`, `1 ≤ i ≤ n`                                     |
| `b`          | `bjj-point`  | `B`, the query's blinded point. Never the identity                      |
| `z`          | `bjj-point`  | `Z_i = sk_i · B`. Never the identity                                    |
| `c`          | `bjj-scalar` | The evaluation proof's challenge                                        |
| `z1`         | `bjj-scalar` | `z_1`                                                                   |
| `z2`         | `bjj-scalar` | `z_2`                                                                   |
| `signature`  | `p256-sig`   | The seat's identity-key signature on every field above, header included |

The record is 356 bytes. The signature is [[trustee-identity]]'s scheme under `abolish/v1/sig/nullifier-answer`, over

```
m = u16(0x0010) ‖ u8(1) ‖ key_id ‖ query_hash ‖ u8(seat) ‖ encode(b) ‖ encode(z) ‖ encode(c) ‖ encode(z1) ‖ encode(z2)
```

the record without its signature, so a later version can't reuse a version 1 signature (T-31). It is made with the seat's **identity key**, not a per-election key: registration happens between elections, when no per-election key exists, and the identity key is the one every client and attester already pins ([[trustee-identity]], Which key signs what). The signature makes a wrong answer attributable to its seat (T-29).

## Answer check

A client checks every answer before combining, and every attester checks each of the `k` answers a client forwards before recombining (part 2b-4). Each takes `key_id`, the panel's identity keys and `C_i` from the key's transcript it checked, and `query_hash` and `B` from the query it made or received, never from the answer. In this order, the first failure is the result:

| Code               | Check                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| decode codes       | The answer decodes strictly as version 1 ([[notation]], Strict decoding).               |
| `answer-key`       | `key_id` is the key's.                                                                  |
| `answer-query`     | `query_hash` and `b` are the query's.                                                   |
| `answer-seat`      | `seat` is a seat of the key's panel, `1 ≤ seat ≤ n`.                                    |
| `answer-signature` | `signature` verifies under that seat's identity key ([[trustee-identity]], Signatures). |
| `answer-proof`     | The evaluation proof verifies against `C_seat`, `b` and `z` (Evaluation, above).        |

The signature is checked before the proof, so an answer that fails only `answer-proof` is a wrong answer the seat signed, which is attributed to it (T-29). An answer that fails an earlier check is attributed to no one: anyone can relay garbage.

## Combination and unblinding

From answers that pass the check, from a set `S` of exactly `k` distinct seats, the combined evaluation is

```
λ_i = Π_{j ∈ S, j ≠ i} j · (j − i)⁻¹   mod l
Z   = Σ_{i ∈ S} λ_i · Z_i
```

By the proofs, `Z_i = sk_i · B` for every `i ∈ S`, so `Z = sk · B` whichever `k` seats answered: one query has one `Z`, and an attester that recombines the `k` forwarded answers gets the same `Z` as the client ([[0022-tier2-keyed-nullifier]], Attestation). Two answers from one seat, or fewer than `k` seats, are refused, never combined. `Z` is the identity only if `sk · B` is, which for `B ≠ (0, 1)` in `𝔾` means `sk = 0`; a combiner refuses it.

The client then unblinds with its own `r` (part 2b-3):

```
U = r⁻¹ · Z  = sk · H1(x)
```

with `r⁻¹` the inverse modulo `l`, and derives `N = H2(x, U)` (part 2b-3). `U` never leaves the device; the output proof shows the attesters that `N` was derived from their `Z` ([[0022-tier2-keyed-nullifier]], Attestation).

## Security notes

- **The query proof is what stops a static Diffie–Hellman oracle.** Each answer is `sk_i` times a point the client sent. A seat that answered any well-formed `B` would let a client chain queries (`B`, then `sk_i · B` as its next `B`, and so on) and run Cheon's attack (EUROCRYPT 2006). The small factors of `l − 1` are `2⁴ · 3 · 5 · 11² · 17 · 967` (about 2²⁸·⁸ in all, by trial division below 2·10⁶) and of `l + 1` are `2 · 19 · 31 · 67 · 641`, so that attack would cut about 14 bits from `sk_i` with about 2²⁹ chained queries. The query proof (part 2b-3) shows the client knows `r` with `B = r · H1(x)`, and `sk_i · B = (r · sk_i) · H1(x)` can't be proven as a next query without knowing `r · sk_i`. So a seat MUST check the query proof before it answers, and the panel's published query counts (part 2b-4) bound what a client with many valid proofs gets.
- **Threshold one-more Diffie–Hellman.** Fewer than `k` seats can't evaluate, and `q` queries give no more than `q` evaluations, under the threshold one-more Diffie–Hellman assumption in the random-oracle model (TOPPSS; [[0022-tier2-keyed-nullifier]], Pros).
- **A discrete-log break gives the shares.** Any recorded `(B, Z_i)` gives `sk_i` to an adversary who solves discrete logs in `𝔾`, and `k` of them give `sk` (A-11, T-15). That is [[0022-tier2-keyed-nullifier]]'s second limit; encrypting queries and answers in transit (part 2b-2) narrows it to clients and seats.
- **Not constant time everywhere.** `@noble/curves`' scalar multiplication is constant time; `sk_i`, `s_i`, `w_1` and `w_2` are `bigint`s, which JavaScript can't zeroise, and the response arithmetic is plain `bigint` arithmetic. A seat's node runs on hardware it controls; the mainnet audit covers it (T-14).

## Test vectors

`docs/spec/vectors/keyed-nullifier.json` ([[vectors/README|vectors]]): the group constants; `J` with every counter's intermediate values; `bjj-scalar` and `bjj-point` encodings at their boundaries and every rejected class (a scalar at `l`, a coordinate at `p`, a point off the curve, the points of order 2, 4 and 8, `G` plus a point of order 2, the identity); `HashToScalarBJJ` with its intermediate bytes; share commitments from dealers' coefficient commitments; answers re-made byte for byte from their shares and nonces, with `T_1`, `T_2` and `t`; answer checks failing each code; and combinations from every `k`-subset of the answering seats, each with its Lagrange coefficients and the same `Z`, with the unblinded `U`. They are printed by `packages/crypto/scripts/keyed-nullifier-vectors.py`, which implements Baby Jubjub's arithmetic, `expand_message_xmd` and `hash_to_field` from their specifications in Python's integers and `hashlib`, checks its `expand_message_xmd` against RFC 9380 Appendix K.1 and its curve against EIP-2494's `G_EIP` and `B8` first, and reuses only `trustee-vectors.py`'s P-256 ECDSA; it shares nothing with `packages/crypto` or any `@noble` library.
