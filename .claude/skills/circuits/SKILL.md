---
name: circuits
description: Rules for packages/circuits (Noir + Barretenberg) — toolchain pins, constraint discipline, tests and artifacts. Load before touching any Noir circuit or proving code.
---

# circuits

Also load `crypto-review`: circuits are protocol code.

## Toolchain pins (move all four together, in one PR)

- `nargo` 1.0.0-beta.22
- `bb` 5.0.0-nightly.20260522: the version bbup's `bb-versions.json` maps to that Noir release
- `@noir-lang/noir_js` 1.0.0-beta.22
- `@aztec/bb.js` 5.0.0-nightly.20260522

Install locally with `.github/scripts/install-toolchain.sh`, which checks sha256 hashes. To upgrade, wait until `bb-versions.json` lists the new Noir version, then update `.github/scripts/install-toolchain.sh` (versions and hashes), the catalog in `pnpm-workspace.yaml`, AGENTS.md and this skill in a single PR.

## Layout

```
packages/circuits/
  <circuit>/Nargo.toml, src/main.nr   # one Nargo package per circuit
  Nargo.toml                          # workspace
  package.json                        # build: nargo compile + bb write_vk; test: nargo test + JS round-trip; check: nargo fmt --check
  artifacts/                          # generated: compiled ACIR + verification keys (committed, never hand-edited)
```

## Rules

- Noir circuits need no per-circuit trusted setup (UltraHonk). Semaphore's existing ceremony is the only accepted exception.
- Every value the statement depends on is a public input or constrained to one. Document the statement at the top of `main.nr` in maths notation, and keep it identical in `docs/spec/`.
- Unconstrained functions (`unconstrained fn`) are hints only. Re-check every output inside the circuit.
- Range-check every value that is meant to be smaller than the field. Watch for wrap-around in subtraction and comparison.
- Domain-separate every in-circuit hash, with the same tags as `docs/spec/`.
- Nullifiers: `H(tag, identity_secret, poll_scope)`, with `poll_scope` bound to the poll ID. They reveal nothing across polls.
- Never put PII or document data in public inputs. Tier 2 proves predicates only (citizenship, age ≥ N, uniqueness).
- Proving runs in a Web Worker in the browser, and in the native prover plugin under Capacitor. The same artifacts serve both.

## Tests

- `nargo test` for completeness (honest witness passes) **and** soundness: each constraint has a test where a malicious witness that violates only that constraint fails.
- JS round-trip: generate a proof with noir_js + bb.js, then verify it in TS, with the Solidity verifier on Anvil where applicable, and in `packages/verifier`.
- Cross-language vectors: public inputs and expected hashes from `docs/spec/vectors/`.
- Track constraint/gate counts in a committed snapshot and fail on unexpected growth.

## Artifacts

`build` regenerates `artifacts/`. CI rebuilds and fails if the committed artifacts differ. The verification key hash is part of the election definition and is anchored on-chain.
