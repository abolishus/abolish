# @abolishus/crypto

The protocol core of [Abolish](https://github.com/abolishus/abolish): canonical encodings, ballot encryption, validity proofs, threshold decryption and the bulletin-board model. Depends only on `@noble/*`.

**Status: early.** The first API is the canonical encoding layer of [`docs/spec/notation.md`](../../docs/spec/notation.md) (P1-10); ballot encryption, proofs and the board model follow. Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Canonical encoding

Strict encoders and decoders for the primitive types of the spec, following option A of ADR 0001 (explicit byte layouts):

- Primitives: `u8`, `u16`, `u32`, `u64` (a `bigint`), `bool`, `enum8([...])`, `bytesFixed(n)`, `bytesVar(max)`, `utf8(max)` (the exact bytes, never normalised) and `fieldBn254` (a `bigint` below `BN254_R`). `list(of, max)` and `struct([...])` compose them.
- `encode(codec, value)` and `decode(codec, bytes)` handle a value that isn't a record. Records go through a `RecordSchema` built from `recordType(number, { version: layout })`. Its `decode` takes the version the election's profile pins and rejects any other version (`profile-mismatch`).
- Decoders reject and never repair. A `DecodeError` carries the spec's error code (`truncated`, `trailing-bytes`, `length-over-max`, `unknown-record-type`, `unexpected-record-type`, `unknown-version`, `invalid-enum`, `invalid-utf8`, `non-canonical`, `profile-mismatch`) and the offset where the failing field starts. Encoders throw `EncodeError` instead of emitting bytes the spec doesn't define (T-31).
- `ds(tag, m)` builds `u8(len(tag)) ‖ tag ‖ m`, only for a tag the registry marks specified. `TAG_REGISTRY` and `RECORD_TYPES` are checked against the spec's registries by tests.

## Rules

- Runtime dependencies are `@noble/*` only, pinned to exact versions in the workspace catalog, with an `@noble`-only transitive closure, no node built-ins and no workspace imports. CI's `gated` check (`.github/tools/ci/src/gated.ts`) enforces this from the lockfile, the `src` imports and the packed bundle, which must inline nothing from `node_modules` (T-55, T-36).
- No primitive is implemented here. Every hash, curve, cipher and KDF comes from the audited `@noble/*` libraries; this package composes published protocols, cited in `docs/spec/`.

## Tests

```sh
vp run --filter @abolishus/crypto test
```

- Unit and property tests use `vite-plus/test` and `fast-check`; property tests honour `FC_NUM_RUNS` (CI sets 1000) and print their seed on failure.
- Published vectors are vendored byte for byte under [`test-vectors/`](test-vectors/README.md), each listed in `test-vectors/manifest.json` with its source URL and sha256. `tests/vectors/harness.ts` checks the sha256 before any test reads a file.
- Cross-language vectors for what the spec defines live in `docs/spec/vectors/`, not here. `tests/primitives-vectors.test.ts` runs every vector in `primitives.json`, building codecs from the file's type descriptors.

## License

[Apache-2.0](LICENSE).
