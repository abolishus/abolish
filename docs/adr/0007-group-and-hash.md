# ADR 0007: Prime-order group and protocol hash

- Status: accepted (owner, 2026-10-10: option A)
- Date: 2026-10-10
- Deciders: owner (one-way door)
- Threats addressed: T-39, T-31, T-30, T-15, T-28, T-29, T-36, T-55 (see [[THREAT_MODEL]])

## Context

[[0002-everlasting-privacy]] (accepted, option B) needs "a prime-order group with no cofactor: ristretto255 (RFC 9496) or a prime-order Weierstrass curve, chosen in P1-11". Everything P1-12 to P1-15 build lives in that group: Pedersen commitments `g^v · h^r`, Pedersen VSS commitments, disjunctive Chaum–Pedersen (CDS) validity proofs, the Diffie–Hellman half of the hybrid share KEM with its Chaum–Pedersen complaint proofs, trustee keys and their proofs of possession. The spec skeleton leaves three things to this item: the protocol hash `H` with its 32-byte output ([[notation]]), the canonical `scalar` and `element` encodings and their validation, and how Fiat–Shamir challenges and the second generator `h` are derived ([[domain-separation]]).

What makes this a one-way door: every commitment, proof and key on the permanent board is a group element or scalar, and its record versions are frozen once anchored, testnet included ([[versioning]]). A later change means a new protocol major version and a second verifier code path for every old election.

What the choice does and doesn't affect:

- **Ballot privacy doesn't depend on it.** Under option B, the board's commitments are perfectly hiding in any prime-order group. A discrete-log break (classical or quantum) breaks binding, so it could forge proofs for _new_ statements, but reveals no historic vote (T-15).
- **Soundness does.** CDS and Chaum–Pedersen proofs are sound only while discrete log is hard and the Fiat–Shamir challenge is a uniform scalar bound to the whole statement (T-28, T-29, T-30). Encodings must be canonical, and validation must reject anything outside the group (T-31, T-39).
- **Contracts decode elements but never verify proofs.** [[verifier]] requires our contracts to accept a direct submission only if it decodes strictly, so every element in a ballot (commitments, VSS commitments, proof commitments, DH ephemeral keys) is decoded on-chain, and an invalid or non-canonical one reverts (T-31). That is field arithmetic in Solidity in every option: an inverse square root for ristretto255's `Decode`, a square root for decompressing a SEC1 point, each one modular exponentiation through the `modexp` precompile plus a few field operations. Validity proofs are checked off-chain by the verifier and our servers, and the membership circuit binds the ballot through a hash in its signal, not group operations. So decoding cost is similar across the options and doesn't decide the choice; on-chain proof verification would, and would reopen it for that version.
- **Static Diffie–Hellman.** Each proven complaint reveals a Diffie–Hellman value under a trustee's per-election key, so trustees answer a static-DH oracle whose queries an attacker can induce by posting (ADR 0002, "Static-DH oracle"). Cheon's attack (EUROCRYPT 2006) turns `d` such answers, for `d` dividing `ℓ − 1` (or `ℓ + 1` with about `2d` answers), into recovery of the key in about `√(ℓ/d) + √d` group operations: the loss is about ½·log₂ `d` bits, where `d` is the largest such divisor the number of queries reaches. The table lists the prime factors of `ℓ ± 1` below 2·10⁶ (by trial division) and the loss at 2¹⁰ and 2¹⁷ queries per key, which depends only on those factors and is exact. For larger query counts:
  - **ristretto255:** Pollard's rho (2²³ iterations) found no further factor of either `ℓ − 1` or `ℓ + 1`. Such a run finds a factor below about 2⁴⁰ with high probability, so the loss stays at 6.4 bits for any query count up to about 2⁴⁰ (the bound beyond 2¹⁷ rests on that search; P1-11 publishes the script).
  - **secp256k1 and P-256** have further factors in that range (509879 in secp256k1's `ℓ + 1`; 187019741 in P-256's `ℓ − 1` and 176337611 in its `ℓ + 1`), so their loss keeps growing: about 11 bits at 2²³ queries.

| Group        | Order `ℓ`                 | Small factors of `ℓ − 1`                | Small factors of `ℓ + 1` | Loss at 2¹⁰ queries | Loss at 2¹⁷ queries |
| ------------ | ------------------------- | --------------------------------------- | ------------------------ | ------------------- | ------------------- |
| ristretto255 | 2²⁵² + 2774…8493 (≈ 2²⁵²) | 2², 3, 11                               | 2, 5, 7, 103             | 3.8 bits            | 6.4 bits            |
| secp256k1    | FFFF…4141 (≈ 2²⁵⁶)        | 2⁶, 3, 149, 631                         | 2, 13, 83, 45751, 509879 | 4.9 bits            | 8.4 bits            |
| P-256        | FFFF…2551 (≈ 2²⁵⁶)        | 2⁴, 3, 71, 131, 373, 3407, 17449, 38189 | 2, 5, 1879               | 4.9 bits            | 8.4 bits            |

Generic discrete-log security is about 2¹²⁶ for ristretto255 and 2¹²⁸ for the two 256-bit curves, so after the loss at 2¹⁷ queries all three stay near 2¹²⁰. What bounds the queries is the attacker's side, never the trustee's: the complaint-oracle queries per trustee key, which are the postings per election times the DH ephemerals each posting addresses to one trustee. P1-12 fixes that at one ephemeral per trustee per posting, and P1-13 bounds postings with a per-nullifier posting limit and [[parameters]] with a maximum group size, so that the queries per key stay below 2³², well inside the range the factor search covers. A trustee never refuses to answer a valid complaint: a cap on answers would let an attacker exhaust it with junk postings, after which invalid-share ballots could no longer be excluded, and the tally would fail the VSS check (T-29, T-54).

Rejected before the options: BN254's G1 (cheap on the EVM and native to Semaphore, but its security has fallen to roughly 100 bits since the tower number field sieve, and no contract needs it); integer groups modulo a prime (ElectionGuard, Helios), whose 4096-bit elements would multiply ballot size and on-chain direct-submit cost by about 16 for no gain.

## Options

All three are implemented in `@noble/curves` 2.4.0, which `packages/crypto` may depend on (`@noble/*` only). Its README lists audits by Trail of Bits at 2.3.0 (August 2026, all modules; the README links no public report for this one yet), by Cure53 at 1.6.0 (2024: the ed25519 module and its add-ons, which include ristretto255, and hash-to-curve) and by Trail of Bits at 0.7.3 (2023: the Weierstrass modules, secp256k1 and hash-to-curve).

Common to every option:

- **`H` is SHA-256** (FIPS 180-4), for every plain hash under `DS(tag, m)`: record hashes, chain links, Merkle nodes, commitments to data. It matches the 32-byte output [[notation]] fixed and the IPFS multihash in [[content-addressing]]; NIST CAVP vectors are already vendored and checked (P1-9); the EVM has a precompile for it and Noir's standard library implements it, so a contract or circuit that ever needs a protocol hash can compute the same one. Its length-extension property doesn't matter here: the protocol never uses `H` as a MAC over a secret (keys come from HKDF, P1-12), and every input starts with a length-prefixed tag.
- **Fiat–Shamir challenges are scalars from a wide hash**, never `H(…) mod ℓ`. A 32-byte digest reduced modulo `ℓ` is statistically close to uniform for ristretto255 and secp256k1 (distance about 2⁻¹²⁸) only because their orders sit just below a power of two; for P-256 the distance is 2⁻³². Each option instead names a published hash-to-scalar construction with at least 128 bits of extra output, so uniformity never rests on the shape of `ℓ`.
- **The tag is the RFC 9380 `DST`** for hash-to-group and hash-to-scalar, as [[domain-separation]] already says for hash-to-curve. RFC 9380 §3.1 recommends a `DST` of at least 16 bytes; every tag used as a `DST` must be at least that long (the tag grammar alone allows 12). The `DST` is always passed explicitly: `@noble/curves` falls back to a default `DST` when it's omitted, so the wrappers require it and a test fails if any call omits it.

### A. ristretto255 (RFC 9496)

ristretto255 is the prime-order quotient group built on Curve25519 ([RFC 9496](https://www.rfc-editor.org/rfc/rfc9496)), designed to remove the cofactor-8 pitfalls of Ed25519.

- **Element:** 32 bytes, RFC 9496 `Encode`/`Decode` (§4.3). Decoding is canonical by construction: it rejects non-canonical field encodings and negative or invalid inputs, and every group element has exactly one encoding. There is no cofactor and so no subgroup check. `Decode` accepts the identity (32 zero bytes), so our decoder rejects it unless the record field explicitly allows it. It is never allowed for trustee keys, per-election DH keys or DH ephemeral keys (an identity ephemeral makes the DH value trivial and silently reduces the share KEM to ML-KEM alone), nor as `h`. `g` is the RFC 9496 base point.
- **Scalar:** 32 bytes, little-endian, value below `ℓ`, as RFC 9497 `SerializeScalar` for ristretto255. A value at or above `ℓ` is rejected, never reduced (some `@noble/curves` field decoders reduce on request; ours must not). Little-endian deviates from the spec's big-endian integers, but matches every library and published vector for this group; the type is its own `scalar` type, never confused with `field<bn254>`. A small integer that is used as a scalar (a vote value, a trustee index) is encoded the same way, as a `scalar` or as a `u*`, everywhere within one transcript, and the spec states which for each.
- **Hash-to-group** (for `h`): `hash_to_ristretto255` (RFC 9380, Appendix B) with `expand_message_xmd` over SHA-512.
- **Hash-to-scalar** (for Fiat–Shamir): the construction of RFC 9497 §4.1 `HashToScalar` for ristretto255-SHA512 (`expand_message_xmd` over SHA-512 to 64 bytes, read little-endian, reduced modulo `ℓ`; statistical distance from uniform about 2⁻²⁶²), with our tag as the `DST` instead of RFC 9497's `"HashToScalar-" ‖ contextString`. RFC 9497's vectors therefore check the construction under its own `DST`; our vectors check it under ours.
- **Published vectors:** RFC 9496 Appendix A (generator multiples, invalid encodings, elements from uniform bytes, square root of a ratio); RFC 9380 Appendix K.3 (`expand_message_xmd` over SHA-512); RFC 9497 Appendix A.1 (ristretto255-SHA512, which exercises `HashToGroup`, `HashToScalar` and serialisation end to end). RFC 9380 gives no vectors for `hash_to_ristretto255` itself, so `h` is checked through its two published halves: the `expand_message_xmd` output and the RFC 9496 derivation from those 64 bytes, both published as our own vectors with the steps in between.
- **Pros:** canonical encodings with nothing to validate beyond `Decode`, so the parser-differential and invalid-point classes (T-31, T-39) shrink to "use `Decode`"; the smallest static-DH loss of the three; the same curve and assumptions as X25519, the classical half of X-Wing that ADR 0002's hybrid KEM follows.
- **Cons:** no EVM precompile, so contracts decode it with `modexp` (as they would decompress a SEC1 point) and could never cheaply verify proofs over it; scalars are little-endian; fewer independent implementations than secp256k1 or P-256 for third-party verifiers in some languages (maintained ones exist for Go in `gtank/ristretto255`, Rust in `curve25519-dalek`, and C in libsodium, which other languages bind). libsodium derives an element from 64 uniform bytes but implements neither `expand_message_xmd` nor `HashToScalar`, so a verifier built on it writes those itself; our vectors publish every intermediate value to catch divergence (T-36). 2¹²⁶ rather than 2¹²⁸ generic security.

### B. secp256k1

The Bitcoin and Ethereum signature curve: prime order (cofactor 1) Weierstrass curve over a 256-bit prime field.

- **Element:** SEC1 compressed, 33 bytes (`0x02`/`0x03` and the x coordinate). Validation: the prefix is one of the two, `x` is below the field prime, the point is on the curve. Prime order means no subgroup check. The identity has no compressed encoding, so it can't appear (a protocol value that legitimately becomes the identity, an aggregate commitment say, needs a special case).
- **Scalar:** 32 bytes big-endian, below `ℓ`.
- **Hash-to-group:** `secp256k1_XMD:SHA-256_SSWU_RO_` (RFC 9380).
- **Hash-to-scalar:** RFC 9380 `hash_to_field` with `L = 48` over SHA-256 (as RFC 9497 does for P-256).
- **Published vectors:** RFC 9380 Appendix J.8.1 (the full suite) and K.1/K.2; Wycheproof ECDH vectors including invalid points.
- **Pros:** big-endian like the rest of the spec; implementations in every language Ethereum tooling uses; full hash-to-curve vectors; on-chain tricks (`ecrecover`) exist for a few operations.
- **Cons:** decoding needs decompression and an on-curve check that every third-party verifier, and our contracts, must get right (T-31, T-39; invalid-curve attacks are the classic failure); no identity encoding; slightly larger elements; a larger static-DH loss, which keeps growing with the query count.

### C. NIST P-256

The NIST prime-order curve, natively supported by WebCrypto and by an EVM precompile for signature verification (RIP-7212 on Base, EIP-7951 on Ethereum).

- Encodings, validation and hash-to-group (`P256_XMD:SHA-256_SSWU_RO_`, RFC 9380 Appendix J.1.1) as B; hash-to-scalar as RFC 9497 §4.3 (`hash_to_field`, `L = 48`).
- **Pros:** as B, plus NIST CAVP and Wycheproof vectors, and hardware and WebCrypto support (which this protocol can't use: WebCrypto exposes neither scalar multiplication by arbitrary scalars nor point addition).
- **Cons:** as B; its constants come from an unexplained seed, which some audiences distrust for a citizen-run parallel record; `ℓ − 1` is the smoothest of the three.

## Recommendation

**A, ristretto255, with SHA-256 as `H`, RFC 9380 `hash_to_ristretto255` for `h`, and RFC 9497 `HashToScalar` for Fiat–Shamir.**

Its encoding is canonical by construction and needs no validation beyond `Decode`, which removes the parser-differential and invalid-point failures (T-31, T-39) from every verifier we and third parties write. That matters more here than anywhere else: [[verifier]] asks third parties to reimplement every check, and the board is permanent. It also has the smallest static-DH loss, and shares its curve with X25519, which ADR 0002's hybrid KEM pattern assumes. Its costs are a group EVM contracts can decode only with `modexp` (as for the alternatives) and can't cheaply verify proofs over (they don't need to), little-endian scalars (matched to RFC 9497 and its vectors) and fewer third-party implementations than secp256k1 (enough exist in every mainstream language).

What would change it: a decision to verify CDS or Chaum–Pedersen proofs in contracts (B, or BN254 with a security argument); a requirement that a third party's verifier run in an environment with no ristretto255 implementation; or a published attack on ristretto255's encoding.

## Consequences

P1-11 (this item, in a follow-up PR on the same branch) builds the group and hash layer in `packages/crypto`:

- `@noble/curves` 2.4.0 is added to the catalog and as `packages/crypto`'s second runtime dependency (the `gated` check allows `@noble/*` only).
- [[notation]]: `element` is the 32-byte RFC 9496 encoding, with the identity rejected unless a record field explicitly allows it; `scalar` is 32 bytes little-endian below `ℓ`, rejected otherwise (`non-canonical`), never reduced. [[domain-separation]] requires tags used as a `DST` to be at least 16 bytes.
- [[domain-separation]]: a Fiat–Shamir challenge becomes `HashToScalar(t)` with `DST` = the tag, replacing `H(DS(tag, t))`, and the `generator-h` tag moves from conditional to specified: `h = hash_to_ristretto255("", DST = "abolish/v1/generator-h")`, its derivation published as a vector (with the `expand_message_xmd` output) so anyone can check no one chose it (ADR 0002's requirement); the vector file also asserts that `h` is neither the identity nor ±`g`.
- `packages/crypto` exports strict element and scalar codecs, `H`, `DS`, `HashToScalar` and `hash_to_ristretto255`, as thin wrappers over `@noble/*` with no arithmetic of our own; property tests for both codecs (round trip, `encode(decode(b)) = b`, rejection of every non-canonical input class, including the scalars `ℓ`, `ℓ + 1` and 2²⁵⁶ − 1, and values that read differently in each byte order); a test that every hash-to-group and hash-to-scalar call passes an explicit `DST`; and the published vectors above, vendored under `packages/crypto/test-vectors/` with their sources, tags and sha256s, re-fetched by `vectors-provenance` (the RFC publisher entry already exists).
- `docs/spec/vectors/`: `h`, codec vectors (valid and every rejected class) and hash-to-scalar vectors under our tags, for TypeScript, Solidity and Noir consumers.
- P1-12 addresses exactly one DH ephemeral to each trustee per posting, and P1-13 bounds postings per nullifier so that the queries per trustee key in any one election stay below 2³², which keeps the static-DH loss at 6.4 bits or less with margin below the factor search's 2⁴⁰ reach. Trustees answer every valid complaint; nothing caps answers.
- P1-18 implements RFC 9496 `Decode` in Solidity for direct submissions, tested in Foundry against RFC 9496 Appendix A.2's invalid encodings and our codec vectors, applying the same per-field identity rule as our codec (the vectors include an identity-rejection case for every field type that forbids it), and measures the gas per element and per ballot at the largest option count against the direct-submit limits (T-52). A rough estimate is a few thousand gas per element, dominated by one `modexp`.
- The STATUS item's "subgroup checks" become "canonical decoding": ristretto255 has no subgroups to check.
- Known-weak: no published vector covers `hash_to_ristretto255` in one step; ours are derived from the two published halves.

If B or C is chosen instead, the same list applies with 33-byte compressed elements, an explicit on-curve check with its own negative vectors (Wycheproof), big-endian scalars, the RFC 9380 Appendix J suite vectors, and a special case for the identity.

## Decision

The owner chose A on 2026-10-10, the day the ADR was opened, so the 72-hour default didn't apply.
