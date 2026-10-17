# ADR 0009: Membership and nullifier proof

- Status: Accepted (agent, 2026-10-11): option B; reading confirmed by the owner (2026-10-12)
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-04, T-05, T-07, T-12, T-13, T-15, T-38 (see [[THREAT_MODEL]])

## Context

Every ballot proves, in zero knowledge, that its voter is a member of one tier's group at the root fixed in the election definition, and carries a per-poll nullifier (brief, Identity; [[verifier]] 5.1–5.3). The brief fixes Semaphore groups for eligibility, Noir for custom circuits, and Semaphore's existing ceremony as the one accepted per-circuit trusted setup. [[0002-everlasting-privacy]] (accepted by the owner) adds a hard requirement: membership proofs must be **statistically or perfectly zero-knowledge**, because a computationally hiding proof would let a future adversary (A-11) extract the voter's secret and link every ballot. It asks P1-17 to show that for bb's zero-knowledge UltraHonk, or to fall back to Semaphore's Groth16 circuit.

What is one-way: every ballot on the permanent board carries a proof under the chosen system and a nullifier under the chosen derivation. Changing either later needs a new protocol version and a second verifier path, and a voter's nullifier must never have two valid derivations within one poll, or one identity could vote twice (`circuits` skill, Rules).

Three things have to be decided together:

1. The proof system and circuit.
2. The nullifier scope: what it binds, and whether it is per poll or per tier group.
3. How the ballot's tier is fixed by the proof's public inputs, so no relay or operator can move a ballot between tally cells ([[verifier]] 2.8).

## Options

### A. Our own Noir circuit with the Semaphore v4 statement, proven with bb's zero-knowledge UltraHonk

Reimplement Semaphore v4's statement in Noir (Baby Jubjub public key from the secret, Poseidon identity commitment, LeanIMT membership, `Poseidon(scope, secret)` nullifier), over the same on-chain groups, with vendored Noir Poseidon and Baby Jubjub libraries.

- **Pros:** no per-circuit trusted setup (bb's universal SRS only); one proving stack (Noir and bb) for this and the Tier 2 circuits; proofs aren't malleable.
- **Cons:**
  - **The zero-knowledge requirement can't be met today.** bb documents a zero-knowledge flavour (masked witness polynomials, a Libra-style zero-knowledge sumcheck, masked opening protocol), but we know of no published proof or audit that its zero knowledge holds statistically against an unbounded adversary. KZG commitments aren't hiding by themselves: an unbounded adversary who solves the discrete log of the SRS learns each committed polynomial's value at the trapdoor point. A statistical argument has to show that every commitment and evaluation the proof reveals is covered by independent masking randomness, for bb's exact implementation and version. That is a research result we can't produce, or get reviewed, inside this item, and ADR 0002 makes it a precondition.
  - A second implementation of Semaphore's statement, with its own soundness risk (T-05), where Semaphore's circom circuit is already published and used in production.
  - Vendoring two Noir libraries needs a new CI provenance check (`.github/`, owner review), as `circuits` requires for every Noir dependency.

### B. Semaphore v4's own circuit and Groth16 proofs (the fallback ADR 0002 names)

Use Semaphore v4's circom circuit unchanged, with the Groth16 proving and verification keys from Semaphore's multi-party trusted setup, one key pair per tree depth 1–32, of which Abolish uses only depth 32 (below). The statement is Semaphore's, cited by tag and commit in [[membership]].

- **Pros:**
  - **Perfect zero knowledge.** Groth16 is perfectly zero-knowledge for a well-formed reference string (Groth, EUROCRYPT 2016, Theorem 1), and remains so against a subverted ceremony if the prover checks the reference string's well-formedness first (Fuchsbauer, PKC 2018). This meets ADR 0002 without a research result.
  - The circuit is Semaphore's own, published, in production use and maintained upstream: we write no constraint code (T-05).
  - The brief already accepts Semaphore's ceremony as the one exception to "no per-circuit trusted setup" (T-07).
  - Stock tooling verifies the same proofs: Semaphore's JavaScript library and contracts, and any Groth16 verifier over BN254. A third-party verifier needs nothing of ours to check a membership proof (T-36).
- **Cons:**
  - Soundness rests on Semaphore's ceremony (one honest participant suffices) in addition to the circuit (T-07).
  - Groth16 proofs are malleable: anyone can re-randomise a proof without the witness. [[verifier]] 5.7 and 6.1 R1 already require replay detection by nullifier and signal, never by proof bytes (T-38).
  - The prover is snarkjs (or another Groth16 prover) with the depth-32 proving key, tens of megabytes. That is third-party runtime code in the ballot client, which P2-8 and P5-4 must handle; option A has the same issue with noir_js and bb.js.
  - Both A and B run over BN254, whose security has fallen to roughly 100–110 bits ([[0007-group-and-hash]]). That bounds the soundness of membership proofs (forging eligibility), not their privacy: zero knowledge doesn't rest on it.

### C. Our own Noir circuit with a modified statement

As A, but with our own nullifier derivation (for example a domain tag inside the in-circuit hash) or tier binding inside the circuit.

- **Pros:** domain separation inside the circuit.
- **Cons:** all of A's, plus a statement that the Groth16 fallback can't prove, so the two systems would derive different nullifiers for the same voter and poll, which the `circuits` skill forbids. Domain separation and tier binding can be had without changing the circuit (below).

## Recommendation

**B: Semaphore v4's circuit and Groth16 proofs, unchanged, with Abolish's domain separation and tier binding carried by the scope.**

- **Proof system.** B is the only option that meets ADR 0002's zero-knowledge requirement today, writes no constraint code of our own, and stays inside the brief's one accepted trusted setup.
- **Scope.** Semaphore's nullifier is `Poseidon(scope, secret)`. Abolish derives the scope, outside the circuit, as a tagged SHA-256 hash of the election-definition hash, the tier and the tier group's root: `S = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(tier) ‖ root))`. Semaphore's own `hash` (keccak-256, shifted right 8 bits) then maps `S` into the field, exactly as Semaphore's libraries and contracts do. So:
  - the domain tag is applied to the scope, which has the same effect as tagging the nullifier: no other Abolish hash, and no other Semaphore application that doesn't deliberately reuse our public scope, produces it (T-12). Deliberate reuse by an application holding the voter's identity would reveal the nullifier, and no tag, in or out of the circuit, stops that: the identity secret is used for Abolish proofs only ([[membership]], Security notes);
  - the definition hash binds the poll, the chain ID and the contract addresses (P1-10b), so a redeploy or a second chain never reuses a scope (T-12, T-30);
  - **one scope per tier group.** A person whose one secret is in two tier groups gets two unrelated nullifiers, even when the two groups have the same root (nothing requires roots to differ: identical rosters give equal roots), so their ballots in two tiers can't be linked through the nullifier (T-13), and G-2's "at most one counted ballot per person per poll per tier" holds for each tier;
  - the tier is fixed by the proof's public inputs through the scope, which binds it explicitly, so a relay can't move a proof to another tier without invalidating it, whatever the two tiers' roots ([[verifier]] 2.8).
- **Tier tree and depth.** Each tier's root is the root of a complete depth-32 `Poseidon2` tree over the group's additions in order, with 0 for empty and removed leaves, and every proof uses Semaphore's depth-32 key with a full 32-level path ([[membership]], Tier tree). Semaphore's circuit hashes leaves and inner nodes alike and doesn't constrain the path length, so over its own LeanIMT one registered value can be the root of a private tree of identities, each with its own nullifier; in the full tree a path of 32 must end at a leaf, so each registration carries at most one identity. A per-tier depth would also be an input the prover can't check cheaply, so a server would supply it, and a wrong one served to one voter would make their ballot fail everywhere and be the only one under its key: suppressed and identifiable (T-10, T-13). The fixed depth costs the largest proving key and 32 levels of hashing per proof; P2-8 and P5-4 measure it, and a later ballot version may change it only together with the tree, never take a depth from a server.
- **Message.** The proof's message is a 32-byte digest whose content P1-12 and P1-13 define (at least the ballot hash, the election definition, the tier and whatever the re-vote rule ranks by, [[verifier]] 5.3), mapped into the field by the same Semaphore `hash`.

What would change it: a published, reviewed proof that bb's zero-knowledge UltraHonk is statistically zero-knowledge (A then becomes possible as a new protocol version, keeping B's nullifier derivation); a break of Semaphore's ceremony; or a Semaphore release that changes the v4 statement (we stay on v4 until an ADR moves).

## Consequences

- [[membership]] specifies the statement, the public inputs, the scope and message mappings, the fixed tree depth, and what the verifier checks. `abolish/v1/nullifier-scope` becomes a specified plain-hash tag, and [[domain-separation]] records that no Abolish tag enters a circuit in version 1.
- `packages/crypto` computes the scope and the Semaphore field mapping, with cross-language vectors from an independent implementation (this item, P1-17).
- **P1-17b** (new): vendor Semaphore v4's verification keys with their provenance (tag, commit, sha256, re-fetched in CI, which needs a `ci:` PR to allow the publisher); check the pinned proving keys' reference strings for well-formedness once, publicly; implement Groth16 verification over BN254 in the gated packages; and test it against real Semaphore proofs vendored as vectors, plus tampered ones.
- **Why Groth16 verification is composition, not a new proof system.** The `crypto-review` rules forbid implementing a pairing or a proof system. P1-17b implements neither: the pairing, the curve groups and their subgroup checks come from `@noble/curves`' audited BN254 module, and the code evaluates the published Groth16 verification equation (Groth 2016, §3.2) over them, as verifying a Schnorr or Chaum–Pedersen proof does over ristretto255. It MUST: decode every proof point strictly (canonical coordinates below the field modulus, on the curve, and in the prime-order subgroup, including G2 membership); require every public input below `r`; require the key's `IC` to have exactly 5 points (4 public inputs); and use only the pinned keys. Any deviation is a blocking review finding.
- **Prover side (P2-8, P5-4):** the ballot client uses exactly the proving key P1-17b checked and pinned (Fuchsbauer, PKC 2018: that check is what keeps zero knowledge perfect against a subverted ceremony), pins the prover by hash, draws the Groth16 randomisers from a CSPRNG, and uses the identity secret for Abolish proofs only.
- **Root 0.** Semaphore's circuit doesn't constrain the proof length, so a root of 0 is provable by anyone with any secret; a verifier fails any tier whose root is 0. A tier tree's root is never 0, so this rejects only forgeries ([[membership]], Statement).
- **Groups.** The roots in election definitions are tier-tree roots, which verifiers rebuild from the board's additions. A group contract may keep a LeanIMT for its own use (P1-18, P3-2), but its root is never an electorate root, and a stock Semaphore verifier contract that accepts any depth must never be used to admit ballots.
- **`packages/circuits`:** no Noir circuit is needed for membership. The Noir workspace scaffold (toolchain, `nargo test`, artifacts, the zero-knowledge-flavour test), the in-circuit tag-to-field rule and the record packing rules move to a new item, P1-17c, ready for the first custom circuit (such as Tier 2 predicates, if [[P3-1]] needs one).
- **Residuals.** Membership soundness rests on Semaphore's ceremony and on BN254 (T-05, T-07). Groth16 malleability is handled by replay rules, not proof bytes (T-38). Participation privacy stays computational, as ADR 0002 says: an unbounded adversary can invert Poseidon on the identity commitments (T-15).
- Threat files T-04, T-05, T-07, T-12 and T-13 are updated to name this decision.

## Decision

Under rule A (`AGENTS.md`): **option B**, with status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].

On 2026-10-12 the owner confirmed the reading this ADR depends on: verifying Semaphore's Groth16 proofs with the BN254 pairing from the audited `@noble/curves` composes a published protocol; it is not implementing a proof system. The `crypto-review` skill now says so. P1-17b may start.

## Amendment (2026-10-17, P2-21 part 1): the prover

Status: Accepted (agent) — owner may veto, listed under Decisions to review in [[STATUS]]. The ballot client needs a Groth16 prover for the key and circuit above. Any correct prover makes proofs in the same encoding that every verifier already checks, so this choice is reversible by a client release; it isn't a protocol version. It does decide what third-party code runs beside the voter's identity secret, and so what the owner is asked to admit into the client.

### Measurements

`packages/crypto/scripts/membership-prover-bench.mjs`, run outside the workspace on 2026-10-17, over the pinned `semaphore-32.zkey` (5,850,470 bytes; 9,418 wires, 4 public, domain 2¹⁴) and `semaphore-32.wasm` (1,859,813 bytes; sha256 `528333d1247f585d33c5a40f46053fb7f8b1f5b8b8fa29118abfc47a60921dc5`, the witness calculator Semaphore 4.14.3 downloads beside the key). The host is a 4-vCPU cloud x86-64 machine, Node 24.22 and Playwright's Chromium; each proof was checked by snarkjs's verifier.

| Prover, where                                                         | One proof (median)    |
| --------------------------------------------------------------------- | --------------------- |
| snarkjs 0.7.5, single thread, Node                                    | 3.7 s                 |
| snarkjs 0.7.5, four threads, Node                                     | 1.15 s                |
| snarkjs 0.7.5, single thread, Chromium, no throttling                 | 3.7 s                 |
| the same, Chromium CPU throttling 4× (Lighthouse's mid-tier phone)    | 16.2 s                |
| the same, throttling 6×                                               | 24.1 s                |
| a Groth16 prover over `@noble/curves`' BN254: its MSMs and FFTs alone | 20.6 s (≈ 80 s at 4×) |
| re-randomising a proof over `@noble/curves` (below)                   | 34 ms                 |

Node's resident memory peaked at about 500 MiB with both modes run in one process (277 MiB single-threaded alone); Chromium's JavaScript heap stayed near 65–115 MiB, with WebAssembly memory on top. The throttled rows stand in for a phone: DevTools' throttling doesn't reach dedicated workers, so the bench proves on the main thread, the same code the client's worker would run. **No real phone was measured**: a session has none, and the item's measurement on a mid-range phone stays open (Known-weak below).

Two facts the prototype established beyond timing:

- snarkjs's multi-threaded mode starts its own workers from `blob:` URLs, which the client's CSP (`worker-src 'self'`, Trusted Types with only `ballot-worker`) refuses, and every snarkjs entry point except `fullProve`/`prove` with `{ singleThread: true }` builds the threaded curve. The client therefore proves single-threaded and never calls snarkjs's verifier or key export (it verifies with `packages/crypto`, below). Under a policy of `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'` and Trusted Types with no policy, single-threaded proving raised no violation.
- snarkjs's randomisers `r`, `s` come from `Fr.random()` of ffjavascript's WebAssembly field, which reads a ChaCha stream that ffjavascript implements itself, seeded once per thread with 32 bytes of `crypto.getRandomValues`, and seeded from `Math.random` if `crypto` is absent. That is not a randomness source this repository would choose, and the proof's zero knowledge rests on it.

### Options

- **A. snarkjs 0.7.5 (with ffjavascript 0.3.1), single-threaded** (chosen). The prover that made `membership-proof.json`'s proofs. The client ships upstream's prebuilt browser bundles, `snarkjs/build/browser.esm.js` and `ffjavascript/build/browser.esm.js` (they inline circom_runtime 0.1.28, fastfile 0.0.20, `@iden3/binfileutils` 0.0.12, wasmcurves 0.2.2, wasmbuilder 0.0.16 and web-worker 1.2.0), about 313 KB minified in a prover-only bundle. GPL-3.0 (circom_runtime and web-worker Apache-2.0); GPL-3.0 §13 lets it be combined with the client's AGPL-3.0-only code, a reading the owner confirms (Owner asks). Needs `'wasm-unsafe-eval'`: both the curve code and the witness calculator are WebAssembly. Upstream's bundles aren't rebuilt from source by us; reviewers read the bundled files the client ships.
- **B. A Groth16 prover of our own over `@noble/curves`' BN254, with the witness computed in TypeScript.** No new third-party runtime code and no WebAssembly, but at least 5.5× slower on the same machine before its witness computation (about 80 s for the MSMs and FFTs alone at 4× throttling), and two new pieces the gate would have to review line by line: a prover (QAP evaluation and H, which the owner's 2026-10-12 reading covers for verification, not proving) and a witness generator that assigns every one of the circuit's 9,418 wires in circom's exact order, including the hint wires (bit decompositions, inverses) that no constraint determines. A wrong wire is a proof that fails, caught by self-verification, but the generator is a second implementation of Semaphore's circuit (T-05, T-39). Rejected on both counts: the time fails the "phone-sized" rule and the code is the kind the `crypto-review` rules keep out.
- **C. A native prover (rapidsnark, or arkworks through a WebAssembly build).** Faster, but rapidsnark has no browser build and an arkworks build is a Rust toolchain and a WebAssembly blob we would build and pin ourselves. Left to [[P5-4]]'s native app, where a native prover fits.

### Decision

**A, with the prover untrusted for zero knowledge.** The client never relies on snarkjs's randomness or on its correctness:

1. **Self-verification** ([[membership]], Security notes): `packages/crypto` verifies snarkjs's output under the pinned key, so a non-satisfying witness or another basis convention, which would leave a witness-dependent term in `C`, never leaves the device.
2. **Re-randomisation in `packages/crypto`.** It then draws `t, u` uniform in `[1, r)` from `crypto.getRandomValues` and outputs `A' = t⁻¹·A`, `B' = t·B + t·u·δ₂`, `C' = C + u·A`, and verifies `A' ‖ B' ‖ C'` again. With `A ≠ 0`, `A'` is uniform over G1's non-identity points, `B'` uniform over G2 given `A'`, and `C'` the one point the verification equation leaves, which is an honest prover's distribution with fresh randomisers (up to the 1/r chance that an honest `A` is the identity). So the proof that leaves the device is perfectly zero-knowledge (for the checked key) whatever `r` and `s` snarkjs drew, even zero, and its randomness is `@noble/*` code over the platform CSPRNG, inside the gate. This is Groth16's published malleability ([[membership]], Security notes, Malleability; T-38) used on purpose; the vectors' `rerandomised` case already exercises its verifier side. It costs 34 ms.
3. **Pinned by hash.** The zkey and the witness calculator are checked by sha256 before use (the zkey's is `MEMBERSHIP_ZKEY_SHA256`); snarkjs and ffjavascript are exact catalog pins with the lockfile's integrity, and the bundled worker is part of the hash-addressed, reproducible client release, whose record names the prover by those versions and hashes.

What snarkjs is still trusted for: computing a witness and proof from the secret without leaking it. It runs in the client's Web Worker, which holds the secret anyway, with no network beyond `connect-src`; a hijacked release of it is the dependency risk the exact pins, the 7-day release age and review of the bundled files address (T-55), not a protocol one.

**Where the code lives.** `packages/crypto` stays `@noble/*`-only: it gets the inputs (the path rebuilt from the tier's leaves and checked against the definition's root, the scope and message fields, the forbidden-commitment and depth checks), the key-hash check, self-verification and re-randomisation, all testable in Node. The snarkjs call is a thin adapter in a new gated package, `packages/membership-prover`, whose only runtime dependencies are `@abolishus/crypto`, snarkjs and ffjavascript, and which `packages/verifier` never imports. Making it a gated package with that rule is a `ci:` change ([[P2-21]], owner asks).

**Owner asks** (each a `ci:` change under rule B; P2-21 builds everything else meanwhile):

- `.github/tools/ci/src/gated.ts` and `affected.ts`: `membership-prover` as a gated package whose runtime dependencies are exactly `@abolishus/crypto`, `snarkjs` and `ffjavascript` (catalog pins), and the `crypto-review` workflow's paths to match.
- The ballot client's bundle allow-list (`apps/ballot/tests/bundle.test.ts`, mirrored in `.github/tools/ci/src/ballot.ts`): code from those two packages' browser builds, in the worker's chunk only.
- The client's CSP: `'wasm-unsafe-eval'` in `script-src` (it allows compiling WebAssembly, never JavaScript `eval`), and `'self'` in `connect-src` for the key and witness calculator, which the client serves from its own release, beside the origins [[P2-8]] part 2b asks for.
- Licensing (owner-only, a legal matter): shipping GPL-3.0 code in the AGPL-3.0-only ballot client, combined under GPL-3.0 §13 as we read it, with the licences in the release's `third-party-licenses.md`.
- The key's source: vendor `semaphore-32.zkey` and `semaphore-32.wasm` (7.7 MB) in `packages/membership-prover`, recorded in its manifest with their URLs under `snark-artifacts.pse.dev/semaphore/4.13.0/` and sha256s, and add that host as a vectors publisher so CI re-fetches both and compares, as it does for Semaphore's verification keys. The ballot build copies them into `dist/`, so the key is part of the release hash, and the client re-checks the sha256 on every use.

### Known-weak

- No real phone measured; the 4× and 6× rows are throttled Chromium on a cloud host. If a mid-range phone takes much longer than about 20 s, the remedies are the owner's (a smaller protocol depth in a new ballot version), never a depth the client chooses.
- snarkjs's prebuilt bundles are trusted as published; we don't rebuild them. The witness calculator isn't rebuilt from `semaphore.circom` either (part 2 of [[P1-17b]] rebuilt only the R1CS).
- The single-threaded prover is about 3× slower than snarkjs's threaded mode; threading through workers the client itself starts, from `'self'`, is possible later without changing anything above.
