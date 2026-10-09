# ADR 0001: Canonical encoding for hashed, signed and anchored data

- Status: needs-decision
- Date: 2026-10-09
- Deciders: owner (one-way door)
- Threats addressed: T-31, T-30, T-36, T-38, T-34, T-23 (see [[THREAT_MODEL]])

## Context

Ballots, proofs, bulletin-board entries, election definitions, and ceremony and tally transcripts are hashed, signed, or anchored on chain. Everything that does that needs exactly one byte representation per value, and every implementation must agree on it: our TypeScript (`packages/crypto`), our Solidity contracts, our Noir circuits where they hash or bind the same data, and third-party verifiers written in any language from `docs/spec/` alone. If two byte strings decode to the same value, or two decoders disagree on the same bytes, an anchor or a Fiat–Shamir challenge commits to something other than what a verifier checks (T-31, T-30). The goal of independent verifiers (T-36) depends on the format being simple enough to re-implement correctly.

The brief requires canonical encodings defined in `docs/spec/`, with hand-written decoders in `packages/crypto`, and says no schema library defines protocol bytes. It asks for an ADR between explicit byte layouts and deterministic CBOR.

**Why it's one-way:** once a ballot or a board root is anchored, even on a testnet, its encoding is permanent. Later formats can be added as new versions, but every verifier has to keep decoding every old version forever.

Constraints that weigh on the choice:

- **Contracts.** The direct-submit path (T-25) means contracts accept ballots and registrations themselves. Each one must at least hash the entry exactly as the off-chain board does, and check its fixed-size fields: the nullifier, the election-definition hash and the proof inputs (T-38, T-34). Solidity has no audited CBOR decoder. A fixed layout can be checked with slicing and `keccak256` alone.
- **Circuits.** Noir circuits work over field elements, not bytes. Whatever a circuit binds (the ballot hash in the membership proof's signal, T-38) must be reproducible from the encoded bytes without parsing inside the circuit.
- **Decoder strictness.** Every decoder must reject non-canonical input: trailing bytes, alternative integer widths, non-canonical points and scalars, unknown versions (`crypto-review` skill). The fewer ways the format allows a value to be written, the fewer rejections each implementation has to get right.
- **Third-party verifiers.** The spec must be implementable from a page of tables, in any language, without a library.

## Options

### A. Explicit fixed byte layouts

Each message type has a spec table: a field order, a fixed width per field, and an explicit framing rule for the few variable-length fields. The building blocks:

- a header: a `u8` length followed by an ASCII domain-separation tag `abolish/v1/<type>` (registered in `docs/spec/`, P1-8), so no tag can be read as a prefix of another. The tag's `v1` is the only version field: there is no separate version byte to disagree with it, and an unregistered tag is rejected;
- unsigned integers, big-endian at a fixed width (`u8`, `u16`, `u32`, `u64`), with no varints;
- group elements and scalars in the compressed encoding the group layer defines (P1-11), with canonicity and subgroup checks on decode (T-39);
- 32-byte hashes;
- variable-length lists and byte strings, prefixed with a `u32` length checked against a per-field maximum that the spec states;
- text (poll titles and options), as length-prefixed strict UTF-8. Decoders reject overlong forms, surrogates and code points above U+10FFFF. NFC normalisation is an encoder (authoring-time) rule, not a decoder check: whether a string is in NFC depends on the implementation's Unicode version, so a decoder check would itself create parser differentials (T-31), and contracts can't check it;
- optional fields only as a presence byte: `0x00` (absent, followed by no bytes at all, never a zero-filled placeholder) or `0x01` (present, followed by the value); any other presence byte is rejected;
- no floats, no maps and no field reordering.

Precedent: ElectionGuard defines its hash inputs as explicit byte sequences of fixed-width integers and elements (ElectionGuard Design Specification v2.0, the section on hash computations). Ethereum's ABI is a layout of this kind for static types, which Solidity reads natively. For dynamic types it uses offsets and accepts non-canonical forms, so contracts take protocol bytes as one opaque `bytes` argument and hash exactly those bytes, never an `abi.encode` of decoded fields (P1-8 states this). RFC 8446 (TLS 1.3) uses the same presentation language of fixed-width fields with explicit length prefixes.

**Pros:**

- Exactly one encoding per value by construction, because there is nothing to choose: no integer widths, no map ordering, no indefinite lengths.
- Decoders are short and total, so they are easy to property-test and fuzz.
- Contracts read fields at fixed offsets and hash the raw bytes. Cross-language vectors (`docs/spec/vectors/`) cover every type.
- A third-party verifier needs only the spec tables.

**Cons:**

- Every message type needs its own spec table, encoder, decoder and vectors.
- Not self-describing, so a hex dump means nothing without the spec. Debug tooling (`packages/verifier` can pretty-print) has to make up for it.
- Adding a field means a new version. That is acceptable, because versions are append-only anyway.

**Threats:** it removes most of the T-31 surface, makes T-30 statement binding mechanical (the challenge hashes the encoded statement), and keeps T-36 cheap for third parties.

### B. Deterministic CBOR

Every message is a CBOR map or array encoded under the Core Deterministic Encoding Requirements of RFC 8949 §4.2.1: shortest-form integers and lengths, no indefinite lengths, and map keys sorted bytewise lexicographically. A profile restricts the allowed types, for example dCBOR (`draft-mcnally-deterministic-cbor`), which also fixes numeric reduction and NFC strings. Our decoders would still be hand-written and would enforce the profile: reject non-shortest forms, unsorted or duplicate keys, unknown tags and floats.

**Pros:**

- Self-describing, with mature tooling and readable diagnostic notation.
- Adding a field is natural.
- Many languages have CBOR libraries.

**Cons:**

- Many ways to write each value, and only the profile rules out all but one. Every implementation must enforce shortest-form integers, key order, duplicate keys, tag and simple-value restrictions, and the float rules correctly. These rules are where CBOR implementations are known to disagree, which is T-31's parser differentials.
- Third parties will reach for a general CBOR library, and most libraries accept non-deterministic input by default. Their verifier then accepts bytes ours rejects, or the reverse.
- No audited Solidity decoder exists. Contracts would have to locate fields inside variable-width CBOR, which costs more gas and needs a hand-written on-chain parser: a new, immutable attack surface (T-63).
- dCBOR is an Internet-Draft, not an RFC, so the profile we pin could drift from what libraries implement.

**Threats:** T-31 is mitigated only as well as every implementation enforces the profile. It adds contract surface (T-63).

### C. SSZ (Ethereum's Simple Serialize)

Fixed-size types are laid out inline; variable-size fields use 4-byte offsets; there is a defined Merkleisation (`hash_tree_root`). SSZ is specified in the Ethereum consensus specs, with implementations in several languages.

**Pros:**

- Canonical by design.
- Merkleisation gives field-level inclusion proofs.
- Battle-tested in Ethereum consensus clients.

**Cons:**

- A general schema system where we need a few dozen fixed messages.
- Offsets reintroduce decoder edge cases: overlapping offsets, gaps, out-of-range offsets.
- Its Merkleisation uses SHA-256 with its own chunking rules, which would constrain the hash choice of P1-11 and P1-16.
- Few non-Ethereum developers know it.
- Solidity support exists only as unaudited community code.

## Recommendation

**A, explicit fixed byte layouts.** Our message set is small and stable, and a few of its fields have to be checked inside Solidity or reproduced for Noir. Those two constraints favour a format with exactly one way to write each value and no parser. A also gives third-party verifiers the smallest spec to implement correctly, which is the system's whole source of authority.

What would change the recommendation:

- If election definitions grow open-ended structure (nested, user-defined ballot types), use B for that one document type only. Hash its bytes as an opaque blob into an A-encoded envelope, so contracts and circuits still see only fixed layouts.
- If the chosen L2 ships an audited CBOR or SSZ precompile, revisit B or C for contract-facing messages.

## Consequences

- **P1-8:** `docs/spec/` defines the primitive types above, the header, the domain-tag registry, the length-limit rule and the vector format.
- **P1-10:** implements encoders and decoders per message type in `packages/crypto`, with property tests (decode∘encode and encode∘decode identities, and rejection of every mutation) and cross-language vectors consumed by TS, Solidity and Noir tests.
- Every message type added later needs a spec table and vectors in the same PR.
- Since decoders accept text that isn't NFC, two definitions can differ in bytes but look identical (close to T-34). The ballot client and the verifier warn on non-NFC or mixed-script text without rejecting it (P1-8, P1-19).
- Tooling must make up for the lack of self-description: the verifier gets a `decode --pretty` command (P1-19).
- **Known-weak:** spec tables are written by hand, so a table and its implementation can drift apart. Cross-language vectors that are generated independently of the code under test are the guard (T-36).

## Default

- PR opened: 2026-10-09T05:56Z (#5).
- If the owner hasn't answered by **2026-10-12T05:56Z** (72 hours later), option A is adopted and this ADR is marked `Status: accepted by default — revisit`.
