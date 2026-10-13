# Ballot commitments and validity proofs

How a plurality or approval ballot commits to its vote on the public board, how the vote is shared among the trustees, and how anyone checks, before the tally, that the commitments hold a vote the election's rules allow. This is the public part of [[0002-everlasting-privacy]] (option B, accepted by the owner) for the homomorphic tally of [[0003-tally-scheme]]: perfectly hiding Pedersen commitments, Pedersen verifiable secret sharing, and disjunctive Chaum–Pedersen validity proofs under a Fiat–Shamir challenge that binds the whole statement. Notation is from [[notation]], the group and hashes from [[group]]. Threats: T-15, T-28, T-29, T-30, T-31, T-32, T-14, T-17, T-36, T-38, T-39, T-52.

It also specifies the ballot record (`0x0002`, version 1) that carries the committed vote with its tier, nullifier, L1 block reference and membership proof, and that record's admission checks (Ballot record); version 2 names a regional cell (Ballot record (version 2)), and version 3 carries one range proof per question of a multi-question poll (Ballot record (version 3)). Share encryption is specified in [[share-encryption]] (P1-12 part 2): the hybrid KEM and AEAD that carry each trustee's shares, and the hash `H(ct_i)` of each ciphertext. This page takes the `n` ciphertext hashes as 32-byte values and binds them into the statement.

## Sources

The construction composes published protocols. No group, hash or proof system is new; the group operations and hashes are `@noble/curves` and `@noble/hashes` ([[group]]).

- **Pedersen commitments** and **Pedersen verifiable secret sharing**: T. P. Pedersen, "Non-Interactive and Information-Theoretic Secure Verifiable Secret Sharing", CRYPTO 1991, Section 4.
- **Sharing the vote among the trustees with Pedersen VSS** and proving each committed vote valid: R. Cramer, M. Franklin, B. Schoenmakers and M. Yung, "Multi-Authority Secret-Ballot Elections with Linear Work", EUROCRYPT 1996, Sections 3 and 4.
- **Proofs of partial knowledge** (the OR composition of Σ-protocols, here over Schnorr proofs of a discrete log base `h`): R. Cramer, I. Damgård and B. Schoenmakers, "Proofs of Partial Knowledge and Simplified Design of Witness Hiding Protocols", CRYPTO 1994. The `L`-way form is the one ElectionGuard 2.0 uses for its range proofs (J. Benaloh and M. Naehrig, ElectionGuard Design Specification 2.0, Section 3.3.5), here over Pedersen commitments instead of ElGamal ciphertexts.
- **Fiat–Shamir with the whole statement hashed**: D. Bernhard, O. Pereira and B. Warinschi, "How Not to Prove Yourself: Pitfalls of the Fiat–Shamir Heuristic and Applications to Helios", ASIACRYPT 2012. Binding the nullifier into every challenge follows V. Cortier and B. Smyth, "Attacking and Fixing Helios", CSF 2011.

## Context

A ballot is checked against values the verifier has already verified, never against values the ballot supplies ([[domain-separation]], Fiat–Shamir):

| Value               | Source                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `definition_hash`   | The registered election definition ([[election-definition]], [[verifier]] 2.1)                             |
| `m`                 | Its `option_count`                                                                                         |
| `min`, `max`        | Its `min_selections` and `max_selections`                                                                  |
| `k`, `n`            | Its `threshold` and `panel_size` ([[verifier]] 2.5)                                                        |
| `tier`, `nullifier` | The ballot record's own tier and nullifier, checked against its membership proof ([[verifier]] 5.1 to 5.3) |

## Committed vote

The voter's choice is a vector `v_0, …, v_{m−1}` with each `v_j ∈ {0, 1}` (1 selects option `j`) and `min ≤ Σ v_j ≤ max`.

For each option `j`, the client draws, uniformly from the scalars and independently, `r_j` and the coefficients `a_{j,1}, …, a_{j,k−1}` and `b_{j,1}, …, b_{j,k−1}`, and forms the two sharing polynomials of degree `k − 1`:

```
f_j(x) = v_j + a_{j,1}·x + … + a_{j,k−1}·x^{k−1}   (mod ℓ)
g_j(x) = r_j + b_{j,1}·x + … + b_{j,k−1}·x^{k−1}   (mod ℓ)
```

Its VSS commitments are, for `t = 0, …, k − 1`,

```
E_{j,t} = g^{coef_t(f_j)} · h^{coef_t(g_j)}
```

so `E_{j,0} = C_j = g^{v_j} · h^{r_j}` is the Pedersen commitment to option `j`'s vote. Trustee `i` (`1 ≤ i ≤ n`, its seat in the panel) receives, for every option, the share `(f_j(i), g_j(i))`, encrypted to it as [[share-encryption]] specifies. Each `E_{j,t}` is information-theoretically hiding (perfectly, up to the sampling distance under Proving) because its `h` exponent is uniform and independent of everything else, so the commitments reveal nothing about the vote to anyone, whatever their computing power ([[0002-everlasting-privacy]], T-15). They are binding under the discrete-log assumption, because no one knows `log_g h` ([[group]], Hash to group and `h`).

The ballot carries the committed vote:

| Field           | Type                                             | Meaning                                                                                                                                      |
| --------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `vss`           | `list<list<element, MAX_TRUSTEES>, MAX_OPTIONS>` | For each option `j` in order, its `k` VSS commitments `E_{j,0}, …, E_{j,k−1}`. None is the identity.                                         |
| `share_hashes`  | `list<bytes[32], MAX_TRUSTEES>`                  | `H(ct_i)` for each trustee `i = 1, …, n` in seat order: the hash of the ciphertext carrying trustee `i`'s shares ([[share-encryption]]).     |
| `option_proofs` | `list<bit_proof, MAX_OPTIONS>`                   | For each option `j` in order, the proof that `C_j` commits to 0 or 1.                                                                        |
| `sum_proof`     | `list<branch, 65>`                               | The proof that `C_Σ` commits to a value from `min` to `max`: one branch per value `s = min, …, max`, in that order. 65 is `MAX_OPTIONS + 1`. |

`bit_proof`:

| Field | Type     | Meaning                                          |
| ----- | -------- | ------------------------------------------------ |
| `c0`  | `scalar` | The challenge of the branch "`C_j` commits to 0" |
| `z0`  | `scalar` | Its response                                     |
| `c1`  | `scalar` | The challenge of the branch "`C_j` commits to 1" |
| `z1`  | `scalar` | Its response                                     |

`branch`:

| Field | Type     | Meaning                |
| ----- | -------- | ---------------------- |
| `c`   | `scalar` | The branch's challenge |
| `z`   | `scalar` | The branch's response  |

Notes:

- **No identity commitments.** A VSS commitment is the identity only if its two exponents satisfy one linear relation, which an honest client hits with probability about 2⁻²⁵², so the decoder rejects it (`non-canonical`, [[group]]) and an honest client that ever drew it would draw again. A `scalar` field accepts 0: a challenge or response of 0 is valid.
- **Sizes.** The counts are bounded by the protocol maxima in the codec and checked against the election in the shape check below. At `MAX_OPTIONS` and `MAX_TRUSTEES` the committed vote is about 45 KB (32 KB of VSS commitments, 8 KB of option proofs, 4 KB of sum proof); at 10 options, `k = 4` and `n = 7`, it is about 2.9 KB.
- **Compact proofs.** A proof carries only its challenges and responses. The prover commitments (`A` below) are recomputed by the verifier and enter the Fiat–Shamir input, so each accepted proof has exactly one encoding, and nothing in it is free for the prover to choose beyond what the protocol needs (T-31, T-17).

## Statement hash

Every validity proof of a ballot binds one statement:

```
statement_hash = H(DS("abolish/v1/ballot-statement",
    definition_hash ‖ u16(0x0002) ‖ u8(1) ‖ u8(tier) ‖ encode(nullifier)
    ‖ encode(vss) ‖ encode(share_hashes)))
```

| Input             | Type             | Why                                                                                                                                                                                                                                |
| ----------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition_hash` | `bytes[32]`      | Binds the election: its poll, chain IDs, contract addresses, panel, ceremony transcript (which fixes the trustees' keys, the role the joint public key has under ElGamal) and its rules (`m`, `min`, `max`, `k`, `n`) (T-30, T-34) |
| `0x0002`, `1`     | `u16`, `u8`      | The ballot record type and the version whose proof rules apply, so a proof is never valid under another version's rules (T-31)                                                                                                     |
| `tier`            | `u8`             | The ballot's tier ([[membership]])                                                                                                                                                                                                 |
| `nullifier`       | `field<bn254>`   | The ballot's nullifier, so no one can copy another voter's commitments and proofs into their own ballot and learn their vote by its effect on the result (T-32; Cortier and Smyth)                                                 |
| `vss`             | as in the ballot | Every commitment the proofs speak about, and every VSS commitment                                                                                                                                                                  |
| `share_hashes`    | as in the ballot | Every share ciphertext, so the shares the trustees hold are fixed by the proved statement ([[0002-everlasting-privacy]], T-30)                                                                                                     |

Under ballot version 2 the version input is 2 and the ballot's `cell` takes the place of `tier`, as a `u8` at the same position (Ballot record (version 2)); nothing else changes, so the input after the tag has the same length, and no proof made under one version verifies under the other (T-31).

The statement is hashed once and each challenge binds its digest: the full statement can be over 33 KB, and repeating it in every one of a ballot's up to 65 challenge inputs would multiply what every verifier hashes per ballot. `H` is collision-resistant, so the digest binds the statement as the statement itself would; ElectionGuard 2.0's extended base hash `H_E` does the same. `definition_hash` is the first input, as [[domain-separation]] requires.

## Ballot hash

A ballot is named by the hash of its public part ([[0002-everlasting-privacy]], Delivery):

```
ballot_hash = H(DS("abolish/v1/ballot",
    definition_hash ‖ u16(0x0002) ‖ u8(1) ‖ u8(tier) ‖ encode(nullifier)
    ‖ encode(vss) ‖ encode(share_hashes) ‖ encode(option_proofs) ‖ encode(sum_proof)))
```

The inputs are the statement hash's, in the same order and encodings, followed by the validity proofs as the ballot carries them (Committed vote): `encode(vss) ‖ … ‖ encode(sum_proof)` is the committed vote's own encoding. The input after the tag is `68 + len(encode(committed_vote))` bytes. Under ballot version 2 the version input is 2 and `cell` takes the place of `tier`, as in the statement hash.

What binds it:

- **The membership proof's message** `M` ([[revoting]], Message), so a membership proof can't be moved to another ballot (T-38).
- **Every share receipt** ([[share-encryption]], Intake and receipts), so a receipt counts only for the public part the trustee checked, and a client can't collect receipts for one public part and publish another ([[0002-everlasting-privacy]], Delivery; T-41).
- **Everything that decides later whether a selected ballot counts** (postings, complaints, the voter's receipt checks) keys on it, never on a board entry, since anyone can get a copy of a ballot boarded first ([[revoting]], Owned elsewhere).

What it leaves out, and why:

- **The membership proof.** A proof can't bind its own hash, and anyone can re-randomise a Groth16 proof without the witness ([[membership]], Security notes): a re-randomised copy of a ballot keeps its ballot hash, and so its receipts, and is a repeat ([[revoting]], Selection step 1).
- **The L1 reference.** `M` binds it beside the ballot hash. The same public part under a newer reference carries the same shares, so the receipts the trustees gave for it still hold.

**Every other field is bound.** Every field of the ballot record (`0x0002`, versions 1 and 2) other than the membership proof, `l1_ref_number` and `l1_ref_hash` MUST be an input to `ballot_hash`, so whoever specifies the record and adds a field there adds it here, before anything freezes. A verifier computes `ballot_hash` from the strictly decoded record, never takes one a record or relay carries.

Only someone who knows the commitments' openings can give a statement a second ballot hash: the voter's client, or `k` trustees together, who can interpolate them from their shares. The validity proofs are proofs of knowledge of those openings (CDS94), so no one else can make another accepting proof of the same statement (T-31, T-32). A second ballot hash also needs a new membership proof, and so the voter's identity secret, before it is a ballot.

## Core hash

A ballot's **core** is the part of it made before the voter chooses to cast or to challenge (Casting step 1): the definition, the tier, `vss` and `share_hashes`. Its hash is the **tracking code** of [[challenge]]:

```
core_hash = H(DS("abolish/v1/ballot-core",
    definition_hash ‖ u16(0x0002) ‖ u8(1) ‖ u8(tier) ‖ encode(vss) ‖ encode(share_hashes)))
```

The inputs are the statement hash's without the nullifier, in the same order and encodings. The client shows it before the choice; a challenge's opening ([[challenge]], `0x0003`) rebuilds it; and anyone computes it from a cast ballot record, so the voter's checker finds the cast ballot by it. It binds the ballot record type and version, as `statement_hash`, `aad` and `t_e` do, so one code never names cores of two ballot versions (T-42, T-47).

## Validity proofs

For a commitment `Y` and a value `s`, let `Y_s = Y · g^{−s}`. "`Y` commits to `s`" means the prover knows `ρ` with `Y_s = h^ρ`, and each branch of a proof is a Schnorr proof of that knowledge. A disjunctive proof over the values `s_0, …, s_{L−1}` has branches `(c_b, z_b)` and is checked as:

```
A_b = h^{z_b} · Y_{s_b}^{−c_b}     for b = 0, …, L − 1
c   = HashToScalar(t(A_0, …, A_{L−1}), DST = tag)
accept iff c_0 + … + c_{L−1} = c   (mod ℓ)
```

### Option proof

For option `j`, `Y = C_j = E_{j,0}`, the values are `0` and `1` in that order (branch `0` is `(c0, z0)`, branch `1` is `(c1, z1)`), the tag is `abolish/v1/fs/ballot-validity/option` and

```
t = statement_hash ‖ u16(j) ‖ encode(C_j) ‖ encode(A_0) ‖ encode(A_1)
```

### Sum proof

`Y = C_Σ = C_0 · C_1 · … · C_{m−1}`, which commits to `Σ v_j` with randomness `Σ r_j`. The values are `min, min + 1, …, max` in that order, the tag is `abolish/v1/fs/ballot-validity/sum` and

```
t = statement_hash ‖ u16(min) ‖ u16(max) ‖ encode(C_Σ) ‖ encode(A_min) ‖ … ‖ encode(A_max)
```

Together with the option proofs, this proves the vote has no option counted twice or negatively and selects from `min` to `max` options (T-28): a plurality ballot selects at most one option and may be blank, an approval ballot respects its limit and minimum ([[0003-tally-scheme]], [[election-definition]]).

### Encoding rules for `t`

- `C_Σ` and every `A_b` are encoded as `element` with the identity allowed: they are computed, not decoded, and an adversarial ballot can make any of them the identity. Every other value is encoded as its table says.
- `u16(j)`, `u16(min)` and `u16(max)` are the proof's position and allowed-value set, which [[domain-separation]] requires in every challenge. The option and sum proofs use different tags, so neither can stand in for the other.
- Each challenge is a fresh `HashToScalar` under its own tag ([[group]], Hash to scalar).

### Proving

To prove `Y` commits to `s_v` with randomness `ρ` (an option proof: `ρ = r_j`, `s_v = v_j`; the sum proof: `ρ = Σ r_j mod ℓ`, `s_v = Σ v_j`):

1. Draw `w` uniformly from the scalars, and set `A_v = h^w`.
2. For every other branch `b ≠ v`, draw `c_b` and `z_b` uniformly from the scalars and set `A_b = h^{z_b} · Y_{s_b}^{−c_b}`.
3. Compute `c` from `t` as above, then `c_v = c − Σ_{b≠v} c_b` and `z_v = w + c_v · ρ`, both mod `ℓ`.

This is the standard simulation of the false branches (CDS94): whatever the committed value, an honest proof is distributed as a uniformly random accepting transcript, so the proof is witness-indistinguishable against an unbounded adversary and reveals nothing about which value was committed (T-15). The only distance from perfect is the scalar sampling: each scalar is 64 CSPRNG bytes reduced mod `ℓ`, within about 2⁻²⁶² of uniform, so a ballot's proofs and commitments are within a statistical distance of about 2⁻²⁵⁰ of their ideal distribution. `w`, the simulated `c_b` and `z_b`, and every polynomial coefficient come from the platform CSPRNG through `packages/crypto` and are never reused. A caller can't supply them: `packages/crypto` proves only a sharing it made itself, unchanged. Once the voter casts, the client discards them with `r_j`; a challenge reveals the polynomials of a core that is never cast, and never any proof's randomness, since no proof exists before the choice ([[challenge]]; [[0002-everlasting-privacy]], T-18, T-45); in JavaScript that means dropping every reference, since a `bigint` can't be overwritten.

Order of construction: the vote's polynomials and `vss` first, then the shares and their ciphertexts ([[share-encryption]]) and `share_hashes`, then `statement_hash`, then the option proofs and the sum proof.

Every validity proof binds the ballot's nullifier. The share ciphertexts don't: their associated data binds the definition, the seat and `vss` but not the tier or the nullifier ([[share-encryption]], Ciphertext), so the sharing, the ciphertexts and `share_hashes` can be made without the nullifier. A challenged ballot is that nullifier-independent core, named by its core hash (above) and opened by a spoiled-ballot opening ([[challenge]]; T-42, T-47).

## Shares

The shares a trustee receives for one ballot are a `list<share, MAX_OPTIONS>` of `m` entries, one per option in order:

| Field | Type     | Meaning  |
| ----- | -------- | -------- |
| `v`   | `scalar` | `f_j(i)` |
| `r`   | `scalar` | `g_j(i)` |

Trustee `i` checks each option's share against the public VSS commitments (Pedersen 1991, Section 4):

```
g^{v} · h^{r} = E_{j,0} · E_{j,1}^{i} · E_{j,2}^{i²} · … · E_{j,k−1}^{i^{k−1}}
```

A trustee receipts the ballot's ciphertext only if the ballot's committed vote passes the checks below (all of them, `validity-shape` included, so each option has exactly `k` VSS commitments), the list has exactly `m` entries and every option's share passes ([[0002-everlasting-privacy]], Delivery). A share that passes is the evaluation at `i` of the polynomials `vss` commits to (binding, under discrete log), so any `k` trustees holding valid shares can open the ballot's commitments, and the tally's summed shares open the sum of the counted commitments (P1-15, T-29). Shares never appear on the board except as P1-13 and part 2 allow (a spoiled ballot's opening, a posted ciphertext); a trustee keeps them only until the tally ([[0002-everlasting-privacy]], Consequences, T-14).

## Checks

The validity check is an admission check ([[verifier]] 5.4): a ballot that fails is rejected, listed in the report and never counted, and the election isn't failed by it. The checks run in this order, and the first failure is the result:

| Code             | Check                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validity-shape` | `vss` has `m` entries, each of exactly `k` elements; `share_hashes` has `n` entries; `option_proofs` has `m` entries; `sum_proof` has `max − min + 1` entries. |
| `option-proof`   | Each option proof verifies, in option order. A report names the first option whose proof fails.                                                                |
| `sum-proof`      | The sum proof verifies.                                                                                                                                        |

Decoding failures (a non-canonical scalar, an identity commitment, a count over its maximum) are decode errors of the ballot record, before any of these.

## Ballot record

Record type `0x0002`, version 1: one cast ballot, posted through our API as a board entry or by direct submit as a contract event (P1-18).

| Field              | Type               | Meaning                                                                                                   |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `definition_hash`  | `bytes[32]`        | The election's definition hash                                                                            |
| `tier`             | `enum8<0, 1, 2>`   | The tier whose group the voter proves membership of ([[membership]], Scope)                               |
| `nullifier`        | `field<bn254>`     | `ν`, the voter's nullifier for this poll and tier                                                         |
| `l1_ref_number`    | `u64`              | The number of the L1 block the ballot names ([[revoting]], Message)                                       |
| `l1_ref_hash`      | `bytes[32]`        | That block's hash                                                                                         |
| `membership_proof` | `membership_proof` | The Groth16 proof of membership, 256 bytes ([[membership]], Proof encoding)                               |
| `committed_vote`   | `committed_vote`   | `vss`, `share_hashes`, `option_proofs` and `sum_proof`, in that order and encoding (Committed vote above) |

Notes:

- **Bound by the ballot hash.** `definition_hash`, `tier`, `nullifier` and `committed_vote` are exactly the inputs of `ballot_hash` beside the record type and version. The other three fields are the two it leaves out: the membership proof, and the L1 reference, which `M` binds (Ballot hash). So every field is bound, as Ballot hash requires.
- **Fixed offsets.** Counting the 3-byte header, `definition_hash` starts at byte 3, `tier` at 35, `nullifier` at 36, `l1_ref_number` at 68, `l1_ref_hash` at 76, `membership_proof` at 108 (its `A`, `B` and `C` at 108, 172 and 300) and `committed_vote` at 364. A contract reads every field it checks at a fixed offset without parsing the committed vote (P1-18). A record is 364 bytes plus its committed vote: 1,192 bytes at 3 options, `k = 2` and `n = 3`; about 3.3 KB at 10 options, `k = 4` and `n = 7`; about 45 KB at `MAX_OPTIONS` and `MAX_TRUSTEES`, well within `MAX_BOARD_PAYLOAD`.
- **It names its election.** Like the delivery records ([[delivery]], Records), a ballot carries its definition hash, so a ballot posted to another election's board is reported as stray rather than read under that election's rules.
- **Cast ballots only.** A ballot challenged at cast carries nothing that depends on the nullifier ([[verifier]] 6.2; [[revoting]], Client rule 6), so it has no nullifier, L1 reference, validity proofs or membership proof, and isn't a record of this version. An election pins one version of `0x0002`, so a challenged ballot can't be a second layout beside this one either. It never reaches the board on its own: its core travels inside its opening, the spoiled-ballot opening record (`0x0003`), published only at the voter's request, after close ([[challenge]]; [[0021-challenged-ballots]]).

### Decoding

The record decodes strictly ([[notation]]): a `tier` other than 0, 1 or 2 is `invalid-enum`; a `nullifier` at or above `r` is `non-canonical`; the membership proof decodes as [[membership]] (Proof encoding) specifies, so a broken point is `non-canonical` at its offset (108, 172 or 300); and the committed vote decodes as Committed vote does. Decoding doesn't compare `definition_hash` or `tier` with the election; the admission checks do, so a ballot naming another election or tier is still read, and reported. A record that fails to decode, including one under a version the profile doesn't pin (`profile-mismatch`), is a rejected entry ([[verifier]] 2.3), listed in the report and never an election failure.

### Admission

The admission checks of [[verifier]] 5.1 to 5.4 on a decoded ballot, against the registered definition (checked by 2.1 to 2.8) and the registered key set (3.1). They run in this order, and the first failure is the result. Each rejects that entry only: it is listed in the report, never counted, and never displaces another ballot (6.1, R4).

| Code                     | Rejects a ballot when                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ballot-stray`           | `definition_hash` isn't the election's.                                                                                                                                                                                                                                                                                                                             |
| `ballot-tier`            | The definition's electorate has no group of tier `tier`.                                                                                                                                                                                                                                                                                                            |
| `validity-shape`         | The committed vote's shape doesn't match the election (Checks).                                                                                                                                                                                                                                                                                                     |
| `share-hash-unqualified` | A seat `i` outside the registered key set has a `share_hashes[i]` other than 32 zero bytes ([[delivery]], Notes).                                                                                                                                                                                                                                                   |
| `membership-proof`       | The membership proof fails [[membership]] (Checks) under the pinned key with the public signals `[ρ, ν, m̂, ŝ]`: `ρ` and `ŝ` are the root and scope of the tier's group in the definition, `ν` is the record's `nullifier`, and `m̂ = F(M)`, with `M` recomputed from the record's `ballot_hash`, `tier` and L1 reference and the definition ([[revoting]], Message). |
| `option-proof`           | An option proof fails (Checks), reported with the first failing option.                                                                                                                                                                                                                                                                                             |
| `sum-proof`              | The sum proof fails (Checks).                                                                                                                                                                                                                                                                                                                                       |

A ballot that passes gives its `ballot_hash` and the tuple (`tier`, `ν`, `M`, `l1_ref_number`) that [[revoting]] ranks. Its L1 reference is admitted separately (5.8, [[revoting]], Admission), as is its time under the close rule (5.5, P1-18); repeats and ties (5.7, 6.1) and delivery (5.9, [[delivery]]) are decided over the ballots admitted. None of these checks reads another entry, so admission is stable (R4).

Why this order: the first two need only the record's header fields; the shape and the unqualified seats only lengths and zeros. The membership proof is checked before the validity proofs so that a non-member's ballot is reported as a membership failure whatever its validity proofs, and the verifier numbering (5.1 before 5.4) is the order a report lists. A seat in the registered key set with a zero share hash isn't rejected here: no ciphertext hashes to it, so the seat can't be delivered and the delivery check leaves the ballot uncounted (5.9).

`share-hash-unqualified` is the check [[delivery]] (Notes) requires: a seat outside the registered key set gets no shares, so its share hash is fixed, and a ballot can't carry `32 · (n − q)` chosen bytes there into the permanent archive (T-17).

### Casting

The ballot client (P2-8, P5-4) builds a record in this order, after running [[verifier]] 2.5 and 2.8 for the election:

1. The vote's sharing, the share ciphertexts and `share_hashes` (Proving; [[share-encryption]]), with 32 zero bytes for each seat outside the registered key set. Nothing so far depends on the nullifier: this is the core, whose hash the client shows before the voter chooses to cast or to challenge ([[challenge]], Client rules).
2. Once the voter chooses to cast: the validity proofs, which bind `ν`; the L1 block ([[revoting]], Client rules 1 to 3); `ballot_hash`; and then the public signals of the admission row `membership-proof`, from the definition it checked and never from a server ([[membership]], Security notes).
3. The membership proof under the pinned depth-32 key, with the proving key whose sha256 `membership_vk_hash` binds ([[membership]], Verification key).
4. Before the record leaves the device, the client runs the admission checks above on the finished record, the membership proof's verification included ([[membership]], Security notes), and never sends a record that fails them.
5. It delivers the finished record, with `ct_i`, to each qualified seat `i`'s intake ([[share-encryption]], Intake and receipts), which checks the record's admission, membership proof included, before it receipts, and it boards the record ([[delivery]], Client rules). The ciphertexts go nowhere before this step, so a challenged ballot, which never has a membership proof, never reaches a trustee.

A retry sends the identical record ([[revoting]], Client rule 3).

### Residuals

- **What the contract path leaves free.** The archive keeps every direct-submitted record, including one the verifier rejects, so a field the contract doesn't check is free to a member with a valid membership proof (T-17). P1-18's contract MUST run, besides the membership proof ([[membership]], Owned elsewhere), the cheap checks before it: `ballot-stray`, `ballot-tier`, `validity-shape` and `share-hash-unqualified`. Two parts stay free even then: the L1 reference (40 bytes), which a contract can't check from L2 ([[revoting]], Owned elsewhere), and the validity proofs (64 bytes per option and per sum branch), whose ristretto255 arithmetic it doesn't run; the verifier rejects such a ballot at 5.8 or 5.4. Until P1-18 specifies its contract, the whole record after the membership proof is free on that path. Through the board path, the board operator MUST board a ballot only if it passes the admission checks above (an honest client's always does, Casting), so a boarded ballot carries none of these chosen bytes; one it boards anyway is still read and rejected, and reporting it against the operator is P1-19's.
- **Random-looking fields.** VSS commitments, a qualified seat's share hash and the proofs' scalars look random, so a malicious client can hide chosen bytes in them, as in every field that must be random ([[notation]], Result-critical fields; T-17).
- **Malleable proofs.** Anyone can re-randomise the membership proof of a ballot they have seen and post the copy; it is a repeat, recognised by (`tier`, `ν`, `M`), never by its bytes ([[revoting]], Selection; T-38).

## Ballot record (version 2)

Record type `0x0002`, version 2: one cast ballot in an election whose definition is version 3 or 4 ([[election-definition]], Layout (version 3); version 4's partition is version 3's), naming the cell it was cast in rather than a tier ([[0019-regional-cells]], Ballot version 2; T-16). Everything not stated here is version 1's: the committed vote, the shares and their ciphertexts, the checks and the casting order.

| Field              | Type               | Meaning                                                                                    |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| `definition_hash`  | `bytes[32]`        | The election's definition hash                                                             |
| `cell`             | `u8`               | The cell's position in the partition ([[election-definition]], Layout (version 3)), from 0 |
| `nullifier`        | `field<bn254>`     | `ν`, the voter's nullifier for this poll and cell ([[membership]], Scope)                  |
| `l1_ref_number`    | `u64`              | As in version 1                                                                            |
| `l1_ref_hash`      | `bytes[32]`        | As in version 1                                                                            |
| `membership_proof` | `membership_proof` | As in version 1, against the cell's cell tree ([[membership]], Cell tree)                  |
| `committed_vote`   | `committed_vote`   | As in version 1                                                                            |

Notes:

- **The same offsets.** `cell` is version 1's `tier` byte, at offset 35, so every field keeps version 1's offset and a record has version 1's size. A contract reads the cell where it read the tier (P1-18, P1-12c).
- **Bound by the ballot hash.** `statement_hash` and `ballot_hash` take version 2 and `cell` in place of version 1 and `tier` (Statement hash, Ballot hash), so every field but the membership proof and the L1 reference is bound, as Ballot hash requires, and a proof under one version never verifies under the other (T-31).
- **The cell decides the tier.** A ballot's tier is its cell's tier in the definition, never a field of the record, and `M` ([[revoting]], Message) is computed with it. The cell is bound into `M` through `ballot_hash`. The re-vote rule ranks by that tier and the nullifier ([[revoting]], Selection), unchanged: the cells of one tier hold disjoint commitments (first occurrence), so one secret has one leaf, one cell and one nullifier per tier ([[membership]], Cell tree).
- **Shares and delivery are version 1's.** The share ciphertexts' associated data and proof of knowledge name ballot version 1 (`u16(0x0002) ‖ u8(1)`, [[share-encryption]], Ciphertext): version 2 keeps version 1's share-ciphertext layout and rules unchanged, and the definition hash, which they also bind, pins the ballot version, so a ciphertext still can't serve two elections or two versions. Version 2 fixes the delivery records (`0x000c` to `0x000e`) at version 1 with the same windows, as version 1 does ([[delivery]], Versions).
- **Only with definition versions 3 and 4.** A profile pairs ballot version 2 with definition version 3 or 4 and nothing else, and definition versions 3 and 4 with ballot version 2 and nothing else ([[verifier]] 2.3, `profile-combination`): version 1's tiers-only partition has no cells to name, and a partition of cells can't be read from a tier. Ballot version 2 also needs a spoiled-ballot opening version that opens its cores: version 2 does ([[challenge]], Opening version 2), so a profile pinning ballot version 2 pins opening version 2, and 2.3 refuses one pinning opening version 1, whose voters couldn't challenge a ballot (T-42, T-47).

### Decoding (version 2)

As version 1, except that `cell` is any `u8`: decoding never compares it with the partition, so a ballot naming a cell the definition doesn't have is still read, and rejected at admission (`ballot-cell`). A record of another version is `profile-mismatch` under a profile pinning version 2, as under one pinning version 1.

### Admission (version 2)

The checks of version 1 (Admission), in the same order, with two changes:

| Code               | Rejects a ballot when                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ballot-cell`      | In place of `ballot-tier`: `cell` is at or above the number of cells in the definition's partition.                                                                                                                                                                                                                                                            |
| `membership-proof` | The membership proof fails [[membership]] (Checks) with `ρ` the cell's `root` and `ŝ` the scope of the cell's tier and root ([[membership]], Scope), both from the definition, `ν` the record's `nullifier`, and `m̂ = F(M)`, with `M` recomputed from the record's `ballot_hash` and L1 reference, the cell's tier and the definition ([[revoting]], Message). |

A ballot that passes gives its `ballot_hash`, its cell, and the tuple (`tier`, `ν`, `M`, `l1_ref_number`) that [[revoting]] ranks, with `tier` its cell's tier. The voter can't choose a cell by choosing a root to prove against: the cell's root and scope come from the definition, and a commitment has a leaf in only one cell of its tier ([[verifier]] 2.8; [[membership]], Cell tree). A ballot naming a cell its voter has no leaf in fails `membership-proof`.

### Casting (version 2)

As version 1, with the cell in place of the tier: the client finds the cell holding its own counted leaf (its group's region, by the fold), checks that the leaf is the counted occurrence in the region it registered in and refuses to cast and alarms otherwise ([[election-definition]], The electorate is in the past; [[0019-regional-cells]], Consequences), and proves against that cell's tree, root and scope, all rebuilt from the board and the definition, never from a server.

### Residuals (version 2)

- **The cell is public.** A ballot shows its cell, and so its region unless the cell is a remainder; that is the result's granularity, which 2.8's floor bounds (T-16). A remainder cell shows which cell, never which of its regions.
- **What the contract path leaves free** is version 1's, with `ballot-cell` in place of `ballot-tier` among the cheap checks a direct-submit contract MUST run (P1-18).

## Ballot record (version 3)

Record type `0x0002`, version 3: one cast ballot in an election whose definition is version 5, which asks several questions ([[election-definition]], Layout (version 5); [[0026-multi-question-ballots]]; T-28, T-30, T-31, T-32, T-34). It has version 2's fields, offsets and cell (the partition of definition version 5 is version 4's), with a committed vote whose last field is one range proof per question in place of version 1's one sum proof. Everything not stated here is version 2's: the shares and their ciphertexts, the decoding of the other fields, the admission order, the membership proof and the casting order.

### Context (version 3)

The values of Context, with the definition's questions in place of its one option count and limits:

| Value                   | Source                                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Q`                     | The number of the definition's `questions`, numbered `q = 0, …, Q − 1`                                                                                |
| `m_q`, `min_q`, `max_q` | Question `q`'s `option_count`, `min_selections` and `max_selections`                                                                                  |
| `o_q`, `T`              | `o_q = m_0 + … + m_{q−1}`, question `q`'s first flat index, and `T = m_0 + … + m_{Q−1}`, the poll's option count ([[election-definition]], Questions) |
| `k`, `n`                | As in Context                                                                                                                                         |
| `cell`, `nullifier`     | The ballot record's own cell and nullifier, checked against its membership proof ([[verifier]] 5.1 to 5.3), as in version 2                           |

Option `j` of question `q` is flat option `o_q + j`. The vote is `v_0, …, v_{T−1}` in flat order, question-major, each `v_j ∈ {0, 1}`, with `min_q ≤ v_{o_q} + … + v_{o_q + m_q − 1} ≤ max_q` for every question. Its sharing, VSS commitments and shares are Committed vote's over the `T` flat options: `m` there is `T` here.

### Committed vote (version 3)

| Field           | Type                                             | Meaning                                                                                                                              |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `vss`           | `list<list<element, MAX_TRUSTEES>, MAX_OPTIONS>` | As version 1, for each flat option `j = 0, …, T − 1` in order                                                                        |
| `share_hashes`  | `list<bytes[32], MAX_TRUSTEES>`                  | As version 1                                                                                                                         |
| `option_proofs` | `list<bit_proof, MAX_OPTIONS>`                   | As version 1, for each flat option in order, its position `u16(j)` the flat index                                                    |
| `sum_proofs`    | `list<list<branch, 65>, MAX_QUESTIONS>`          | For each question `q` in order, the proof that `Y_q` commits to a value from `min_q` to `max_q`: one branch per value, in that order |

`T ≤ MAX_OPTIONS` (the definition's `option-count` rule), so a flat index fits version 1's `u16` and every per-option list its maximum, and a question's range has at most `m_q + 1 ≤ 65` values, version 1's branch maximum. The codec bounds `sum_proofs` by `MAX_QUESTIONS` ([[parameters]]) and each entry by 65; the shape check below compares both with the election. The range branches total `Σ (max_q − min_q + 1) ≤ T + Q ≤ 96`, so the largest committed vote is about 47 KB, against version 1's 45 KB.

### Question range proof

`Y_q = C_{o_q} · C_{o_q + 1} · … · C_{o_q + m_q − 1}`, the product of question `q`'s vote commitments, which commits to the question's number of selections with randomness `r_{o_q} + … + r_{o_q + m_q − 1}`. The proof is a disjunctive proof of Validity proofs over the values `min_q, min_q + 1, …, max_q` in that order, under the tag `abolish/v1/fs/ballot-validity/question-sum` ([[domain-separation]]), with

```
t = statement_hash ‖ u16(q) ‖ u16(o_q) ‖ u16(m_q) ‖ u16(min_q) ‖ u16(max_q)
    ‖ encode(Y_q) ‖ encode(A_min) ‖ … ‖ encode(A_max)
```

`Y_q` and every `A_b` are encoded with the identity allowed, as version 1's `C_Σ` (Encoding rules for `t`). The question's number, its first flat index and its option count fix which commitments `Y_q` multiplies, and `min_q` and `max_q` the allowed-value set, so each is in the challenge as [[domain-separation]] requires: a range proof can't move to another question, even one of the same shape, or to another range, ballot or election, and the option and question proofs use different tags, as do version 1's sum proof and this one (T-30, T-32).

**How it composes.** The option proofs show each `C_j` commits to 0 or 1, so each `Y_q` commits to the number of question `q`'s options selected; the range proofs show each of those numbers is within its question's limits. Together: no option counted twice or negatively, no over-vote on any question, each question's minimum met, and no count moved from one question to another, which a single sum over all `T` options wouldn't catch (T-28). Nothing relates two questions: the proofs never show how one question's answer bears on another's ([[0026-multi-question-ballots]], No cross-tabulation). With one question the construction is version 1's, under the new tag and with the position inputs.

**Proving** is Proving's, with `ρ = r_{o_q} + … + r_{o_q + m_q − 1} mod ℓ` and `s_v` the question's number of selections; the client makes the range proofs after every option proof, in question order, and draws every `w`, simulated `c_b` and `z_b` fresh.

### Hashes (version 3)

`statement_hash`, `ballot_hash` and `core_hash` are version 2's with version input 3 (Statement hash, Ballot hash, Core hash): `u8(3)` in place of `u8(2)`, `cell` at the same position, and `encode(sum_proofs)` in place of `encode(sum_proof)` at the end of `ballot_hash`'s input, which is again the committed vote's own encoding. So no proof or tracking code made under one version is valid under another (T-31), and a version-3 core's tracking code differs from a version-2 core's over the same bytes ([[challenge]], Core and tracking code). Every field of the record but the membership proof and the L1 reference is bound, as Ballot hash requires. `M` ([[revoting]], Message) is version 2's.

### Checks (version 3)

The checks of Checks, in the same order, over the flat options and the questions:

| Code             | Check                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validity-shape` | `vss` has `T` entries, each of exactly `k` elements; `share_hashes` has `n` entries; `option_proofs` has `T` entries; `sum_proofs` has `Q` entries, and entry `q` has exactly `max_q − min_q + 1` branches. |
| `option-proof`   | Each option proof verifies, in flat order. A report names the first failing flat option.                                                                                                                    |
| `sum-proof`      | Each question's range proof verifies, in question order. A report names the first failing question.                                                                                                         |

A trustee's share check is Shares', over `T` options: it receipts only a list of exactly `T` shares, each passing.

### Decoding (version 3)

As version 2, with the committed vote above: `sum_proofs` over `MAX_QUESTIONS` entries, or an entry over 65 branches, is `length-over-max`, and a scalar at or above `ℓ` is `non-canonical`. A record of another version is `profile-mismatch` under a profile pinning version 3.

### Admission (version 3)

Version 2's checks (Admission (version 2)), in the same order, with `validity-shape`, `option-proof` and `sum-proof` as Checks (version 3) states them. `option-proof` reports the first failing flat option and `sum-proof` the first failing question. A ballot that passes gives what a version-2 ballot gives: its `ballot_hash`, its cell and the tuple [[revoting]] ranks, every question in it. Selection is per tier and nullifier over the whole ballot, so a re-vote replaces every answer and a tie voids every question ([[0026-multi-question-ballots]], Re-voting, challenge and receipts).

### Shares and delivery (version 3)

Version 1's, as version 2 keeps them: share plaintexts of `T` entries, each seat's ciphertext under [[share-encryption]]'s rules, whose associated data and proof of knowledge name ballot version 1 (`u16(0x0002) ‖ u8(1)`), the delivery records (`0x000c` to `0x000e`) at version 1 with the same windows ([[delivery]], Versions). The definition hash, which the ciphertexts bind, pins the ballot version, so a ciphertext still can't serve two elections or two versions. A plaintext of `T ≤ 64` shares fits `sealed`'s maximum.

### Casting (version 3)

Version 2's (Casting (version 2)), with the proofs of Proving above. The ballot client asks every question before it builds the core, shows every question's answers in the display text before the tracking code, and keeps no record of earlier answers to pre-fill a re-vote (T-45, T-47; [[display-text]], Client rules).

### Residuals (version 3)

- **Version 2's residuals hold**: the cell is public, and the contract path leaves the same fields free, with the range proofs (64 bytes per branch) in place of the sum proof; P1-18's direct-submit contract MUST run `validity-shape` per question, as it does for versions 1 and 2.
- **Small cells reveal whole ballots.** A cell with one counted ballot shows every answer of that voter, all questions at once ([[0026-multi-question-ballots]], Consequences; T-16).

## Residuals

- **Trustees can open any ballot.** Any `k` trustees can combine their shares and open a ballot's commitments, publicly and verifiably (T-14, [[0002-everlasting-privacy]]). This page doesn't change that.
- **Binding is computational.** Someone who could compute discrete logs in ristretto255 (a cryptographically relevant quantum computer) could open a commitment to another value and forge validity proofs for past elections. Privacy is unaffected; historical verification then rests on what was anchored on L1 before the break ([[0002-everlasting-privacy]], Context).
- **Shares check only against the client's own commitments.** A trustee's check proves that the shares match `vss`, not that the client sent the shares the voter meant: a malicious client can commit to a valid vote other than the voter's choice. That is cast-as-intended, P1-13's Benaloh challenge (T-41, T-42).
- **Not constant time.** The prover's scalar arithmetic (`c_v`, `z_v`, the polynomial evaluations) uses JavaScript `bigint`, which isn't constant time. Each scalar multiplication is `@noble/curves`' constant-time ladder, and `packages/crypto` runs the same multiplications whatever the vote (`g^{v_j}` as `g^{v_j + 1} · g^{−1}`; every `Y_s` before the real branch is chosen), but the order of a proof's operations still depends on which branch is real. A local timing attacker on the voter's device could learn about `ρ` or the vote. The device is in the voter's trust base already (T-18, T-41).

## Test vectors

`docs/spec/vectors/ballot-validity.json` ([[vectors/README|vectors]]): ballots for plurality and approval, blank ballots, ballots at `MAX_OPTIONS` and at `MAX_TRUSTEES`, each with the randomness that produced it so an implementation can reproduce every byte; one ballot failing each check, including a proof copied to another nullifier, option or election, a vote of 2, an over-vote, and challenges that don't sum; codec rejections of the committed vote and of shares; and valid and invalid shares for every trustee of a ballot. They are printed by `packages/crypto/scripts/ballot-validity-vectors.py`, an implementation of this page in Python's integers and `hashlib`, reusing only the independent ristretto255 and RFC 9380 code of `group-vectors.py`, which checks itself against the RFCs first.

`docs/spec/vectors/ballot-v2.json`: version-2 ballot records of an election whose definition is version 3, with tier 0 split into a large region's cell and a remainder of two small regions, and tier 2 unsplit (three cells), each with its encoding, statement hash, ballot hash, `M`, the public signals the admission check derives and the result: admitted ballots in every cell (both regions of the remainder, a re-vote, a share hash at every seat, a commitment repeated in two groups counted in its first one), one ballot rejected by each code (`ballot-cell` at the first cell past the partition and at 255), and membership failures including a proof under another cell's root and scope (of the same tier and of another), another ballot's proof, a changed L1 reference and a repeated commitment proving from its zeroed leaf; the two order cases; and decode rejections. They are printed by `packages/crypto/scripts/ballot-v2-vectors.py`, which builds each cell tree itself by the first-occurrence rule and reuses `ballot-vectors.py` and `regional-cells-vectors.py`, with membership proofs by `ballot-proofs.mjs` as for version 1.

`docs/spec/vectors/ballot-v3.json`: version-3 committed votes over version-5 definitions (each listed with its encoding, hash, questions, offsets, cells and panel): valid ballots for the owner's four methods in one poll (every question at its least and at its most), one question, `MAX_QUESTIONS` questions of two options (`T = MAX_OPTIONS`), one question of `MAX_OPTIONS` options (65 range branches) and `MAX_TRUSTEES`, each with the randomness that made it, its shares, statement, ballot and core hashes; one failing each check, with the flat option or question it names: `validity-shape` per question (a missing, extra or swapped entry, a branch too many), option proofs swapped across a question boundary or made over version 2's statement hash, copies to another nullifier, cell or election, an over-vote, an over-limit and two under-`exactly` answers, a count moved from one question to another, two same-shaped questions' proofs swapped, and a range proof made as version 1's sum proof; and decode rejections of the committed vote. They are printed by `packages/crypto/scripts/ballot-v3-vectors.py`, an implementation of Ballot record (version 3) in Python's integers and `hashlib` that reuses `ballot-validity-vectors.py`'s proofs and `definition-v5-vectors.py`'s definitions. It prints `spoiled-opening-v2.json` ([[challenge]]) and `tally-questions.json` ([[tally]]) too. Admission vectors with membership proofs (version 2's order with version 3's checks) come with the verifier's reading of version 3 (P2-14 part 5).

`docs/spec/vectors/ballot.json`: ballot records of two elections (plurality over tiers 0 and 2, approval over tier 1), each with its encoding, ballot hash, `M`, the public signals the admission check derives and the result: admitted ballots (each tier, a re-vote, the same ballot proved twice, a share hash at every seat), and one ballot rejected by each code, the membership failures including a changed L1 reference, another ballot's proof, a proof under another tier's root and scope, a nullifier that isn't the circuit's and a non-member; two ballots failing two checks each, which pin the order; and decode rejections. They are printed by `packages/crypto/scripts/ballot-vectors.py`, an implementation of Ballot record in Python's integers and `hashlib` (reusing this folder's other independent generators, with its own Baby Jubjub), with membership proofs from snarkjs over Semaphore's depth-32 circuit (`ballot-proofs.mjs`), which checks that each proof's root and nullifier are the ones the Python computed; every pairing verdict in the file is snarkjs's.
