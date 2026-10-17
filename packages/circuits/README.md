# @abolishus/circuits

Abolish's Noir circuits, built with Noir 1.0.0-beta.22 for Barretenberg 5.0.0-nightly.20260522 (pins: `.github/scripts/install-toolchain.sh`). Internal and source-only.

**Status: libraries and Tier 2's first two circuits (P1-17c, P3-4).** Membership proofs use Semaphore v4's own circuit and Groth16 keys ([[0009-membership-proof]], P1-17b), not Noir. The query and output circuits of Tier 2's keyed nullifier ([[nullifier-query]], P3-4) are here, with their soundness tests, committed artifacts and verification keys, the reference string bb proves them under, and proof round trips through bb; the proof checks a seat and an attester run aren't yet (Not yet).

## Layout

```
Nargo.toml              # workspace
lib/abolish/            # shared library: byte packing (src/pack.nr)
lib/keyed_nullifier/    # the keyed nullifier's hashes: the sponge, H1 and H2; the blinding both circuits share
nullifier_query/        # the query circuit: opens comm_in, outputs B = r · H1(σ, x)
nullifier_output/       # the output circuit: one r for B and Z, U in the subgroup, outputs N
gates.json              # each circuit's ACIR opcodes and UltraHonk circuit size, as bb gates reports them
artifacts/              # generated: each circuit's ACIR and ABI (<circuit>.json) and verification key (<circuit>.vk)
crs/                    # the reference string bb proves and verifies under, from Ignition (Reference string)
scripts/                # artifacts.ts writes artifacts/; crs.ts writes crs/
vendor/                 # third-party Noir libraries, unchanged (Vendored dependencies)
test/                   # vite-plus tests: vectors through Noir, source rules, vendored trees
```

Each circuit gets its own Nargo package next to `lib/`, depending on the libraries by path, with its statement at the top of `src/main.nr` as [[nullifier-query]] states it and its soundness tests below.

## Rules

- **Packing** (`docs/spec/notation.md`, Circuit-facing values): `pack_bytes` and `pack_bounded_bytes` match `packBytes` and `packBoundedBytes` in `@abolishus/crypto`. Both run the vectors in `docs/spec/vectors/circuit.json`, which an independent Python script prints. `pack_bounded_bytes` constrains the length and zero padding, so each value has one packing (T-31).
- **Keyed-nullifier hashes** ([[keyed-nullifier-hashes]]): `lib/keyed_nullifier` computes the spec's Poseidon2 sponge (Noir's width-4 permutation), `H1` (two Elligator 2 maps through TACEO's gadgets, summed with the complete Edwards law, cofactor cleared) and `H2`, which refuses a `U` off the curve or outside the prime-order subgroup (finding A, T-03). TACEO's `encode` is never called (T-36). `test/keyed-nullifier-hashes.test.ts` runs every vector of `keyed-nullifier-hashes.json` through them, each map before the cofactor is cleared.
- **Query and output circuits** ([[nullifier-query]]): `nullifier_query` opens `comm_in` with the private-nullifier slot in zkPassport's clear-value form (`x ≠ 0`, `s_x ≠ 0`) and outputs `B`; `nullifier_output` takes `B` and `Z` public, multiplies `H1(σ, x)` and `U` by one set of `r`'s bits with `0 < r < l` (`blinding_bits`), refuses an identity `U` and leaves the subgroup check to `h2`, and outputs `N`. `ctx` and `q` enter no constraint: the proof binds them. Each `src/main.nr` has a test per constraint that breaks only it; `test/nullifier-circuits.test.ts` runs both on every vector of `nullifier-query.json`, checks each compiled ABI's public inputs against the spec's order, and compares `bb gates` with `gates.json` (T-03, T-21, T-30).
- **Tags** (`docs/spec/domain-separation.md`, In-circuit hashes): a tag enters a circuit only as the constant `tag_field(tag)`, which `circuitTagField` in `@abolishus/crypto` computes and `circuit.json` lists. A circuit never recomputes it (T-30).
- **Artifacts** (`vp run build`, which runs `scripts/artifacts.ts`): `artifacts/<circuit>.json` is nargo's compiled program without its debug symbols and file map, which carry the sources' absolute paths, and `artifacts/<circuit>.vk` is `bb write_vk` of it under `crs/` with bb's `noir-recursive` target (Poseidon2 transcript, zero knowledge). They are never edited by hand: `test/proofs.test.ts` rebuilds them into a scratch directory and fails on any difference, and `repro-build` compares two builds of them. [[nullifier-query]] (Keys and proofs) pins each key's sha256, which the release pins too (T-05, T-21).
- **Proofs** ([[nullifier-query]], Keys and proofs): `test/proofs.test.ts` proves both circuits on every vector of `nullifier-query.json` with bb under the committed key and `crs/`, and checks the public inputs bb outputs against the vector's, the pinned length (14,656 bytes), that each proof verifies under its own public inputs and fails with any one of them changed (`ctx` and `q`, which no constraint uses, among them), under the other circuit's key and under the other vector's inputs, that any one proof field changed fails (fast-check), and that two proofs of one witness differ, as only a zero-knowledge prover's do (T-03, T-13, T-21). A refusal must be bb's verifier rejecting, never bb stopping on a bad file, except under the other circuit's key, whose count of public inputs bb refuses first; each key's sha256 and the proof length are checked against the spec.
- **Zero knowledge only.** `test/source-rules.test.ts` fails if any file here asks bb for a proof without zero knowledge (T-13, T-15).
- **Path dependencies only.** The same test fails on a dependency that isn't a path inside this package (T-55). A vendored dependency records its upstream repository, tag, commit and tree hash here.

## Reference string

bb proves and verifies under a KZG reference string, and fetches one from `crs.aztec-labs.com` at first use unless `-c` names a directory that holds enough points. `crs/` is that directory, so no build or test downloads it: `bn254_g1.dat` holds `[x^i]₁` for `i` from 0 to `2¹⁵ − 1` (the output circuit's dyadic size; the query circuit's is `2¹⁴`) and `bn254_g2.dat` holds `[x]₂`, from Aztec's Ignition ceremony (176 participants, 2019; soundness needs one of them honest). `scripts/crs.ts` reads them from Ignition's first monomial transcript (`https://aztec-ignition.s3.amazonaws.com/MAIN%20IGNITION/monomial/transcript00.dat`) by byte range, checks its header and re-encodes each coordinate from the transcript's limb order to bb's 32 bytes big-endian; it printed:

| Bytes                                 | sha256                                                             |
| ------------------------------------- | ------------------------------------------------------------------ |
| transcript 0 to 2,097,179             | `3d58729a277724d12c964411de12dd35fd02abc82761880c711605528c877026` |
| transcript 322,560,092 to 322,560,219 | `227512f4233e1b068e5dbfcf1a7fbb8b03d18050844eec29cb34af283fa6a7c9` |
| `crs/bn254_g1.dat`                    | `50d2f4e9567be2b8e382cedfd078b96a3428a94597b7e88c4116e105d578ce77` |
| `crs/bn254_g2.dat`                    | `01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f` |

An independent re-encoding (Python, in the session that vendored them) wrote the same bytes. `test/crs.test.ts` pins both files' hashes, checks that `crs/` holds nothing else (a file bb fetched because a circuit outgrew `2¹⁵` would appear there), that every G1 point is on the curve, that the first is the generator, that `[x]₂` is in G2's prime-order subgroup, and that the G1 points are successive powers of the `x` of `[x]₂`: `e(Σ ρ_i · P_{i+1}, [1]₂) = e(Σ ρ_i · P_i, [x]₂)` under fresh random weights `ρ_i`, which a string with any `P_{i+1} ≠ x · P_i` passes with probability `1/r`. bb's verifier doesn't read `bn254_g2.dat`: it uses an `[x]₂` compiled into bb, and the test checks that the pinned bb binary holds the file's bytes, which ties the vendored powers to bb's `x` through a second source. No test can show that `x` is unknown; that is Ignition's claim (T-21, T-55).

## Vendored dependencies

Copied as plain files, unchanged, from the pinned commits, with their MIT licences beside them; upstream's READMEs are left out. `test/keyed-nullifier-hashes.test.ts` recomputes the git object id of every vendored entry (what `git rev-parse <commit>:<path>` prints upstream) and fails on any file under `vendor/` that isn't pinned, so any edit shows up as a failed test and in the reviewed diff (T-55). Refreshing one means copying a new upstream tree and updating its rows here and in the test, together with the spec's review of the diff ([[keyed-nullifier-hashes]], TACEO's gadgets).

| Upstream                                     | Tag      | Commit                                     |
| -------------------------------------------- | -------- | ------------------------------------------ |
| `https://github.com/TaceoLabs/oprf-nr`       | `v1.0.0` | `e4984d6ca15771200875745828e8f6c5ced70186` |
| `https://github.com/TaceoLabs/noir-poseidon` | `v0.6.1` | `23cf1f05cbebb78538c8e321ab3da306e3529923` |

| Path                                         | Upstream path           | Git object id                              |
| -------------------------------------------- | ----------------------- | ------------------------------------------ |
| `vendor/oprf-nr/LICENSE`                     | `LICENSE`               | `b82e0563feef75ccfd57f081fd2efb5f80b391d7` |
| `vendor/oprf-nr/babyjubjub/src`              | `babyjubjub/src`        | `4c27dd3b30880bd23c95dd88f0c794a8c9482366` |
| `vendor/noir-poseidon/LICENSE`               | `LICENSE`               | `3fe6670c1099f6fb152d1cde560c3495ee3f9555` |
| `vendor/noir-poseidon/poseidon2/Nargo.toml`  | `poseidon2/Nargo.toml`  | `7bf975d0e027da52afd3887ca1ddecef5092e8f4` |
| `vendor/noir-poseidon/poseidon2/src`         | `poseidon2/src`         | `f3a287154fe93da15680fca1398ad583fe782450` |
| `vendor/noir-poseidon/hash_utils/Nargo.toml` | `hash_utils/Nargo.toml` | `3e8398fa4ffff7a9e20c717791ca7607610dc58c` |
| `vendor/noir-poseidon/hash_utils/src`        | `hash_utils/src`        | `d8bc189c687d2d01419758e43a49576b2bae66ff` |

One file differs from upstream: `vendor/oprf-nr/babyjubjub/Nargo.toml` takes `poseidon2` by path (`../../noir-poseidon/poseidon2`) instead of upstream's `{ tag = "v0.6.1", git = "https://github.com/TaceoLabs/noir-poseidon", directory = "poseidon2" }`, and the test checks the whole file. `poseidon2` is used only by TACEO's `encode`, which our circuits don't call; it is vendored because the library doesn't compile without it. `lib/keyed_nullifier/src/rational_map.nr` copies the private rational map and its helpers from `hash_to_curve.nr`, and the test checks the copy against the vendored lines. All three libraries are workspace members, so `nargo test` runs their own tests too, TACEO's `encode` known answers among them.

## Test

```sh
.github/scripts/install-toolchain.sh   # nargo and bb, from the repository root
export PATH="$HOME/.local/abolish-toolchain/bin:$PATH"
vp run --filter @abolishus/circuits test
```

`nargo test` covers completeness and soundness of the library: each constraint has a test where a witness breaking only it fails. `test/vectors.test.ts` turns every packing vector into a Noir test, plus a padding test per short bounded value, and runs them.

## Not yet

P3-4 part 2b-3b-2b-2b brings the proof checks a seat and an attester run (`query-proof`, `output-proof`), through `@aztec/bb.js` under the committed keys and `crs/`, with proving through `@noir-lang/noir_js`, and the keyed-nullifier evaluation taking only a checked query. The list and record packings come with the circuits that need them.
