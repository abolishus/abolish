# ADR 0001: Canonical encoding of protocol bytes

- Status: needs-decision
- Date: 2026-10-09
- Deciders: owner (one-way door)
- Threats addressed: T-31, T-30, T-36, T-23, T-34, T-38 (see [[THREAT_MODEL]])

## Context

Everything Abolish hashes, signs, proves over or anchors (ballots, validity proofs, bulletin-board entries, election definitions, ceremony and tally transcripts, receipts, Merkle leaves) must have exactly one byte representation. That representation is what the verifier recomputes, what Fiat–Shamir challenges hash, what the L2 contracts store hashes of and what L1 anchors commit to. The brief requires it to be defined in `docs/spec/`, decoded by hand-written code in `packages/crypto`, and never defined by a schema library.

The encoding has to be consumed in four places, written by different people at different times:

1. TypeScript (`packages/crypto`, and from it the verifier, SDK and ballot client).
2. Solidity: the direct-submit path (T-25) must check and hash a submitted ballot or registration on-chain. On-chain decoding costs gas per byte and per branch.
3. Noir: circuits bind to election and poll identifiers and to public inputs. Noir has no heap and works on fixed-size arrays and field elements, so every in-circuit input has a length known at compile time.
4. Third-party verifiers in any language (T-36). The spec plus `docs/spec/vectors/*.json` must be enough to write a strict decoder in a weekend.

The decision is one-way: once a ballot or board entry is anchored, its bytes are final. The encoding can gain new record versions, but it can never change how an existing record decodes, or every past election stops verifying.

The threat it must close is T-31: two byte strings that decode to the same value (malleability), or two implementations that decode the same bytes differently (parser differentials). Either lets a hash or anchor commit to something other than what a verifier checks. The second-order threats are T-30, because a Fiat–Shamir transcript built from an ambiguous encoding may not bind the whole statement, and T-23, T-34 and T-38, because board entries, election definitions and ballots are compared by the hash of their encoding.

## Options

### A. Explicit byte layouts, specified per record

Every record type is a fixed sequence of fields, specified in `docs/spec/` as a table of field, type and length. It is built from a handful of primitives:

- Unsigned integers `u8`, `u16`, `u32`, `u64`: fixed width, big-endian.
- Fixed-length byte strings, such as hashes, field elements in their canonical fixed-length form, and compressed group elements in the curve library's canonical encoding (which the decoder validates, including subgroup membership, per T-39).
- Variable-length byte strings and lists: a `u32` length prefix (element count for lists), with a per-field maximum stated in the spec.
- Every top-level record starts with a 2-byte record type and a 1-byte version. Every hash over a record is prefixed with a registered domain-separation tag (P1-8). There are no optional fields: a different shape is a different version.

Decoding is total and strict. It rejects trailing bytes, lengths over their maximum, non-canonical group or field encodings, unknown types and versions, and out-of-range enum values. `decode(encode(x)) = x` and `encode(decode(b)) = b` for every accepted `b`, both property-tested.

This is the style of the ElectionGuard Design Specification 2.0 (Benaloh and Naehrig, Microsoft Research), which fixes the byte layout and length of every hash input. It also matches Noir's fixed-size arrays and Solidity's fixed-offset calldata reads. Unlike `abi.encodePacked`, which is ambiguous for adjacent dynamic types, every variable-length field carries its length.

- **Pros:**
  - Injective by construction, with a tiny parser surface: a few hundred lines per language, no recursion, no generic decoder.
  - Solidity decodes with fixed offsets and `calldataload`, so gas is predictable. Noir takes the same fields as fixed-size arrays. A third party can implement it from the tables alone.
  - The vectors double as documentation of every byte.
- **Cons:**
  - Each record type needs its own spec table and its own encoder and decoder in each language, so adding a field is a new version, never an edit.
  - It isn't self-describing: a raw blob is meaningless without the spec. Debugging needs a dump tool, which we write once in `packages/verifier`.
  - Variable-length data (option lists, transcripts) needs care with maximums so that Noir and Solidity sizes stay bounded.
- **Threats:**
  - Closes T-31 if the spec and the strict decoders are right. The residual is spec bugs, caught by cross-language vectors and `crypto-review`.
  - Supports T-30, because the Fiat–Shamir input is simply the concatenation of the canonical encodings.

### B. Deterministic CBOR

Records are CBOR maps or arrays with the Core Deterministic Encoding rules of [RFC 8949 §4.2.1](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2.1): preferred (shortest) integer and length forms, definite lengths only, and map keys sorted bytewise lexicographically by their encoding. It can be restricted further by a profile such as [dCBOR](https://datatracker.ietf.org/doc/draft-mcnally-deterministic-cbor/), which pins numeric reduction and forbids duplicate keys. A strict decoder must re-encode and compare, or check each rule as it parses.

- **Pros:**
  - Self-describing and widely known, with good tooling for inspection (`cbor.me`, diagnostic notation).
  - New optional fields are easy, and records nest naturally.
  - COSE and WebAuthn already use CBOR, so the ballot client sees it anyway in passkey attestation.
- **Cons:**
  - "Deterministic" depends on the profile: RFC 7049's canonical ordering (length-first) differs from RFC 8949's (bytewise), and libraries differ in what they accept. Typical generic decoders accept non-preferred integers, indefinite lengths, duplicate keys or non-shortest floats unless configured otherwise. That is exactly the parser differential T-31 names.
  - `packages/crypto` must depend only on `@noble/*`, so we would hand-write a CBOR subset decoder anyway: the same work as option A plus a generic type system.
  - Solidity has no CBOR decoder worth trusting. On-chain direct-submit would need one written and audited, with variable gas.
  - Noir can't parse variable-shape data at all, so circuits would need a second, fixed encoding of the same values. That means two canonical forms, and the ambiguity moves to the mapping between them.
- **Threats:** mitigates T-31 only if every implementation enforces the full profile, which we can't require of third-party verifiers. It weakens T-36 in practice, because an independent verifier that uses a lenient off-the-shelf CBOR library is the likely parser differential.

### C. SSZ (Ethereum Simple Serialize)

The [consensus-layer serialization](https://github.com/ethereum/consensus-specs/blob/dev/ssz/simple-serialize.md): schema-defined, fixed-size fields inline, variable-size fields through 4-byte offsets, and a standard Merkleization (`hash_tree_root`) that gives inclusion proofs per field.

- **Pros:**
  - Canonical by design and specified independently of us, with several implementations and test suites.
  - Merkleization would give per-field inclusion proofs for free, useful for board entries.
  - Familiar to Ethereum verifier authors.
- **Cons:**
  - Offsets add a malleability class that decoders must reject explicitly (overlapping, out-of-order or out-of-bounds offsets). Differential fuzzing of consensus clients has found bugs of exactly this kind.
  - Its Merkleization is SHA-256 over 32-byte chunks, which fits neither Noir circuits (where we'd want a SNARK-friendly hash) nor our own board Merkle design (P1-16) without a second tree.
  - No maintained TypeScript implementation fits the `@noble/*`-only rule, so we'd hand-write the subset again. Solidity support is limited to fixed-size cases.
  - It's a schema system for Ethereum consensus objects, and following its upstream evolution (for example progressive containers) is a dependency on someone else's roadmap.
- **Threats:** comparable to A for T-31 if offsets are validated strictly. It adds an offset-validation attack surface that A doesn't have.

## Recommendation

**Option A: explicit byte layouts.**

- It is the only option that all four consumers (TypeScript, Solidity, Noir, third parties) can decode strictly with short code they write themselves. That is the property T-31 and T-36 need.
- B's self-description and C's Merkleization don't pay for themselves here. We'd hand-write a strict subset of either, keep a second fixed form for Noir anyway (B), or replace its tree (C).
- A is also what ElectionGuard 2.0, the closest published prior art for this kind of verifier, chose for its hash inputs.

These conventions come with A and are specified in P1-8:

- Big-endian integers.
- A `u32` length prefix with a per-field maximum.
- A 2-byte type plus 1-byte version on every top-level record.
- Domain-separation tags on every hash input.
- No optional fields.
- Group and field elements in the canonical fixed-length encoding of the library chosen by the group/hash layer (P1-11).
- Circuit-facing values packed into field elements by a rule stated next to each record, so the in-circuit and off-circuit forms are defined together.

What would change the recommendation:

- If the direct-submit path were dropped (no on-chain decoding) and circuits never consumed encoded records, B's tooling advantage would matter more. The brief requires both, so this is unlikely.
- If an audited, strict, `@noble`-style canonical encoder emerged that every target language already has, it would be worth re-evaluating, but only for new record versions.

## Consequences

- P1-8 writes the primitive table, the record-type and domain-tag registries, the versioning rule (a new version never changes how an old one decodes) and the vector format in `docs/spec/`.
- P1-10 implements strict encoders and decoders in `packages/crypto`, with:
  - round-trip and rejection property tests (fast-check: random bytes must either be rejected or re-encode to themselves);
  - cross-language vectors consumed by Solidity (P1-18) and Noir (P1-17) tests.
- Every record type costs a spec table, vectors and three implementations. That is deliberate: the cost of a new shape falls on us, not on verifiers.
- A dump tool in `packages/verifier` (P1-19) turns any encoded record into a readable form, so the format's opacity doesn't hurt debugging or public audit.
- Known-weak until P1-10 lands: the vectors are the only cross-check between implementations. A bug shared by the spec and our TypeScript encoder would also be in the vectors, so the vectors must be hand-checked against the spec tables, and `crypto-review` reviews spec and vectors together.

## Default

Opened 2026-10-09 06:15 UTC. If the owner hasn't answered by **2026-10-12 06:15 UTC**, option A is adopted and this ADR is marked `Status: accepted by default — revisit`.
