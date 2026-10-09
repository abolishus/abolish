# Test vectors

Cross-language vectors for the encodings and computations in this spec. TypeScript (`packages/crypto`), Solidity (`packages/contracts`) and Noir (`packages/circuits`) tests consume them, and so can any third-party verifier (T-36, T-31). Published vectors from outside sources (RFCs, library authors) live in `packages/crypto/test-vectors/` with their source URL and sha256 instead; this folder holds vectors for what this spec defines.

## Files

One JSON file per spec section or record type, named after it (`primitives.json`, `election-definition.json`, …). Each file is UTF-8 JSON, formatted by `vp check`.

| File              | Covers                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| `primitives.json` | Primitive types, record framing and strict-decoding rejections ([[notation]]) |

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

| `kind`                            | Other members                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `u8`, `u16`, `u32`, `u64`, `bool` | none                                                                                                                              |
| `enum8`                           | `values`: the allowed values, as decimal strings                                                                                  |
| `bytes`                           | either `length` (`bytes[N]`) or `max` (`bytes<M>`), as a JSON number                                                              |
| `utf8`                            | `max`, as a JSON number                                                                                                           |
| `field`                           | `field`: the field's name (`bn254`)                                                                                               |
| `list`                            | `max`, as a JSON number, and `of`: the element's type descriptor                                                                  |
| `record`                          | `recordType` (4 lowercase hex digits), `version` (a JSON number) and `fields`: an array of `{ "name", "type" }` in encoding order |

## Rules

- The record types a file's decoder knows are exactly those that appear as a `recordType` in that file; any other type is unknown ([[notation]], Strict decoding).

- A vector, once its layout is frozen ([[versioning]]), is never edited or removed. New vectors are added.
- Every rejection rule in a spec section has at least one invalid vector, and every field type at least one valid vector at each boundary (zero, maximum, maximum plus one where representable).
- Generated vectors are checked by hand, or by a second implementation written independently from the spec, before they are committed. The `generator` field says which.
