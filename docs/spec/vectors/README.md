# Test vectors

Cross-language vectors for the encodings and computations in this spec. TypeScript (`packages/crypto`), Solidity (`packages/contracts`) and Noir (`packages/circuits`) tests consume them, and so can any third-party verifier (T-36, T-31). Published vectors from outside sources (RFCs, library authors) live in `packages/crypto/test-vectors/` with their source URL and sha256 instead; this folder holds vectors for what this spec defines.

## Files

One JSON file per spec section or record type, named after it (`primitives.json`, `election-definition.json`, …). Each file is UTF-8 JSON, formatted by `vp check`.

| File                          | Covers                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primitives.json`             | Primitive types, record framing and strict-decoding rejections ([[notation]])                                                                                                                                                                                                                                                                             |
| `group.json`                  | `scalar` and `element` codecs: valid boundaries and every rejected class ([[group]])                                                                                                                                                                                                                                                                      |
| `board.json`                  | Board entries, the board tree with every inclusion and consistency proof, checkpoints, board checks ([[board]])                                                                                                                                                                                                                                           |
| `membership.json`             | The nullifier scope, the Semaphore field mapping `F` and the protocol-wide tree depth ([[membership]])                                                                                                                                                                                                                                                    |
| `tier-tree.json`              | circomlib's `Poseidon2`, the empty-subtree chain, tier trees replayed from additions and removals (forbidden and stray ones included), roots and paths ([[membership]], Tier tree)                                                                                                                                                                        |
| `membership-proof.json`       | The pinned depth-32 key and its hash, real Semaphore proofs with snarkjs's verdicts, tampered proofs and signals, and rejected encodings ([[membership]], Verification key, Proof encoding)                                                                                                                                                               |
| `vouch.json`                  | Tier 1 vouches: scopes, messages, a Tier 2 tier tree, and Tier 1 addition records with real Semaphore proofs, honest and refused by each check, and rejected encodings ([[vouching]])                                                                                                                                                                     |
| `keyed-nullifier.json`        | Tier 2's keyed nullifier: the group constants, `J` step by step, `bjj-scalar` and `bjj-point` boundaries and rejections, `HashToScalarBJJ`, share commitments, answers re-made byte for byte from their shares and nonces, answer checks failing each code, and combinations from every `k`-subset with their Lagrange coefficients ([[keyed-nullifier]]) |
| `revoting.json`               | The membership message `M` and `F(M)`, and the selection of counted ballots, ties and repeats included ([[revoting]])                                                                                                                                                                                                                                     |
| `hash.json`                   | `H`, `HashToScalar` under each Fiat–Shamir tag, and `h`, with intermediate bytes ([[group]])                                                                                                                                                                                                                                                              |
| `election-definition.json`    | Election definition version 1: codec, definition hash, self-pin and well-formedness ([[election-definition]])                                                                                                                                                                                                                                             |
| `election-definition-v3.json` | Election definition version 3: codec, definition hash, self-pin and well-formedness, regional cells included ([[election-definition]], Layout (version 3))                                                                                                                                                                                                |
| `election-definition-v4.json` | Election definition version 4: codec, definition hash, self-pin and well-formedness with receipt keys, and the judging rule of a listed key over its L1 record ([[election-definition]], Layout (version 4), Receipt keys)                                                                                                                                |
| `regional-cells.json`         | Regional cells: the fold at and around the floor, and tiers replayed into first-occurrence leaves, region counts, cells, cell-tree roots and paths ([[election-definition]], Regional cells; [[membership]], Cell tree)                                                                                                                                   |
| `display-text.json`           | Display-text record version 1: codec, commitment and well-formedness ([[display-text]])                                                                                                                                                                                                                                                                   |
| `event-accumulator.json`      | The event accumulator: genesis values, event sequences step by step, rejected inputs ([[contracts]])                                                                                                                                                                                                                                                      |
| `election-registry.json`      | Election identifiers the election registry assigns, and inputs with no `u64` encoding ([[contracts]], Election registry)                                                                                                                                                                                                                                  |
| `group-registry.json`         | The group registry's EIP-712 domain and types, addition and removal records with their digests and signed approvals, rejected records and forbidden commitments ([[contracts]], Group registry)                                                                                                                                                           |
| `trustee.json`                | Trustee identity keys and signatures, accepted and rejected; panel identifiers; ceremony-registration statements ([[trustee-identity]])                                                                                                                                                                                                                   |
| `ballot-validity.json`        | Committed votes with the randomness that made them, their validity verdicts, trustees' share checks and codec rejections ([[ballot-validity]])                                                                                                                                                                                                            |
| `share-encryption.json`       | Trustee KEM keys, share ciphertexts with the randomness that made them, decryptions, postings and complaints with their verdicts, and codec rejections ([[share-encryption]])                                                                                                                                                                             |
| `share-receipt.json`          | Ballot hashes; each seat's intake of the share-encryption ballots with its share receipt, intakes failing each check, and receipt checks ([[ballot-validity]], Ballot hash; [[share-encryption]], Intake and receipts)                                                                                                                                    |
| `ballot.json`                 | Ballot records (`0x0002`) with real Semaphore membership proofs: encodings, ballot hashes, `M`, the derived signals, snarkjs's verdicts, admission results and decode rejections ([[ballot-validity]], Ballot record)                                                                                                                                     |
| `delivery.json`               | Share receipts, postings and complaints as records, their decode rejections, board entries under version 3, the deadline segments and deadlines, and elections with the delivery check's verdicts ([[delivery]])                                                                                                                                          |
| `tally.json`                  | Cell aggregates, trustees' per-ballot and summed shares with their check verdicts, combined seats, Lagrange coefficients and openings; published openings with the verifier's verdicts; a derived total ([[tally]])                                                                                                                                       |
| `tally-opening.json`          | Tally openings (record type `0x0006`): signed records re-made byte for byte, decode rejections, and elections with the verifier's per-cell verdicts and attributions ([[tally]], Opening record)                                                                                                                                                          |
| `summed-share.json`           | Summed-share messages (record type `0x000b`): messages re-made byte for byte from their randomness with every intermediate value, decode rejections, and each of the recipient's checks failing ([[tally]], Summed-share message)                                                                                                                         |
| `destruction.json`            | Destruction statements (record type `0x000f`): statements re-made byte for byte, decode rejections, and the verifier's report over a board's statements ([[tally]], Destruction), and board-entry envelopes under versions 1, 3 and 4                                                                                                                     |
| `receipt.json`                | Receipts: the record and its signed statement, rejected encodings and the checks at cast ([[receipts]])                                                                                                                                                                                                                                                   |
| `challenge.json`              | Spoiled-ballot openings (record type `0x0003`): openings re-made byte for byte from their randomness, with core hashes and votes; openings outside the rules; every check failing and the order; decode rejections; cast ballots' core hashes ([[challenge]])                                                                                             |
| `ceremony.json`               | Key-ceremony transcripts: honest runs with the secrets that made them, every seat disqualification and transcript-level failure, the registered key sets and hashes, and decode rejections ([[ceremony]])                                                                                                                                                 |
| `circuit.json`                | Circuit-facing values: each registered tag's field element and the two byte packings ([[notation]], [[domain-separation]])                                                                                                                                                                                                                                |
| `identity-backup.json`        | Identity secrets at their boundaries and their sampling, the PRF salt, backups with their keys, locator, row id, associated data and envelope, and envelopes that don't open, with their codes ([[identity-backup]])                                                                                                                                      |
| `l1-anchor.json`              | Board anchors read from L1 state: Anvil's raw headers and `eth_getProof` trie nodes for a deployed board anchor, with the anchors a verifier reads or the code it stops with ([[verifier]], Anchors from L1; [[contracts]], Board anchor)                                                                                                                 |
| `verifier-ceremony.json`      | The verifier's key-ceremony checks: definitions, board copies and pinned panels, with the rows 2.5, 3.1 and 3.2 (and 2.3's profile combination for board-entry versions 3 and 4) and what the transcript check found ([[verifier]], Key ceremony)                                                                                                         |

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
| `p256-key`                        | none; the value is the key's 33-byte compressed encoding ([[trustee-identity]], Identity key), in hex                                 |
| `list`                            | `max`, as a JSON number, and `of`: the element's type descriptor                                                                      |
| `record`                          | `recordType` (4 lowercase hex digits), `version` (a JSON number) and `fields`: an array of `{ "name", "type" }` in encoding order     |
| `struct`                          | `fields`: as for `record`. A structure nested in a record, with no header; its value is a JSON object keyed by field name             |
| `ref`                             | `name`: a key of the file's `types`; the descriptor it names                                                                          |

## Record vectors

`election-definition.json` and `display-text.json` add members to their vectors:

- In `election-definition.json`, a `0x0001` record is decoded the two-step way of [[election-definition]] (Decoding), so its own profile's pin is checked and can fail with `profile-mismatch`. Each valid vector carries `hash`, the definition hash, and `stubHash`, the stub hash, both as lowercase hex.
- In `display-text.json`, each vector carries `pinned`, the version the election's profile pins, and is decoded against it ([[notation]]: the pin is checked before the version is looked up). Each valid vector carries `commitment`, the display-text commitment as lowercase hex, and `definition`, the definition fields it is checked against: `optionCount` (a decimal string) and `displayTextCommitment` (hex).
- `election-definition-v3.json` and `election-definition-v4.json` are read the same way as `election-definition.json`. `election-definition-v4.json` also has `judging`: one listed key's record and the election's opening, each with `id`, `note`, and `registeredAt`, `retiredAt`, `opensAt` and `provenAt` (the timestamp of the L1 block the record was read at), all decimal strings, and either `judgement` (`judges`, `unregistered`, `retired` or `unsettled`; [[election-definition]], Receipt keys) or `error`: `impossible-record`, a record the anchor can't hold at that block (written after it, or retired without a registration before the retirement).
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

## Group-registry vectors

`group-registry.json` covers [[contracts]], Group registry, with its own format, `abolish-group-registry-vectors/1`, and the same top-level fields, plus:

- `domain`: the EIP-712 domain (`name`, `version`, `chainId` as a JSON number, `verifyingContract` hex), its `typeHash` and `separator`. Every record below is signed under it.
- `types`: `AddMembers` and `RemoveMembers`, each with its `type` string and `typeHash`.
- `constants`: `maxBatch`, `maxRegistrars`, the field modulus `r` and `Poseidon2(0, 1)` (hex).
- `registrars`: the `threshold`, the test `secretKeys` (32 bytes big-endian, hex; never real keys), their `addresses` in ascending order, as the registry pins them, and an `outsiderSecretKey` no registrar holds.
- `commitments`: values (32 bytes, hex) at the forbidden boundaries, each with `forbidden`.
- `additions` and `removals`: valid records. Each has `id`, `description`, `groupId`, `tier`, `firstIndex` (additions) or `size` and `indices` (removals) as JSON numbers (some exceed 2⁵³, so a consumer reads them exactly, not as doubles), `commitments` (hex, additions), `structHash`, `digest`, `record` (hex) and `approvals`: each with `seat`, `r` and `s` (hex), `v` and `signer`, the address `ecrecover` returns. Signatures are RFC 6979 (HMAC-SHA-256) over the digest, low-s, so a deterministic signer reproduces them byte for byte.
- `rejected`: records breaking one stateless rule, each with `id`, `kind` (`add` or `remove`), `description`, `record` and `error`: `length`, `batch`, `forbidden-commitment`, `index-order` and `index-range` (removals: an index not above the one before, or not below `size`), `approvals` (fewer than the threshold), `seat` or `signature`, the last two with the failing `seat`. The rules that need the registry's state (the group, the position, an index already removed) are tested against the contract instead.
- `sequences`: histories of group 0 as a verifier replays them ([[contracts]], Group registry, Verification). Each has `id`, `description`, `groupId`, `records` (each with `kind`, `add` or `remove`, and `record`, hex, in log order) and either `count` (additions), `leaves` (hex, `0` for a removed member) and `groupSize`, or `error` (`group-history`) with `at`, the first failing record's position, and `reason`: a record error code above, `group` (a record of another group), `position` (a `first_index` other than the replayed count), `size` (a removal's `size` above it) or `removed` (an index already removed). `omitted-tail` and `omitted-removal` replay cleanly: they show the residual a replay can't catch. `two-faults` fixes the report order.

## Membership vectors

`membership.json` covers [[membership]] with its own format, `abolish-membership-vectors/1`, and the same top-level fields, plus:

- `fieldMap`: `F`. Each has `id`, `input` (32 bytes, hex), `keccak256` (the Keccak-256 digest of `input`, hex) and `output` (`F(input)`, decimal).
- `depth`: the protocol-wide tree depth, as a JSON number.
- `scopes`: the nullifier scope. Each has `id`, `definitionHash` and `root` (32 bytes each, hex; `root` is read big-endian), `tier` (a JSON number) and either `scope` (`S_g`, hex) and `scopeField` (`F(S_g)`, decimal), or `error`: `non-canonical` for a root that isn't a canonical `field<bn254>`, `zero-root` for a root of 0 ([[membership]], Statement), `unknown-tier` for a tier other than 0, 1 or 2.

`tier-tree.json` covers [[membership]], Tier tree, with format `abolish-tier-tree-vectors/1` and the same top-level fields, plus `depth`, and:

- `poseidon2`: circomlib's `Poseidon2`. Each has `id`, `inputs` (two decimal field elements) and `output` (decimal).
- `zeros`: `Z_0` to `Z_32`, decimal.
- `trees`: groups replayed under the lenient rules of Commitments and removals. Each has `id`, `note`, `events` (in order, each `{"add": c}` with `c` a decimal `uint256`, possibly forbidden, or `{"remove": i}` with `i` a decimal leaf index, possibly stray), the resulting `leaves` (decimal, `0` for a removed or forbidden addition), `groupSize`, `root` (decimal), `emptyRoot` (whether `root = Z_32`, which fails a definition listing the tier) and `paths`: up to three members' `index` and `siblings` (32 decimal values, bottom up).

`membership-proof.json` covers [[membership]], Verification key, Proof encoding and Verification, with format `abolish-membership-proof-vectors/1` and the same top-level fields, plus `source` (Semaphore's commit and the artifacts' URLs and sha256s), and:

- `verificationKey`: `depth`, `encoding` (the 768-byte `vk`, hex), `zkeySha256` and `hash` (`membership_vk_hash`, hex).
- `definitionHash` (hex) and `trees`: each tree's `id`, `tier`, `leaves` and `root` (decimal), which a verifier rebuilds.
- `fieldMapping`: `scopeBytes` (`S_g` over `definitionHash`, the `tier` and the `root`) with `scope` (`F(S_g)`), or `messageBytes` with `message` (`F(M)`), all from Semaphore's own `hash`.
- `proofs`: each has `name`, `note`, `proof` (256 bytes, hex), `signals` (`root`, `nullifier`, `message`, `scope`, decimal, as given to the verifier), `snarkjs` (snarkjs's verdict), `valid` (the spec's) and, when invalid, `reason`: `proof` (the pairing check fails), `signal` (a signal at or above `r`) or `root` (`ρ = 0`, which snarkjs accepts).
- `decode`: proof encodings every decoder rejects, each with `name`, `note` and `proof` (hex). The errors are `truncated` for `short`, `trailing-bytes` for `long`, and otherwise `non-canonical` at the broken point's offset (0, 64 or 192).

The proofs are randomised: regenerating gives other proof bytes for the same statements, so the committed file is the record.

## Vouch vectors

`vouch.json` covers [[vouching]] with format `abolish-vouch-vectors/1` and the same top-level fields, plus `source` (Semaphore's commit and the depth-32 artifacts' URLs and sha256s), `parameters` (`k` and `slots`, JSON numbers), `context` (`chainId`, decimal, and `registry`, 20 bytes, hex), and:

- `tier2`: the Tier 2 group the vouchers prove against: `groupId` and `rootBlock` (decimal), `leaves` and `root` (decimal), which a consumer rebuilds as a tier tree ([[membership]], Tier tree).
- `scopes`: each has `id`, `kind` (`vouchee` or `slot`), `chainId`, `registry`, either `groupId` and `commitment` (decimal) or `slot` (a JSON number), `scope` (`S_V` or `S_j`, hex) and `scopeField` (`F` of it, decimal, from Semaphore's own `hash`).
- `messages`: each has `id`, `role` (0 or 1), `chainId`, `registry`, `groupId`, `commitment`, `tier2GroupId`, `rootBlock` and `otherNullifier` (decimal), `message` (hex) and `messageField` (decimal).
- `additions`: Tier 1 addition records. Each has `id`, `description`, `context` (as above; some differ from the file's), `groupId` and `commitment` (decimal), `record` (hex) and `valid`; an invalid one has `error`, the first failing check of [[vouching]], Checks of one addition (`forbidden-commitment`, `slot`, `root`, `duplicate-voucher`, `duplicate-slot` or `proof`), `vouch` (the failing vouch's position, except for the first) and, for `proof`, `which` (`vouchee` or `slot`). Every addition also has `snarkjs`: whether every proof in it passes snarkjs's `groth16.verify` with the signals recomputed from the spec. Cases refused by a cheap check have `snarkjs: true`, so each shows its check is needed; `root-zero` carries forged proofs of root 0 that snarkjs accepts. `pooled-slot` is valid (one vouch's two proofs come from two members), and so is `mixed-root-blocks` (its vouches name different root blocks).
- `decode`: records every strict decoder refuses, each with `name`, `record` (hex), `error` (`length` or `non-canonical`) and, for `non-canonical`, `offset` in the record. `two-vouches`, `four-vouches` and `no-vouches` are consistently framed records with a count other than `k`.

The proofs are randomised: regenerating gives other proof bytes for the same statements, so the committed file is the record.

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

## Share-encryption vectors

`share-encryption.json` covers [[share-encryption]] with its own format, `abolish-share-encryption-vectors/1`, and the same top-level fields, plus `tags` (the combiner, associated-data, ciphertext, ephemeral-proof and complaint tags, ASCII) and:

- `panels`: trustee KEM keys by panel name (`panel-3`, `panel-2`, `panel-16`), seat 1 first. Each has `seed` (`d ‖ z`, hex), `x` (decimal) and `publicKey` (the `kem_key` encoding, hex).
- `ballots`: each has `id`, `description`, `context` (as in the ballot-validity vectors), `panel`, `votes`, `randomness` (the sharing polynomials and proof randomness, as in the ballot-validity vectors), `encapsulation` (per seat, `m` hex, and `e` and the proof nonce `w` decimal), `ciphertexts` (hex, seat order), `intermediate` (per seat: `kemSharedSecret`, `dhSharedSecret`, `aeadKey` and `associatedDataHash`, the SHA-256 of `aad`, hex), `shareHashes`, `committedVote` (hex; it passes the validity check) and `decryptions` (per seat, `result`: `"ok"` with `shares` hex, or a decryption code). Four ballots are dishonest: their `intermediate` values are those of the ciphertext actually sent (`aeadKey` is `null` for `copied-ephemeral`'s seat 1, whose seal is garbage).
- `decryptFailures`: decryptions under the wrong context or of altered ciphertexts, all with the `panel-3` keys. Each has `id`, `description`, `definitionHash`, `seat` (in the associated data), `keySeat` (whose secret key decrypts), `vss` (hex), `ciphertext` and `result`.
- `postings`: each has `id`, `description`, `ballot`, `seat`, `ciphertext`, `m` and `result`: `"ok"` or a posting code.
- `complaints`: each has `id`, `description`, `ballot`, `seat`, `ciphertext`, `m` (the posting complained about), `proof` (the `complaint_proof` encoding, hex), `w` (decimal, where the proof is honest and reproducible) and `result`: `"ok"` for a proven complaint, or a posting or complaint code.
- `decode`: each has `id`, `description`, `type` (`kem-key`, `kem-secret`, `share-ciphertext` or `complaint-proof`), `encoding` (hex) and `error`: a decode error code, or `null` for an encoding that must decode and re-encode to itself.

## Share-receipt vectors

`share-receipt.json` covers [[ballot-validity]] (Ballot hash) and [[share-encryption]] (Intake and receipts) with its own format, `abolish-share-receipt-vectors/1`, and the same top-level fields, plus `tags` (the ballot-hash and share-receipt tags, ASCII) and:

- `panels`: by the names of `share-encryption.json`'s panels, each seat's `seat`, `signingSecret` (32 bytes big-endian, hex; test data), `signingKey` (its registered per-election key) and `identityKey` (a key that is never a receipt signer), as `p256-key` encodings, hex.
- `ballotHashes`: each has `source` (`ballot-validity.json` or `share-encryption.json`), `ballot` (the `id` of a valid ballot in that file, whose `context` and committed vote it hashes) and `ballotHash` (hex).
- `intakes`: every seat's intake of every `share-encryption.json` ballot, with that file's KEM keys and this file's signing secrets. Each has `ballot`, `seat` and `result`: `"ok"`, with `ballotHash`, `shareHash`, `statement` (the signed `m`, hex) and `receipt` (the signature, RFC 6979 after the low-s rule, hex), or an intake code.
- `intakeFailures`: intakes by `panel-3`'s seats that fail. Each has `id`, `description`, `context` (as in the ballot-validity vectors), `seat`, `committedVote` (hex), `ciphertext` (hex), `result` (the first failing code) and, for `option-proof`, `option`.
- `receiptChecks`: each has `id`, `description`, `panel` (whose signing keys are registered), `definitionHash`, `ballotHash`, `seat`, `shareHash` (the statement the checker builds, hex), `signature` (hex) and `valid`.

## Challenge vectors

`challenge.json` covers [[challenge]] and [[ballot-validity]] (Core hash) with its own format, `abolish-challenge-vectors/1`, and the same top-level fields, plus `recordType` (`0x0003`), `version` (1), `tag` (the core-hash tag, ASCII) and:

- `panels`: KEM keys by panel name (`panel-3`, `panel-2` and `panel-16` are `share-encryption.json`'s), each seat's `seat`, `seed`, `x` (test data) and `publicKey` (its `kem_key` encoding, hex).
- `elections`: by name, each `definition` (an election definition, hex), `definitionHash`, `panel` and `registered` (the seats of the registered key set; the other seats are outside it).
- `openings`: each has `id`, `description`, `election` (the one it is checked against), `encoding` (hex), `coreHash` (hex) and `result`: `"ok"`, with `votes` (each `v_j`, decimal) and `withinRules` (`false` is `opening-vote-outside`), or the first failing check, with `option` for `opening-vss` and `seat` for `opening-ciphertext`. An opening an honest client made also has `randomness`: `polynomials` (each option's `f` and `g`, decimal) and `encapsulation` (every seat's `m` (hex), `e` and `w` (decimal), registered or not, as the client's encryption draws them), from which `openChallenge` re-makes `encoding`.
- `decode`: rejected encodings, as in the ballot vectors.
- `sharedCommitment`: each has `id`, `description`, `opening` (the `id` of an opening in this file), `core` (`definitionHash`, `tier`, `vss` as its encoding and `shareHashes`, hex), its `coreHash`, and `shared`: whether that core shares a vote commitment with the opening ([[challenge]], Shared commitments).
- `castBallots`: `ballot` (the `id` of an admitted ballot in `ballot.json`) and its `coreHash`.

## Ballot vectors

`ballot.json` covers [[ballot-validity]] (Ballot record) with its own format, `abolish-ballot-vectors/1`, and the same top-level fields, plus `recordType` (`0x0002`) and `version` (1), and:

- `groups`: the tier groups the elections list, plus `outsiders` (a tree no election lists). Each has `id`, `tier`, `secrets` (each member's identity secret `s`, decimal; test data), `leaves` (their identity commitments `Poseidon2(s · B8)`, decimal) and `root` (the depth-32 tier tree's root, decimal).
- `elections`: by name (`plurality`: 3 options, `k = 2`, `n = 3`, tiers 0 and 2; `approval`: 4 options, 1 to 2 selections, `k = 3`, `n = 4`, tier 1). Each has `definition` (the election definition's encoding, hex), `definitionHash` (hex) and `tiers` (each listed tier's `tier`, `group`, `root` and `scope`, `F(S_g)`, decimal).
- `ballots`: each has `id`, `description`, `election` (the one it is checked against), `registered` (the seats of the registered key set), `encoding` (the record, hex; it decodes and re-encodes to itself), `ballotHash` (hex, over the record's own fields) and `result`: `ok` or the first failing admission code, with `option` for `option-proof`. Where the admission check reaches the membership step's inputs (the definition hash and tier match), it also has `message` (`M`, hex), `signals` (`root`, `nullifier`, `message` and `scope`, decimal: the public signals the check derives from the record and the definition) and `snarkjs` (snarkjs 0.7.5's `groth16.verify` on the record's proof with those signals).
- `decode`: each has `id`, `description`, `encoding` (hex), `error` (the decode error code) and, where fixed, `offset`; the pinned version is 1, and the only known record type is `0x0002`.

The proofs are randomised: regenerating gives other proof bytes for the same statements, so the committed file is the record.

## Delivery vectors

`delivery.json` covers [[delivery]] with its own format, `abolish-delivery-vectors/1`, and the same top-level fields, plus `tags` (the share-receipt and share-complaint signature tags, ASCII), `windows` (`delivery` and `complaint`, `DELIVERY_WINDOW` and `COMPLAINT_WINDOW` in seconds, decimal), `definitionHash` (every election's, hex) and:

- `panel`: a 2-of-3 panel; each seat has `seat`, `kemKey` (its registered `kem_key` encoding, hex; from `share-encryption.json`'s `panel-3` seeds), `signingSecret` (32 bytes big-endian, hex; test data), `signingKey` (its registered per-election key) and `identityKey` (a key that never signs a receipt or complaint), as `p256-key` encodings, hex.
- `records`: valid records, each with `id`, `description`, `type` (`share-receipt`, `share-posting` or `share-complaint`), `encoding` (the full record, hex), `seat` and, for a receipt or complaint, `statement` (the signed `m`, hex); a complaint also has `w` (its proof nonce, decimal). The complaint's signature is RFC 6979 after the low-`s` rule, so it is re-made byte for byte from the seat's `signingSecret`. Each must decode and re-encode to itself.
- `decode`: each has `id`, `description`, `type` (the record it is decoded as), `encoding` (hex) and `error`, the decode error code.
- `boardEntries`: each has `id`, `description`, `version` (1 or 3, the pinned board-entry version), `encoding` (the entry, hex) and `error`: the decode error code, or `null` for an entry that must decode and re-encode to itself.
- `segments`: each has `id`, `epoch`, `period`, `closesAt`, `l1InclusionBound`, the resulting `delivery` (`s_D`) and `complaint` (`s_K`), and `deliveryDeadline` (`t_D`) and `complaintDeadline` (`t_K`), all decimal.
- `elections`: each has `id`, `description`, `registered` (the qualified seats of `panel`), `segments` (`delivery` and `complaint`, decimal), `deadlines` (`delivery` and `complaint`, `t_D` and `t_K` in seconds, decimal), `ballots` (the selected ballots, each with `id`, `tier`, `nullifier` (decimal), `committedVote` (hex; it passes the validity check) and `ballotHash` (hex)), `entries` (the delivery records in the counted extent, in board order, each with `path`: `board`, with `segment`, or `contract`, with `submittedAt` (decimal); and `payload`, hex) and `result`: `ballots` (per selected ballot, in order: `ballotHash`, `counted`, `delivered`, `missing` (seats, ascending) and `excludedBy` (each proven complaint's `at`, `seat` and `signer`, the seat its signature attributes it to or `null`)), `records` (each reported record's `at`, a position in `entries`, and `code`, with `signer` for `share-receipt`, `complaint-unfounded` and `receipt-contradicted`), and `rejected` (each undecodable payload's `at` and `error`).

## Ceremony vectors

`ceremony.json` covers [[ceremony]] with its own format, `abolish-ceremony-vectors/1`, and the same top-level fields, plus `tags` (the ceremony's tags, ASCII) and:

- `election`: the fields every transcript's context is rebuilt from: `l2ChainId` (decimal), `trusteeRegistry`, `electionId` and `stubHash` (hex).
- `panels`: by name (`panel-4`, 3-of-4; `panel-4-k2`, 2-of-4; `panel-2`, 2-of-2; `panel-3`, 2-of-3; `panel-16`, 11-of-16), each with `threshold`, `identitySecrets` (32 bytes big-endian, hex, seat 1 first) and `keys` (the `p256-key` encodings, hex).
- `transcripts`: each has `id`, `description`, `panel`, `transcript` (the record's full encoding, hex) and `result`, the transcript check's output: `ok`; for a valid transcript, `hash` (the transcript hash), `seats` (every panel seat with its `reasons`, empty for a qualified seat) and `registered` (each qualified seat's `index`, `kemKey` and `signingKey`, hex); otherwise `code`, with `seats` for `ceremony-quorum`. The honest runs (`honest-4`, `honest-2`, `honest-16`, `absent`) also carry `runId`, `context` and, per seat taking part, `kemSeed` (hex), `kemX` and `pokNonce` (decimal), `signingSecret` (hex) and `challengeSecrets` (the `μ`s in target order, hex), from which every message is reproduced byte for byte (ECDSA nonces are RFC 6979's).
- `decode`: each has `id`, `description`, `transcript` (hex) and `error`, the decode error code; the context is `panel-2`'s.

## Tally-opening vectors

`tally-opening.json` covers [[tally]] (Opening record, Opening checks) with its own format, `abolish-tally-opening-vectors/1`, and the same top-level fields, plus `tag` (the signature tag, ASCII), `recordType` and `version`, and:

- `election`: what every opening below is checked against: `definitionHash` (hex), `rules` (`optionCount`, `threshold`, `panelSize`) and `registered` (each qualified seat's `index` and per-election `signingKey`, hex).
- `openings`: signed tally openings. Each has `id`, `description`, `signingSecret` (32 bytes big-endian, hex; test data), `signingKey`, `definitionHash`, `cell`, `aggregateHash`, `signer`, `opening` (`v` and `r` decimal, per option), `message` (the signed `m`, hex), `signature` (RFC 6979 after the low-s rule, so a deterministic signer reproduces it) and `encoding` (the record, hex).
- `decodeErrors`: each has `id`, `description`, `encoding` (hex), `error` (the decode error code) and `offset`; the known type is `0x0006`, version 1, which is also the pinned version.
- `elections`: each has `id`, `description`, `cells` (per cell in partition order, each counted ballot's `vss` encoding, hex), `openings` (the tally-opening payloads on the board, in board order, hex; some don't decode), optionally `boardedAfter` (per cell, ballots boarded after the counted extent that the re-vote rule would select, which never enter `cells`; counting them would fail the cell's honest openings as `tally-aggregate`) with `electionFailure` (`code`, `tally-late`, and `attributedTo`, `operator`: the late ballots change a counted set, so the election fails though `result`, the tally check over the counted extent, passes) and `result`: `ok`; `failure` (`cell`, `code` and, for `tally-opening` and `tally-range`, `option`) when not ok; `cells`, each with `ok`, `counts` (decimal) or `code` and `option`, `passing` (`at`, the opening's position in `openings`, and `signer`, the seat its signature attributes it to or `null`) and `failing` (the same, with `code`, one of `tally-missing`, `tally-aggregate` and `tally-opening`, and `option` for `tally-opening`); `stray`, the openings of no cell, with `at` and `signer`; and `rejected`, the payloads that don't decode under the pinned version, with `at` and `error`.

## Summed-share vectors

`summed-share.json` covers [[tally]] (Summed-share message) with its own format, `abolish-summed-share-vectors/1`, and the same top-level fields, plus `recordType`, `version` and `tags` (`kem`, `aad` and `signature`, ASCII), and:

- `election`: what every message is checked against: `definitionHash` (hex), `rules` (`optionCount`, `threshold`, `panelSize`), `cells` (per cell in partition order, each counted ballot's `vss` encoding, hex; each cell's aggregate and `aggregate_hash` follow from them) and `registered` (each qualified seat's `index` and per-election `signingKey`, hex). Seat 4 holds keys but isn't registered.
- `seats`: per seat, `index`, `kem` (`seed` hex, `x` decimal and `publicKey`, the `kem_key` encoding, hex; test data), `signingSecret` (32 bytes big-endian, hex; test data) and `signingKey`.
- `messages`: honest messages. Each has `id`, `description`, `cell`, `aggregateHash`, `sender`, `recipient`, `summed` (`v` and `r` decimal, per option), the sender's randomness `mu` (hex) and `e` (decimal), and the values it makes: `ctM`, `ctDh`, `ssM`, `ssDh`, `key` (`K`), `aad`, `plaintext`, `signed` (the bytes signed), `signature` (RFC 6979 after the low-s rule) and `encoding` (the record), all hex. The recipient's check passes with `summed`.
- `decodeErrors`: each has `id`, `description`, `encoding` (hex), `error` (the decode error code) and `offset`; the known type is `0x000b`, version 1. Each is also `summed-malformed` at seat 2.
- `receiving`: each has `id`, `description`, `recipient` (the seat checking it, with its `kem` secret from `seats`), `encoding` (hex) and `result`: `ok`, or the first failing code of [[tally]], Receiving.

## Destruction vectors

`destruction.json` covers [[tally]] (Destruction, Destruction checks) with its own format, `abolish-destruction-vectors/1`, and the same top-level fields, plus `tag` (the signature tag, ASCII), `recordType` and `version`, and:

- `election`: what every statement is checked against: `definitionHash` (hex) and `registered` (each qualified seat's `index` and per-election `signingKey`, hex). Seat 3 holds a key but isn't registered.
- `statements`: signed statements. Each has `id`, `description`, `signingSecret` (32 bytes big-endian, hex; test data), `signingKey`, `definitionHash`, `signer`, `message` (the signed bytes, header included, hex), `signature` (RFC 6979 after the low-s rule) and `encoding` (the record, hex).
- `decodeErrors`: each has `id`, `description`, `encoding` (hex), `error` (the decode error code) and `offset`; the known type is `0x000f`, version 1.
- `reports`: each has `id`, `description`, `firstPassing` (per cell, the segment of its first passing opening, or `null`), `windowSegment` (`s_T`), `entries` (the destruction-statement payloads in the sealed extent, in board order, each with its `segment` and `payload`, hex; some don't decode) and `result`: `from` (the destruction segment), `seats` (per registered seat, `seat`, `code` and, unless it is `destruction-missing`, `at`), `duplicates` (`at`, `seat`), `unattributed` (`at`), `stray` (`at`, `signer` or `null`) and `rejected` (`at`, `error`); every `at` is a position in `entries`.
- `boardEntries`: board-entry envelopes under version 1, 3 or 4, in the shape of `delivery.json`'s: version 4 carries a destruction statement and still refuses a share posting, a summed-share message, a voter's receipt and a definition; versions 1 and 3 refuse the statement.

## Circuit vectors

`circuit.json` checks computations, so it has its own format, `abolish-circuit-vectors/1`, with the same top-level fields, plus:

- `tags`: `tag_field` ([[domain-separation]], In-circuit hashes). Each has `tag` (ASCII), `digest` (the SHA-256 digest under `abolish/v1/circuit-tag`, hex) and `field` (decimal). They cover every registered tag to test the derivation; only a tag registered In-circuit may be used in a circuit. A tag registered after the file was generated may have no vector yet; consumers check the ones present.
- `packBytes`: `bytes[N]` packing ([[notation]], Circuit-facing values). Each has `id`, `bytes` (hex; `N` is its length) and `fields` (decimal strings).
- `packBoundedBytes`: `bytes<M>` packing. Each has `id`, `max` (`M`, a JSON number), `bytes` (the content, hex) and either `fields` (the length, then the packed padded content, decimal strings) or `error`: `too-long` for content longer than `M`. A Noir consumer passes the content zero-padded to `M` bytes, and checks that a non-zero padding byte fails.

## L1 anchor vectors

`l1-anchor.json` checks reading the board anchor from L1 state, so it has its own format, `abolish-l1-anchor-vectors/1`, with the same top-level fields, plus `clock` (the anchor's clock with `lastSegment`, as in `board.json`), `electionId` (hex) and `vectors`. The generator deploys the board anchor on Anvil with `board.json`'s clock and anchors `board.json`'s `valid` board, and a second anchor holds a segment-4 checkpoint with another head. Headers, block hashes and trie nodes are Anvil's own, from an implementation that shares no code with ours; the expected anchors are the checkpoints the generator sent. Each vector has:

- `id`, `description`;
- `block`: `header` (the raw RLP header, hex), `number` and `timestamp` (decimal), and `hash` (hex) unless the header was changed;
- `anchor` (the address, hex), `firstSegment` (decimal), `nodes` and `checkpoints`: a format-2 bundle's `l1` member ([[verifier]], Bundle);
- `copy`: the `board.json` board whose entries make `board.bin`, cut to its first `copyEntries` entries when that member is present (beside `result`);
- `result`: either `anchors` (each `segment`, `hash` and `source`, in segment order) or `error` (the L1 code and, for `l1-checkpoint-unknown`, its `segment`);
- `board`, beside `result` and only with `anchors`: `"ok"` if 4.1 and 4.2 pass, else the board-check code with its `at` members flattened beside it (`{"code": "unanchored", "segment": 0}`).

## Rules

- The record types a file's decoder knows are exactly those that appear as a `recordType` in that file, and the versions it knows of each type exactly those that appear with it; any other type is unknown ([[notation]], Strict decoding).
- A vector, once its layout is frozen ([[versioning]]), is never edited or removed. New vectors are added. `packages/crypto/tests/vectors/trustee-published.json` pins every published `trustee.json` vector by the sha256 of its JSON; a PR that adds vectors there adds their digests in the same PR.
- Every rejection rule in a spec section has at least one invalid vector, and every field type at least one valid vector at each boundary (zero, maximum, maximum plus one where representable). Rejections that need an election's context (`profile-mismatch`) are covered by the record vectors above.
- Generated vectors are checked by hand, or by a second implementation written independently from the spec, before they are committed. The `generator` field says which.

## Identity-backup vectors

`identity-backup.json` covers [[identity-backup]] with its own format, `abolish-identity-backup-vectors/1`, and the same top-level fields, plus `tags` (the five registered tags, as ASCII strings), `order` (`l`, decimal) and `prfSalt` (hex), and:

- `secrets`: each has `id`, `encoding` (hex) and `isSecret`, whether it encodes an identity secret (exactly 32 bytes, `1 ≤ s < l`).
- `sampling`: each has `id`, `draws` (32-byte hex values, in the order the CSPRNG returns them) and `secret`, the value the sampler keeps: the last draw, with its top 5 bits cleared. Every earlier draw is rejected.
- `backups`: each has `id`, `description`, `prfOutput`, `secret` and `nonce` (the inputs), and `wrapKey`, `locator`, `backupId` (the server's row id), `aad` and `envelope` (the 63-byte record), all hex.
- `open`: envelopes that don't give a secret. Each has `id`, `description`, `prfOutput`, `envelope` (hex) and `code`: a decode error code ([[notation]]), `backup-open` or `backup-secret`.
