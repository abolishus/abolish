# Keyed-nullifier hashes

[[keyed-nullifier]]'s nullifier is `N = H2(x, sk · H1(x))`. This page fixes `H1` and `H2`: the Poseidon2 instance both use, the Tier 2 scope as a field element `σ`, `H1` as RFC 9380's `hash_to_curve` structure over Baby Jubjub, and `H2`. It also records the review of the TACEO gadgets our circuits will compute `H1` with, against the code Least Authority audited ([[0022-tier2-keyed-nullifier]], Amendment). Both hashes are computed only inside the query and output circuits; off-circuit code computes only `σ` and the tags' field elements. Notation is from [[notation]], the group and its encodings from [[keyed-nullifier]]. Threats: T-03, T-13, T-21, T-30, T-31, T-36, T-39.

What this page doesn't yet specify (P3-4 part 2b-3b-2): the query and output records, `query_hash` and the statements of the query and output circuits. The hashes themselves are in `packages/circuits/lib/keyed_nullifier`, over the vendored gadgets, and its tests run this page's vectors through them (part 2b-3b-1).

## Sources

- Poseidon2: Grassi, Khovratovich and Schofnegger, "Poseidon2: A Faster Version of the Poseidon Hash Function", AFRICACRYPT 2023 (eprint 2023/323). Round constants from the Poseidon paper's Grain LFSR (Grassi, Khovratovich, Rechberger, Roy and Schofnegger, USENIX Security 2021, eprint 2019/458, Appendix F), as the Poseidon2 reference code generates them.
- The width-4 instance over BN254 is the one Noir's standard library (`std::hash::poseidon2_permutation`) and Barretenberg implement. Its internal diagonal is pinned from Noir's `bn254_blackbox_solver` at `v1.0.0-beta.22`, the Noir release [[0010-tier2-identity-provider]]'s toolchain pins.
- `hash_to_curve`, Elligator 2 and the Montgomery-to-twisted-Edwards rational map: [RFC 9380](https://www.rfc-editor.org/rfc/rfc9380) §3, §6.7.1, Appendix D.1 and Appendix H.5.
- TACEO's gadgets: `TaceoLabs/oprf-nr` v1.0.0 at `e4984d6`; the audited code: `TaceoLabs/oprf-service` at `aaf0c88`, fixes verified at `50798b4` (Least Authority, January 2026).

## Poseidon2

**"Poseidon2" on this page is always this permutation**, never the two-input circomlib Poseidon that [[membership]] writes `Poseidon2` for Semaphore's tree. They are different functions with different constants; neither is ever used for the other's inputs ([[0022-tier2-keyed-nullifier]], Amendment).

`Poseidon2(s)` permutes a state `s` of 4 elements of `F_p` ([[notation]], `field<bn254>`; `p` is [[keyed-nullifier]]'s, BN254's scalar field order, and `r` on this page is always the client's blinding scalar), with `R_F = 8` full rounds, `R_P = 56` partial rounds and the S-box `v ↦ v⁵`:

1. `s ← M_E · s`.
2. For each round `j` from 0 to 63: in a full round (`j < 4` or `j ≥ 60`), add `c_j` to every element, apply the S-box to every element, then `s ← M_E · s`; in a partial round (`4 ≤ j < 60`), add `c_j[0]` to `s[0]`, apply the S-box to `s[0]` only, then `s ← M_I · s`.

| Value | Definition                                                                                                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M_E` | The paper's `M4`: rows `[5, 7, 1, 3]`, `[4, 6, 1, 1]`, `[1, 3, 5, 7]`, `[1, 1, 4, 6]`                                                                                                                                         |
| `M_I` | `𝟙 + diag(μ)`, so `(M_I · s)[i] = μ_i · s[i] + Σ s`, with `μ` the four values below                                                                                                                                           |
| `c_j` | Grain LFSR output for a prime field, `n = 254`, `t = 4`, `R_F = 8`, `R_P = 56`, read 254 bits at a time most significant first and kept if below `p`: 4 per full round, 1 per partial round (`c_j[1..3] = 0`), in round order |

```
μ_0 = 0x10dc6e9c006ea38b04b1e03b4bd9490c0d03f98929ca1d7fb56821fd19d3b6e7
μ_1 = 0x0c28145b6a44df3e0149b3d0a30b3bb599df9756d4dd9b84a86b38cfb45a740b
μ_2 = 0x00544b8338791518b2c7645a50392798b21f75bb60e3596170067d00141cac15
μ_3 = 0x222c01175718386f2e2e82eb122789e352e105a3b8fa852613bc534433ee428b
```

The vectors list every `c_j`. `Poseidon2([0, 0, 0, 0])` is Noir's published known answer; the generator checks it before printing anything.

**Sponge.** `Sponge(m_1, …, m_n)` absorbs `n ≥ 1` field elements at rate 3 and capacity 1:

```
s = [0, 0, 0, n · 2⁶⁴]
for each block of 3 inputs (the last zero-padded): s[0..2] += block; s ← Poseidon2(s)
Sponge(m_1, …, m_n) = s[0], s[1], s[2]   (the rate of the last state)
```

It is defined here rather than by reference to a library's hash function, whose padding rules differ between libraries: Noir's standard-library `Poseidon2Hasher`, for one, permutes once more when `n` is a multiple of 3. The input count in the capacity element separates inputs of different lengths. This page always takes outputs from the first squeeze, at most 3 of them, so each output costs no extra permutation.

## Scope field

The Tier 2 scope ([[nullifier-key]], Key context) enters both hashes as one field element:

```
σ = int(H(DS("abolish/v1/keyed-nullifier/scope", u64(l2_chain_id) ‖ group_registry))) >> 8
```

with `l2_chain_id` and `group_registry` (`bytes[20]`) from the release's pins, `int` reading the digest big-endian, and the shift leaving 248 bits, so `σ < p` with no reduction ([[domain-separation]], In-circuit hashes). `σ` is a public input of both circuits, and a seat recomputes it from its own pins, never from a query. It is the same for every key of the scope, initial or reshared ([[nullifier-reshare]]), so a document's `N` doesn't change when the panel does. Binding the scope into `H1` and `H2` keeps `N` scoped to one registry on one chain even if a key were ever reused elsewhere ([[0022-tier2-keyed-nullifier]], The group and hashes; T-21).

## H1

`H1(x) = H1(σ, x)` maps a document's `x ∈ F_r` to a point of `𝔾`, following RFC 9380's `hash_to_curve` (§3): two field elements, each mapped to the curve, summed, then the cofactor cleared.

```
u_0, u_1 = Sponge(tag_field("abolish/v1/keyed-nullifier/h1"), σ, x)[0..1]
Q_0 = map(u_0),  Q_1 = map(u_1)
H1(σ, x) = 8 · (Q_0 + Q_1)
```

- **Hash to field.** `u_0` and `u_1` are the first two rate elements of one squeeze, so they are two independent outputs of the sponge, as RFC 9380's `hash_to_field` with `count = 2` requires. Poseidon2's outputs are already elements of `F_p`, Baby Jubjub's base field, so no reduction and no bias. TACEO's `encode` takes one element, under its own tag, and maps it once: RFC 9380's `encode_to_curve`, which isn't a random oracle, while 2HashDH's proof models `H1` as one ([[0022-tier2-keyed-nullifier]], Amendment).
- **The map.** `map` is RFC 9380's Elligator 2 (§6.7.1) onto Baby Jubjub's Montgomery form `K · t² = s³ + J_M · s² + s` with `J_M = 168698` and `K = 1`, then the rational map of Appendix D.1 to the twisted Edwards form:

  ```
  x1 = −J_M · inv0(1 + Z · u²);  if x1 = 0 then x1 = −J_M
  gx1 = x1³ + J_M · x1² + x1;  x2 = −x1 − J_M;  gx2 = x2³ + J_M · x2² + x2
  if gx1 is square (0 included): (s, t) = (x1, √gx1 with sgn0 = 1)
  else:                          (s, t) = (x2, √gx2 with sgn0 = 0)
  (v, w) = (s / t, (s − 1) / (s + 1)),  or (0, 1) if t = 0 or s = −1
  ```

  `Z = 5`, the first non-square of `1, −1, 2, −2, …` (RFC 9380 Appendix H.5's `find_z_ell2`). `sgn0(y) = y mod 2` of the integer below `p`. The map is deterministic: whichever square root an implementation computes, the sign rule picks one. With `K = 1`, `a = J_M + 2 = 168700` and `d = J_M − 2 = 168696`, so the rational map lands on Baby Jubjub as [[keyed-nullifier]] defines it, with no scaling.

- **Exceptional cases.** `1 + Z · u²` is never 0, because `−1` is a square in `F_p` and `−1/Z` isn't. No point of the Montgomery form has `s = −1`, because `t² = J_M − 2 = d` isn't a square, and `(0, 0)` is its only point with `t = 0`, because the other roots of `s² + J_M · s + 1` don't exist (`J_M² − 4 = a · d` isn't a square). So the rational map's only exceptional input is `(0, 0)`, the point of order 2, which it sends to the identity `(0, 1)` as Appendix D.1 requires. Elligator 2 reaches `(0, 0)` only from `u = 0` (where `gx1 = −J_M` is a non-square, `x2 = 0` and `gx2 = 0`); the vectors include it.
- **Sum and cofactor.** `Q_0 + Q_1` is the twisted Edwards addition law, which is complete on Baby Jubjub (`a` is a square and `d` isn't), so it is correct for every pair, equal points and the identity included. Montgomery addition is not complete and MUST NOT be used for this sum (TACEO's audit finding B). Multiplying by the cofactor 8 lands in `𝔾`.
- **The identity.** `H1` is the identity only if `Q_0 + Q_1` has order dividing 8, which a random oracle hits with probability about `2⁻²⁵¹`. A query with `B` the identity is refused ([[keyed-nullifier]], Evaluation) whatever its cause.
- **`x = 0`.** `H1` is defined for every `x`. The query circuit, not `H1`, refuses `x = 0`, because zkPassport's hash-only commitment form sets the private nullifier to 0 and would give every document the same `x` ([[0022-tier2-keyed-nullifier]], Amendment).

## H2

```
N = H2(σ, x, U) = Sponge(tag_field("abolish/v1/keyed-nullifier/h2"), σ, x, U.x, U.y)[0]
```

with `U = sk · H1(σ, x)` given by its affine coordinates. `N` is a `field<bn254>`. `H2` hashes `x` as well as `U` (2HashDH's `H2(x, ·)`), so two documents whose `U` collided would still get different `N`.

**`U` MUST be in `𝔾`** (TACEO's audit finding A). The output circuit takes `x`, `r` and `U` as private inputs and proves, for one `r` with `0 < r < l`, both `B = r · H1(σ, x)` for the public `B` the seats answered and `Z = r · U` for the public `Z` the attesters recombined ([[0022-tier2-keyed-nullifier]], Attestation). The first equation fixes `r` (with `x`); without it, any `U′ ∈ 𝔾` has some `r′` with `Z = r′ · U′`, and the client could choose `N`. Given that shared `r`, if `U` were only checked to lie on the curve, `U + T` for any point `T` of order dividing `gcd(r, 8)` would satisfy the second equation too and hash to a second `N` for the same document, whenever `r` is even. So the output circuit checks that `U` is on the curve and in `𝔾` (part 2b-3b states it). Off-circuit code never computes `H2`.

## Tags

Both hashes take their tag as the first sponge input, `tag_field(tag)` ([[domain-separation]], In-circuit hashes), with a fixed input count: 3 for `H1` and 5 for `H2`. The tags are the first registered with the primitive In-circuit. Their field elements are in `docs/spec/vectors/circuit.json` and this page's vectors; a circuit embeds them as constants.

## TACEO's gadgets

[[0022-tier2-keyed-nullifier]]'s Amendment requires `H1` to be computed with TACEO's audited map, not a map of our own, and the audit's coverage of `oprf-nr` v1.0.0 to be shown by a diff against the audited code.

**What our circuits use.** Only the `babyjubjub` library of `oprf-nr` v1.0.0: `BabyJubJubPoint` (`new`, `identity`, `is_on_curve`, `is_identity`, `add`, `double`, `multiply_by_cofactor`, `scalar_mul`, `scalar_mul_bits`, `check_sub_group`, `validate_babyjubjub_field`), `hash_to_curve::map_to_curve_elligator2`, and the rational map `rational_map_mont_to_twisted_edwards`, which isn't public, so part 2b-3b copies its text unchanged into our library with its provenance, together with the private helpers it calls from the same file, `is_zero` and `inverse_or_zero`, the latter in its `50798b4` form (finding D), which v1.0.0 keeps unchanged. Not used: `encode` and its `hash_to_field` (TACEO's tag and one map), `generator_mul_fix` and the Montgomery and window-table code behind it, and the whole `oprf` library (its `dlog` checks a proof against a public key, which option A has none of, and `oprf_output` hashes under TACEO's tag).

**The diff.** Every file of `babyjubjub/src` at v1.0.0 was compared with `noir/babyjubjub/src` at `50798b4`. Nothing in the logic changed:

| File                                    | Difference from `50798b4`                                                                                                                                                                                                                                  | Review                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `lib.nr`                                | `u1` bits became `bool` (`to_le_bits` results, `BABYJUBJUB_CHARACTERISTIC`, `scalar_mul_bits`'s tests)                                                                                                                                                     | The same constraints: a Noir `bool` is a range-checked bit, as `u1` was                                                    |
| `hash_to_curve.nr`                      | The Poseidon2 import renamed (`perm::x5_3` to `permutation::t3`, `noir-poseidon` v0.5.0-beta.0 to v0.6.1); `comptime global Z` to `global Z`; `pow`'s bits `u1` to `bool`; `sgn0` returns `x.sgn0()` (a `bool` in current Noir) instead of `x.sgn0() == 1` | Only `encode`'s `hash_to_field` uses Poseidon2, and we don't call it. The map and the rational map are otherwise identical |
| `montgomery.nr`                         | Formatting of one signature; `from_montgomery_unconstrained` became `pub(crate)`                                                                                                                                                                           | Not used by our circuits                                                                                                   |
| `escalar_mul_fix.nr`, `window_table.nr` | `u1` to `bool`                                                                                                                                                                                                                                             | Not used by our circuits                                                                                                   |
| `tests.nr`                              | None                                                                                                                                                                                                                                                       | —                                                                                                                          |

Between the audited `aaf0c88` and `50798b4`, the files we use changed by the audit's fixes only: `inverse_or_zero` gained its constraints (`5aa1a41`, finding D), and `check_sub_group`'s ladder of Montgomery additions, which could meet points with no valid Montgomery mapping (finding B's incomplete addition), was first constrained (`fa9491e`) and then replaced by a twisted Edwards double-and-add in `lib.nr` (`ac80d85`). The same range also split the generator multiplication into a 126-bit and a 125-bit segment so that its Montgomery accumulator never meets equal points (`1cd1561`); we don't use it.

**The findings that touch our circuits:**

- **A, a subgroup check on the unblinded response.** Applies to the output circuit: `U` MUST be checked in `𝔾` (H2, above). `check_sub_group` computes `l · P` with complete Edwards additions and requires the point on the curve first, so the output circuit asserts `is_on_curve` and then `check_sub_group`. Its twisted Edwards ladder (`ac80d85`) was written after the audited `aaf0c88`, so it was reviewed here: `BABYJUBJUB_CHARACTERISTIC` is `l` in little-endian bits with bit 250 set, and the ladder starts at `P` and consumes bits 249 down to 0, computing `l · P`. The identity passes it, which is harmless here: `Z` is the identity only if `B` or `sk` is, and both are refused.
- **B, incomplete Montgomery addition.** `H1`'s sum uses `BabyJubJubPoint::add`, the complete twisted Edwards law, and `scalar_mul` and `check_sub_group` use the same law. No Montgomery addition is in our circuits' path. `add`'s constraints `x · (1 + d·β·γ) = β + γ` and `y · (1 − d·β·γ) = δ + a·β − γ` fix `x` and `y` only while the denominators are nonzero, which completeness guarantees for points on the curve, so every point reaching `add` must be on the curve: the map's outputs are (`t² = g(s)` is asserted and the rational map is algebraic), and inputs from outside the circuit are checked with `is_on_curve` first.
- **D, the zero case of `inv0` in the map.** Resolved at `50798b4` and unchanged: `inverse_or_zero` constrains `x · z = 0` and `inv · z = 0` with `z = 1 − x · inv`, so `inv = x⁻¹` when `x ≠ 0` and `inv = 0` when `x = 0`. The audited version computed `1/x` in constrained code, which no witness satisfies at `x = 0`: `map(0)` couldn't be proven at all.
- **E, exceptional cases of the Montgomery–Edwards conversion.** The rational map computes `inv0((s + 1) · t)` and returns `(0, 1)` when it is 0, as RFC 9380 Appendix D.1 requires; the only reachable exceptional input is `(0, 0)` (Exceptional cases, above), and the vectors include it. `to_montgomery` and `from_montgomery`, whose preconditions exclude these points, are used only by `generator_mul_fix`, which we don't use.

**Other checks of the map.** `is_quadratic_residue_or_zero` takes a hinted Legendre symbol `l` and a hinted root `b` and constrains `l ∈ {−1, 0, 1}`, `l(l−1)(b² − 5·g) + (l+1)(b² − g) = 0` and `g = 0 ⇒ l = 0`; since 5 is a non-square, a nonzero square can only give `l ∈ {0, 1}` and a non-square only `l = −1`, so its result is the true one. The root `y` is hinted and constrained by `y · y = gx`, and the sign rule then fixes it. `sgn0` is `(y as u8) % 2`; in Noir 1.0.0-beta.22 truncating a `Field` to 8 bits also constrains the quotient so that `q · 2⁸ + rem < p` (its compiler's `truncate_field_to_6_bits` test shows the constraint), so the parity is that of the canonical integer and no prover can flip a root's sign. `scalar_mul` decomposes its scalar into 251 bits, which bounds it below `2²⁵¹` but not below `l`; the query circuit therefore range-checks `r` with `validate_babyjubjub_field` and refuses `r = 0` (part 2b-3b).

**Cross-check.** The vectors' generator reproduces TACEO's three `encode` known answers from this page's map and the Poseidon2 reference code's width-3 instance before printing anything. That comparison is after the cofactor is cleared, so it shows the map defined here equals their gadget's up to a point of order dividing 8, the sign of `t` included (a negation survives the multiplication by 8), not exactly. Part 2b-3b's Noir tests therefore assert each vector's `map0` and `map1` before cofactor clearing, as well as `H1` and `N`, through the vendored gadgets.

## Security notes

- **A random oracle into `𝔾`.** RFC 9380's `hash_to_curve` is indifferentiable from a random oracle when `hash_to_field` is, which 2HashDH's analysis assumes of `H1` (TOPPSS). Here `hash_to_field` is a Poseidon2 sponge, so the assumption is Poseidon2's, as for every in-circuit hash of zkPassport's that `x` already rests on.
- **One `N` per document.** `H1` and `H2` are deterministic functions of `σ` and `x` (and `U`, itself fixed by `sk` and `H1`), so the uniqueness of `N` reduces to that of `x` ([[0022-tier2-keyed-nullifier]], Uniqueness of `x`) and to the circuits' checks named above: the map's sign rule, one `r` with `0 < r < l` binding `B = r · H1(σ, x)` and `Z = r · U`, `U ∈ 𝔾`, and `x ≠ 0` (T-03).
- **Our composition, with our vectors.** Nothing outside this repository publishes vectors for `H1` or `H2`; the vectors are ours, from an independent implementation, and the cross-check against TACEO's answers covers the map (T-36).

## Test vectors

`docs/spec/vectors/keyed-nullifier-hashes.json` ([[vectors/README|vectors]]): Poseidon2's parameters, every round constant and the internal diagonal, four permutations (Noir's known answer for zeros among them) and sponges of 1 to 7 inputs with all three outputs; both tags' field elements; Elligator 2 and the rational map for eleven `u` with every intermediate value (`u = 0`, the exceptional case, among them, and both branches of the square test) and the rational map's exceptional input; `σ` for three scopes; and `H1` and `H2` for eight cases (`x` at 0, 1 and `p − 1`, four documents, and one document under another scope), with `u_0`, `u_1`, both maps, the sum, `H1`, a key, `U` and `N`. They are printed by `packages/crypto/scripts/keyed-nullifier-hashes-vectors.py`, which implements the Grain LFSR, Poseidon2, Elligator 2 and the rational map from their specifications in Python's integers, derives the round constants (equal to Noir's table), checks Noir's width-4 known answer, the Poseidon2 reference code's width-3 known answer and TACEO's three `encode` answers first, and reuses only `keyed-nullifier-vectors.py`'s Baby Jubjub arithmetic and `circuit-vectors.py`'s `tag_field`; it shares nothing with `packages/crypto`, `packages/circuits`, any `@noble` library or TACEO's code.
