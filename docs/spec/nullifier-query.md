# Nullifier query

How a client asks the panel for its Tier 2 keyed nullifier and shows the attesters what it got ([[0022-tier2-keyed-nullifier]], option A, Query and Attestation): the query record (record type `0x001d`, version 1) with its context and `query_hash`, the statement of the **query circuit**, the output record (record type `0x001e`, version 1), the statement of the **output circuit**, and the checks a seat makes of a query and an attester of an output before either proof. [[keyed-nullifier]] has the group, the evaluation and the answers; [[keyed-nullifier-hashes]] has `σ`, `H1` and `H2`. Notation and decoding rules are from [[notation]]. Threats: T-03, T-13, T-15, T-21, T-30, T-31, T-39.

What this page doesn't yet specify:

- **The proof checks in code** (P3-4 part 2b-3b-2b-2b): both statements are Noir circuits in `packages/circuits` (`nullifier_query`, `nullifier_output`), with a soundness test for each constraint and every vector run through them (part 2b-3b-2b-1), and their verification keys, reference string and proof length are pinned below (Keys and proofs) with proof round trips through bb (part 2b-3b-2b-2a); `query-proof` and `output-proof` as code that a seat and an attester call, through `@aztec/bb.js`, are part 2b-3b-2b-2b.
- **Part 2b-4:** the identity chain a query's `comm_in` must come from and its checks ([[0010-tier2-identity-provider]]'s pinned circuit set, US anchors, proof date and predicates), the transport of queries and answers under the registration KEM keys ([[nullifier-key]]) and a fresh client key, the attestation's group position and quorum, the delivery of `N` to every seat, the published probe counts, and [[verifier]] 2.4's count of attested additions.

## Sources

- 2HashDH and its threshold form: as [[keyed-nullifier]]. The query proof shows that the client knows `r` and `x` with `B = r · H1(x)`, which is what keeps the seats from being a static Diffie–Hellman oracle ([[keyed-nullifier]], Security notes); the output proof is [[0022-tier2-keyed-nullifier]]'s, Attestation.
- zkPassport's commitment: `hash_salt_dg1_dg2_hash_private_nullifier` and `SaltedValue::get_hash` in `zkpassport/circuits` at `c7da418` (`src/noir/lib/commitment/common`, `src/noir/lib/utils/src/types.nr`), the commitment its integrity sub-circuit outputs (`commit_to_disclosure`) and its own OPRF query circuit (`bin/oprf-auth`) opens. Its hash is `Poseidon2::hash` of `noir-lang/poseidon` v0.3.0 (`0880c37`), which equals this repository's `Sponge(…)[0]` ([[keyed-nullifier-hashes]], Sponge) for every input count: both absorb at rate 3 with `n · 2⁶⁴` in the capacity, and neither permutes again after a full last block.
- UltraHonk, in its zero-knowledge flavour only, as the `circuits` skill and [[0010-tier2-identity-provider]] require.

## The query

The client holds the document's `x`, zkPassport's `private_nullifier` (non-zero, [[0022-tier2-keyed-nullifier]], Amendment), the salt `s_x` and the other four salted hashes of the commitment `comm_in` its identity chain output, and the identity commitment it wants added to a Tier 2 group. For each query it draws `r` uniform on `1` to `l − 1` and `query_id`, 32 bytes, from the CSPRNG; neither is ever reused. The query circuit outputs `B = r · H1(σ, x)`: `H1` exists only in circuits ([[keyed-nullifier-hashes]]), so the client learns `B` from the circuit's execution, never by computing `H1` itself.

### Query record

Record type `0x001d`, version 1. Never on the board, the chain or the archive, and never pinned by a profile: the Tier 2 key fixes its version (version 1 of the key transcript, [[nullifier-key]], fixes version 1).

| Field            | Type           | Meaning                                                                                                                       |
| ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `key_id`         | `bytes[32]`    | The key asked under ([[nullifier-key]], Transcript; [[nullifier-reshare]] for a successor key)                                |
| `l2_chain_id`    | `u64`          | The Tier 2 scope's chain ([[keyed-nullifier-hashes]], Scope field)                                                            |
| `group_registry` | `bytes[20]`    | The Tier 2 scope's group registry                                                                                             |
| `group_id`       | `u64`          | The Tier 2 group the commitment is to join ([[contracts]], Group registry)                                                    |
| `commitment`     | `field<bn254>` | The identity commitment to be added ([[membership]])                                                                          |
| `query_id`       | `bytes[32]`    | Fresh from the client's CSPRNG for every query                                                                                |
| `comm_in`        | `field<bn254>` | The commitment the client's identity chain output, which its other proofs of the registration share (part 2b-4)               |
| `b`              | `bjj-point`    | `B = r · H1(σ, x)`. Never the identity                                                                                        |
| `proof`          | `bytes<65536>` | The query proof: an UltraHonk proof, zero-knowledge flavour, of the query circuit under the verification key the release pins |

`l2_chain_id` and `group_registry` are the scope's, which `σ` hashes; they are in the record so that `query_hash`, which the seats' answers sign, names the scope too. The proof's length is the proving system's, which the record doesn't fix: the bound only keeps decoding finite, and `query-proof` refuses a proof of any other length.

### Context and `query_hash`

With `m_ctx` the record's first six fields under its header, and `m_query` the record without its proof,

```
m_ctx      = u16(0x001d) ‖ u8(1) ‖ key_id ‖ u64(l2_chain_id) ‖ group_registry ‖ u64(group_id) ‖ commitment ‖ query_id
ctx        = int(H(DS("abolish/v1/keyed-nullifier/query-context", m_ctx))) >> 8
m_query    = m_ctx ‖ comm_in ‖ encode(b)
query_hash = H(DS("abolish/v1/keyed-nullifier/query", m_query))
q          = int(query_hash) >> 8
```

with `int` reading a digest big-endian, as for `σ` ([[keyed-nullifier-hashes]], Scope field): the shift leaves 248 bits, so `ctx < p` and `q < p` with no reduction. `ctx` binds the query circuit's proof to the key, the scope, the group, the commitment and this query; it can't cover `b`, which the circuit outputs. `query_hash` names the whole statement, `b` and `comm_in` included, and is what the seats' answers ([[keyed-nullifier]], Answer record) and the output proof carry. Neither covers the proof, which is randomised: two proofs of one statement are one query. The header in both keeps a later version's query from sharing a version 1 context or name (T-31).

### Query circuit

Public inputs, in this order: `σ`, `ctx`, `comm_in`, then the output `B` as `B.x`, `B.y`. Private inputs: `d_1`, `d_2`, `d_3`, `d_4`, `s_x`, `x` and `r`, each a `field<bn254>`. The statement is

```
comm_in = Sponge(d_1, d_2, d_3, d_4, Sponge(s_x, x)[0])[0]
x ≠ 0,  s_x ≠ 0
0 < r < l
B = r · H1(σ, x)
```

- **`comm_in`'s opening.** `d_1` to `d_4` are the salted hashes of `dg1`, the expiry date, the normalised `dg2` hash and its hash type, in either of zkPassport's forms, which the circuit doesn't need to tell apart. The fifth slot is opened only in the clear-value form, `Sponge(s_x, x)[0]` with both non-zero (`SaltedValue::get_hash` on a clear value), never as a bare hash: zkPassport's hash-only form carries the private nullifier's value as 0, and every document would then share a second `x` ([[0022-tier2-keyed-nullifier]], Amendment; T-03). That `comm_in` came from this document's identity chain, so that `x` is its private nullifier, is checked outside the circuit, against the chain's own proofs of the same `comm_in` (part 2b-4).
- **`x ≠ 0`.** `H1` is defined at 0 ([[keyed-nullifier-hashes]], H1); the circuit refuses it.
- **`r`.** `0 < r < l` by `validate_babyjubjub_field` (`r < l`) and `r ≠ 0`: `scalar_mul` bounds its scalar only below `2²⁵¹` ([[keyed-nullifier-hashes]], TACEO's gadgets). The circuits take `r`'s 251 bits from `validate_scalar_field_with_bits`, which applies that bound, and multiply with `scalar_mul_bits`, `scalar_mul`'s own loop; the output circuit multiplies `H1(σ, x)` and `U` by the same bits. `B` is then never the identity, since `H1` isn't ([[keyed-nullifier-hashes]], H1, The identity).
- **`B`** is computed with `H1` and `scalar_mul_bits` from [[keyed-nullifier-hashes]]' gadgets; every point that meets `add` is on the curve.
- **`ctx` enters no constraint.** A public input is bound by the proof itself: the verifier absorbs every public input into its transcript, so a proof made under one `ctx` doesn't verify under another. `σ` is a public input for the same reason and is also an input of `H1`. That rests on Noir and bb keeping a `pub` parameter that no constraint uses, so a test MUST show that a proof verifies under its own `ctx` and fails under any other (`packages/circuits` `test/proofs.test.ts` does, for every public input).

**What it proves.** The client knows `x ≠ 0` inside the commitment its identity chain output and `r` with `B = r · H1(σ, x)`, for this context. So `sk_i · B = (r · sk_i) · H1(σ, x)` can't serve as a next query without knowing `r · sk_i`, which is what stops chained queries ([[keyed-nullifier]], Security notes), and a query moved to another key, scope, group, commitment or `query_id` fails the proof (T-21, T-30). Its verification key, and so its circuit, is pinned by the release, as [[0010-tier2-identity-provider]] pins the identity chain's; a changed circuit is a new protocol version, never a parameter (T-05).

**What it reveals.** For `r` uniform and unknown to the seat, `B` is uniform in `𝔾`, so it says nothing about `x`. `comm_in` hides the document only if its salts do: the client MUST draw `s_x` and every other salt of its identity chain uniformly from the CSPRNG, fresh for each chain, never a constant (part 2b-4 checks nothing of it; a fixed salt would let anyone holding the chip data recompute `comm_in`). The proof is zero-knowledge, but only computationally: its witness holds the salted hashes of `dg1`, and a seat that kept the proof and later broke the assumption would learn nothing of `dg1` beyond those hashes, but would learn `x` and so the document's chip-recomputable nullifier. Seats delete queries once they have answered or refused ([[0022-tier2-keyed-nullifier]], Consequences, Channels; T-15).

### Query check

A seat checks a query before it answers, against its own pins and the key it holds, never against values the query supplies. In this order, the first failure is the result:

| Code               | Check                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| decode codes       | The query decodes strictly as version 1 ([[notation]], Strict decoding); `b` is in `𝔾` and isn't the identity.                |
| `query-key`        | `key_id` is the key the seat holds a share of.                                                                                |
| `query-scope`      | `l2_chain_id` and `group_registry` are the release's pins; `σ` is recomputed from them.                                       |
| `query-group`      | `group_id` is a group of the registry whose tier is 2, in the seat's view of the registry's finalized history.                |
| `query-commitment` | `commitment` isn't forbidden ([[membership]], Commitments and removals).                                                      |
| `query-proof`      | `proof` verifies under the pinned query-circuit key with public inputs `σ`, `ctx`, `comm_in`, `b.x`, `b.y` (Keys and proofs). |

Only then does the seat answer ([[keyed-nullifier]], Evaluation), with `query_hash` and `b` from the query. The checks of the identity chain behind `comm_in` come before the answer too (part 2b-4). The proof is checked last because it is the costly check; a query that fails an earlier one costs the seat a decoding and a few lookups.

## The output

From `k` checked answers the client combines `Z = sk · B` and unblinds `U = r⁻¹ · Z = sk · H1(σ, x)` ([[keyed-nullifier]], Combination and unblinding), then proves the output circuit's statement, which also outputs `N = H2(σ, x, U)`. `U` never leaves the device; nor do `x` and `r`.

### Output record

Record type `0x001e`, version 1. Never on the board, the chain or the archive, and never pinned by a profile: the Tier 2 key fixes its version (version 1 of the key transcript fixes version 1).

| Field        | Type                   | Meaning                                                                                                                         |
| ------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `query_hash` | `bytes[32]`            | The query the answers are for                                                                                                   |
| `answers`    | `list<bytes[356], 16>` | The answers combined, each a nullifier answer record (`0x0010`) of the version the key fixes, in strictly ascending seat order  |
| `n`          | `field<bn254>`         | `N`                                                                                                                             |
| `proof`      | `bytes<65536>`         | The output proof: an UltraHonk proof, zero-knowledge flavour, of the output circuit under the verification key the release pins |

Each element of `answers` is a whole answer record, header and signature included, decoded strictly ([[keyed-nullifier]], Answer record); 16 is `MAX_TRUSTEES` ([[parameters]]). Ascending seats give a set of answers one encoding. `Z` isn't in the record: every attester recombines it from the answers itself.

### Output circuit

Public inputs, in this order: `σ`, `q`, `B.x`, `B.y`, `Z.x`, `Z.y`, then the output `N`. Private inputs: `x`, `r`, and `U` as `U.x`, `U.y`, each a `field<bn254>`. The statement is

```
x ≠ 0
0 < r < l
B = r · H1(σ, x)
U is on the curve, l · U = (0, 1) and U ≠ (0, 1)
Z = r · U
N = H2(σ, x, U)
```

- **One `r` for `B` and `Z`.** The first equation fixes `r` with `x`; without it, every `U′ ∈ 𝔾` has some `r′` with `Z = r′ · U′`, and the client could choose `N` ([[keyed-nullifier-hashes]], H2). `0 < r < l` as in the query circuit.
- **`x` is the query's.** The query proof showed `B = r_q · H1(σ, x_q)` for the document's `x_q`. An output proof with `B = r · H1(σ, x)` for another `x` would give `log` relations between two of `H1`'s outputs, which is a discrete logarithm in `𝔾` for a random oracle; so the output's `x` is the query's. `x ≠ 0` is restated here, at the cost of one constraint, so the statement doesn't lean on that argument for 0.
- **`U` in `𝔾`, and not the identity.** On the curve first (`is_on_curve`), then an assertion that `check_sub_group` returns true, since it returns a `bool` and asserts nothing itself ([[keyed-nullifier-hashes]], TACEO's finding A): with `U` only on the curve, `U + T` for `T` of order dividing `gcd(r, 8)` would satisfy `Z = r · U` too and hash to a second `N`. The identity is refused as well, closing what part 2b-3b-1 left to this circuit (`h2` accepts it): `Z` would then be the identity, which the attesters refuse anyway, so this costs one constraint and removes the dependence.
- **`q` enters no constraint**, as `ctx` in the query circuit: it binds the proof to the query, and so to its key, scope, group, commitment, `comm_in` and `B`. `test/proofs.test.ts` shows a proof fails under any other `q`.

**What it proves.** For the query named by `q`, the `N` it outputs is `H2(σ, x, sk · H1(σ, x))` with `x` the document's, given that `Z = sk · B`, which the attesters establish from the answers' proofs. Given that the identity chain is sound, so that `x` is the document's one private nullifier (part 2b-4, and the question [[0022-tier2-keyed-nullifier]]'s Amendment leaves open), one document therefore has one `N` under one key's scope: `H1` and `H2` are deterministic, the map's sign rule is fixed, `U` is unique in `𝔾`, and `r` and `x` are bound as above (T-03). **What it reveals:** nothing beyond `N`, `Z` and the public inputs, computationally; the attesters see `N` and never `x` or `U`.

### Output check

Each attester checks an output against the query it checked (the query check above, with the identity chain of part 2b-4) and the key's transcript, never against values the output supplies for them. In this order, the first failure is the result:

| Code                 | Check                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| decode codes         | The output decodes strictly as version 1, and each answer as the version the key fixes.                                                                                                                                                                  |
| `output-query`       | `query_hash` is the query's.                                                                                                                                                                                                                             |
| `output-answers`     | There are exactly `k` answers, `k` the key's threshold, in strictly ascending seat order.                                                                                                                                                                |
| answer codes         | Each answer, in record order, passes the answer check with the query's `query_hash` and `b` ([[keyed-nullifier]], Answer check); the first failure is the result, with the answer's index. A failure at `answer-proof` is attributed to its seat (T-29). |
| `output-combination` | `Z`, combined from the answers ([[keyed-nullifier]], Combination and unblinding), isn't the identity.                                                                                                                                                    |
| `output-proof`       | `proof` verifies under the pinned output-circuit key with public inputs `σ`, `q`, `b.x`, `b.y`, `Z.x`, `Z.y`, `n` (Keys and proofs).                                                                                                                     |

What an attester does with an `N` that passes (its position, quorum, uniqueness against its list and delivery to every seat) is part 2b-4's.

## Keys and proofs

Both proofs are UltraHonk proofs in the zero-knowledge flavour, from Barretenberg 5.0.0-nightly.20260522 over circuits compiled by Noir 1.0.0-beta.22, with bb's `noir-recursive` target: a Poseidon2 Fiat–Shamir transcript, zero knowledge. Neither is checked on-chain, so no EVM target or Solidity verifier exists for them. A different prover version, target or circuit is a new protocol version, never a parameter (T-05).

- **The reference string** is the first `2¹⁵` powers `[x^i]₁` (from `i = 0`, the generator) and `[x]₂` of Aztec's Ignition ceremony, read from its first monomial transcript (`https://aztec-ignition.s3.amazonaws.com/MAIN%20IGNITION/monomial/transcript00.dat`, bytes 28 to 2,097,179 for G1 and 322,560,092 to 322,560,219 for `[x]₂`), in bb's encoding: each coordinate 32 bytes big-endian, G1 points as `x ‖ y`, `[x]₂` as `x.c0 ‖ x.c1 ‖ y.c0 ‖ y.c1`. `2¹⁵` is the output circuit's dyadic size, and the query circuit's is `2¹⁴` (`packages/circuits/gates.json`). bb's verifier takes `[x]₂` from a constant compiled into bb, not from the file; the file equals it, so the vendored powers are of bb's own `x`. The files are `packages/circuits/crs/bn254_g1.dat` (sha256 `50d2f4e9567be2b8e382cedfd078b96a3428a94597b7e88c4116e105d578ce77`) and `bn254_g2.dat` (sha256 `01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f`). Soundness rests on no one knowing `x`, which is Ignition's claim (one honest participant of its 176); the files' structure, every `[x^{i+1}]₁` against `[x^i]₁` under `[x]₂`, is checked by a test (T-21, T-55).
- **The verification keys** are `bb write_vk` of each compiled circuit under that string, 3,680 bytes each: the query circuit's `packages/circuits/artifacts/nullifier_query.vk` (sha256 `7acd95ec349d94b384baad47d08a1d7e050f307e997544d5d3fe309d5f1ab1dc`) and the output circuit's `nullifier_output.vk` (sha256 `b953a354fbc14d9c325ef03f311874c82f6b5ee178c16612dd516075de41d8cb`). The release pins them by these hashes; `query-proof` and `output-proof` use only a key with its pinned hash, whatever its source (T-05, T-21).
- **A proof is exactly 14,656 bytes** (458 field elements) for either circuit; `query-proof` and `output-proof` refuse a proof of any other length before verifying. The public inputs aren't part of the proof bytes: the checker supplies them, each as a `field<bn254>`, in the circuit's order above, from the record and its own recomputation (`σ` from the pins, `ctx` and `q` from the records, `Z` from the answers), never from the prover.

## Security notes

- **Each query is a single evaluation.** The query proof makes every answered `B` a blinding of `H1(σ, x)` for an `x` the client holds inside an identity-chain commitment, so a client gets one evaluation per valid query, and the panel's published counts (part 2b-4) bound how many (T-13, T-21).
- **Relays learn nothing they can use.** A relay that copies a query can only get the same answers to the same `B`, useless without `r`. One that moves an output to another commitment or group fails `output-query`, since `query_hash` names both, and one that changes either inside the query fails `query-proof` through `ctx` (T-21).
- **A discrete-log break.** Every recorded query and answer is a pair `(B, Z_i)`, as [[keyed-nullifier]], Security notes, says; the output adds `Z` and `N`, never `U`, `x` or `r`.
- **Computational zero knowledge towards the seats.** Both proofs are UltraHonk's zero-knowledge flavour, for which no statistical argument is published ([[0009-membership-proof]]). They never reach the board; a seat that keeps them breaks the deletion rule, and a later break of the assumption shows it `x` (T-15).

## Test vectors

`docs/spec/vectors/nullifier-query.json` ([[vectors/README|vectors]]): two queries for two documents under a key of `k = 2` of `n = 3`, each with its whole statement (the commitment's five slots and `comm_in`, `x`, `s_x`, `r`, `B` through `H1`), `m_ctx`, `ctx`, `m_query`, `query_hash`, `q`, both circuits' public inputs in order, and its record with a stand-in proof; for each, the answers of every seat, the `k`-subsets combined to one `Z`, the unblinded `U` and `N`, and an output record; and records failing each code the checks above can decide without a proof: undecodable ones (a trailing byte, a truncated proof, a `b` that is the identity or outside `𝔾`, a commitment at `p`, a proof or answer count over its bound, and a query or answer of version 2, `profile-mismatch` since the key fixes version 1), and one for each of `query-key`, `query-scope`, `query-group`, `query-commitment`, `output-query`, `output-answers` (too few, too many, out of order and a repeated seat), an answer failing its check, and a combination to the identity. The proofs in them are stand-ins, since `query-proof` and `output-proof` are part 2b-3b-2b's. They are printed by `packages/crypto/scripts/nullifier-query-vectors.py`, which reuses `keyed-nullifier-hashes-vectors.py`'s Poseidon2, `H1` and `H2`, `keyed-nullifier-vectors.py`'s Baby Jubjub arithmetic and answer proofs and `trustee-vectors.py`'s P-256 ECDSA, and shares nothing with `packages/crypto`.
