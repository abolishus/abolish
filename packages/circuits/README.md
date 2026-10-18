# @abolishus/circuits

Abolish's Noir circuits, built with Noir 1.0.0-beta.22 for Barretenberg 5.0.0-nightly.20260522 (pins: `.github/scripts/install-toolchain.sh`). Internal and source-only.

**Status: libraries and Tier 2's first two circuits (P1-17c, P3-4).** Membership proofs use Semaphore v4's own circuit and Groth16 keys ([[0009-membership-proof]], P1-17b), not Noir. The query and output circuits of Tier 2's keyed nullifier ([[nullifier-query]], P3-4) are here, with their soundness tests, committed artifacts and verification keys, the reference string bb proves them under, proof round trips through bb, and `src/`: the proof checks a seat and an attester run (`query-proof`, `output-proof`), proving through noir_js and bb.js, and a seat's answer only to a query whose proof it checked.

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
src/                    # the proofs through bb.js (proofs.ts) and the query and output with them (nullifier.ts)
scripts/                # artifacts.ts writes artifacts/; crs.ts writes crs/
vendor/                 # third-party Noir code, unchanged: TACEO's gadgets, zkPassport's circuits and their libraries (Vendored dependencies)
test/                   # vite-plus tests: vectors through Noir, source rules, vendored trees, the disclosure circuits' ABIs
```

Each circuit gets its own Nargo package next to `lib/`, depending on the libraries by path, with its statement at the top of `src/main.nr` as [[nullifier-query]] states it and its soundness tests below.

## Rules

- **Packing** (`docs/spec/notation.md`, Circuit-facing values): `pack_bytes` and `pack_bounded_bytes` match `packBytes` and `packBoundedBytes` in `@abolishus/crypto`. Both run the vectors in `docs/spec/vectors/circuit.json`, which an independent Python script prints. `pack_bounded_bytes` constrains the length and zero padding, so each value has one packing (T-31).
- **Keyed-nullifier hashes** ([[keyed-nullifier-hashes]]): `lib/keyed_nullifier` computes the spec's Poseidon2 sponge (Noir's width-4 permutation), `H1` (two Elligator 2 maps through TACEO's gadgets, summed with the complete Edwards law, cofactor cleared) and `H2`, which refuses a `U` off the curve or outside the prime-order subgroup (finding A, T-03). TACEO's `encode` is never called (T-36). `test/keyed-nullifier-hashes.test.ts` runs every vector of `keyed-nullifier-hashes.json` through them, each map before the cofactor is cleared.
- **Query and output circuits** ([[nullifier-query]]): `nullifier_query` opens `comm_in` with the private-nullifier slot in zkPassport's clear-value form (`x ≠ 0`, `s_x ≠ 0`) and outputs `B`; `nullifier_output` takes `B` and `Z` public, multiplies `H1(σ, x)` and `U` by one set of `r`'s bits with `0 < r < l` (`blinding_bits`), refuses an identity `U` and leaves the subgroup check to `h2`, and outputs `N`. `ctx` and `q` enter no constraint: the proof binds them. Each `src/main.nr` has a test per constraint that breaks only it; `test/nullifier-circuits.test.ts` runs both on every vector of `nullifier-query.json`, checks each compiled ABI's public inputs against the spec's order, and compares `bb gates` with `gates.json` (T-03, T-21, T-30).
- **Tags** (`docs/spec/domain-separation.md`, In-circuit hashes): a tag enters a circuit only as the constant `tag_field(tag)`, which `circuitTagField` in `@abolishus/crypto` computes and `circuit.json` lists. A circuit never recomputes it (T-30).
- **Artifacts** (`vp run build`, which runs `scripts/artifacts.ts`): `artifacts/<circuit>.json` is nargo's compiled program without its debug symbols and file map, which carry the sources' absolute paths, and `artifacts/<circuit>.vk` is `bb write_vk` of it under `crs/` with bb's `noir-recursive` target (Poseidon2 transcript, zero knowledge). They are never edited by hand: `test/proofs.test.ts` rebuilds them into a scratch directory and fails on any difference, and `repro-build` compares two builds of them. [[nullifier-query]] (Keys and proofs) pins each key's sha256, which the release pins too (T-05, T-21).
- **Proofs** ([[nullifier-query]], Keys and proofs): `test/proofs.test.ts` proves both circuits on every vector of `nullifier-query.json` with bb under the committed key and `crs/`, and checks the public inputs bb outputs against the vector's, the pinned length (14,656 bytes), that each proof verifies under its own public inputs and fails with any one of them changed (`ctx` and `q`, which no constraint uses, among them), under the other circuit's key and under the other vector's inputs, that any one proof field changed fails (fast-check), and that two proofs of one witness differ, as only a zero-knowledge prover's do (T-03, T-13, T-21). A refusal must be bb's verifier rejecting, never bb stopping on a bad file, except under the other circuit's key, whose count of public inputs bb refuses first; each key's sha256 and the proof length are checked against the spec.
- **Proof checks and proving in code** (`src/`, [[nullifier-query]], Query check, Output check): `NullifierProofs` opens Barretenberg through `@aztec/bb.js` only as WebAssembly (never the native binary bb.js spawns by default in Node) with `skipSrsInit`, and loads the reference string the caller read, refused unless both files have their pinned sha256, as each verification key is; nothing is downloaded. `verify` refuses a proof of any length but 14,656 bytes or with an element at or above BN254's `r` before Barretenberg sees it, and treats an abort (a point off the curve) as a refusal, replacing the WebAssembly module, which an abort can leave leaking. `prove` executes the program with noir_js and proves under the pinned key, then verifies its own proof. `checkQuery` and `checkOutput` run `@abolishus/crypto`'s checks and then the proof with the public inputs those checks build from the checker's pins and records; `answerQuery` answers only a query object `checkQuery` returned, and `checkOutput` checks only against one. `proveQuery` draws `r` and `query_id` from the CSPRNG. `src/` uses no node built-ins, so it runs in a browser worker; the caller reads `crs/` and `artifacts/` (T-05, T-21, T-55).
  `test/nullifier-proofs.test.ts`: every pin refused when broken; the backend and the reference string held by the source and by bb.js's `CRS_PATH` staying empty; both queries proved from the vectors' statements to their `B` and records, both outputs to their `N`, and each output's proof accepted inside the vector's own output, whose answers the vectors' seats signed; each check refusing a changed field the proof binds (`commitment`, `query_id`, `comm_in`, `B`, `N`), another query's proof, a proof one byte short or long, any one proof element changed (fast-check), a non-canonical element and an aborting one; bb.js's proofs accepted by the pinned bb binary; an unchecked query refused by `answerQuery` and `checkOutput`.
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

Copied as plain files, unchanged, from the pinned commits, with their licences beside them; upstream's READMEs, tests outside `src/`, scripts and tooling are left out. `test/vendored.test.ts` recomputes the git object id of every vendored entry (what `git rev-parse <commit>:<path>` prints upstream) and fails on any file under `vendor/` that isn't pinned, so any edit shows up as a failed test and in the reviewed diff (T-55). `vp check` leaves `vendor/` unformatted (the root `.prettierignore`), so a fix run can't change it either. Refreshing one means copying a new upstream tree and updating its rows here and in the test, together with the spec's review of the diff ([[keyed-nullifier-hashes]], TACEO's gadgets; [[identity-chain]], Circuit set, for zkPassport's).

| Upstream                                     | Tag         | Commit                                     | Licence                                                     |
| -------------------------------------------- | ----------- | ------------------------------------------ | ----------------------------------------------------------- |
| `https://github.com/TaceoLabs/oprf-nr`       | `v1.0.0`    | `e4984d6ca15771200875745828e8f6c5ced70186` | MIT                                                         |
| `https://github.com/TaceoLabs/noir-poseidon` | `v0.6.1`    | `23cf1f05cbebb78538c8e321ab3da306e3529923` | MIT                                                         |
| `https://github.com/zkpassport/circuits`     | none        | `c7da41870d6223a15c38417424e01e48ab7a4cd9` | Apache-2.0                                                  |
| `https://github.com/noir-lang/poseidon`      | `v0.3.0`    | `0880c371e88e583d39515fd3f877538657ac41eb` | Apache-2.0                                                  |
| `https://github.com/noir-lang/sha256`        | `v0.3.0`    | `9442e5b6856f98b2ec029882d7e90199ecff91ba` | MIT, declared in its `package.json`; it has no licence file |
| `https://github.com/zac-williamson/sha1`     | `v0.11`     | `d510f33c8546488286946ed459b26b62f5a71f91` | Apache-2.0                                                  |
| `https://github.com/zkpassport/sha512`       | `v0.2.0`    | `e92ffb473f3264529a0793770f63a09946df50cc` | Apache-2.0                                                  |
| `https://github.com/madztheo/noir-date`      | `v0.5.6`    | `ca9029869819c567c7b533e4b13d9ed47f2b7db3` | MIT                                                         |
| `https://github.com/zkpassport/noir-bignum`  | `v0.10.0-2` | `a5fe5b5676e2b2589199160705a588ba779a1eb5` | Apache-2.0                                                  |
| `https://github.com/zkpassport/noir_rsa`     | `v0.12.0`   | `516db18a732d3426d9417444e5b6c0733d2b0d1c` | Apache-2.0                                                  |

| Path                                                                                      | Upstream path                                                       | Git object id                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `vendor/oprf-nr/LICENSE`                                                                  | `LICENSE`                                                           | `b82e0563feef75ccfd57f081fd2efb5f80b391d7` |
| `vendor/oprf-nr/babyjubjub/Nargo.toml`                                                    | `babyjubjub/Nargo.toml` (ours, below)                               | `6b8273fbf649348b6124bef0c0ecc2470fc2ac91` |
| `vendor/oprf-nr/babyjubjub/src`                                                           | `babyjubjub/src`                                                    | `4c27dd3b30880bd23c95dd88f0c794a8c9482366` |
| `vendor/noir-poseidon/LICENSE`                                                            | `LICENSE`                                                           | `3fe6670c1099f6fb152d1cde560c3495ee3f9555` |
| `vendor/noir-poseidon/poseidon2/Nargo.toml`                                               | `poseidon2/Nargo.toml`                                              | `7bf975d0e027da52afd3887ca1ddecef5092e8f4` |
| `vendor/noir-poseidon/poseidon2/src`                                                      | `poseidon2/src`                                                     | `f3a287154fe93da15680fca1398ad583fe782450` |
| `vendor/noir-poseidon/hash_utils/Nargo.toml`                                              | `hash_utils/Nargo.toml`                                             | `3e8398fa4ffff7a9e20c717791ca7607610dc58c` |
| `vendor/noir-poseidon/hash_utils/src`                                                     | `hash_utils/src`                                                    | `d8bc189c687d2d01419758e43a49576b2bae66ff` |
| `vendor/zkpassport-circuits/LICENSE`                                                      | `LICENSE`                                                           | `195d3262e75c1630565fd92cf332f8ec8ae55330` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/common/Nargo.toml`                    | `src/noir/lib/commitment/common/Nargo.toml` (ours, below)           | `bdb0a287e398aa175a32069d817bf2c2963bc8f7` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/common/src`                           | `src/noir/lib/commitment/common/src`                                | `682ede99bec8a168e487a2bebc7931666c6bf1db` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/csc-to-dsc/Nargo.toml`                | `src/noir/lib/commitment/csc-to-dsc/Nargo.toml`                     | `20460db2731deb904d734f03a6631081fe14ecc5` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/csc-to-dsc/src`                       | `src/noir/lib/commitment/csc-to-dsc/src`                            | `0f8729954e4da449f8715a545e2449f31bac212e` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/dsc-to-id/Nargo.toml`                 | `src/noir/lib/commitment/dsc-to-id/Nargo.toml`                      | `af6149d7623f4e86446aba2a9fbdc069e878ad33` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/dsc-to-id/src`                        | `src/noir/lib/commitment/dsc-to-id/src`                             | `c7747ca86979712fa1083e7e87d3f6462dff60ef` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/integrity-to-disclosure/Nargo.toml`   | `src/noir/lib/commitment/integrity-to-disclosure/Nargo.toml`        | `e67e03e45c908b32e639bc91c6b25b1bf22c3879` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/integrity-to-disclosure/src`          | `src/noir/lib/commitment/integrity-to-disclosure/src`               | `2e3c64169eb0ba613264c22ce34b33ad75fc776b` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/scoped-nullifier/Nargo.toml`          | `src/noir/lib/commitment/scoped-nullifier/Nargo.toml` (ours, below) | `2acaea8ebb79cf61d78fb671008ab63678b147e9` |
| `vendor/zkpassport-circuits/src/noir/lib/commitment/scoped-nullifier/src`                 | `src/noir/lib/commitment/scoped-nullifier/src`                      | `f5618d5989adaad0421ce49035110dd3e04e6453` |
| `vendor/zkpassport-circuits/src/noir/lib/compare/age/Nargo.toml`                          | `src/noir/lib/compare/age/Nargo.toml` (ours, below)                 | `ffafc8d224b95efd0531c04158e7febc9aa62a09` |
| `vendor/zkpassport-circuits/src/noir/lib/compare/age/src`                                 | `src/noir/lib/compare/age/src`                                      | `496cfd5344432a709580159e1f45085b3c40cb9f` |
| `vendor/zkpassport-circuits/src/noir/lib/data-check/expiry/Nargo.toml`                    | `src/noir/lib/data-check/expiry/Nargo.toml` (ours, below)           | `b87a4f87b519c5c78cec6b0a6c62a3c66fd9f7f4` |
| `vendor/zkpassport-circuits/src/noir/lib/data-check/expiry/src`                           | `src/noir/lib/data-check/expiry/src`                                | `715de49176da02ec75cd5599ab8e996c814644a7` |
| `vendor/zkpassport-circuits/src/noir/lib/data-check/integrity/Nargo.toml`                 | `src/noir/lib/data-check/integrity/Nargo.toml` (ours, below)        | `6e1e43678a8028fcf7a7364b7d8e2eed839b46da` |
| `vendor/zkpassport-circuits/src/noir/lib/data-check/integrity/src`                        | `src/noir/lib/data-check/integrity/src`                             | `be5202e189a6ccb56015b28ced0902a5e9759ae3` |
| `vendor/zkpassport-circuits/src/noir/lib/data-check/tbs-pubkey/Nargo.toml`                | `src/noir/lib/data-check/tbs-pubkey/Nargo.toml`                     | `91affca7d3a25310ba78d22d969429d5ea11e0a3` |
| `vendor/zkpassport-circuits/src/noir/lib/data-check/tbs-pubkey/src`                       | `src/noir/lib/data-check/tbs-pubkey/src`                            | `9e3637ac0e104ea50bebe0bee45be15029e57e50` |
| `vendor/zkpassport-circuits/src/noir/lib/inclusion-check/country/Nargo.toml`              | `src/noir/lib/inclusion-check/country/Nargo.toml` (ours, below)     | `85d4f21a69d22ebb5aec0962d44623dc6231b672` |
| `vendor/zkpassport-circuits/src/noir/lib/inclusion-check/country/src`                     | `src/noir/lib/inclusion-check/country/src`                          | `ef8897969247ab0f7e34981194ea608ca23df0e2` |
| `vendor/zkpassport-circuits/src/noir/lib/sig-check/common/Nargo.toml`                     | `src/noir/lib/sig-check/common/Nargo.toml` (ours, below)            | `59510839cbb06d941dbeb2d9715216246ba5aee9` |
| `vendor/zkpassport-circuits/src/noir/lib/sig-check/common/src`                            | `src/noir/lib/sig-check/common/src`                                 | `813fc5381165d25c459c63f6a4cf92c317e6ea59` |
| `vendor/zkpassport-circuits/src/noir/lib/sig-check/rsa/Nargo.toml`                        | `src/noir/lib/sig-check/rsa/Nargo.toml` (ours, below)               | `4f7c28bb8e503eec5942dde82b794e8260d4df69` |
| `vendor/zkpassport-circuits/src/noir/lib/sig-check/rsa/src`                               | `src/noir/lib/sig-check/rsa/src`                                    | `e501fa389366bcd6cd78d4b74d8fcc9c91c51f4b` |
| `vendor/zkpassport-circuits/src/noir/lib/utils/Nargo.toml`                                | `src/noir/lib/utils/Nargo.toml` (ours, below)                       | `a92c03e442c9eeef43cf4a6eac3c8fa333b8f90d` |
| `vendor/zkpassport-circuits/src/noir/lib/utils/src`                                       | `src/noir/lib/utils/src`                                            | `1a7e5fb3b842054705f6e8233aa98ac39c7ed694` |
| `vendor/zkpassport-circuits/src/noir/bin/compare/age/standard/Nargo.toml`                 | `src/noir/bin/compare/age/standard/Nargo.toml`                      | `460f82f7719ce6e36c5cc60d22f75b34556e9f4d` |
| `vendor/zkpassport-circuits/src/noir/bin/compare/age/standard/src`                        | `src/noir/bin/compare/age/standard/src`                             | `d9230e79130879a5483522de2b76ac29eb6451a0` |
| `vendor/zkpassport-circuits/src/noir/bin/inclusion-check/nationality/standard/Nargo.toml` | `src/noir/bin/inclusion-check/nationality/standard/Nargo.toml`      | `6f5f28ac9bf746204e3209e6d200655abde7a3d2` |
| `vendor/zkpassport-circuits/src/noir/bin/inclusion-check/nationality/standard/src`        | `src/noir/bin/inclusion-check/nationality/standard/src`             | `4d0138fddeb975d0c4d90d529e0992159e721d7d` |
| `vendor/poseidon/LICENSE`                                                                 | `LICENSE`                                                           | `c61b66391a3c1545c8c274bc6d7d764bafb84993` |
| `vendor/sha1/LICENSE`                                                                     | `LICENSE`                                                           | `c61b66391a3c1545c8c274bc6d7d764bafb84993` |
| `vendor/sha512/LICENSE`                                                                   | `LICENSE`                                                           | `c61b66391a3c1545c8c274bc6d7d764bafb84993` |
| `vendor/noir-date/LICENSE`                                                                | `LICENSE`                                                           | `3285316f6b59c81ed0df57f80576fdb779494e15` |
| `vendor/noir-bignum/LICENSE`                                                              | `LICENSE`                                                           | `c61b66391a3c1545c8c274bc6d7d764bafb84993` |
| `vendor/noir_rsa/LICENSE`                                                                 | `LICENSE`                                                           | `c61b66391a3c1545c8c274bc6d7d764bafb84993` |
| `vendor/poseidon/Nargo.toml`                                                              | `Nargo.toml`                                                        | `bc2f9b292b57961e839865cb4d45233be62c0984` |
| `vendor/poseidon/src`                                                                     | `src`                                                               | `8a265c8dc3e93e91a8ebbfb74ade8437ff649e25` |
| `vendor/sha256/Nargo.toml`                                                                | `Nargo.toml`                                                        | `7afdf910a143104ecdfb37ede2b099af51aa541f` |
| `vendor/sha256/src`                                                                       | `src`                                                               | `a29ada5689f6e213a587c2995ca67d51bdc6218d` |
| `vendor/sha1/Nargo.toml`                                                                  | `Nargo.toml`                                                        | `c2aa756f000d98971849d5ff708b2c3bfa2efbe4` |
| `vendor/sha1/src`                                                                         | `src`                                                               | `d9ead839874603c843e7d6865672a56b60dd5a57` |
| `vendor/sha512/Nargo.toml`                                                                | `Nargo.toml`                                                        | `b38232d29febe9ecc379f76a12460cbfc07dda63` |
| `vendor/sha512/src`                                                                       | `src`                                                               | `41fb8f81389367d4e376b28b08c37e73b694d2cf` |
| `vendor/noir-date/Nargo.toml`                                                             | `Nargo.toml`                                                        | `5d0990651236dc63c21671f7712ac27e8a46c375` |
| `vendor/noir-date/src`                                                                    | `src`                                                               | `1042c7eaa545d70d9a10e724d2b151367c5d3afb` |
| `vendor/noir-bignum/Nargo.toml`                                                           | `Nargo.toml` (ours, below)                                          | `e381b8351892fb82428c9b4a09fa09b34b7cd6b5` |
| `vendor/noir-bignum/src`                                                                  | `src`                                                               | `4a6958dcd47a1e96f7aac96536b7fc33c7779964` |
| `vendor/noir_rsa/Nargo.toml`                                                              | `Nargo.toml` (ours, below)                                          | `105a48d7e821b0a81f3c34c60ceb889280e25714` |
| `vendor/noir_rsa/src`                                                                     | `src`                                                               | `2794e852766c0c5fe024e5a4dabcd39bd923d198` |
| `vendor/oprf-nr/oprf/Nargo.toml`                                                          | `oprf/Nargo.toml` (ours, below)                                     | `aba6597741a8e4a24340742028ff247ae1cb1d74` |
| `vendor/oprf-nr/oprf/src`                                                                 | `oprf/src`                                                          | `f0cbcffe6ef95ca7a2c4df03aeee984019957e88` |

**Ours, in place of upstream's.** A Nargo.toml marked "ours" replaces each git dependency line (`name = { tag = …, git = … }`) with `name = { path = … }` to the vendored copy of that repository and tag, and changes nothing else: the test puts upstream's lines back and checks the result against upstream's object id, and checks that each path names the copy the line it replaced named. The two zkPassport binaries' `Prover.toml` files are nargo's, which it writes at a binary's first check, committed so a check leaves the tree clean; the test checks that they hold no values.

**What's here, and why.** zkPassport's libraries are those the five sub-proofs of [[identity-chain]] reach through RSA signatures, with the `age` and `nationality` binaries (`compare/age/standard`, `inclusion-check/nationality/standard`), which that page fixes; the `dsc`, `id` and `integrity` binaries are one per algorithm and size and come with the circuit list a later part pins. The ECDSA side isn't vendored: `sig-check/ecdsa` reaches `zkpassport/noir_bigcurve` (through `noir-ecdsa`), which, like `noir-lang/noir_bigcurve` it forks, has no licence in any commit, so it can't be copied here (STATUS.md, Blocked). `poseidon2` is used only by TACEO's `encode`, which our circuits don't call; it is vendored because babyjubjub doesn't compile without it. `lib/keyed_nullifier/src/rational_map.nr` copies the private rational map and its helpers from `hash_to_curve.nr`, and `test/keyed-nullifier-hashes.test.ts` checks the copy against the vendored lines.

**Workspace members.** TACEO's libraries and zkPassport's libraries and binaries are workspace members, so `nargo check` compiles them and `nargo test` runs their own tests (TACEO's `encode` known answers and zkPassport's commitment, date, integrity and country tests among them). The other libraries are compiled only through zkPassport's: their own suites need an oracle server (`poseidon`, `sha256`, `sha512`) or minutes of CI (`noir-bignum`'s 330 tests), and `nargo fmt --check` would hold them to our formatter. No build or test fetches anything: every dependency is a path inside this package.

## Test

```sh
.github/scripts/install-toolchain.sh   # nargo and bb, from the repository root
export PATH="$HOME/.local/abolish-toolchain/bin:$PATH"
vp run --filter @abolishus/circuits test
```

`nargo test` covers completeness and soundness of the library: each constraint has a test where a witness breaking only it fails. `test/vectors.test.ts` turns every packing vector into a Noir test, plus a padding test per short bounded value, and runs them.

## Not yet

The identity chain's `dsc`, `id` and `integrity` binaries, every key of its circuit list and its proof checks (zkPassport's libraries and disclosure circuits are vendored, Vendored dependencies), the transport of the chain and of the output, and the attestation are P3-4 part 2b-4; the trustee node's seat calls `checkQuery` and `answerQuery` with P2-13. The list and record packings come with the circuits that need them.
