# Test vectors

Cross-language vectors for the encodings and computations in this spec. TypeScript (`packages/crypto`), Solidity (`packages/contracts`) and Noir (`packages/circuits`) tests consume them, and so can any third-party verifier (T-36, T-31). Published vectors from outside sources (RFCs, library authors) live in `packages/crypto/test-vectors/` with their source URL and sha256 instead; this folder holds vectors for what this spec defines.

## Files

One JSON file per spec section or record type, named after it (`primitives.json`, `election-definition.json`, …). Each file is UTF-8 JSON, formatted by `vp check`.

| File                       | Covers                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `primitives.json`          | Primitive types, record framing and strict-decoding rejections ([[notation]])                                         |
| `group.json`               | `scalar` and `element` codecs: valid boundaries and every rejected class ([[group]])                                  |
| `hash.json`                | `H`, `HashToScalar` under each Fiat–Shamir tag, and `h`, with intermediate bytes ([[group]])                          |
| `election-definition.json` | Election definition version 1 (draft): codec, definition hash, self-pin and well-formedness ([[election-definition]]) |
| `display-text.json`        | Display-text record version 1 (draft): codec, commitment and well-formedness ([[display-text]])                       |

## Format

```json
{
  "format": "abolish-vectors/1",
  "title": "Primitive types and record framing",
  "spec": "docs/spec/notation.md",
  "generator": "How the vectors were produced and checked",
  "vectors": [
    { "id": "u16-max", "type": { "kind": "u16" }, "value": "65535", "encoding": "ffff" },
    { "id": "u16-truncated", "type": { "kind": "u16" }, "encoding": "ff", "error": "truncated" }
  ]
}
```

Top-level fields:

- `format`: always `abolish-vectors/1` for this layout. A consumer rejects any other value.
- `title`, `spec`: what the file covers and the spec page that defines it.
- `generator`: how the vectors were produced, and how they were checked against the spec tables independently of the encoder that produced them ([[0001-canonical-encoding]], Consequences).
- `vectors`: the list of vectors.
- `draft` (optional): `true` if the file's layouts are drafts ([[versioning]], Draft layouts). Its vectors don't freeze them and may change with the layout.
- `types` (optional): named type descriptors, an object from name to descriptor, which `ref` descriptors point to.

Each vector:

- `id`: unique within the file, lowercase words joined by `-`. Never reused for a different vector.
- `description`: optional, what the vector exercises.
- `type`: the type to decode `encoding` as (below).
- `encoding`: the complete input, as lowercase hex with no prefix. It is the whole input: a decoder that leaves bytes unread fails with `trailing-bytes`.
- Exactly one of:
  - `value`: the vector is valid. Decoding `encoding` gives `value`, and encoding `value` gives `encoding` byte for byte.
  - `error`: the vector is invalid. Decoding `encoding` fails, with this decode error code ([[notation]], Strict decoding).

Values:

- Integers of every width are JSON strings in decimal (`"18446744073709551615"`), so no JSON parser rounds them.
- `bool` is a JSON boolean.
- `bytes[N]`, `bytes<M>`, `utf8<M>` and `field<…>` values are lowercase hex strings of the content bytes, without the length prefix.
- Lists are JSON arrays of element values.
- Records are JSON objects keyed by field name, without the header; the header comes from the `type`.

Type descriptors:

| `kind`                            | Other members                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `u8`, `u16`, `u32`, `u64`, `bool` | none                                                                                                                                  |
| `enum8`                           | `values`: the allowed values, as decimal strings                                                                                      |
| `bytes`                           | either `length` (`bytes[N]`) or `max` (`bytes<M>`), as a JSON number                                                                  |
| `utf8`                            | `max`, as a JSON number                                                                                                               |
| `field`                           | `field`: the field's name (`bn254`)                                                                                                   |
| `scalar`                          | none; the value is a decimal string                                                                                                   |
| `element`                         | `identity`: `"allowed"` or `"rejected"`, whether the field may hold the identity; the value is the element's 32-byte encoding, in hex |
| `list`                            | `max`, as a JSON number, and `of`: the element's type descriptor                                                                      |
| `record`                          | `recordType` (4 lowercase hex digits), `version` (a JSON number) and `fields`: an array of `{ "name", "type" }` in encoding order     |
| `struct`                          | `fields`: as for `record`. A structure nested in a record, with no header; its value is a JSON object keyed by field name             |
| `ref`                             | `name`: a key of the file's `types`; the descriptor it names                                                                          |

## Record vectors

`election-definition.json` and `display-text.json` add members to their vectors:

- In `election-definition.json`, a `0x0001` record is decoded the two-step way of [[election-definition]] (Decoding), so its own profile's pin is checked and can fail with `profile-mismatch`. Each valid vector carries `hash`, the definition hash as lowercase hex.
- In `display-text.json`, each vector carries `pinned`, the version the election's profile pins, and is decoded against it ([[notation]]: the pin is checked before the version is looked up). Each valid vector carries `commitment`, the display-text commitment as lowercase hex, and `definition`, the definition fields it is checked against: `optionCount` (a decimal string) and `displayTextCommitment` (hex).
- `illFormed` (valid vectors only): the bytes decode and round-trip, but the record breaks the well-formedness rule with this code, the first in the spec's order. A valid vector without it is well formed.

## Hash vectors

`hash.json` checks computations rather than codecs, so it has its own format, `abolish-hash-vectors/1`, with the same top-level fields. Each vector:

- `id`, `description` (optional): as above.
- `function`: `H`, `hash-to-scalar` (`HashToScalar(message, DST)`) or `hash-to-group` (`hash_to_ristretto255(message, DST)`), as [[group]] defines them.
- `dst`: the `DST` as an ASCII string, for `hash-to-scalar` and `hash-to-group`.
- `message`: the input, as lowercase hex.
- `uniformBytes`: the 64-byte `expand_message_xmd` output, as lowercase hex, for `hash-to-scalar` and `hash-to-group`.
- `output`: the result: the 32-byte digest for `H`, the `scalar` encoding for `hash-to-scalar`, the `element` encoding for `hash-to-group`.
- `notEqual` (only on `generator-h`): encodings the output must differ from (`identity`, `g`, `minusG`).

## Rules

- The record types a file's decoder knows are exactly those that appear as a `recordType` in that file, and the versions it knows of each type exactly those that appear with it; any other type is unknown ([[notation]], Strict decoding).
- A vector, once its layout is frozen ([[versioning]]), is never edited or removed. New vectors are added.
- Every rejection rule in a spec section has at least one invalid vector, and every field type at least one valid vector at each boundary (zero, maximum, maximum plus one where representable). Rejections that need an election's context (`profile-mismatch`) are covered by the record vectors above.
- Generated vectors are checked by hand, or by a second implementation written independently from the spec, before they are committed. The `generator` field says which.
