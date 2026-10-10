# Election definition

The election definition fixes everything about an election that a result depends on: its profile, its rules, its electorate, its trustee panel, its timing, where it lives on chain and which display text it commits to. Its hash is registered on L2 before voting opens and bound into every ballot and proof, so none of this can change after voting opens or differ between voters (T-34). This page specifies version 1 of record type `0x0001` ([[versioning]]) and the definition hash. Notation and decoding rules are from [[notation]]. Threats: T-34, T-31, T-30, T-32, T-17, T-28, T-35, T-37, T-16.

Version 1 is a **draft** ([[versioning]], Draft layouts). Fields owned by items not yet written (the panel and ceremony from P1-14, the electorate and verification key from P1-17, the contracts and timing from P1-18) may change in place until those items settle them. A draft layout is never anchored on any chain and never used in a real election.

## Layout (version 1)

| Field                      | Type                  | Meaning                                                                                                                                                                                                                            |
| -------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`                  | `profile`             | The election profile ([[versioning]]): the protocol major version and the record version pinned for each record type (below).                                                                                                      |
| `election_id`              | `bytes[32]`           | Drawn from a CSPRNG through `packages/crypto` when the election is created, before the key ceremony, whose context binds it ([[domain-separation]], Fiat–Shamir). Never reused.                                                    |
| `l2_chain_id`              | `u64`                 | EIP-155 chain ID of the L2 holding the groups, the definition registry, the trustee registry and direct-submitted ballots ([[0004-l2-choice]]).                                                                                    |
| `l1_chain_id`              | `u64`                 | EIP-155 chain ID of the L1 that carries the anchors and the forced-ballot relay.                                                                                                                                                   |
| `election_registry`        | `bytes[20]`           | L2 address of the contract the definition hash is registered with.                                                                                                                                                                 |
| `board`                    | `bytes[20]`           | L2 address of the board contract that accepts direct-submitted ballots.                                                                                                                                                            |
| `trustee_registry`         | `bytes[20]`           | L2 address of the contract the panel's keys and the ceremony transcript hash are registered with.                                                                                                                                  |
| `group_registry`           | `bytes[20]`           | L2 address of the Semaphore group contract holding the electorate's groups.                                                                                                                                                        |
| `l1_anchor`                | `bytes[20]`           | L1 address of the anchor contract (P4-1).                                                                                                                                                                                          |
| `l1_relay`                 | `bytes[20]`           | L1 address of the forced-ballot relay ([[0004-l2-choice]], Close rule).                                                                                                                                                            |
| `election_type`            | `enum8<1, 2>`         | 1 plurality, 2 approval ([[0003-tally-scheme]]). Ranked choice is a later version.                                                                                                                                                 |
| `tally_scheme`             | `enum8<1>`            | 1: homomorphically summed Pedersen commitments, opened per cell from the trustees' summed VSS shares ([[0002-everlasting-privacy]], [[0003-tally-scheme]]).                                                                        |
| `option_count`             | `u16`                 | Number of options in the election's one question. Options are named by index, 0 to `option_count − 1`; only the display text says what they mean ([[display-text]]).                                                               |
| `min_selections`           | `u16`                 | Least number of options a counted ballot selects. 0 allows a blank ballot.                                                                                                                                                         |
| `max_selections`           | `u16`                 | Greatest number of options a counted ballot selects: 1 for plurality, the approval limit for approval. The validity proofs (P1-12) prove the sum of a ballot's selections lies in `[min_selections, max_selections]` (T-28).       |
| `electorate`               | `list<tier_group, 3>` | One entry per tier that may vote (below).                                                                                                                                                                                          |
| `membership_vk_hash`       | `bytes[32]`           | Hash of the membership circuit's verification key, as P1-17 defines it. A verifier compares it with the key it pins for the ballot version the profile names, never verifies under a key taken from here ([[verifier]] 1.3, T-05). |
| `panel_id`                 | `bytes[32]`           | The trustee panel's identifier, as P1-14 defines it from the panel's pinned identity keys, `k` and `n` ([[0006-trustees]]).                                                                                                        |
| `threshold`                | `u8`                  | `k`: how many trustees' shares open a tally.                                                                                                                                                                                       |
| `panel_size`               | `u8`                  | `n`: how many trustees hold shares.                                                                                                                                                                                                |
| `ceremony_transcript_hash` | `bytes[32]`           | `H(DS("abolish/v1/ceremony-transcript", ·))` of the key ceremony's transcript (P1-14), which fixes each trustee's per-election keys. The ceremony runs before the definition exists, so the definition binds its outcome (T-37).   |
| `opens_at`                 | `u64`                 | Opening time, in seconds since the Unix epoch, compared with L2 `block.timestamp`.                                                                                                                                                 |
| `closes_at`                | `u64`                 | Closing time, in the same units. The close rule that uses it, and how `l1_inclusion_bound` enters it, is P1-18's ([[0004-l2-choice]], T-35, T-50).                                                                                 |
| `l1_inclusion_bound`       | `u32`                 | δ, in seconds: how long after `closes_at` the L1 block carrying an ordinary ballot's batch may be ([[0004-l2-choice]], Close rule).                                                                                                |
| `sequencing_window`        | `u64`                 | The L2's sequencing window, in L1 blocks, that the close rule assumes. The verifier re-checks it against the chain's configuration for the whole poll ([[verifier]] 2.6).                                                          |
| `max_sequencer_drift`      | `u64`                 | The L2's maximum sequencer drift, in seconds, that the close rule assumes; re-checked like `sequencing_window`.                                                                                                                    |
| `display_text_commitment`  | `bytes[32]`           | The salted commitment to the election's display text ([[display-text]]).                                                                                                                                                           |

`profile`:

| Field            | Type                   | Meaning                                                                                       |
| ---------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `protocol_major` | `u8`                   | The protocol major version, the `v1` in every tag ([[versioning]]).                           |
| `pins`           | `list<record_pin, 64>` | The version of each record type used in the election, one entry per type, in ascending order. |

`record_pin`:

| Field         | Type  | Meaning                                                     |
| ------------- | ----- | ----------------------------------------------------------- |
| `record_type` | `u16` | A record type from the registry ([[versioning]]).           |
| `version`     | `u8`  | The version every record of that type in the election uses. |

`tier_group`:

| Field           | Type             | Meaning                                                                                                                                    |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tier`          | `enum8<0, 1, 2>` | The identity tier (Tier 0 passkey, Tier 1 vouched, Tier 2 ZK proof of personhood; [[PROJECT_BRIEF]]).                                      |
| `group_id`      | `u64`            | The Semaphore group's identifier in `group_registry`, a counter the contract assigns (P1-18, P3-2).                                        |
| `root`          | `field<bn254>`   | The group's Merkle root at `root_l2_block`. Ballots of this tier prove membership against this root and no other ([[verifier]] 5.1, T-13). |
| `root_l2_block` | `u64`            | The L2 block number at which `root` is the group's root.                                                                                   |
| `group_size`    | `u64`            | The group's member count at `root_l2_block`: the tier's anonymity set, reported with its results ([[verifier]] 8.1, T-16).                 |

Every field is a fixed format: integers, enums, a `field<bn254>`, and `bytes[N]` holding hashes, addresses or a CSPRNG output, so the definition carries no free text and nothing a person chooses as bytes ([[notation]], Result-critical fields; T-17). The election's question and option labels are in its display text.

## Definition hash

```
definition_hash = H(DS("abolish/v1/election-definition", encode(definition)))
```

`encode(definition)` is the record's full canonical encoding, header included. `definition_hash` is what the election registry stores, what the nullifier scope is derived from (P1-17) and what every Fiat–Shamir statement in the election starts from ([[domain-separation]]), so it binds the chain IDs, contract addresses and `election_id` into every proof (T-30, T-32).

## Decoding

A definition carries its own profile, so no version can be pinned before it is read. It is decoded in two steps:

1. Decode the bytes strictly as record type `0x0001` with no pin ([[notation]], Strict decoding).
2. Find the pin for `0x0001` in the decoded `profile.pins`. If there is none, or its version isn't the record's own `version`, reject with `profile-mismatch`.

Step 2 means a definition can only be read under the layout its own profile names, so once a second definition version exists, no one can create an election under a retired layout by labelling it with an older version byte (T-34, T-31; [[verifier]] 2.3).

## Well-formedness

A definition that decodes must also be well formed. Each rule below has a code; a verifier reports the first rule that fails, in this order, and the election fails ([[verifier]] 2.1 to 2.8). These are election checks, never decode errors: the bytes are canonical, but the election they define isn't one this protocol runs.

| Code              | Rule                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol-major`  | `profile.protocol_major` is 1.                                                                                                                                                                         |
| `profile-order`   | `profile.pins` is in strictly ascending order of `record_type`, so no type is pinned twice.                                                                                                            |
| `profile-types`   | The pinned types are exactly the types the election type uses. For plurality and approval that is every type from `0x0001` to `0x0009`. No other type, and nothing from the test range, may be pinned. |
| `profile-version` | Every pinned version is at least 1.                                                                                                                                                                    |
| `option-count`    | `2 ≤ option_count ≤ MAX_OPTIONS` ([[parameters]]).                                                                                                                                                     |
| `selections`      | `min_selections ≤ max_selections ≤ option_count` and `max_selections ≥ 1`. For plurality, `max_selections` is 1 (so `min_selections` is 0 or 1).                                                       |
| `electorate`      | `electorate` is non-empty and in strictly ascending order of `tier`, so each tier appears at most once; no two entries share a `group_id`; every `group_size` is at least 1.                           |
| `panel`           | `1 ≤ threshold ≤ panel_size ≤ MAX_TRUSTEES` ([[parameters]]).                                                                                                                                          |
| `chain`           | `l2_chain_id` and `l1_chain_id` are non-zero and differ; no address is all zeros; the four L2 addresses are pairwise distinct, and so are the two L1 addresses.                                        |
| `timing`          | `opens_at < closes_at`.                                                                                                                                                                                |

Notes:

- **Tally partition.** In version 1 the partition is the tiers only: one cell per `electorate` entry. Because entries are in strictly ascending tier order, no tier is repeated and each cell is exactly one tier; the electorate is the list of tiers, so none is omitted ([[verifier]] 2.8). Regional cells need a later version (P1-15).
- **What well-formedness doesn't check.** Whether the verifier supports each pinned version, and whether any is retired or broken ([[verifier]] 2.3, 8.3); whether the roots, group sizes, panel and ceremony hash match the chain and the board (2.4, 2.5); whether the timing bounds held (2.6); the close rule itself (P1-18).
- **Tally scheme.** Version 1 lists one scheme, which both election types use, so `tally_scheme` needs no rule beyond its enum. A later version that adds a scheme adds a rule pairing schemes with election types.
- **Approval with a minimum.** `min_selections` lets a definition require a non-blank ballot. The validity proof proves the range, so a ballot outside it is rejected at admission ([[verifier]] 5.4).

## Vectors

`docs/spec/vectors/election-definition.json` ([[vectors/README|vectors]]): valid definitions at the boundaries of every field, every decode rejection, the `profile-mismatch` cases of step 2, and one ill-formed definition per well-formedness rule. The display-text record is in `docs/spec/vectors/display-text.json` ([[display-text]]).
