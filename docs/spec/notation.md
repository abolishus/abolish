# Notation and primitive encodings

Every byte string Abolish hashes, signs, proves over or anchors is built from the primitives on this page, following [[0001-canonical-encoding]] (option A: explicit byte layouts). Record layouts in later sections are tables of these primitives. Threats: T-31 (encoding ambiguity), T-30 (Fiat–Shamir inputs are concatenations of these encodings), T-36 (third-party verifiers implement this page alone), T-17 (result-critical fields are fixed formats).

## Notation

| Notation           | Meaning                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `a ‖ b`            | Concatenation of byte strings `a` and `b`.                                                                                                |
| `len(a)`           | Length of byte string `a` in bytes.                                                                                                       |
| `0x1f2e`           | A byte string written in hexadecimal, two digits per byte, most significant first. In vector files, hex is lowercase with no `0x` prefix. |
| `"abc"`            | The ASCII bytes of a literal string, with no terminator.                                                                                  |
| `u8(x)` … `u64(x)` | The integer `x` encoded as an unsigned integer of that width (below).                                                                     |
| `encode(r)`        | The canonical encoding of value or record `r` under its type.                                                                             |
| `DS(tag, m)`       | Domain-separated hash input for message `m` under a registered tag ([[domain-separation]]).                                               |
| `H(m)`             | The protocol hash function, specified by P1-11 (group and hash layer). Its output is 32 bytes.                                            |
| `[a, b, …]`        | A list, encoded as below.                                                                                                                 |

Indices are 0-based unless a section says otherwise (trustee evaluation points, for example, start at 1).

## Primitive types

| Type                | Encoding                                                                                                                                                                                        | Valid values                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `u8`                | 1 byte.                                                                                                                                                                                         | 0 to 2⁸ − 1                                                                                                                                                                           |
| `u16`               | 2 bytes, big-endian.                                                                                                                                                                            | 0 to 2¹⁶ − 1                                                                                                                                                                          |
| `u32`               | 4 bytes, big-endian.                                                                                                                                                                            | 0 to 2³² − 1                                                                                                                                                                          |
| `u64`               | 8 bytes, big-endian.                                                                                                                                                                            | 0 to 2⁶⁴ − 1                                                                                                                                                                          |
| `bool`              | 1 byte: `0x00` false, `0x01` true.                                                                                                                                                              | Any other byte is rejected (`invalid-enum`).                                                                                                                                          |
| `enum8<…>`          | `u8`, with the allowed values listed next to the field.                                                                                                                                         | Any unlisted value is rejected (`invalid-enum`).                                                                                                                                      |
| `bytes[N]`          | Exactly `N` bytes, no prefix.                                                                                                                                                                   | Any `N` bytes, unless the field restricts them further.                                                                                                                               |
| `field<bn254>`      | 32 bytes, big-endian: an element of the BN254 scalar field, the native field of our Noir circuits under bb and of Semaphore v4.                                                                 | Values below `r` = `0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`. A value ≥ `r` is rejected (`non-canonical`), so each field element has exactly one encoding. |
| `bytes<M>`          | `u32(n) ‖ n bytes`, with `n ≤ M`.                                                                                                                                                               | `n > M` is rejected (`length-over-max`).                                                                                                                                              |
| `utf8<M>`           | As `bytes<M>`; the `n` bytes must be well-formed UTF-8 ([RFC 3629](https://www.rfc-editor.org/rfc/rfc3629)). Used only for display text ([[display-text]]).                                     | Ill-formed UTF-8 is rejected (`invalid-utf8`).                                                                                                                                        |
| `list<T, M>`        | `u32(c) ‖ encode(e₀) ‖ … ‖ encode(e_{c−1})`, where `c` is the element count, `c ≤ M`, and each element is encoded as `T`.                                                                       | `c > M` is rejected (`length-over-max`).                                                                                                                                              |
| `scalar`, `element` | Group scalars and group elements in the canonical fixed-length encoding of the group chosen by P1-11, which also specifies their validation (range, canonicity, subgroup membership, identity). | Defined by P1-11 (`non-canonical`).                                                                                                                                                   |

Rules that apply to every type:

- Integers are fixed width. There are no variable-length integers anywhere in the protocol.
- Every field element (nullifiers, identity commitments, group roots, nullifier scopes, circuit public inputs) is a `field<bn254>`, never a bare `bytes[32]`. Otherwise `x` and `x + r` would be two encodings of one value that a circuit or contract reducing modulo `r` treats as equal, so one nullifier could appear as two (T-04, T-31). Field elements are compared, sorted and deduplicated as decoded values.
- `M` is part of the type. Every `bytes<M>`, `utf8<M>` and `list<T, M>` field in a record table states its `M`. `M` is at most 2³² − 1.
- There are no optional fields, no defaults and no unions. A value that can be absent is a different record version or a different record type ([[versioning]]). Where a field can legitimately be empty, it is a `bytes<M>` or `list<T, M>` of length zero.
- A `utf8<M>` value is compared and hashed as its exact bytes. Decoders don't normalise Unicode; two texts that differ only in normalisation are different texts.

## Records

A record is a top-level encoded object: something hashed, signed, anchored, posted to the board or stored as a file. Every record starts with a header:

| Field         | Type  | Meaning                                                                   |
| ------------- | ----- | ------------------------------------------------------------------------- |
| `record_type` | `u16` | From the record-type registry in [[versioning]]. `0x0000` is never valid. |
| `version`     | `u8`  | The layout version of this record type. `0x00` is never valid.            |

The header is followed by the record's fields in the order of its table, with no padding, separators or alignment. A record's encoding ends exactly where its last field ends.

Structures nested inside a record (an option inside an election definition, a proof inside a ballot) are encoded as their fields in order, with no header of their own. Their layout is fixed by the containing record's type and version.

## Strict decoding

A decoder for a record type takes a complete byte string and either returns one value or rejects. It MUST reject, and MUST NOT repair, guess or skip:

- input that ends before the last field is read (`truncated`);
- bytes left over after the last field (`trailing-bytes`);
- a length or count over the field's maximum (`length-over-max`);
- an unknown `record_type` (`unknown-record-type`), a known type other than the one expected where the record is read (`unexpected-record-type`), or a known type with an unknown `version` (`unknown-version`). A type is known if the registry in [[versioning]] gives it a specified layout; reserved types and the test range are unknown to production decoders. In a vector file, the known types are exactly those that appear as a `recordType` in that file;
- a `bool` or enum value outside its listed values (`invalid-enum`);
- ill-formed UTF-8 in a `utf8<M>` field (`invalid-utf8`);
- a group element or scalar that fails the validation P1-11 specifies (`non-canonical`);
- a record whose version isn't the one the election's profile pins ([[versioning]], `profile-mismatch`). A decoder that knows the election checks this immediately after the header, before any field; the verifier checks it for every record (check 2.3 in [[verifier]]).

Decoding proceeds left to right, and the first failure is the result. Each field is read in full before its content is validated: a `utf8<M>` field whose bytes run past the end of the input is `truncated`, not `invalid-utf8`. A length or count is checked against its maximum before anything it describes is read or allocated, so a hostile length can't exhaust memory (T-52). The codes above are the decode error codes the vector files use ([[vectors/README|vectors]]). A conforming decoder MUST reject exactly the inputs this spec rejects; reporting the same code is required of `packages/crypto` and RECOMMENDED for third parties.

Every accepted byte string `b` re-encodes to itself: `encode(decode(b)) = b`. Every value `x` round-trips: `decode(encode(x)) = x`. Both are property-tested in `packages/crypto` (P1-10), and random byte strings must either be rejected or re-encode to themselves.

## Result-critical fields

A record that affects a result (anything on the board, in an election definition, or in a ceremony or tally transcript) is archived permanently ([[0005-permanent-archive]]). To keep personal data out of permanent storage (T-17, G-12), its fields are restricted to fixed formats: integers, `bool`, enums, `field<bn254>` values, `bytes[N]` holding hashes, salts or identifiers, group elements and scalars, proof structures whose internal layout the spec defines, and bounded lists of these. A result-critical record never contains free text, and never contains a `bytes<M>` field whose contents the spec doesn't define. Human-readable text lives only in display-text records, outside the archive, and the definition commits to it by hash ([[display-text]]).

## Circuit-facing values

Noir circuits take fixed-size arrays of field elements. Each record a circuit consumes states, next to its table, how its fields are packed into field elements, so the in-circuit and off-circuit forms are defined together and can't drift ([[0001-canonical-encoding]]). The packing rules come with P1-11 and P1-17.
