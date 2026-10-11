# Test vectors

Cross-language vectors for the encodings and computations in this spec. TypeScript (`packages/crypto`), Solidity (`packages/contracts`) and Noir (`packages/circuits`) tests consume them, and so can any third-party verifier (T-36, T-31). Published vectors from outside sources (RFCs, library authors) live in `packages/crypto/test-vectors/` with their source URL and sha256 instead; this folder holds vectors for what this spec defines.

## Files

One JSON file per spec section or record type, named after it (`primitives.json`, `election-definition.json`, …). Each file is UTF-8 JSON, formatted by `vp check`.

| File                       | Covers                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `primitives.json`          | Primitive types, record framing and strict-decoding rejections ([[notation]])                                                                  |
| `group.json`               | `scalar` and `element` codecs: valid boundaries and every rejected class ([[group]])                                                           |
| `board.json`               | Board entries, the board tree with every inclusion and consistency proof, checkpoints, board checks ([[board]])                                |
| `membership.json`          | The nullifier scope, the Semaphore field mapping `F` and the protocol-wide tree depth ([[membership]])                                         |
| `revoting.json`            | The membership message `M` and `F(M)`, and the selection of counted ballots, ties and repeats included ([[revoting]])                          |
| `hash.json`                | `H`, `HashToScalar` under each Fiat–Shamir tag, and `h`, with intermediate bytes ([[group]])                                                   |
| `election-definition.json` | Election definition version 1: codec, definition hash, self-pin and well-formedness ([[election-definition]])                                  |
| `display-text.json`        | Display-text record version 1: codec, commitment and well-formedness ([[display-text]])                                                        |
| `event-accumulator.json`   | The event accumulator: genesis values, event sequences step by step, rejected inputs ([[contracts]])                                           |
| `election-registry.json`   | Election identifiers the election registry assigns, and inputs with no `u64` encoding ([[contracts]], Election registry)                       |
| `trustee.json`             | Trustee identity keys and signatures, accepted and rejected; panel identifiers; ceremony-registration statements ([[trustee-identity]])        |
| `ballot-validity.json`     | Committed votes with the randomness that made them, their validity verdicts, trustees' share checks and codec rejections ([[ballot-validity]]) |
| `circuit.json`             | Circuit-facing values: each registered tag's field element and the two byte packings ([[notation]], [[domain-separation]])                     |

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

- In `election-definition.json`, a `0x0001` record is decoded the two-step way of [[election-definition]] (Decoding), so its own profile's pin is checked and can fail with `profile-mismatch`. Each valid vector carries `hash`, the definition hash, and `stubHash`, the stub hash, both as lowercase hex.
- In `display-text.json`, each vector carries `pinned`, the version the election's profile pins, and is decoded against it ([[notation]]: the pin is checked before the version is looked up). Each valid vector carries `commitment`, the display-text commitment as lowercase hex, and `definition`, the definition fields it is checked against: `optionCount` (a decimal string) and `displayTextCommitment` (hex).
- `illFormed` (valid vectors only): the bytes decode and round-trip, but the record breaks the well-formedness rule with this code, the first in the spec's order. A valid vector without it is well formed.

## Board vectors

`board.json` covers [[board]] with its own format, `abolish-board-vectors/1`, and the same top-level fields, plus:

- `maxBoardPayload`: `MAX_BOARD_PAYLOAD`, as a decimal string.
- `clock`: the anchoring clock the board vectors use (`epoch`, `period`, `deadline`, `lastSegment`, decimal strings; [[board]], Timing). Real elections take theirs from P4-1.
- `entries`: board-entry codec vectors. Each has `id`, `description` and `encoding` (hex), and either `value` (`election_id`, `index`, `segment`, `payload`; integers as decimal strings, bytes as hex) with `entryHash`, or `error` (a decode error code).
- `tree`: `leaves` (32-byte hex, used as `D[n]`), `roots` (the root of every prefix, size 1 first), `inclusion` (`index`, `size`, `path`) and `consistency` (`size1`, `size2`, `path`) for every pair, and `rejected`: proofs that must fail, with `kind` (`inclusion` or `consistency`) and the arguments of that check.
- `boards`: board checks. Each has `electionId`, `now` (the finalized L1 time of the check), `entries` (hex encodings in order, possibly with unauthenticated entries after the anchored extent), `checkpoints` (each anchor: `electionId`, `segment`, `size`, `head`, `root`, its `hash`, and `anchoredAt`, the L1 time it was anchored), and `result`: `"ok"`, with `extent` (how many entries the anchors authenticate) and `links` (their chain links), or `{ "code", … }` with `entry`, `checkpoint`, `segment` or `decodeError` saying where it failed ([[board]], Board checks).

## Hash vectors

`hash.json` checks computations rather than codecs, so it has its own format, `abolish-hash-vectors/1`, with the same top-level fields. Each vector:

- `id`, `description` (optional): as above.
- `function`: `H`, `hash-to-scalar` (`HashToScalar(message, DST)`) or `hash-to-group` (`hash_to_ristretto255(message, DST)`), as [[group]] defines them.
- `dst`: the `DST` as an ASCII string, for `hash-to-scalar` and `hash-to-group`.
- `message`: the input, as lowercase hex.
- `uniformBytes`: the 64-byte `expand_message_xmd` output, as lowercase hex, for `hash-to-scalar` and `hash-to-group`.
- `output`: the result: the 32-byte digest for `H`, the `scalar` encoding for `hash-to-scalar`, the `element` encoding for `hash-to-group`.
- `notEqual` (only on `generator-h`): encodings the output must differ from (`identity`, `g`, `minusG`).

## Event-accumulator vectors

`event-accumulator.json` checks a computation, so it has its own format, `abolish-event-accumulator-vectors/1`, with the same top-level fields, plus `tag` (the registered tag, as an ASCII string) and:

- `genesis`: each has `id`, `description`, `chainId` (decimal string), `address` (20 bytes, hex) and `accumulator`, the genesis value ([[contracts]], Values).
- `sequences`: each has `id`, `description`, `chainId`, `address`, `genesis`, `events` (each `{ "topics": [32-byte hex, …], "data": hex }`, in emission order) and `accumulators`, the value after each event in turn.
- `rejected`: inputs with no accumulator value. `kind` is `genesis` (with `chainId` and `address`: a chain ID with no `u64` encoding) or `step` (with `topics` and `data`: a log with no topics, more than four, or a topic that isn't 32 bytes). A Solidity consumer can't represent a non-32-byte topic and skips it.

## Election-registry vectors

`election-registry.json` checks a computation, so it has its own format, `abolish-election-registry-vectors/1`, with the same top-level fields, plus `tag` (the registered tag, as an ASCII string) and:

- `electionIds`: each has `id`, `description`, `chainId` and `counter` (decimal strings), `registry` (20 bytes, hex) and `electionId`, the identifier ([[contracts]], Election identifier).
- `rejected`: the same inputs with no `electionId`, where `chainId` or `counter` has no `u64` encoding. A Solidity consumer can't represent them and skips them.

## Membership vectors

`membership.json` covers [[membership]] with its own format, `abolish-membership-vectors/1`, and the same top-level fields, plus:

- `fieldMap`: `F`. Each has `id`, `input` (32 bytes, hex), `keccak256` (the Keccak-256 digest of `input`, hex) and `output` (`F(input)`, decimal).
- `depth`: the protocol-wide tree depth, as a JSON number.
- `scopes`: the nullifier scope. Each has `id`, `definitionHash` and `root` (32 bytes each, hex; `root` is read big-endian), `tier` (a JSON number) and either `scope` (`S_g`, hex) and `scopeField` (`F(S_g)`, decimal), or `error`: `non-canonical` for a root that isn't a canonical `field<bn254>`, `zero-root` for a root of 0 ([[membership]], Statement), `unknown-tier` for a tier other than 0, 1 or 2.

## Trustee vectors

`trustee.json` covers [[trustee-identity]] with its own format, `abolish-trustee-vectors/1`, and the same top-level fields, plus `tags` (the panel and registration tags, ASCII) and:

- `keys`: `p256-key` encodings. Each has `id`, `encoding` (hex), an optional `description`, and `secretKey` (the test secret scalar, 32 bytes big-endian; never a real key), or nothing more for a valid key with no known secret (the two points with `x = 0`, which some decoders wrongly reject), or `error`, a decode error code ([[notation]], Strict decoding): `non-canonical`, `truncated` or `trailing-bytes`.
- `signatures`: each has `id`, `key` and `message` (`m`, hex), `dsMessage` (`DS(tag, m)` under the registration tag, hex), `signature` (hex) and `valid`. Valid ones also give `digest` (`H(DS(tag, m))`). All but one are RFC 6979 signatures after the low-s rule, so a deterministic signer reproduces them byte for byte; they include a digest at or above `n` (`sig-digest-at-least-n`). The exception, `sig-x-of-r-at-least-n`, has `x(R) ≥ n` and a key constructed for it with no known secret; it must verify. Invalid ones have a `description`; they cover high `s`, `r` and `s` out of range, a flipped bit, another message, key or tag, wrong lengths, DER, and the signing key's own uncompressed and hybrid SEC 1 forms (valid signatures, rejected only for the key's encoding).
- Two vectors published in the first version are kept unchanged although their names mislead: `key-x-above-p` encodes `x = p` with prefix `0x03` (the same bytes as `key-x-equals-p-prefix-03`; `key-x-p-plus-on-curve-x` is the real aliasing case), and `sig-key-uncompressed` pairs G's uncompressed form with key-1's signature, so it is invalid for two reasons and is superseded by `sig-key-uncompressed-own` and `sig-key-hybrid`, which only the encoding rule rejects.
- `panels`: each has `id`, `threshold`, `keys` (hex, seat 1 first) and either `panelId` (hex) or `error`: `threshold` (`k` outside `2 ≤ k ≤ n`), `size` (`n` over `MAX_TRUSTEES`), `duplicate-key` or `key` (a key that isn't a `p256-key`).
- `registrations`: ceremony registrations signed by a seat of the panel named in `panel`. Each has `id`, `l2ChainId` (decimal), `trusteeRegistry`, `index`, `stubHash`, `ceremonyTranscriptHash`, `message` (the 125-byte `m`) and `signature`, by the key in seat `index`.

## Ballot-validity vectors

`ballot-validity.json` covers [[ballot-validity]] with its own format, `abolish-ballot-validity-vectors/1`, and the same top-level fields, plus `tags` (the statement, option and sum tags, ASCII), `generatorH` (`h`'s encoding, hex) and:

- `ballots`: each has `id`, `description`, `context` (`definitionHash` hex; `optionCount`, `minSelections`, `maxSelections`, `threshold`, `panelSize` and `tier` as JSON numbers; `nullifier` decimal), `encoding` (the committed vote, hex) and `result`: `"ok"`, or `{ "code" }` with the first failing check's code, plus `option` for `option-proof`. Valid ballots also carry what made them, so an implementation reproduces `encoding` byte for byte: `votes`; `randomness`, with `polynomials` (per option, `f` and `g`: the `k` coefficients of `f_j` and `g_j`, constant term first, decimal) and the proof randomness `options` (per option) and `sum`, each `{ "w", "simulated": [{ "c", "z" }] }` (decimal; the simulated branches in branch order, skipping the real one); `shareHashes` (hex, seat order); `statementHash` (hex); and `shares` (each trustee's `list<share>` encoding, hex, seat 1 first).
- `shareChecks`: each has `id`, `ballot` (the `id` of the ballot whose `vss` it is checked against), `index` (the trustee's seat), `shares` (hex) and `valid`.
- `decode`: rejected encodings. Each has `id`, `description`, `type` (`committed-vote` or `shares`), `encoding` (hex) and `error`, a decode error code.

## Circuit vectors

`circuit.json` checks computations, so it has its own format, `abolish-circuit-vectors/1`, with the same top-level fields, plus:

- `tags`: `tag_field` ([[domain-separation]], In-circuit hashes). Each has `tag` (ASCII), `digest` (the SHA-256 digest under `abolish/v1/circuit-tag`, hex) and `field` (decimal). They cover every registered tag to test the derivation; only a tag registered In-circuit may be used in a circuit. A tag registered after the file was generated may have no vector yet; consumers check the ones present.
- `packBytes`: `bytes[N]` packing ([[notation]], Circuit-facing values). Each has `id`, `bytes` (hex; `N` is its length) and `fields` (decimal strings).
- `packBoundedBytes`: `bytes<M>` packing. Each has `id`, `max` (`M`, a JSON number), `bytes` (the content, hex) and either `fields` (the length, then the packed padded content, decimal strings) or `error`: `too-long` for content longer than `M`. A Noir consumer passes the content zero-padded to `M` bytes, and checks that a non-zero padding byte fails.

## Rules

- The record types a file's decoder knows are exactly those that appear as a `recordType` in that file, and the versions it knows of each type exactly those that appear with it; any other type is unknown ([[notation]], Strict decoding).
- A vector, once its layout is frozen ([[versioning]]), is never edited or removed. New vectors are added. `packages/crypto/tests/vectors/trustee-published.json` pins every published `trustee.json` vector by the sha256 of its JSON; a PR that adds vectors there adds their digests in the same PR.
- Every rejection rule in a spec section has at least one invalid vector, and every field type at least one valid vector at each boundary (zero, maximum, maximum plus one where representable). Rejections that need an election's context (`profile-mismatch`) are covered by the record vectors above.
- Generated vectors are checked by hand, or by a second implementation written independently from the spec, before they are committed. The `generator` field says which.
