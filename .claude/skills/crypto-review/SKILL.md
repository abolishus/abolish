---
name: crypto-review
description: Rules and the in-session adversarial review procedure for protocol code — packages/crypto, circuits, contracts, verifier, core, sdk and both Capacitor plugins, apps/ballot, docs/spec and test-vectors. Load before writing or reviewing any of them, and before opening a PR that touches them.
---

# crypto-review

## Design rules

- Never implement a primitive (curve arithmetic, hash, AEAD, KDF, signature, pairing, proof system). Use `@noble/curves`, `@noble/hashes` and `@noble/ciphers` (audited) in TypeScript; Semaphore and Noir stdlib in circuits; OpenZeppelin or Semaphore contracts in Solidity, only at audited releases.
- Composing published protocols is expected. Cite the exact source in `docs/spec/`: ElectionGuard spec version and section, Helios/Belenios papers, Benaloh challenge, Chaum–Pedersen, disjunctive Chaum–Pedersen (CDS), the Fiat–Shamir transform with full statement binding, Pedersen/Feldman VSS, Semaphore v4.
- Every hash use has a unique ASCII domain-separation tag registered in `docs/spec/`, `abolish/v1/<purpose>`.
- Fiat–Shamir challenges hash the **entire** statement: domain tag, election ID / manifest hash, public key, every commitment, every ciphertext, and context such as the poll ID and the chain ID plus contract address where relevant.
- Decoders are strict and canonical. Fixed lengths. Reject non-canonical points and scalars, identity where invalid, small-subgroup points, trailing bytes and alternative encodings. Every decoder has a property test showing `decode(encode(x)) = x` and that `encode(decode(b)) = b` for every accepted `b`.
- Secrets are never logged or serialised outside the defined key formats; compare secrets in constant time; zeroise where the platform allows.
- Randomness for secrets: CSPRNG only, with nonces never reused. Deterministic randomness exists only behind an explicit test seam that production code cannot reach.
- Every protocol message format is versioned. Unknown versions are rejected, never guessed.
- Anything on the public board that is only computationally hiding must agree with the accepted everlasting-privacy ADR.
- Everything the verifier checks lives in `packages/{crypto,circuits,contracts,verifier}`, the only paths the required `crypto-review` gate covers. `packages/verifier` and `packages/crypto` never depend on `core`, `sdk`, `api-contract` or `ui`; no gated path contains a symlink; `apps/ballot` reaches the plaintext and randomness only through `packages/crypto` APIs. Code outside the gate that reimplements any of it is a blocking finding.

## Tests required

- Published vectors for every primitive configuration we rely on, plus our own cross-language vectors in `docs/spec/vectors/`, consumed by TS, Solidity and Noir tests.
- fast-check properties for codecs, proof soundness (tampered proofs fail), completeness (honest proofs verify) and homomorphic correctness.
- Negative tests for every check in a verifier: each one has a test showing that removing it lets a bad input through. Use mutation-style tests where practical.
- Verifier tests run against fixtures produced by the reference election, not by the code under test.

## In-session independent review (mandatory before opening the PR)

Spawn a fresh subagent: general-purpose, with no access to your reasoning. Pass it only:

- the diff: `git diff origin/main...HEAD`
- the paths of the relevant spec, ADR and threat-model sections
- the full text of `.github/review/crypto-review.md`, as its review instructions

Ask it to return findings as severity, file:line, attack, and fix. Then:

1. Fix every blocking finding, or rebut it in writing with an argument a cryptographer would accept.
2. If you changed code, re-run the subagent on the new diff.
3. Summarise the subagent review (findings and dispositions) in the PR body under "Independent review".

## Red flags: stop and write an ADR instead

- Choosing or changing a group, curve, hash or proof system.
- Changing what is public on the board, or what the server learns.
- Changing the identity scheme, nullifier derivation or group structure.
- Changing a canonical encoding that has already been anchored anywhere, testnet included. Versions are append-only.
