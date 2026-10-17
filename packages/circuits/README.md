# @abolishus/circuits

Abolish's Noir circuits, built with Noir 1.0.0-beta.22 for Barretenberg 5.0.0-nightly.20260522 (pins: `.github/scripts/install-toolchain.sh`). Internal and source-only.

**Status: libraries (P1-17c, P3-4).** There is no circuit yet. Membership proofs use Semaphore v4's own circuit and Groth16 keys ([[0009-membership-proof]], P1-17b), not Noir. This package holds what the first custom circuits, Tier 2's query and output circuits ([[keyed-nullifier]], P3-4), build on.

## Layout

```
Nargo.toml              # workspace
lib/abolish/            # shared library: byte packing (src/pack.nr)
lib/keyed_nullifier/    # the keyed nullifier's hashes: the sponge, H1 and H2
vendor/                 # third-party Noir libraries, unchanged (Vendored dependencies)
test/                   # vite-plus tests: vectors through Noir, source rules, vendored trees
```

Each circuit gets its own Nargo package next to `lib/`, depending on `abolish` by path.

## Rules

- **Packing** (`docs/spec/notation.md`, Circuit-facing values): `pack_bytes` and `pack_bounded_bytes` match `packBytes` and `packBoundedBytes` in `@abolishus/crypto`. Both run the vectors in `docs/spec/vectors/circuit.json`, which an independent Python script prints. `pack_bounded_bytes` constrains the length and zero padding, so each value has one packing (T-31).
- **Keyed-nullifier hashes** ([[keyed-nullifier-hashes]]): `lib/keyed_nullifier` computes the spec's Poseidon2 sponge (Noir's width-4 permutation), `H1` (two Elligator 2 maps through TACEO's gadgets, summed with the complete Edwards law, cofactor cleared) and `H2`, which refuses a `U` off the curve or outside the prime-order subgroup (finding A, T-03). TACEO's `encode` is never called (T-36). `test/keyed-nullifier-hashes.test.ts` runs every vector of `keyed-nullifier-hashes.json` through them, each map before the cofactor is cleared.
- **Tags** (`docs/spec/domain-separation.md`, In-circuit hashes): a tag enters a circuit only as the constant `tag_field(tag)`, which `circuitTagField` in `@abolishus/crypto` computes and `circuit.json` lists. A circuit never recomputes it (T-30).
- **Zero knowledge only.** `test/source-rules.test.ts` fails if any file here asks bb for a proof without zero knowledge (T-13, T-15).
- **Path dependencies only.** The same test fails on a dependency that isn't a path inside this package (T-55). A vendored dependency records its upstream repository, tag, commit and tree hash here.

## Vendored dependencies

Copied as plain files, unchanged, from the pinned commits, with their MIT licences beside them. `test/keyed-nullifier-hashes.test.ts` recomputes each tree's git object id (what `git rev-parse <commit>:<path>` prints upstream), so any edit shows up as a failed test and in the reviewed diff (T-55). Refreshing one means copying a new upstream tree and updating its row here and in the test, together with the spec's review of the diff ([[keyed-nullifier-hashes]], TACEO's gadgets).

| Path                              | Upstream                                     | Tag      | Commit                                     | Tree pinned                                                  |
| --------------------------------- | -------------------------------------------- | -------- | ------------------------------------------ | ------------------------------------------------------------ |
| `vendor/oprf-nr/babyjubjub`       | `https://github.com/TaceoLabs/oprf-nr`       | `v1.0.0` | `e4984d6ca15771200875745828e8f6c5ced70186` | `babyjubjub/src`: `4c27dd3b30880bd23c95dd88f0c794a8c9482366` |
| `vendor/noir-poseidon/poseidon2`  | `https://github.com/TaceoLabs/noir-poseidon` | `v0.6.1` | `23cf1f05cbebb78538c8e321ab3da306e3529923` | `poseidon2`: `5c72d2098b1b0daefc7eea327302f46774a5eba6`      |
| `vendor/noir-poseidon/hash_utils` | `https://github.com/TaceoLabs/noir-poseidon` | `v0.6.1` | `23cf1f05cbebb78538c8e321ab3da306e3529923` | `hash_utils`: `e85d957d3cae9acd652cf09ae676d7dbf9d848b2`     |

One file differs from upstream: `vendor/oprf-nr/babyjubjub/Nargo.toml` takes `poseidon2` by path (`../../noir-poseidon/poseidon2`) instead of upstream's `{ tag = "v0.6.1", git = "https://github.com/TaceoLabs/noir-poseidon", directory = "poseidon2" }`, so only its `src` tree is pinned, and the test checks the whole file. `poseidon2` is used only by TACEO's `encode`, which our circuits don't call; it is vendored because the library doesn't compile without it. `lib/keyed_nullifier/src/rational_map.nr` copies the private rational map and its helpers from `hash_to_curve.nr`, and the test checks the copy against the vendored lines. All three libraries are workspace members, so `nargo test` runs their own tests too, TACEO's `encode` known answers among them.

## Test

```sh
.github/scripts/install-toolchain.sh   # nargo and bb, from the repository root
export PATH="$HOME/.local/abolish-toolchain/bin:$PATH"
vp run --filter @abolishus/circuits test
```

`nargo test` covers completeness and soundness of the library: each constraint has a test where a witness breaking only it fails. `test/vectors.test.ts` turns every packing vector into a Noir test, plus a padding test per short bounded value, and runs them.

## Not yet

The first circuit brings committed artifacts (ACIR and verification keys, rebuilt and compared by CI), the test that each key and verifier is bb's zero-knowledge flavour, a JS round trip through `@noir-lang/noir_js` and `@aztec/bb.js`, gate-count snapshots, and the list and record packings.
