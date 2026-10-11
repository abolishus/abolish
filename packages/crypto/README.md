# @abolishus/crypto

The protocol core of [Abolish](https://github.com/abolishus/abolish): canonical encodings, ballot encryption, validity proofs, threshold decryption and the bulletin-board model. Depends only on `@noble/*`.

**Status: early.** The first APIs are the canonical encoding layer of [`docs/spec/notation.md`](../../docs/spec/notation.md) (P1-10), the group and hash layer of [`docs/spec/group.md`](../../docs/spec/group.md) (P1-11), and the bulletin board of [`docs/spec/board.md`](../../docs/spec/board.md) (P1-16); ballot commitments and proofs follow. Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Canonical encoding

Strict encoders and decoders for the primitive types of the spec, following option A of ADR 0001 (explicit byte layouts):

- Primitives: `u8`, `u16`, `u32`, `u64` (a `bigint`), `bool`, `enum8([...])`, `bytesFixed(n)`, `bytesVar(max)`, `utf8(max)` (the exact bytes, never normalised) and `fieldBn254` (a `bigint` below `BN254_R`). `list(of, max)` and `struct([...])` compose them.
- `encode(codec, value)` and `decode(codec, bytes)` handle a value that isn't a record. Records go through a `RecordSchema` built from `recordType(number, { version: layout })`. Its `decode` requires the version the election's profile pins and rejects any other version (`profile-mismatch`, checked before the version is looked up, so it wins over `unknown-version`). Skipping that check means passing `UNPINNED` explicitly: tests and vector files do, and so does `decodeElectionDefinition`, because a definition carries its own profile and is checked against it once decoded. A production schema accepts only the record-type numbers the registry assigns. Inputs are copied once into a plain `Uint8Array`, so decoded values never alias the caller's buffer.
- Decoders reject and never repair. A `DecodeError` carries the spec's error code (`truncated`, `trailing-bytes`, `length-over-max`, `unknown-record-type`, `unexpected-record-type`, `unknown-version`, `invalid-enum`, `invalid-utf8`, `non-canonical`, `profile-mismatch`) and the offset where the failing field starts. Encoders throw `EncodeError` instead of emitting bytes the spec doesn't define (T-31).
- `ds(tag, m)` builds `u8(len(tag)) ‖ tag ‖ m`, only for a tag the registry marks specified. `TAG_REGISTRY` and `RECORD_TYPES` are checked against the spec's registries by tests.

## Election definition and display text

Version 1 of record types `0x0001` and `0x0009` ([`docs/spec/election-definition.md`](../../docs/spec/election-definition.md), [`docs/spec/display-text.md`](../../docs/spec/display-text.md)). Both are frozen by their vectors; a change is a new version (T-34, T-31). The entry point exports no generic record decoder, so a definition is decoded only with its self-pin check.

- `encodeElectionDefinition` and `decodeElectionDefinition`. The decoder decodes strictly, then rejects with `profile-mismatch` unless the definition's own profile pins `0x0001` at the record's version. `electionDefinitionHash` is `H(DS("abolish/v1/election-definition", ·))`. `electionDefinitionRule` returns the first well-formedness rule a decoded definition breaks.
- `encodeDisplayText`, `decodeDisplayText` (against the version a definition pins), `displayTextCommitment` and `displayTextRule`, which a client runs before showing any text: commitment first, then shape.
- `newDisplayTextSalt` draws 32 bytes from the platform CSPRNG (`@noble/hashes` `randomBytes`). `election_id` isn't drawn here: the election registry assigns it (P1-18).
- `PARAMETERS` mirrors `docs/spec/parameters.md`. The production record schema (these types and no others) stays internal.

## Group and hash

The prime-order group and hashes of ADR 0007 (option A), as thin wrappers over `@noble/curves` and `@noble/hashes` (T-39, T-31, T-30, T-15):

- `scalar`: 32 bytes little-endian, below `GROUP_ORDER` (ℓ), a `bigint`; a value at or above ℓ is rejected, never reduced. `element` and `elementOrIdentity`: the 32-byte RFC 9496 encoding of a ristretto255 `Element`; `element` rejects the identity. Both fail with `non-canonical`. The element encoder accepts only points built by `@noble/curves` and re-decodes its own output, so it writes nothing but valid encodings.
- `H(m)`: SHA-256. Plain hashes are `H(ds(tag, m))`.
- `challenge(tag, t)`: a Fiat–Shamir challenge, RFC 9497 `HashToScalar` with the tag as `DST`; it accepts only specified Fiat–Shamir tags (today the two ballot-validity tags). `hashToGroup(tag, m)`: RFC 9380 `hash_to_ristretto255` under a specified hash-to-curve tag. Both always pass the `DST` to `@noble/curves`, which would otherwise use its own.
- `G` (the RFC 9496 generator), `GENERATOR_H` (`h = hash_to_ristretto255("", DST = "abolish/v1/generator-h")`) and `IDENTITY`.

## Ballot commitments and validity proofs

The public part of a plurality or approval ballot, per [`docs/spec/ballot-validity.md`](../../docs/spec/ballot-validity.md) (ADR 0002 option B, ADR 0003; T-15, T-28, T-30, T-32):

- `shareVote(rules, votes)` draws each option's sharing polynomials from the CSPRNG and returns the `VoteSharing`: the Pedersen VSS commitments (`vss`, the first of each option being its commitment `C_j`) and every trustee's shares. It refuses a vote the rules don't allow.
- `proveValidity(context, sharing, shareHashes)` adds an option proof per option and the sum proof, under challenges bound to `statementHash` (definition hash, ballot version, tier, nullifier, every commitment and every share-ciphertext hash). It returns the `CommittedVote`, which `COMMITTED_VOTE` encodes.
- `checkValidity(context, vote)` is the admission check: `validity-shape`, then `option-proof` (naming the option), then `sum-proof`. Its context comes from the registered definition and the ballot's own tier and nullifier, never from the committed vote.
- `checkShares(vss, index, shares)` is trustee `index`'s check of its shares (`SHARES`) against the VSS commitments.

The caller erases a `VoteSharing` once the voter casts. Share encryption (part 2) and the ballot record (part 3) follow.

## Bulletin board

The board of `docs/spec/board.md` (T-23, T-24, T-42):

- `encodeBoardEntry` and `decodeBoardEntry` (record type `0x0007`, version 1): the envelope of an election, a position, an anchoring segment and one payload record of a type allowed on the board, at most `MAX_BOARD_PAYLOAD` bytes. Only the payload's header is read; the record itself is decoded where it is used.
- `boardEntryHash`, `chainLink` and `checkpointHash`: `H` under `abolish/v1/board-entry`, `abolish/v1/board-chain` and `abolish/v1/board-checkpoint`.
- The RFC 9162 Merkle tree, generic over its two hashes (`TreeHash`), with `BOARD_TREE` using tagged `H`: `merkleRoot`, `merkleRoots` (every requested prefix root in one pass), `inclusionProof`, `consistencyProof`, and `verifyInclusion` and `verifyConsistency`, which return false for any malformed argument and never throw.
- `verifyBoard` checks one election's board against every anchor for it, given the anchoring clock (`AnchorClock`) and the latest finalized L1 time. Only timely anchors count (`isTimely`). It checks only the prefix those anchors cover and ignores entries past it. Within that prefix it checks strict decoding, election, positions, segments, the order of spoiled-ballot openings, equivocation, each checkpoint's boundary, unanchored segments and the seal, after first checking the copy's raw bytes against every anchored head and root (a mismatch, `copy-mismatch`, means the copy is wrong, not the election; `checkpoint-inconsistent`, a checkpoint no board can match, from L1 alone or against the copy, fails the election, attributably to the anchoring authority). A failure throws a `BoardError` with the spec's code. `checkBoard` runs the entry checks alone, and `checkpointOf` builds the checkpoint after a segment.

## Membership

What Abolish derives around Semaphore v4's membership circuit (`docs/spec/membership.md`, ADR 0009; T-12, T-13):

- `nullifierScope(definitionHash, tier, root)`: `S_g = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(tier) ‖ root))`, one scope per poll and tier group, even for tiers with equal roots. `membershipScope` maps it into the field as the circuit's scope input.
- `semaphoreField(x)`: Semaphore's `hash`, `keccak256(x) >> 8`, for 32-byte inputs.
- `MEMBERSHIP_DEPTH`: 32, the one tree depth (and so verification key) every membership proof uses, so no server can steer it.

Groth16 verification of the proofs themselves is P1-17b's.

## Circuit-facing values

How tags and bytes become BN254 field elements, exactly as `packages/circuits` does in Noir (`docs/spec/notation.md`, Circuit-facing values; `docs/spec/domain-separation.md`, In-circuit hashes; T-30, T-31):

- `circuitTagField(tag)`: `int(H(DS("abolish/v1/circuit-tag", tag))) >> 8`, the constant by which a tag enters a circuit, only for a tag registered In-circuit (none yet), so no plain-hash tag gets a second layout (T-30).
- `packBytes(bytes)`: `bytes[N]` as `ceil(N / 31)` big-endian chunks. `packBoundedBytes(bytes, max)`: the length, then the content zero-padded to `max` and packed.

## Rules

- Runtime dependencies are `@noble/*` only, pinned to exact versions in the workspace catalog, with an `@noble`-only transitive closure, no node built-ins and no workspace imports. CI's `gated` check (`.github/tools/ci/src/gated.ts`) enforces this from the lockfile, the `src` imports and the packed bundle, which must inline nothing from `node_modules` (T-55, T-36).
- No primitive is implemented here. Every hash, curve, cipher and KDF comes from the audited `@noble/*` libraries; this package composes published protocols, cited in `docs/spec/`.

## Tests

```sh
vp run --filter @abolishus/crypto test
```

- Unit and property tests use `vite-plus/test` and `fast-check`; property tests honour `FC_NUM_RUNS` (CI sets 1000) and print their seed on failure.
- Published vectors are vendored byte for byte under [`test-vectors/`](test-vectors/README.md), each listed in `test-vectors/manifest.json` with its source URL and sha256. `tests/vectors/harness.ts` checks the sha256 before any test reads a file.
- Cross-language vectors for what the spec defines live in `docs/spec/vectors/`, not here. `tests/primitives-vectors.test.ts` runs every vector in `primitives.json` and `group.json`, building codecs from the files' type descriptors; `tests/group.test.ts` runs `hash.json`; `tests/board-vectors.test.ts` runs `board.json`; `tests/record-vectors.test.ts` runs `election-definition.json` and `display-text.json` through the production codecs, hashes and rule checks; `tests/membership.test.ts` runs `membership.json`; `tests/circuit.test.ts` runs `circuit.json`.
- `scripts/group-vectors.py` prints `group.json` and `hash.json` from an independent Python implementation of RFC 9496, RFC 9380 §5.3.1 and RFC 9497 §4.1 (`python3 -I packages/crypto/scripts/group-vectors.py docs/spec/vectors`, then `vp check --fix`). `scripts/definition-vectors.py` prints `election-definition.json` and `display-text.json` from the spec tables with only the Python standard library (`python3 -I packages/crypto/scripts/definition-vectors.py docs/spec/vectors`, then `vp check --fix`). `scripts/static-dh-factors.ts` reproduces ADR 0007's factor search of ℓ ± 1 (`vp node packages/crypto/scripts/static-dh-factors.ts`, about 30 seconds). `scripts/board-vectors.py` prints `board.json` from an independent Python implementation of `docs/spec/board.md` and RFC 9162 §2.1, after checking itself against the vendored transparency-dev vectors. `scripts/membership-vectors.py` prints `membership.json`, with its own Keccak-256 checked against `hashlib.sha3_256` and published answers. `scripts/circuit-vectors.py` prints `circuit.json`, reading the tags from the registry in `docs/spec/domain-separation.md`. `scripts/revoting-vectors.py` prints `revoting.json` (the membership message, the L1-reference admission check and ballot selection), reusing `membership-vectors.py`'s self-checked Keccak. `scripts/ballot-validity-vectors.py` prints `ballot-validity.json` from an independent Python implementation of `docs/spec/ballot-validity.md`, reusing `group-vectors.py`'s self-checked ristretto255; each valid ballot lists the randomness that made it, and `tests/ballot-validity.test.ts` reproduces it byte for byte. Run the Python generators with `python3 -I -B`, so no bytecode cache is written next to them.

## License

[Apache-2.0](LICENSE).
