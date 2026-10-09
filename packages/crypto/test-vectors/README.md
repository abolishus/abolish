# Published test vectors

Vectors published by standards bodies and library authors (NIST CAVP, RFCs, Wycheproof, the `@noble/*` authors), vendored so tests never need the network. Vectors for what Abolish's own spec defines live in `docs/spec/vectors/` instead.

## Rules

- Each file is a byte-for-byte copy of the published file, in a directory named after its publisher (`nist-cavp/`, `rfc/`, …), under its published name. Never edit, reformat or regenerate one; `.gitattributes` stops line-ending conversion.
- Each file is listed in `manifest.json` with:
  - `path`: relative to this directory;
  - `sha256`: of the vendored bytes;
  - `source`: the exact URL it was fetched from, pinned to a commit or immutable release where the host has one;
  - `origin` and `originUrl`: who published the vectors, and where, when `source` is a mirror;
  - `license`, `retrieved` (date) and `covers` (which primitive and parameters).
- `tests/vectors/harness.ts` refuses to read a file that isn't listed or whose sha256 doesn't match, and a test fails if any file here isn't listed. The sha256 is computed with `node:crypto`, never with the code under test.
- A test that consumes a file also asserts how many vectors it parsed, so a parser that drops vectors fails instead of checking fewer.

## Files

| Path                           | Covers                       | Origin                                                       |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `nist-cavp/SHA256ShortMsg.rsp` | SHA-256, messages 0–64 bytes | NIST CAVP SHAVS byte-oriented vectors, via pyca/cryptography |

The NIST CAVP zip on csrc.nist.gov couldn't be fetched from the session that vendored this file, so it was taken from the pyca/cryptography mirror at a pinned commit. All 65 digests were checked against both `@noble/hashes` and OpenSSL (through Python's `hashlib`) when it was vendored; a byte comparison against NIST's own zip is still to do.
