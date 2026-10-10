# Group, hash and hash-to-group

The prime-order group, the protocol hash `H`, the canonical `scalar` and `element` encodings, and how Fiat–Shamir challenges and the second generator `h` are derived. Everything later sections commit to, prove or encrypt lives here. Decided by [[0007-group-and-hash]] (option A). Threats: T-39 (invalid group elements), T-31 (encoding ambiguity), T-30 (Fiat–Shamir), T-15 (`h` with a known discrete log), T-36 (third-party verifiers implement this page alone). Notation is from [[notation]].

## Group

The group is **ristretto255** ([RFC 9496](https://www.rfc-editor.org/rfc/rfc9496)), the prime-order quotient group built on Curve25519. Its order is

```
ℓ = 2^252 + 27742317777372353535851937790883648493
  = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed
```

It has no cofactor and no subgroups other than the trivial ones, so there is no subgroup check anywhere in the protocol. `g` is the RFC 9496 generator (its encoding is `B[1]` of RFC 9496 Appendix A.1). The group is written multiplicatively in the protocol sections (`g^v · h^r`); RFC 9496 writes it additively.

## Encodings

| Type      | Encoding                                                                                           | Rejected (`non-canonical`)                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `scalar`  | 32 bytes, little-endian, the integer value below `ℓ`: RFC 9497 `SerializeScalar` for ristretto255. | A value at or above `ℓ`. It is never reduced: `ℓ` is not a second encoding of 0.                                                             |
| `element` | 32 bytes: RFC 9496 §4.3.2 `Encode`. Decoded by RFC 9496 §4.3.1 `Decode`.                           | Every input `Decode` rejects (a non-canonical or negative field element, a non-square, a negative `x·y`, `y = 0`), and the identity (below). |

- **Identity.** `Decode` accepts the identity, whose only encoding is 32 zero bytes. An `element` field rejects it unless its record table explicitly says the field allows the identity, and the table says why. It is never allowed for a trustee key, a per-election DH key, a DH ephemeral key or `h`: an identity ephemeral makes the DH value trivial, which silently reduces the hybrid share KEM to its post-quantum half alone (T-39). The vector type descriptor is `{ "kind": "element", "identity": "allowed" | "rejected" }`.
- **One encoding per value.** Every group element has exactly one encoding, and `Decode` accepts no other, so `encode(decode(b)) = b` for every accepted `b` (T-31). Elements are compared as decoded values, which for ristretto255 is the same as comparing encodings.
- **Byte order.** Scalars are little-endian, unlike the big-endian integers in [[notation]], to match RFC 9496, RFC 9497 and every library and published vector for this group. `scalar` is its own type, never confused with `field<bn254>` or a `u*`. A small integer used as a scalar (a vote value, a trustee index) is encoded the same way, as a `scalar` or as a `u*`, everywhere within one transcript, and the section that uses it says which.

## The protocol hash `H`

`H` is SHA-256 (FIPS 180-4), with 32-byte output. Every plain hash is `H(DS(tag, m))` ([[domain-separation]]): record hashes, chain links, Merkle nodes, commitments to data. The EVM has a precompile for it and Noir's standard library implements it. Its length-extension property doesn't matter: `H` is never a MAC over a secret, and every input starts with a length-prefixed tag.

## Hash to scalar

```
HashToScalar(m, DST) = OS2IP_LE(expand_message_xmd(m, DST, 64)) mod ℓ
```

`expand_message_xmd` is [RFC 9380](https://www.rfc-editor.org/rfc/rfc9380) §5.3.1 over SHA-512, and `OS2IP_LE` reads the 64 bytes as a little-endian integer. This is RFC 9497 §4.1 `HashToScalar` for ristretto255-SHA512, except that the `DST` is the Abolish tag instead of RFC 9497's `"HashToScalar-" ‖ contextString`. The 512-bit intermediate puts the result within about 2⁻²⁶² of uniform, whatever the shape of `ℓ`.

A **Fiat–Shamir challenge** is `HashToScalar(t, DST = tag)`, where `tag` is the proof's registered Fiat–Shamir tag and `t` is the canonical encoding of the whole statement and every prover commitment, laid out as a table in the proof's own section ([[domain-separation]], Applying a tag). `t` is not framed with `DS`: `expand_message_xmd` binds the `DST` with its own length (T-30).

## Hash to group and `h`

```
hash_to_ristretto255(m, DST) = ElementDerivation(expand_message_xmd(m, DST, 64))
```

This is RFC 9380 Appendix B, with `expand_message_xmd` over SHA-512 and the element derivation of RFC 9496 §4.3.4 (two Elligator maps of 32 bytes each, added).

The second Pedersen generator is

```
h = hash_to_ristretto255("", DST = "abolish/v1/generator-h")
  = 2ac338de551824e59d1a2563c133a8ec81b4007edb867d4e4411a416cc98fa34
```

so no one chose it, and no one knows its discrete log relative to `g` ([[0002-everlasting-privacy]], T-15). `hash.json` publishes the 64 bytes `expand_message_xmd` outputs on the way, and asserts that `h` is neither the identity nor `g` nor `g⁻¹`. RFC 9380 publishes no `hash_to_ristretto255` vectors, so anyone checking `h` checks the two published halves: `expand_message_xmd` (RFC 9380 Appendix K.3) and element derivation (RFC 9496 Appendix A.3).

## DST rules

- Every `DST` is a registered tag ([[domain-separation]]) whose primitive is the construction it's used with: a Fiat–Shamir tag only for `HashToScalar`, a hash-to-curve tag only for `hash_to_ristretto255`. A tag is never used both as a `DST` and inside `DS`.
- A tag used as a `DST` is 16 to 255 bytes long. RFC 9380 §3.1 recommends at least 16 bytes and requires at most 255 (a longer one would be hashed down); the tag grammar alone allows 12.
- Implementations pass the `DST` explicitly. Libraries that default to their own `DST` when it is omitted (`@noble/curves` does) are never called without one; a test in `packages/crypto` checks every call.

## Static Diffie–Hellman

Each proven complaint in the share KEM reveals a DH value under a trustee's per-election key: a static-DH oracle. By Cheon's attack (EUROCRYPT 2006), `d` answers, for `d` dividing `ℓ − 1` (or about `2d` for `d` dividing `ℓ + 1`), cut the key's security by about ½·log₂ `d` bits. [[0007-group-and-hash]] tabulates the small factors of `ℓ ± 1` (`ℓ − 1`: 2², 3, 11; `ℓ + 1`: 2, 5, 7, 103) and the loss: 3.8 bits at 2¹⁰ queries per key, 6.4 bits at 2¹⁷. `packages/crypto/scripts/static-dh-factors.ts` reproduces the factor search (trial division below 2·10⁶, then Pollard's rho for 2²³ iterations on what remains, which would find a factor below about 2⁴⁰ with high probability and finds none), and a test checks the trial-division table. P1-12 and P1-13 keep the queries per trustee key in one election below 2³².

## Test vectors

- [[vectors/README|vectors]]: `group.json` (every valid boundary and every rejected class of `scalar` and `element`) and `hash.json` (`H`, `h` with its intermediate bytes, and `HashToScalar` under each Fiat–Shamir tag with its intermediate bytes). Both are printed by `packages/crypto/scripts/group-vectors.py`, an independent implementation of RFC 9496, RFC 9380 §5.3.1 and RFC 9497 §4.1 that shares no code with `packages/crypto`.
- Published vectors, vendored in `packages/crypto/test-vectors/rfc/` and checked by `packages/crypto`: RFC 9496 Appendix A.1 to A.3, RFC 9380 Appendix K.3 and RFC 9497 Appendix A.1 (ristretto255-SHA512, all three modes). RFC 9496 Appendix A.4 (`SQRT_RATIO_M1`) is checked only through `Decode` and element derivation, because `@noble/curves` doesn't export it.

## For third-party verifiers

Maintained ristretto255 implementations exist for Go (`gtank/ristretto255`), Rust (`curve25519-dalek`) and C (libsodium). libsodium derives an element from 64 uniform bytes but implements neither `expand_message_xmd` nor `HashToScalar`; a verifier built on it writes those from RFC 9380 §5.3.1, and `hash.json`'s intermediate bytes catch a divergence (T-36).
