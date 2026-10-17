# @abolishus/membership-prover

The ballot client's Groth16 membership prover: snarkjs 0.7.5 behind one call, run only in the client's prover worker ([[0009-membership-proof]], Amendment of 2026-10-17; `docs/spec/membership.md`, Security notes). Source-only, AGPL-3.0-only, never published. It is inside the `crypto-review` gate, its direct runtime dependencies are exactly `@abolishus/crypto`, `snarkjs` and `ffjavascript` (`.github/tools/ci/src/gated.ts`), and no other gated package may depend on it, so the verifier never runs snarkjs (T-36, T-55).

- `proveMembership(witness, { zkey, wasm }, onProgress?)`: snarkjs's proof for the witness `membershipProverInput` built (`@abolishus/crypto`), as the 256-byte `membership_proof` encoding. The proving key and witness calculator are copied, then refused unless their sha256s are the pinned ones (`checkMembershipZkey`, `checkMembershipWasm`), before the witness reaches them; the prover runs single-threaded, since its threaded mode starts `blob:` workers the client's CSP refuses. `onProgress` counts steps done of `MEMBERSHIP_PROVER_STEPS` (the witness and each step snarkjs logs), never time. snarkjs's public signals are discarded.

Nothing here is trusted for soundness or zero knowledge. Its output goes back to the ballot worker, which checks it against the public inputs it computed and re-randomises it with its own CSPRNG (`finishMembershipProof`), in a realm snarkjs can't reach; only that result leaves the device.

## Artifacts

`artifacts/snark-artifacts/` vendors Semaphore 4.13.0's `semaphore-32.zkey` and `semaphore-32.wasm` byte for byte, as `@semaphore-protocol/proof` 4.14.3 downloads them, each listed in `artifacts/manifest.json` with its URL and sha256 (the format of `packages/crypto/test-vectors/`). CI's `vectors-provenance` step re-fetches both from `snark-artifacts.pse.dev` and fails unless the bytes match. The ballot client's build ships these two files and no other `.zkey` or `.wasm` (`.github/tools/ci/src/ballot.ts`).

## Test

`vp run --filter @abolishus/membership-prover test` proves every case of `docs/spec/vectors/membership-prover.json` with the vendored artifacts and checks each proof with `packages/crypto`'s verifier and finisher, and checks the refusals: another key or calculator (before any progress), a path of other than 32 siblings, and a witness off the definition's root, whose proof finishing refuses. `tests/seal.test.ts` seals, casts and proves a version-3 ballot with `packages/crypto`'s seal under a definition whose key set comes from a ceremony run in the test, and checks the record passes `checkBallotV3` (twice: a recast under a newer L1 block keeps the committed vote). About 40 seconds.
