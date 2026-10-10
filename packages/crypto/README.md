# @abolishus/crypto

The protocol core of [Abolish](https://github.com/abolishus/abolish): canonical encodings, ballot encryption, validity proofs, threshold decryption and the bulletin-board model. Depends only on `@noble/*`.

**Status: early.** The first APIs are the canonical encoding layer of [`docs/spec/notation.md`](../../docs/spec/notation.md) (P1-10) and the group and hash layer of [`docs/spec/group.md`](../../docs/spec/group.md) (P1-11); ballot commitments, proofs and the board model follow. Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Canonical encoding

Strict encoders and decoders for the primitive types of the spec, following option A of ADR 0001 (explicit byte layouts):

- Primitives: `u8`, `u16`, `u32`, `u64` (a `bigint`), `bool`, `enum8([...])`, `bytesFixed(n)`, `bytesVar(max)`, `utf8(max)` (the exact bytes, never normalised) and `fieldBn254` (a `bigint` below `BN254_R`). `list(of, max)` and `struct([...])` compose them.
- `encode(codec, value)` and `decode(codec, bytes)` handle a value that isn't a record. Records go through a `RecordSchema` built from `recordType(number, { version: layout })`. Its `decode` requires the version the election's profile pins and rejects any other version (`profile-mismatch`). Skipping that check means passing `UNPINNED` explicitly, which only vector files and tests do. Inputs are copied once into a plain `Uint8Array`, so decoded values never alias the caller's buffer.
- Decoders reject and never repair. A `DecodeError` carries the spec's error code (`truncated`, `trailing-bytes`, `length-over-max`, `unknown-record-type`, `unexpected-record-type`, `unknown-version`, `invalid-enum`, `invalid-utf8`, `non-canonical`, `profile-mismatch`) and the offset where the failing field starts. Encoders throw `EncodeError` instead of emitting bytes the spec doesn't define (T-31).
- `ds(tag, m)` builds `u8(len(tag)) ‖ tag ‖ m`, only for a tag the registry marks specified. `TAG_REGISTRY` and `RECORD_TYPES` are checked against the spec's registries by tests.

## Group and hash

The prime-order group and hashes of ADR 0007 (option A), as thin wrappers over `@noble/curves` and `@noble/hashes` (T-39, T-31, T-30, T-15):

- `scalar`: 32 bytes little-endian, below `GROUP_ORDER` (ℓ), a `bigint`; a value at or above ℓ is rejected, never reduced. `element` and `elementOrIdentity`: the 32-byte RFC 9496 encoding of a ristretto255 `Element`; `element` rejects the identity. Both fail with `non-canonical`. The element encoder accepts only points built by `@noble/curves` and re-decodes its own output, so it writes nothing but valid encodings.
- `H(m)`: SHA-256. Plain hashes are `H(ds(tag, m))`.
- `challenge(tag, t)`: a Fiat–Shamir challenge, RFC 9497 `HashToScalar` with the tag as `DST`; it accepts only specified Fiat–Shamir tags, of which there are none until P1-12 specifies the first statement. `hashToGroup(tag, m)`: RFC 9380 `hash_to_ristretto255` under a specified hash-to-curve tag. Both always pass the `DST` to `@noble/curves`, which would otherwise use its own.
- `G` (the RFC 9496 generator), `GENERATOR_H` (`h = hash_to_ristretto255("", DST = "abolish/v1/generator-h")`) and `IDENTITY`.

## Rules

- Runtime dependencies are `@noble/*` only, pinned to exact versions in the workspace catalog, with an `@noble`-only transitive closure, no node built-ins and no workspace imports. CI's `gated` check (`.github/tools/ci/src/gated.ts`) enforces this from the lockfile, the `src` imports and the packed bundle, which must inline nothing from `node_modules` (T-55, T-36).
- No primitive is implemented here. Every hash, curve, cipher and KDF comes from the audited `@noble/*` libraries; this package composes published protocols, cited in `docs/spec/`.

## Tests

```sh
vp run --filter @abolishus/crypto test
```

- Unit and property tests use `vite-plus/test` and `fast-check`; property tests honour `FC_NUM_RUNS` (CI sets 1000) and print their seed on failure.
- Published vectors are vendored byte for byte under [`test-vectors/`](test-vectors/README.md), each listed in `test-vectors/manifest.json` with its source URL and sha256. `tests/vectors/harness.ts` checks the sha256 before any test reads a file.
- Cross-language vectors for what the spec defines live in `docs/spec/vectors/`, not here. `tests/primitives-vectors.test.ts` runs every vector in `primitives.json` and `group.json`, building codecs from the files' type descriptors; `tests/group.test.ts` runs `hash.json`.
- `scripts/group-vectors.py` prints `group.json` and `hash.json` from an independent Python implementation of RFC 9496, RFC 9380 §5.3.1 and RFC 9497 §4.1 (`python3 -I packages/crypto/scripts/group-vectors.py docs/spec/vectors`, then `vp check --fix`). `scripts/static-dh-factors.ts` reproduces ADR 0007's factor search of ℓ ± 1 (`vp node packages/crypto/scripts/static-dh-factors.ts`, about 30 seconds).

## License

[Apache-2.0](LICENSE).
