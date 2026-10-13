# Share encryption

How a ballot's shares reach each trustee privately: the hybrid KEM that combines ML-KEM-768 with Diffie–Hellman in ristretto255, the AEAD that seals the shares, the hash `H(ct_i)` the committed vote carries, a trustee's decryption and check, its intake and signed share receipt, the public check of a ciphertext the client posts itself, and a trustee's complaint about a posted share that is invalid. This is the private part of [[0002-everlasting-privacy]] (option B, accepted by the owner, with the owner's answer to the ML-KEM question), with the Diffie–Hellman half chosen by [[0016-share-kem-dh-group]]. Notation is from [[notation]], the group and hashes from [[group]], the committed vote and shares from [[ballot-validity]]. Threats: T-15, T-14, T-18, T-30, T-31, T-36, T-37, T-39, T-41.

What this page doesn't cover yet:

- **Registering trustee KEM keys** with their proofs of possession, in the ceremony transcript: [[ceremony]]. This page defines the key and its encoding.
- **Receipts, postings and complaints on the board:** the records that carry them, the complaint's signature, the delivery deadline, the complaint window and which ballots they deliver or exclude are in [[delivery]]. This page defines what each one checks, and the share receipt's signed statement.
- **Spoiled ballots:** what a challenged ballot reveals and how its ciphertexts are rebuilt are in [[challenge]]. Encryption is deterministic given the randomness below, so revealing it lets anyone rebuild each ciphertext.

## Sources

- **ML-KEM-768:** NIST FIPS 203 (August 2024), `ML-KEM.KeyGen_internal`, `ML-KEM.Encaps_internal` and `ML-KEM.Decaps_internal` (Algorithms 16 to 18) with the input checks of §7.2 and §7.3, from `@noble/post-quantum`. That library is self-audited only; the owner allowed it on testnets, with an independent audit before mainnet ([[0002-everlasting-privacy]], Decision).
- **The combiner:** X-Wing (D. Connolly, P. Schwabe and B. Westerbaan, `draft-connolly-cfrg-xwing-kem`, and "X-Wing: The Hybrid KEM You've Been Looking For", IACR CiC 2024), with Diffie–Hellman in ristretto255 instead of X25519 and SHA-256 under our tag instead of SHA3-256 under X-Wing's label. KEM combiners in general: F. Giacon, F. Heuer and B. Poettering, "KEM Combiners", PKC 2018.
- **ChaCha20-Poly1305:** RFC 8439, §2.8, from `@noble/ciphers`.
- **Complaint proof:** the Chaum–Pedersen proof of equal discrete logs (D. Chaum and T. P. Pedersen, "Wallet Databases with Observers", CRYPTO 1992), in compact form under Fiat–Shamir with the whole statement hashed ([[domain-separation]]).

## Trustee KEM key

Each trustee generates a fresh key for each election ([[0002-everlasting-privacy]]): 64 bytes `seed = d ‖ z` and a scalar `x`, uniform on 1 to `ℓ − 1`, all from the CSPRNG.

```
(ek, dk) = ML-KEM-768.KeyGen_internal(d, z)
dh       = g^x
```

The public key, `kem_key`:

| Field | Type          | Meaning                                                                                                                                                                           |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ek`  | `bytes[1184]` | The ML-KEM-768 encapsulation key. It must pass FIPS 203 §7.2's modulus check: every 12-bit coefficient of its first 1152 bytes, read as `ByteDecode12` reads them, is below 3329. |
| `dh`  | `element`     | `g^x`. Never the identity ([[group]]).                                                                                                                                            |

A key failing the modulus check is a decode error (`non-canonical`): with it, `ByteEncode12(ByteDecode12(ek)) = ek`, so each key has one encoding (T-31, T-39).

The same key also receives other trustees' summed shares in the tally, under separate tags ([[tally]], Summed-share message). The secret key, `kem_secret`, is what a trustee node stores, never posts or sends, and destroys after the tally ([[0002-everlasting-privacy]], Consequences; P1-15 part 3; T-14):

| Field  | Type        | Meaning                                    |
| ------ | ----------- | ------------------------------------------ |
| `seed` | `bytes[64]` | `d ‖ z`; the node derives `dk` from it     |
| `x`    | `scalar`    | The DH secret key. Not 0 (`non-canonical`) |

## Ciphertext

For trustee `i`, with its registered key `(ek_i, dh_i)` and the shares `S_i` it receives ([[ballot-validity]], Shares), the client draws 32 bytes `m_i` and scalars `e_i` and `w_i`, uniform on 1 to `ℓ − 1`, from the CSPRNG, fresh for each trustee and each ballot, and computes:

```
(ss_M, ct_M) = ML-KEM-768.Encaps_internal(ek_i, m_i)
ct_DH        = g^{e_i}
ss_DH        = dh_i^{e_i}
K            = H(DS("abolish/v1/kem/share", ss_M ‖ encode(ss_DH) ‖ encode(ct_DH) ‖ encode(dh_i)))
aad          = DS("abolish/v1/kem/share-aad",
                 definition_hash ‖ u16(0x0002) ‖ u8(1) ‖ u8(i) ‖ encode(vss))
sealed       = ChaCha20-Poly1305.Seal(K, nonce = 12 zero bytes, aad, encode(S_i))
pok_c        = HashToScalar(t_e(g^{w_i}), DST = "abolish/v1/fs/share-ephemeral")
pok_z        = w_i + pok_c · e_i  (mod ℓ)
ct_i         = encode(share_ciphertext)
```

`(pok_c, pok_z)` is a Schnorr proof of knowledge of `e_i = log_g ct_DH` (C. P. Schnorr, "Efficient Signature Generation by Smart Cards", J. Cryptology 1991), in compact form. Its challenge input binds the whole ciphertext and everything it is for:

```
t_e(A) = definition_hash ‖ u16(0x0002) ‖ u8(1) ‖ u8(i) ‖ encode(dh_i) ‖ encode(vss)
         ‖ ct_M ‖ encode(ct_DH) ‖ u32(len(sealed)) ‖ sealed ‖ encode(A)
```

with `A` encoded with the identity allowed. Anyone checks it by recomputing `A = g^{pok_z} · ct_DH^{−pok_c}` and comparing the challenge. Without it, an attacker could copy a victim's `ct_DH` into a ciphertext of its own ballot, with its own `ct_M` and a garbage seal, and post it: the posting passes, the trustee's decryption fails, and its honest complaint would reveal `ct_DH^x`, the victim's DH value, so anyone holding the victim's `ss_M` (published by a posting, or seen in transit) reads the victim's share. With the proof, only the party that knows `e_i` can make a ciphertext with that `ct_DH` for that seat, key, committed vote and seal, and a complaint reveals only `dh_i^{e_i}`, which the poster already knows (T-15, T-41).

`u16(0x0002) ‖ u8(1)` in `aad` and `t_e` names ballot version 1's share-ciphertext rules. Ballot versions 2 and 3 keep them unchanged, so their ciphertexts carry the same bytes (under version 3 over the poll's `T` flat options); the definition hash, which both bind, pins the election's ballot version ([[ballot-validity]], Ballot record (version 2)). Ballot version 4, whose vote is shared to two panels, names its own rules and the seat's panel (Ballot version 4).

`share_ciphertext`:

| Field      | Type          | Meaning                                                                                                                  |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ct_mlkem` | `bytes[1088]` | `ct_M`                                                                                                                   |
| `ct_dh`    | `element`     | `ct_DH`. Never the identity: an identity ephemeral makes `ss_DH` public, leaving only the ML-KEM half (T-39)             |
| `pok_c`    | `scalar`      | The proof of knowledge's challenge                                                                                       |
| `pok_z`    | `scalar`      | Its response                                                                                                             |
| `sealed`   | `bytes<4116>` | The AEAD output: `encode(S_i)` (a 4-byte count and 64 bytes per option) and the 16-byte tag. 4116 bytes at `MAX_OPTIONS` |

The committed vote's share hash for seat `i` ([[ballot-validity]], Committed vote) is

```
H(ct_i) = H(DS("abolish/v1/share-ciphertext", ct_i))
```

Notes:

- **The combiner.** `K` hashes both shared secrets, the DH ciphertext and the trustee's DH key, as X-Wing does. It omits `ct_M` and `ek`: ML-KEM's shared secret already depends on `H(ek)`, and X-Wing's analysis shows ML-KEM's ciphertext second-preimage resistance makes `ct_M` redundant. `K` is secret as long as either half is: an adversary needs both ML-KEM and discrete logs in ristretto255 to read a share in transit ([[0002-everlasting-privacy]], Decision; T-15).
- **One key, one message.** Each `K` seals exactly one message: it hashes a fresh 256-bit `m_i` and a fresh `e_i`, so the fixed nonce never repeats under a key. `packages/crypto` draws both itself and never accepts them from a caller outside its tests.
- **Associated data.** `aad` binds the election, the ballot record type and version, the seat and every VSS commitment, so a ciphertext opens only for the seat and the committed vote it was made for ([[0002-everlasting-privacy]], Private part). It doesn't bind `H(ct_i)`, which is computed from `sealed`. It also doesn't bind the tier or the nullifier, which ADR 0002's Private part listed (the owner accepted this in [[0016-share-kem-dh-group]]), so a ballot challenged before casting can be made with nothing that depends on the nullifier ([[ballot-validity]], Proving; [[verifier]] 6.2). Nothing is lost: the validity proofs bind the nullifier and every `H(ct_j)` ([[ballot-validity]], Statement hash), so moving ciphertexts to another nullifier needs new validity proofs, which need the openings.
- **The nullifier and `t_e`.** [[domain-separation]] (Fiat–Shamir) requires every proof carried in a ballot to bind the ballot's nullifier, so its proofs can't be copied into another voter's ballot (T-32). `t_e` leaves the nullifier out, for the same reason `aad` does: a challenged ballot's ciphertexts are made before its nullifier. The rule's purpose still holds. `t_e` binds `vss`, so a copied ciphertext verifies only next to byte-identical VSS commitments, that is, commitments to the same vote; the copying ballot then needs option and sum proofs over that `vss` whose challenges bind its own nullifier ([[ballot-validity]], Statement hash), so the victim's proofs don't carry over and fresh ones need the openings `r_j` and `r_Σ` of the constant-term commitments. A spoiled ballot publishes those openings, so anyone may re-cast its core under their own nullifier; that reveals nothing, since its vote is already public. A copy posted anyway (direct submit) draws no complaint: an unmodified `ct_i` decrypts correctly, and changing any byte breaks the proof. The owner accepted this exception to the rule's letter in [[0016-share-kem-dh-group]] (Decision).
- **Hiding.** `H(ct_i)` is statistically hiding in the random-oracle model: `ct_i` carries `m_i` and `e_i`, over 500 bits of fresh entropy, against a 256-bit digest ([[0002-everlasting-privacy]], Public part). The proof of knowledge is zero-knowledge in the random-oracle model and adds nothing about `e_i` beyond `ct_DH`.
- **Sizes.** `ct_i` is 1088 + 32 + 64 + 4 + 4 + 64·`m` + 16 bytes: 1848 bytes at 10 options.

Order of construction ([[ballot-validity]], Proving): the sharing and `vss`, then every `ct_i` and `H(ct_i)`, then the statement hash and the proofs. The client keeps `(m_i, e_i, w_i)` until the voter casts or challenges: a posting needs `m_i`, a challenge reveals them ([[challenge]], Opening), and a cast erases them, except `ct_i` and `m_i` for a seat that didn't receipt, kept only until the voter decides whether to post it ([[delivery]], Client rules; [[0002-everlasting-privacy]], Private part; T-18, T-45).

## Decryption

Trustee `i`, holding `kem_secret = (seed, x)` and the ballot's committed vote, which has already passed the validity checks ([[ballot-validity]], Checks):

1. Decode `ct_i` as `share_ciphertext`; on failure, `share-malformed`.
2. Check the proof of knowledge of `e_i`, with `dh = g^x`; on failure, `share-proof`.
3. `ss_M = ML-KEM-768.Decaps_internal(dk, ct_M)`, `ss_DH = ct_DH^x`, `K` and `aad` as above.
4. Open `sealed`. If the AEAD fails, or the plaintext doesn't decode as `list<share, MAX_OPTIONS>` with exactly `m` entries, `share-decrypt`.
5. Check every option's share against `vss` ([[ballot-validity]], Shares); on failure, `share-check`.

The checks run in that order and the first failure is the result. These steps take `ct_i` as delivered; intake (below) checks `H(ct_i)` against the committed vote's `share_hashes[i]` first, as the posting check does. On any failure it refuses at once and publishes nothing ([[0002-everlasting-privacy]], Delivery). It never reveals `ss_M` or `ss_DH` for a ciphertext it decrypted: ML-KEM's implicit rejection (FIPS 203 Algorithm 18) makes `Decaps` return a pseudorandom secret for a ciphertext that fails re-encryption, and revealing that output would leak `dk` over a few thousand crafted ciphertexts.

## Intake and receipts

Trustee `i`'s node takes a delivery of one cast ballot: the whole ballot record (`0x0002`, [[ballot-validity]], Ballot record), its membership proof included, under the version the election's profile pins, and `ct_i` ([[0002-everlasting-privacy]], Decision, 2026-10-12: membership-checked intake). Before it takes any, it runs [[verifier]] 2.5 for the election, and checks the definition it takes the roots from as a verifier does before admitting ballots: the ceremony registered the key set it holds a seat of (3.2), the definition names the pinned membership key (1.3), and each tier's (or cell's) root and member count are the ones it recomputes from the group registry, none of them 0 (2.4, 2.8; [[verifier]], Ballot admission). Those member counts are what bound its receipt obligation ([[delivery]], Direct submit), so a definition whose roots carry identities nobody registered would lift the bound, and the node refuses intake for it. It checks, in this order, and the first failure is the result:

1. `delivery-malformed`: the record doesn't decode strictly under the pinned version ([[ballot-validity]], Decoding; a record of another version is malformed here too).
2. `ballot-stray`, then `ballot-tier` (under ballot versions 2 and 3, `ballot-cell`), `validity-shape` and `share-hash-unqualified`: the admission checks before the membership proof ([[ballot-validity]], Admission), against the registered definition and key set.
3. `share-hash`: `H(ct_i)` equals `share_hashes[i]`, the committed vote's hash for seat `i`.
4. `membership-proof`, `option-proof` and `sum-proof`: the rest of the admission checks, in their order. The membership proof is checked against the root and scope of the record's tier (or cell) in the definition and `M` recomputed from the record, never against anything the delivery names ([[membership]], Checks).
5. Decryption, steps 1 to 5 above (`share-malformed`, `share-proof`, `share-decrypt`, `share-check`).

Steps 2 and 4 are exactly the admission checks of [[verifier]] 5.1 to 5.4, so a ballot a trustee receipts passes them for every verifier: a trustee receipts only a ballot whose membership proof verifies against the registered root of its tier. It doesn't check the L1 reference ([[revoting]], Admission): the named block may not be finalized yet at intake, and the node reads it later, when it decides which receipts it owes ([[delivery]], Direct submit).

On any failure it refuses at once, signs nothing and publishes nothing ([[0002-everlasting-privacy]], Delivery). If every check passes, it stores `ct_i` and its shares under the ballot hash until the tally ([[0002-everlasting-privacy]], Consequences; P1-15 part 3), and returns a **share receipt**: an ECDSA P-256 signature by its per-election signing key ([[trustee-identity]], Which key signs what), under `abolish/v1/sig/share-receipt`, over

```
m = definition_hash ‖ ballot_hash ‖ u8(i) ‖ H(ct_i)
```

97 bytes, with `ballot_hash` from [[ballot-validity]] (Ballot hash).

Anyone checks a share receipt for seat `i` against a ballot:

| Code            | Check                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `share-receipt` | Seat `i` has registered keys ([[ceremony]], Transcript check), and the signature verifies under seat `i`'s registered signing key, never its identity key, over `m` built from the election's `definition_hash`, the ballot's recomputed `ballot_hash` and its `share_hashes[i]`. |

A receipt that fails is ignored: it delivers nothing, and, like a failing posting, it never excludes a ballot or fails the election, since anyone can attach junk to a ballot. The ballot's own checks (validity, membership) run as for any ballot; a receipt adds nothing to them.

Notes:

- **What a receipt says.** That seat `i` holds `ct_i` and found that its shares open and pass against this exact public part, which passed the validity checks, and that a ballot record carrying it passed every admission check of [[verifier]] 5.1 to 5.4, its membership proof included. So the nullifier belongs to a registered member of the tier (or cell) at the definition's root: anyone who wants a node to receipt, store or owe a receipt must hold a member's secret. Nothing about the L1 reference or the close rule, which the node reads later (Direct submit, [[delivery]]); a receipt for a ballot that is never admitted, or never selected, delivers nothing. Intake runs only once the voter has chosen to cast, since the membership proof exists only then ([[revoting]], Client rule 6), so a challenged ballot never reaches a trustee ([[challenge]]).
- **One public part.** `ballot_hash` binds the definition, the ballot version, the tier, the nullifier, every commitment, every share hash and every proof ([[ballot-validity]], Ballot hash), so a receipt counts only for the public part the trustee checked. It leaves out the membership proof and the L1 reference, so the receipt also covers a re-randomised copy of the ballot, and the same public part cast again under a newer L1 reference: both carry the shares the trustee holds.
- **`H(ct_i)` in `m`.** `ballot_hash` binds it already. It is in `m` too so that a receipt names its ciphertext on its own: the trustee's stored ciphertext and a voter's receipt check are found by it.
- **The order.** The admission checks that read only the record's header fields, lengths and zeros run first, so `share_hashes[i]` exists when step 3 reads it, and the cheap checks run before the membership proof (a pairing check) and the validity proofs (at `MAX_OPTIONS`, hundreds of scalar multiplications), and before any decapsulation. Among the admission checks the order is [[ballot-validity]]'s, so a ballot a trustee refuses with an admission code is one a verifier rejects with the same code, `share-hash` aside. The membership proof is checked before the validity proofs and decryption, so only a member's ballot makes a node run the costly steps.
- **Repeated deliveries.** A node signs with an RFC 6979 nonce, as `packages/crypto` does, so delivering the same ciphertext for the same public part again gives the same receipt. A node whose signer draws its nonces (an HSM, say) gives another valid signature on the same statement, which counts the same: the protocol keys on the statement, never on signature bytes ([[trustee-identity]], Signing).

## Public posting

If trustee `i` doesn't receipt, the client may post `(i, ct_i, m_i)` itself, only at the voter's explicit choice and only through the contract path, never for a seat whose receipt passes ([[0002-everlasting-privacy]], Delivery and Decision; [[delivery]], Client rules). Anyone checks a posting against the ballot's committed vote and the seat's registered key, in this order:

| Code                    | Check                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `posting-malformed`     | `m_i` is 32 bytes and `ct_i` decodes as `share_ciphertext`.                                                                                     |
| `posting-hash`          | `H(ct_i)` equals the committed vote's `share_hashes[i]`.                                                                                        |
| `posting-proof`         | The proof of knowledge of `e_i` verifies for seat `i`, its registered `dh_i` and the ballot's `vss`.                                            |
| `posting-encapsulation` | `ML-KEM-768.Encaps_internal(ek_i, m_i)` gives `ct_M` equal to `ct_i`'s `ct_mlkem`. Encapsulation is used only to verify here, never to encrypt. |

A posting that fails is ignored: it never excludes a ballot, because anyone who has seen `ct_i` could attach a wrong `m_i`. `m_i` determines `ct_M`, and ML-KEM's correctness makes the passing `m_i` for a given `ct_M` unique, so only a party that knows `m_i` can supply one: the client that made `ct_i`, or trustee `i`, which recovers `m_i` with ML-KEM's inner decryption (FIPS 203 K-PKE.Decrypt, a step of `Decaps`) when `ct_M` is honest. A posting by trustee `i` gives it no new power, since it holds `S_i` and could disclose it outright ([[0002-everlasting-privacy]]; T-14), but it publishes `ss_M`, so the share drops to classical privacy for everyone even after the trustee receipted it, and [[verifier]] 8.2 counts it as readable. This corrects [[0002-everlasting-privacy]] (option B, Re-voting), which says only the voter's own client can supply a passing posting. A passing posting publishes `ss_M`, so **a posted share has only classical (Diffie–Hellman) privacy** ([[0002-everlasting-privacy]], Cons; T-15, T-27).

## Complaints

Suppose a posting passes but trustee `i`'s decryption of it fails at step 4 or 5. The trustee publishes a complaint: `D = ct_DH^x` with a Chaum–Pedersen proof that `log_g dh_i = log_{ct_DH} D`. Anyone then derives `K` from the posted `m_i` and `D`, and sees that the shares don't open or don't pass. A proven complaint excludes the ballot ([[0002-everlasting-privacy]], Complaints; [[revoting]], No fallback).

`complaint_proof`:

| Field | Type      | Meaning                               |
| ----- | --------- | ------------------------------------- |
| `dh`  | `element` | `D`, the DH value. Never the identity |
| `c`   | `scalar`  | The challenge                         |
| `z`   | `scalar`  | The response                          |

Proving, with `w` uniform on 1 to `ℓ − 1` from the CSPRNG: `A_1 = g^w`, `A_2 = ct_DH^w`, `c` as below, `z = w + c·x mod ℓ`. Checking recomputes

```
A_1 = g^z · dh_i^{−c}
A_2 = ct_DH^z · D^{−c}
t   = definition_hash ‖ u8(i) ‖ encode(dh_i) ‖ H(ct_i) ‖ encode(ct_DH) ‖ encode(D) ‖ encode(A_1) ‖ encode(A_2)
c   = HashToScalar(t, DST = "abolish/v1/fs/share-complaint")
```

and accepts if the recomputed `c` equals the proof's. `A_1` and `A_2` are encoded with the identity allowed; every other value is as its table says. `t` carries the election, the proof's position (the seat), the trustee's key, the ciphertext the complaint is about (by its hash, which the ballot's statement binds) and every prover commitment ([[domain-separation]], Fiat–Shamir).

Anyone checks a complaint in this order, and the first failure is the result:

| Code                  | Check                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `posting-*`           | The posting passes the public check above. A complaint about a posting that fails it is void.                                                                                                                                                                |
| `complaint-proof`     | The Chaum–Pedersen proof verifies.                                                                                                                                                                                                                           |
| `complaint-unfounded` | With `ss_M` from the posting's `Encaps_internal`, `ss_DH = D`, and `K` and `aad` as above, decryption steps 4 and 5 fail. If they pass, the complaint is unfounded: the ballot stands, and the complaint is attributed to the trustee that signed it (T-29). |

If every check passes, the complaint is proven and the ballot is excluded.

Notes:

- **Only posted ciphertexts.** A trustee complains only about a posting that passes the public check, its proof of knowledge included, and whose shares fail its own decryption at step 4 or 5; `packages/crypto` refuses to make a complaint otherwise. A ciphertext delivered at intake that fails is refused there, with nothing published.
- **No DH oracle.** A passing posting's `ct_i` proves that whoever made it knows `e_i` (the Schnorr proof is extractable in the random-oracle model, by rewinding with the forking lemma, Pointcheval and Stern, J. Cryptology 2000; composing many postings follows Bernhard, Pereira and Warinschi, ASIACRYPT 2012), so the `D = dh_i^{e_i}` a complaint reveals is a value the poster could already compute: the complaint answers no static Diffie–Hellman query ([[group]], Static Diffie–Hellman), and it can't be aimed at another ciphertext's ephemeral.
- **Intake reveals nothing the sender lacks.** A trustee's accept or refuse at intake tells the sender whether the AEAD opened and the shares passed. With the proof of knowledge checked first, the sender already knows `ss_DH`, and the ML-KEM half stays behind implicit rejection.

## Ballot version 4

Ballot version 4 shares each vote in two halves, to the default panel and to an author panel ([[ballot-validity]], Ballot record (version 4); [[0027-trustee-panels-and-live-results]], Part 1). Its ciphertexts, intake, receipts, postings and complaints are the rules above with the seat's panel bound into each of them, so a ciphertext, receipt or complaint for one panel's seat `i` is never one for the other panel's seat `i` (T-30, T-37, T-29). Everything not stated here is as above. `panel` is the seat's panel, `u8(1)` for the default panel and `u8(2)` for the author panel ([[ballot-validity]], Context (version 4)).

### Keys

Each seat's key is the `kem_key` of the registered key set of its own panel: a default seat's from the default panel's ceremony, an author seat's from the author panel's ([[ceremony]]; P2-16 part 3). A seat's shares are `(f^P_j(i), g^P_j(i))` for its panel `P`, `T` of them.

### Ciphertext (ballot version 4)

As Ciphertext, with the associated data and the proof of knowledge's challenge input naming ballot version 4, the seat's panel and both halves' commitments:

```
aad    = DS("abolish/v1/kem/share-aad",
             definition_hash ‖ u16(0x0002) ‖ u8(4) ‖ u8(panel) ‖ u8(i) ‖ encode(vss) ‖ encode(author_vss))
t_e(A) = definition_hash ‖ u16(0x0002) ‖ u8(4) ‖ u8(panel) ‖ u8(i) ‖ encode(dh_i) ‖ encode(vss) ‖ encode(author_vss)
         ‖ ct_M ‖ encode(ct_DH) ‖ u32(len(sealed)) ‖ sealed ‖ encode(A)
```

with `dh_i` the seat's key in its own panel. `K`, `sealed`, `share_ciphertext` and `H(ct_i)` are unchanged, and the share hash goes into `share_hashes[i]` for a default seat and `author_share_hashes[i]` for an author seat. Both tags keep their layouts up to the version byte, which says how the rest reads: versions 1 to 3 name ballot version 1's rules (`u8(1)`, then the seat), version 4 names its own (`u8(4)`, then the panel and the seat), so no ciphertext made under one opens or proves under the other (T-31).

Why both halves' commitments, whichever panel the seat is in: `aad` then binds the seat's ciphertext to the whole core but the share hashes, as under version 1, so an author seat's ciphertext can't be moved to a ballot with another default half, or the reverse, without failing its seal and its proof. With no author panel `encode(author_vss)` is a zero count.

### Decryption and intake (ballot version 4)

Decryption is steps 1 to 5 above, with `aad` and `t_e` above, the seat's panel's `kem_secret`, and step 5 checking each share against its own panel's commitments ([[ballot-validity]], Shares (version 4)). Intake is Intake and receipts' order, run by a seat of either panel on the whole ballot record, with:

- step 2's `share-hash-unqualified` over both panels ([[ballot-validity]], Admission (version 4));
- step 3, `share-hash`, comparing `H(ct_i)` with its own panel's list: `share_hashes[i]` for a default seat, `author_share_hashes[i]` for an author seat.

Before it takes any delivery, a seat of either panel runs what a default seat runs (Intake and receipts: [[verifier]] 2.5 with `panel-kind` and `default-seat`, 3.2 for its own panel, 1.3, 2.4, 2.8), and, with an author panel, checks the author panel's transcript and approvals as P2-16 part 3 specifies; an author seat also checks that the definition names its own identity key at its own index in `author_keys`, so a creator who substituted author keys finds no author node taking part (T-37). A node refuses intake for an election it can't check this way.

### Share receipt (ballot version 4)

A seat's receipt is an ECDSA P-256 signature by its per-election signing key, registered in its own panel's key set, under `abolish/v1/sig/share-receipt-2`, over

```
m = definition_hash ‖ ballot_hash ‖ u8(panel) ‖ u8(i) ‖ H(ct_i)
```

98 bytes. It is checked as `share-receipt` is, with the seat's registered keys and signing key taken from its own panel's registered key set, and the share hash from its own panel's list. The statement has a new tag because its layout names no version: under one tag, a 97-byte version-1 statement and a 98-byte version-4 one would be two layouts ([[domain-separation]], Rules).

### Public posting (ballot version 4)

Public posting's checks, with the seat's panel: `posting-hash` compares `H(ct_i)` with its own panel's share-hash list, `posting-proof` checks the proof of knowledge with `t_e` above and its own panel's `dh_i`, and `posting-encapsulation` uses its own panel's `ek_i`. A passing posting of an author seat publishes `ss_M` for that author seat's share only: classical privacy for that share of the author half, which on its own reveals nothing about the vote ([[0027-trustee-panels-and-live-results]], What an author panel does weaken).

### Complaints (ballot version 4)

Complaints' proof and checks, with the seat's panel in the challenge input, under its own tag:

```
t = definition_hash ‖ u8(panel) ‖ u8(i) ‖ encode(dh_i) ‖ H(ct_i) ‖ encode(ct_DH) ‖ encode(D) ‖ encode(A_1) ‖ encode(A_2)
c = HashToScalar(t, DST = "abolish/v1/fs/share-complaint-2")
```

with `dh_i` from the seat's own panel. `complaint-unfounded` decrypts with `aad` above and checks against the seat's own panel's commitments. The tag is new because version 1's `t` names no version ([[domain-separation]], Rules), so a proof under one layout is never checked under the other.

## Residuals

- **Only computationally hiding in transit.** A recorded `ct_i` falls to an adversary who breaks both ML-KEM-768 and discrete logs in ristretto255 (A-11, T-15). A posted `ct_i` falls to discrete logs alone.
- **Unaudited ML-KEM code.** `@noble/post-quantum` has no independent audit; testnets only until one exists ([[0002-everlasting-privacy]], Decision). The audit covers both compositions of this hybrid: share encryption here and the summed-share message of [[tally]].
- **Not X-Wing.** The combiner follows X-Wing over another group and hash, so X-Wing's vectors and proofs don't apply directly ([[0016-share-kem-dh-group]], T-36).
- **Intake is open to every member.** Since intake checks membership, only a holder of a registered member's secret can make a trustee node verify validity proofs, decapsulate, and store a ciphertext and its shares until the tally; but a member can do so for any number of ballots of their own nullifier (other votes, other L1 references), and a Tier 0 identity costs one Turnstile solve ([[0024-tier0-registration]]). Storage and work are bounded by the node's rate limits and quotas, which a node operator must set and may now set per tier and nullifier: an honest client casts each ballot on a strictly newer L1 block, except the one tie escape of [[revoting]] (Client rules 3 and 5) (T-39, T-52, T-54). A membership proof costs a pairing check, so the cheapest refusals (a malformed record, a stray or a wrong share hash) come first, and a flood of ballots with invalid proofs costs a node one pairing check each.
- **Not constant time.** ML-KEM's arithmetic in `@noble/post-quantum` is JavaScript and makes no constant-time claim; the scalar multiplications are `@noble/curves`' constant-time ladder. A timing attacker could learn about `dk` or `x`, and not only a local one: trustee intake decapsulates any well-formed ciphertext with a valid proof of knowledge in a ballot that passes admission, and the proof doesn't cover `ct_M`, so it is a remote decapsulation endpoint for a chosen `ct_M`, open to any registered member, a Tier 0 one included. The mainnet audit must cover ML-KEM's timing, and intake needs rate limits (T-39, T-14).
- **Secrets can't be zeroised in JavaScript.** `packages/crypto` overwrites the byte arrays it derives (`dk`, `ss_M`, `K`), but `x` and `e_i` are `bigint`s.

## Test vectors

`docs/spec/vectors/share-encryption.json` ([[vectors/README|vectors]]): trustee keys from their seeds; ballots with every ciphertext and share hash, from the randomness that made them; each trustee's decryption, and decryptions failing each step (another seat, another definition, a changed `vss`, a flipped tag byte, wrong shares sealed correctly); postings passing and failing each check; complaints proven, unfounded and failing their proof; codec rejections of `kem_key`, `kem_secret`, `share_ciphertext` and `complaint_proof`. They are printed by `packages/crypto/scripts/share-encryption-vectors.py`, which implements ML-KEM-768 from FIPS 203 and ChaCha20-Poly1305 from RFC 8439 in Python's integers and `hashlib`, reusing only the independent ristretto255 code of `group-vectors.py` and the ballot code of `ballot-validity-vectors.py`. Before printing, it checks its ML-KEM-768 against the accumulated FIPS 203 vectors of Go's `crypto/mlkem` tests (100 iterations; 10 000 with `--full`) and its AEAD against RFC 8439 §2.8.2. `packages/crypto` checks `@noble/post-quantum` against the same 10 000-iteration hash and `@noble/ciphers` against RFC 8439 §2.8.2.

`docs/spec/vectors/share-encryption-v4.json`: Ballot version 4's ciphertexts to seats of both panels, in elections with an author panel (`k_A` from 1 to 16, `MAX_OPTIONS` and `MAX_TRUSTEES` in both halves) and one without, each re-made byte for byte from its shares and randomness, beside the committed vote that carries their hashes; each seat's decryption against its own panel's commitments, and dishonest clients' ciphertexts failing each step (an author share that fails its check, a seal under the wrong DH value, a short plaintext, an author ciphertext naming the default panel, one made under ballot version 1's rules, one binding only the default half); decryptions under the other panel, another seat, another definition, another default or author half, or version 1's rules; postings passing and failing each check for both panels (another panel's list and key included); and complaints proven at seats of both panels, unfounded, and failing their proof (the default panel's byte, version 1's challenge, another panel's key). They are printed by `packages/crypto/scripts/share-encryption-v4-vectors.py`, which reuses `share-encryption-vectors.py`'s ML-KEM-768, AEAD and codec, and `ballot-v4-vectors.py`'s elections and ballots, and so shares nothing with `packages/crypto`.

`docs/spec/vectors/intake-v4.json`: intake of whole version-4 ballot records at seats of both panels (Decryption and intake (ballot version 4)), over `ballot-v4-records.json`'s elections with a 2-of-3 author panel and without one, each record with a real Semaphore membership proof and real ciphertexts to every seat of both panels: each seat's version-2 receipt re-made byte for byte (Share receipt (ballot version 4)), and intakes failing at every step, from `delivery-malformed` to `share-check` at seats of both panels, with a seat's ciphertext delivered to the same index of the other panel (`share-hash`), an author seat's ciphertext bound as a default seat's or made under ballot version 1's rules (`share-proof`), and each panel's seat sealed the other half's shares (`share-check`), and the order pinned where two would fail (`share-hash` before the membership proof, the membership proof before decryption); and receipt checks passing and failing (the other panel's seat, another seat, an unregistered seat, seats 0 and 17, panel 3, another definition, ballot or share hash, version 1's tag and statement, the identity key, an altered or high-`s` signature). They are printed by `packages/crypto/scripts/intake-v4-vectors.py`, reusing `ballot-v4-records-vectors.py`'s elections, records and admission, `share-encryption-v4-vectors.py`'s encryption and decryption, and `trustee-vectors.py`'s P-256 ECDSA, with membership proofs and pairing verdicts from snarkjs as for `ballot-v4-records.json`.

`docs/spec/vectors/share-receipt.json`: the ballot hash of every valid ballot in `ballot-validity.json` and every ballot in `share-encryption.json`; each seat's intake of the `share-encryption.json` ballots, with its share receipt re-made byte for byte from the seat's signing secret; intakes failing each check from `validity-shape` on (a shape for another panel, a swapped option proof, an altered sum proof, another seat's ciphertext, and the dishonest clients' ciphertexts) and showing their order; and receipt checks passing and failing (another seat, an unregistered seat, seat 0 and seat 17, the identity key, another definition, another ballot, another ciphertext, an altered or high-`s` signature). They are printed by `packages/crypto/scripts/share-receipt-vectors.py`, which reuses `share-encryption-vectors.py`'s ballots and decryption and `trustee-vectors.py`'s P-256 ECDSA, and so shares nothing with `packages/crypto`.

`docs/spec/vectors/intake.json`: intake of whole ballot records, under ballot versions 1 and 2, each with a real Semaphore membership proof and real ciphertexts to a three-seat panel: each seat's receipt re-made byte for byte, and intakes failing at every step, from `delivery-malformed` through the admission checks and `share-hash` to `share-proof` and `share-check`, with the order pinned where two checks would fail (`validity-shape` and `share-hash-unqualified` before `share-hash`, `share-hash` before the membership proof, the membership proof before the validity proofs and before decryption). They are printed by `packages/crypto/scripts/intake-vectors.py`, reusing `ballot-vectors.py`'s and `ballot-v2-vectors.py`'s elections and records and the share-encryption and share-receipt generators, with membership proofs and pairing verdicts from snarkjs over Semaphore's own circuit (`ballot-proofs.mjs`). `share-receipt.json`'s intakes are the share half of this check, run with no record.

`docs/spec/vectors/intake-v3.json`: the same for version-3 records ([[ballot-validity]], Shares and delivery (version 3)), over `ballot-v3-records.json`'s election with three questions: each seat's receipt re-made byte for byte, a ballot answering only one question, and intakes failing at every step, `option-proof` naming the flat option and `sum-proof` the question, with the order pinned where two would fail (`share-hash` before the membership proof, the membership proof before the range proofs). They are printed by `packages/crypto/scripts/ballot-v3-records-vectors.py`, reusing the share-encryption and share-receipt generators.
