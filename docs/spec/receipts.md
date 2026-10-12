# Receipts

What a voter keeps after casting through our API, and the check the client runs when it gets one: that the board the operator showed holds the voter's entry (T-25, T-26). It builds on [[board]]'s chain, tree and inclusion proofs, and on [[trustee-identity]]'s signature suite. The choice of design is [[0013-ballot-receipts]]. Threats: T-25 (censorship), T-26 (unprovable drops), T-23 (tampering), T-24 (equivocation), T-31 (one encoding), T-30 (cross-protocol signatures), T-52 (bounded inputs). Notation is from [[notation]]; `H` and `DS` are from [[group]] and [[domain-separation]].

This page specifies the record, its signed statement and the checks at cast. What a receipt is evidence of later, to the voter and to third parties, is P1-13b's (Later checks, below).

## Model

- **The operator signs the board it shows.** Right after appending entry `i`, the operator signs the state of its board of `i + 1` entries: the entry's hash, index and segment, the chain head `link_i` and the tree root `root_{i+1}` ([[board]]). The voter's entry is the last one in that state, so the receipt commits to everything the voter was shown before it, in order.
- **Inclusion is checked at cast.** The receipt carries the audit path of entry `i` in the tree of `i + 1` entries, so the client checks inclusion before telling the voter the ballot was received, with no one else's help.
- **What a receipt is not.** It says nothing about whether the ballot inside the entry is admitted or counts; that is decided by the ballot's content ([[revoting]], Residuals). It isn't on the board, the chain or the archive: it stays with the voter.

## Receipt (record type `0x0004`, version 1)

| Field          | Type                  | Meaning                                                                                                      |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `election_id`  | `bytes[32]`           | The board's election.                                                                                        |
| `index`        | `u64`                 | `i`: the entry's position on the board.                                                                      |
| `segment`      | `u32`                 | The entry's segment.                                                                                         |
| `entry_hash`   | `bytes[32]`           | `entry_hash_i`.                                                                                              |
| `link`         | `bytes[32]`           | `link_i`, the chain head of the board of `i + 1` entries.                                                    |
| `root`         | `bytes[32]`           | `root_{i+1}`, the tree root of the board of `i + 1` entries.                                                 |
| `operator_key` | `bytes[33]`           | The receipt key that signed, as a `p256-key` ([[trustee-identity]], Identity key).                           |
| `signature`    | `bytes[64]`           | A `p256-sig` ([[trustee-identity]], Signatures) on the statement below.                                      |
| `inclusion`    | `list<bytes[32], 64>` | `PATH(i, D[i+1])`: the audit path of entry `i` in the tree of `i + 1` entries ([[board]], Inclusion proofs). |

A decoder rejects an `operator_key` or `signature` that isn't a canonical `p256-key` or `p256-sig` (`non-canonical`), and an `inclusion` of more than 64 hashes (`length-over-max`), before reading any of it (T-52). An audit path in a tree of at most 2⁶⁴ − 1 entries has at most 64 hashes. A receipt is decoded under the version the ballot client's release pins; it has no election profile of its own, since it is never part of an election's data.

The **signed statement** is the first seven fields, encoded in order with no record header:

```
m = election_id ‖ u64(index) ‖ u32(segment) ‖ entry_hash ‖ link ‖ root ‖ operator_key
```

173 bytes, signed as `Sign(operator_key, "abolish/v1/sig/receipt", m)` ([[trustee-identity]], Signatures). The tag makes the signature valid for a receipt only (T-30); the statement binds the election and the position, so it can't be moved to another board or entry; the key is inside the statement, so a signature can't be re-attributed to another receipt key. The audit path isn't signed: it is checkable on its own, and a signer could otherwise make two receipts with different bytes for one statement.

**Receipt keys.** The operator signs receipts with a P-256 key that the ballot client's release pins, as a set (more than one, so a key can be rotated without a release on the day). A receipt signed by any other key is no receipt. Standby keys are held with the same custody as the active key, and a retired key's private part is destroyed. Which key set judges an election's receipts later, and how it is fixed so that no later release can change it, is P1-13b's.

**Signing.** The operator appends entries one at a time ([[board]], Model), so after each append it knows `link_i`, `root_{i+1}` and the audit path. It signs only once the entry is durably stored, so a crash after signing can't lose an entry it acknowledged, and answers the submission with the receipt. It signs no other statement under this tag, and never a statement about an index it hasn't appended. As for trustee keys ([[trustee-identity]], Security notes), a receipt key is used for receipt statements only, never for another tag or protocol, and the board server builds the 173-byte `m` from the entry it appended and computes `H(DS(tag, m))` itself: a key service that signs digests handed to it would let any caller that can reach it forge receipts. A receipt is issued for every ballot appended through our API at a voter's request; whether and when spoiled-ballot openings, which are held and appended sorted at the period's end ([[board]]), get receipts is P1-13's challenge-and-spoil part.

## Checks at cast

The client runs these as soon as it gets the receipt, before telling the voter that the ballot was received. Its inputs are the receipt's bytes, the election identifier it cast in, the payload it submitted (the complete record, header included), the board-entry version the election's profile pins, the pinned receipt keys, and the segments it accepts under [[board]]'s client rule 1, capped at the election's seal (`lastSegment`): rule 1's one-period tolerance never reaches past it, since no later segment is ever anchored. In order, the first failure being the result:

1. `decode`: the receipt doesn't decode strictly as a version 1 receipt (with the [[notation]] code).
2. `receipt-key`: `operator_key` isn't one of the pinned receipt keys.
3. `receipt-signature`: `signature` doesn't verify on `m` under `operator_key` and the tag.
4. `receipt-election`: `election_id` isn't the election cast in.
5. `receipt-segment`: `segment` isn't one the client accepts under client rule 1.
6. `receipt-entry`: `entry_hash` isn't `H(DS("abolish/v1/board-entry", encode(entry)))` for the board entry (record `0x0007`, under the board-entry version the election's profile pins) with this receipt's `election_id`, `index` and `segment`, and the payload the client submitted.
7. `receipt-inclusion`: `inclusion` doesn't verify, by [[board]]'s inclusion-proof procedure, `entry_hash` as entry `index` of the tree of `index + 1` entries with root `root`. An `index` of 2⁶⁴ − 1 always fails here, since the size doesn't fit a `u64`.

A receipt that fails any of these isn't a receipt: the client tells the voter the ballot isn't confirmed, keeps the ballot, and resubmits the identical bytes ([[revoting]], Client rules) or submits it directly (P4-2). These failures aren't alarms: nothing in them is evidence a third party can check, since before step 3 the operator hasn't signed anything, and after it the payload and the accepted segments are known only to the client.

A receipt that passes is kept, with the payload, until the later checks (below) are done with it.

## Later checks

The checks after the segment's deadline against the checkpoints anchored on L1, the check with a copy of the anchored board, and what makes a receipt evidence a third party can check are P1-13b's. Reviews of a first draft fixed what that design must cover:

- **Time.** A receipt carries no time of its own, so a key obtained after an election could otherwise forge evidence against it for good; the evidence a receipt gives must be bounded in time, and a voter's evidence of a real drop must survive that bound.
- **Withheld boards.** An operator can anchor a fork that no checkpoint contradicts from L1 alone and withhold the board until any bound has passed.
- **Keys.** The receipt keys that judge an election must be fixed before voting starts (bound in the election definition, or recorded per election), so a later release can't void receipts, and keys not bound to an election can't forge against it.
- **Presence.** A dropped ballot is shown only by a valid ballot that no admitted entry of the anchored board carries by content (`(tier, ν, M)`); a rejected or re-randomised copy proves nothing either way. That needs P1-12's ballot record.
- **Privacy.** Anything a voter posts or fetches to keep or check evidence must not name the entry to the operator or to the source (T-45, T-11).

Until P1-13b, [[board]]'s client rule 2 is unchanged, and a receipt is the voter's own check at cast.

## Residuals

- **A receipt names the voter's entry,** and so its nullifier: anyone the voter shows a receipt to learns which ballots are the voter's, and sees every re-vote under that nullifier (T-45, [[revoting]], Residuals). A receipt reveals nothing about the vote.
- **Withholding without a receipt.** An operator that never appends a submission gives no receipt; the client sees no receipt and submits directly (P4-2). That leaves no evidence of the refusal itself (T-25).
- **The check at cast shows only the operator's signed claim.** Nothing ties the signed root to a real or anchored board, so the operator, or anyone holding a receipt key or able to make the board server's key service sign, can sign a receipt over a made-up tree for a ballot that is on no board, and the check at cast passes (T-25). Only the later checks ([[board]]'s client rule 2, and P1-13b) catch that; until then the voter can't detect it at cast.
- **The operator's key is online.** It signs every append, so it sits in the board server's KMS, not in cold storage.
