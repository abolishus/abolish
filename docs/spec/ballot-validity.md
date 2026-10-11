# Ballot commitments and validity proofs

How a plurality or approval ballot commits to its vote on the public board, how the vote is shared among the trustees, and how anyone checks, before the tally, that the commitments hold a vote the election's rules allow. This is the public part of [[0002-everlasting-privacy]] (option B, accepted by the owner) for the homomorphic tally of [[0003-tally-scheme]]: perfectly hiding Pedersen commitments, Pedersen verifiable secret sharing, and disjunctive Chaum–Pedersen validity proofs under a Fiat–Shamir challenge that binds the whole statement. Notation is from [[notation]], the group and hashes from [[group]]. Threats: T-15, T-28, T-29, T-30, T-31, T-32, T-14, T-36, T-38, T-39.

What this page doesn't cover yet, by the part of P1-12 that owns it:

- **Share encryption** (part 2): the hybrid KEM and AEAD that carry each trustee's shares, and the hash `H(ct_i)` of each ciphertext. This page takes the `n` ciphertext hashes as 32-byte values and binds them into the statement.
- **The ballot record** (`0x0002`, part 3, with P1-13 and P1-17b): the record that carries the committed vote below with its tier, nullifier, L1 block reference and membership proof, and the ballot hash. The committed vote is a structure nested in that record, and its layout here is the one version 1 of the record carries.

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

so `E_{j,0} = C_j = g^{v_j} · h^{r_j}` is the Pedersen commitment to option `j`'s vote. Trustee `i` (`1 ≤ i ≤ n`, its seat in the panel) receives, for every option, the share `(f_j(i), g_j(i))`; part 2 encrypts the shares to it. Each `E_{j,t}` is information-theoretically hiding (perfectly, up to the sampling distance under Proving) because its `h` exponent is uniform and independent of everything else, so the commitments reveal nothing about the vote to anyone, whatever their computing power ([[0002-everlasting-privacy]], T-15). They are binding under the discrete-log assumption, because no one knows `log_g h` ([[group]], Hash to group and `h`).

The ballot carries the committed vote:

| Field           | Type                                             | Meaning                                                                                                                                      |
| --------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `vss`           | `list<list<element, MAX_TRUSTEES>, MAX_OPTIONS>` | For each option `j` in order, its `k` VSS commitments `E_{j,0}, …, E_{j,k−1}`. None is the identity.                                         |
| `share_hashes`  | `list<bytes[32], MAX_TRUSTEES>`                  | `H(ct_i)` for each trustee `i = 1, …, n` in seat order: the hash of the ciphertext carrying trustee `i`'s shares (part 2).                   |
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

The statement is hashed once and each challenge binds its digest: the full statement can be over 33 KB, and repeating it in every one of a ballot's up to 65 challenge inputs would multiply what every verifier hashes per ballot. `H` is collision-resistant, so the digest binds the statement as the statement itself would; ElectionGuard 2.0's extended base hash `H_E` does the same. `definition_hash` is the first input, as [[domain-separation]] requires.

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

This is the standard simulation of the false branches (CDS94): whatever the committed value, an honest proof is distributed as a uniformly random accepting transcript, so the proof is witness-indistinguishable against an unbounded adversary and reveals nothing about which value was committed (T-15). The only distance from perfect is the scalar sampling: each scalar is 64 CSPRNG bytes reduced mod `ℓ`, within about 2⁻²⁶² of uniform, so a ballot's proofs and commitments are within a statistical distance of about 2⁻²⁵⁰ of their ideal distribution. `w`, the simulated `c_b` and `z_b`, and every polynomial coefficient come from the platform CSPRNG through `packages/crypto` and are never reused. A caller can't supply them: `packages/crypto` proves only a sharing it made itself, unchanged. Once the voter casts, the client discards them with `r_j`, except where P1-13's challenge reveals them on a spoiled ballot ([[0002-everlasting-privacy]], T-18, T-45); in JavaScript that means dropping every reference, since a `bigint` can't be overwritten.

Order of construction: the vote's polynomials and `vss` first, then the shares and their ciphertexts (part 2) and `share_hashes`, then `statement_hash`, then the option proofs and the sum proof.

Every validity proof binds the ballot's nullifier, and so does each share ciphertext's associated data ([[0002-everlasting-privacy]], Private part), which reaches the proofs through `share_hashes`. P1-13 requires a challenged ballot to carry nothing that depends on the nullifier ([[verifier]] 6.2, [[board]]), so P1-13 and part 2 reconcile the two before either is frozen: for example, a challenged ballot built without proofs and under a nullifier-independent context, or a tracking code over the nullifier-independent core. Until then a challenged ballot's format is open (T-42, T-47).

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

## Residuals

- **Trustees can open any ballot.** Any `k` trustees can combine their shares and open a ballot's commitments, publicly and verifiably (T-14, [[0002-everlasting-privacy]]). This page doesn't change that.
- **Binding is computational.** Someone who could compute discrete logs in ristretto255 (a cryptographically relevant quantum computer) could open a commitment to another value and forge validity proofs for past elections. Privacy is unaffected; historical verification then rests on what was anchored on L1 before the break ([[0002-everlasting-privacy]], Context).
- **Shares check only against the client's own commitments.** A trustee's check proves that the shares match `vss`, not that the client sent the shares the voter meant: a malicious client can commit to a valid vote other than the voter's choice. That is cast-as-intended, P1-13's Benaloh challenge (T-41, T-42).
- **Not constant time.** The prover's scalar arithmetic (`c_v`, `z_v`, the polynomial evaluations) uses JavaScript `bigint`, which isn't constant time. Each scalar multiplication is `@noble/curves`' constant-time ladder, and `packages/crypto` runs the same multiplications whatever the vote (`g^{v_j}` as `g^{v_j + 1} · g^{−1}`; every `Y_s` before the real branch is chosen), but the order of a proof's operations still depends on which branch is real. A local timing attacker on the voter's device could learn about `ρ` or the vote. The device is in the voter's trust base already (T-18, T-41).

## Test vectors

`docs/spec/vectors/ballot-validity.json` ([[vectors/README|vectors]]): ballots for plurality and approval, blank ballots, ballots at `MAX_OPTIONS` and at `MAX_TRUSTEES`, each with the randomness that produced it so an implementation can reproduce every byte; one ballot failing each check, including a proof copied to another nullifier, option or election, a vote of 2, an over-vote, and challenges that don't sum; codec rejections of the committed vote and of shares; and valid and invalid shares for every trustee of a ballot. They are printed by `packages/crypto/scripts/ballot-validity-vectors.py`, an implementation of this page in Python's integers and `hashlib`, reusing only the independent ristretto255 and RFC 9380 code of `group-vectors.py`, which checks itself against the RFCs first.
