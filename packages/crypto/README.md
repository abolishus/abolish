# @abolishus/crypto

The protocol core of [Abolish](https://github.com/abolishus/abolish): canonical encodings, ballot encryption, validity proofs, threshold decryption and the bulletin-board model. Depends only on `@noble/*`.

**Status: scaffold.** No API yet; the canonical encoders and decoders land with STATUS item P1-10. Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Rules

- Runtime dependencies are `@noble/*` only, pinned to exact versions in the workspace catalog, with an `@noble`-only transitive closure, no node built-ins and no workspace imports. CI's `gated` check (`.github/tools/ci/src/gated.ts`) enforces this from the lockfile, the `src` imports and the packed bundle, which must inline nothing from `node_modules` (T-55, T-36).
- No primitive is implemented here. Every hash, curve, cipher and KDF comes from the audited `@noble/*` libraries; this package composes published protocols, cited in `docs/spec/`.

## Tests

```sh
vp run --filter @abolishus/crypto test
```

- Unit and property tests use `vite-plus/test` and `fast-check`; property tests honour `FC_NUM_RUNS` (CI sets 1000) and print their seed on failure.
- Published vectors are vendored byte for byte under [`test-vectors/`](test-vectors/README.md), each listed in `test-vectors/manifest.json` with its source URL and sha256. `tests/vectors/harness.ts` checks the sha256 before any test reads a file.
- Cross-language vectors for what the spec defines live in `docs/spec/vectors/`, not here.

## License

[Apache-2.0](LICENSE).
