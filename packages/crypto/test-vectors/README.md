# Published test vectors

Vectors published by standards bodies and library authors (NIST CAVP, RFCs, Wycheproof, the `@noble/*` authors), vendored so tests never need the network. Vectors for what Abolish's own spec defines live in `docs/spec/vectors/` instead.

## Rules

- Each file is a byte-for-byte copy of the published file, in a directory named after its publisher (`nist-cavp/`, `rfc/`, …), under its published name. Never edit, reformat or regenerate one; `.gitattributes` stops line-ending conversion.
- Each file is listed in `manifest.json` with:
  - `path`: relative to this directory;
  - `sha256`: of the vendored bytes;
  - `source`: the exact URL it was fetched from: a `raw.githubusercontent.com` URL pinned to a full commit hash in a repository allowlisted for its directory (`VECTOR_PUBLISHERS` in `.github/tools/ci/src/gated.ts`; adding one needs the owner's review), or an RFC's text under `rfc/`;
  - `tag`: a tag of that repository at that commit (for an RFC, its name). GitHub serves commits from a repository's forks under its own name, so CI's `vectors-provenance` step fetches the file both by commit and by tag, and fails unless both give the manifest's sha256 and the vendored file matches;
  - `origin` and `originUrl`: who published the vectors, and where, when `source` is a mirror;
  - `license`, `retrieved` (date) and `covers` (which primitive and parameters).
- `tests/vectors/harness.ts` refuses to read a file that isn't listed or whose sha256 doesn't match, and a test fails if any file here isn't listed. The sha256 is computed with `node:crypto`, never with the code under test.
- A test that consumes a file also asserts how many vectors it parsed, so a parser that drops vectors fails instead of checking fewer.

## Files

| Path                              | Covers                                                                             | Origin                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `nist-cavp/SHA256ShortMsg.rsp`    | SHA-256, messages 0–64 bytes                                                       | NIST CAVP SHAVS byte-oriented vectors, via pyca/cryptography       |
| `rfc/rfc9496.txt`                 | ristretto255: Appendix A.1–A.3                                                     | RFC 9496, from the RFC Editor                                      |
| `rfc/rfc9380.txt`                 | `expand_message_xmd` over SHA-512: Appendix K.3                                    | RFC 9380, from the RFC Editor                                      |
| `rfc/rfc9497.txt`                 | ristretto255-SHA512 `HashToScalar`, `HashToGroup` and serialisation: Appendix A.1  | RFC 9497, from the RFC Editor                                      |
| `rfc/rfc6979.txt`                 | ECDSA P-256/SHA-256 with RFC 6979 nonces: Appendix A.2.5                           | RFC 6979, from the RFC Editor                                      |
| `rfc/rfc8439.txt`                 | ChaCha20-Poly1305 AEAD: §2.8.2 (encryption) and Appendix A.5 (decryption)          | RFC 8439, from the RFC Editor                                      |
| `rfc/rfc5869.txt`                 | HKDF-SHA-256: Appendix A.1–A.3                                                     | RFC 5869, from the RFC Editor                                      |
| `nist-cavp/SigVer.rsp`            | ECDSA P-256/SHA-256 signature verification: the `[P-256,SHA-256]` section          | NIST CAVP ECDSA SigVer (FIPS 186-3) vectors, via pyca/cryptography |
| `transparency-dev/constants.go`   | RFC 6962 Merkle tree: leaf inputs, node hashes and roots of trees of 1 to 8 leaves | transparency-dev/merkle v0.0.2 (Apache-2.0)                        |
| `transparency-dev/verify_test.go` | RFC 6962 inclusion and consistency proofs over the same leaves                     | transparency-dev/merkle v0.0.2 (Apache-2.0)                        |

The NIST CAVP zip on csrc.nist.gov couldn't be fetched from the session that vendored this file, so it was taken from the pyca/cryptography mirror at a pinned commit. All 65 digests were checked against both `@noble/hashes` and OpenSSL (through Python's `hashlib`) when it was vendored; a byte comparison against NIST's own zip is still to do.

The RFC texts are vendored whole, and `tests/vectors/rfc.ts` parses the vectors out of their appendices strictly. RFC 9496 Appendix A.4 (`SQRT_RATIO_M1`) isn't checked directly, because `@noble/curves` doesn't export the function; it is exercised through `Decode` and element derivation.

The transparency-dev files are Go source; `tests/vectors/transparency-dev.test.ts` parses their tables strictly and asserts how many rows it read. They use RFC 6962's `0x00`/`0x01` prefixes rather than our tags, so they test the tree code with RFC 6962's hashes plugged in; `docs/spec/vectors/board.json` covers the tagged instantiation. The directory needs `transparency-dev/merkle` in `VECTOR_PUBLISHERS`, added by the `ci:` PR #30.

The SigVer file's passing cases include signatures with `s` in the high half, which ECDSA accepts and Abolish's low-s rule rejects ([[trustee-identity]]). `tests/vectors/p256.test.ts` checks every failing case is rejected and every passing case is accepted exactly when its `s` is in the low half, and that the low-half form `(r, n − s)` of each high-s passing case is accepted.

ML-KEM-768 has no vendored vectors yet. `tests/vectors/mlkem.test.ts` checks `@noble/post-quantum` against the accumulated FIPS 203 hashes of Go's `crypto/mlkem` tests (go1.25.0, `TestAccumulated`), copied into the test with their URL: the inputs come from SHAKE-128, so the two 32-byte hashes stand for 10 000 key generations, encapsulations and decapsulations, but neither `golang/go` nor C2SP's CCTV is an allowlisted publisher, so the provenance step doesn't re-fetch them. Vendoring NIST's ACVP ML-KEM vectors needs a publisher added in a `ci:` PR.
