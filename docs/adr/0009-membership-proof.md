# ADR 0009: Membership and nullifier proof

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option B
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

Use Semaphore v4's circom circuit unchanged, with the Groth16 proving and verification keys from Semaphore's multi-party trusted setup, one key pair per tree depth 1–32. The statement is Semaphore's, cited by tag and commit in [[membership]].

- **Pros:**
  - **Perfect zero knowledge.** Groth16 is perfectly zero-knowledge for a well-formed reference string (Groth, EUROCRYPT 2016, Theorem 1), and remains so against a subverted ceremony if the prover checks the reference string's well-formedness first (Fuchsbauer, PKC 2018). This meets ADR 0002 without a research result.
  - The circuit is Semaphore's own, published, in production use and maintained upstream: we write no constraint code (T-05).
  - The brief already accepts Semaphore's ceremony as the one exception to "no per-circuit trusted setup" (T-07).
  - Stock tooling verifies the same proofs: Semaphore's JavaScript library and contracts, and any Groth16 verifier over BN254. A third-party verifier needs nothing of ours to check a membership proof (T-36).
- **Cons:**
  - Soundness rests on Semaphore's ceremony (one honest participant suffices) in addition to the circuit (T-07).
  - Groth16 proofs are malleable: anyone can re-randomise a proof without the witness. [[verifier]] 5.7 and 6.1 R1 already require replay detection by nullifier and signal, never by proof bytes (T-38).
  - The prover is snarkjs (or another Groth16 prover) with a per-depth proving key of up to tens of megabytes. That is third-party runtime code in the ballot client, which P2-8 and P5-4 must handle; option A has the same issue with noir_js and bb.js.
  - Both A and B run over BN254, whose security has fallen to roughly 100–110 bits ([[0007-group-and-hash]]). That bounds the soundness of membership proofs (forging eligibility), not their privacy: zero knowledge doesn't rest on it.

### C. Our own Noir circuit with a modified statement

As A, but with our own nullifier derivation (for example a domain tag inside the in-circuit hash) or tier binding inside the circuit.

- **Pros:** domain separation inside the circuit.
- **Cons:** all of A's, plus a statement that the Groth16 fallback can't prove, so the two systems would derive different nullifiers for the same voter and poll, which the `circuits` skill forbids. Domain separation and tier binding can be had without changing the circuit (below).

## Recommendation

**B: Semaphore v4's circuit and Groth16 proofs, unchanged, with Abolish's domain separation and tier binding carried by the scope.**

- **Proof system.** B is the only option that meets ADR 0002's zero-knowledge requirement today, writes no constraint code of our own, and stays inside the brief's one accepted trusted setup.
- **Scope.** Semaphore's nullifier is `Poseidon(scope, secret)`. Abolish derives the scope, outside the circuit, as a tagged SHA-256 hash of the election-definition hash and the tier group's root: `S = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ root))`. Semaphore's own `hash` (keccak-256, shifted right 8 bits) then maps `S` into the field, exactly as Semaphore's libraries and contracts do. So:
  - the domain tag is applied to the scope, which has the same effect as tagging the nullifier: no other Abolish hash, and no other Semaphore application that doesn't deliberately reuse our public scope, produces it (T-12). Deliberate reuse by an application holding the voter's identity would reveal the nullifier, and no tag, in or out of the circuit, stops that: the identity secret is used for Abolish proofs only ([[membership]], Security notes);
  - the definition hash binds the poll, the chain ID and the contract addresses (P1-10b), so a redeploy or a second chain never reuses a scope (T-12, T-30);
  - **one scope per tier group.** A person whose one secret is in two tier groups gets two unrelated nullifiers, so their ballots in two tiers can't be linked through the nullifier (T-13), and G-2's "at most one counted ballot per person per poll per tier" holds for each tier;
  - the tier is fixed twice by the proof's public inputs: by the root it verifies against (P1-10b requires distinct roots per tier) and by the scope, which a relay can't change without invalidating the proof ([[verifier]] 2.8).
- **Message.** The proof's message is a 32-byte digest whose content P1-12 and P1-13 define (at least the ballot hash, the election definition, the tier and whatever the re-vote rule ranks by, [[verifier]] 5.3), mapped into the field by the same Semaphore `hash`.

What would change it: a published, reviewed proof that bb's zero-knowledge UltraHonk is statistically zero-knowledge (A then becomes possible as a new protocol version, keeping B's nullifier derivation); a break of Semaphore's ceremony; or a Semaphore release that changes the v4 statement (we stay on v4 until an ADR moves).

## Consequences

- [[membership]] specifies the statement, the public inputs, the scope and message mappings, the tree depth, and what the verifier checks. `abolish/v1/nullifier-scope` becomes a specified plain-hash tag, and [[domain-separation]] records that no Abolish tag enters a circuit in version 1.
- `packages/crypto` computes the scope and the Semaphore field mapping, with cross-language vectors from an independent implementation (this item, P1-17).
- **P1-17b** (new): vendor Semaphore v4's verification keys with their provenance (tag, commit, sha256, re-fetched in CI, which needs a `ci:` PR to allow the publisher); check the pinned proving keys' reference strings for well-formedness once, publicly; implement Groth16 verification over BN254 in the gated packages; and test it against real Semaphore proofs vendored as vectors, plus tampered ones.
- **Why Groth16 verification is composition, not a new proof system.** The `crypto-review` rules forbid implementing a pairing or a proof system. P1-17b implements neither: the pairing, the curve groups and their subgroup checks come from `@noble/curves`' audited BN254 module, and the code evaluates the published Groth16 verification equation (Groth 2016, §3.2) over them, as verifying a Schnorr or Chaum–Pedersen proof does over ristretto255. It MUST: decode every proof point strictly (canonical coordinates below the field modulus, on the curve, and in the prime-order subgroup, including G2 membership); require every public input below `r`; require the key's `IC` to have exactly 5 points (4 public inputs); and use only the pinned keys. Any deviation is a blocking review finding.
- **Prover side (P2-8, P5-4):** the ballot client uses exactly the proving key P1-17b checked and pinned (Fuchsbauer, PKC 2018: that check is what keeps zero knowledge perfect against a subverted ceremony), pins the prover by hash, draws the Groth16 randomisers from a CSPRNG, and uses the identity secret for Abolish proofs only.
- **Root 0.** Semaphore's circuit doesn't constrain the proof length, so a root of 0 is provable by anyone with any secret; a verifier fails any tier whose root is 0 ([[membership]], Statement).
- **`packages/circuits`:** no Noir circuit is needed for membership. The Noir workspace scaffold (toolchain, `nargo test`, artifacts, the zero-knowledge-flavour test) comes with the first custom circuit, the Tier 2 predicates (P3-1). Its in-circuit tag-to-field rule is defined there.
- **Residuals.** Membership soundness rests on Semaphore's ceremony and on BN254 (T-05, T-07). Groth16 malleability is handled by replay rules, not proof bytes (T-38). Participation privacy stays computational, as ADR 0002 says: an unbounded adversary can invert Poseidon on the identity commitments (T-15).
- Threat files T-04, T-05, T-07, T-12 and T-13 are updated to name this decision.

## Decision

Under rule A (`AGENTS.md`): **option B**, with status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
