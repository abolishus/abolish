# Bulletin board

The public bulletin board: the envelope that places a record on it, how its entries are hash-chained and committed to by an append-only Merkle tree, the inclusion and consistency proofs over that tree, how entries are grouped into anchoring segments, and the checkpoints that get anchored on L1. Threats: T-23 (board tampering), T-24 (equivocation), T-31 (encoding ambiguity), T-42 and T-47 (spoiled-ballot openings linked to their cast ballot by position), T-52 (bounded inputs), T-17 (no free text on the board), T-36 (third-party verifiers implement this page alone). Notation is from [[notation]]; `H` and `DS` are from [[group]] and [[domain-separation]].

## Model

- **One board per election.** Every entry names its election. Entries are appended by whoever runs the board (our server, A-2), one at a time, and never changed or removed (T-23).
- **Position.** Entry `i` is the `i`-th entry appended, counting from 0. Its position is part of the entry, and so of its hash.
- **Segments.** Entries are grouped by anchoring period: each entry carries the number of the period in which it was appended, its segment. Segment numbers never decrease along a board. Periods are fixed intervals of L1 time under the anchoring clock (Anchoring, below), whose values P4-1 sets (hourly).
- **Checkpoints.** After each period, the board's state (its size, chain head and Merkle root after that period's segment) is summarised as a checkpoint, and P4-1 anchors it on L1 so that its election and segment can be read there. Every period that adds entries gets one, and a verifier checks every checkpoint anchored for the election. Anyone holding the entries can recompute every checkpoint, and anyone holding a receipt can check it against an anchored checkpoint with a logarithmic-size proof (T-24).
- **What the board doesn't decide.** Whether a ballot or opening counts is decided by the admission checks on the record an entry carries ([[verifier]]), never by the envelope. The board's order matters only where this page says so (openings, below); P1-13's re-vote rule must not depend on the order in which the operator writes unanchored entries ([[verifier]] 6.1, R3).

## Board entry (record type `0x0007`, version 1)

| Field         | Type                       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `election_id` | `bytes[32]`                | The election's identifier: the value the election registry assigns when the election is created, before its key ceremony, which the definition and the ceremony context also bind (P1-10b, P1-14, P1-18). Equal for every entry of a board. It MUST be unique across every election whose checkpoints go through the same anchor contract: P1-18 derives it from the chain ID, the registry's address and the registry's own counter, never a bare counter, so a redeployed registry can't reuse one and have its checkpoints attributed to another election. |
| `index`       | `u64`                      | The entry's position on the board, from 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `segment`     | `u32`                      | The anchoring period in which the entry was appended (P4-1). Never smaller than the previous entry's.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `payload`     | `bytes<MAX_BOARD_PAYLOAD>` | One complete record, header included, of a type allowed on the board (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`MAX_BOARD_PAYLOAD` is in [[parameters]]. The `election_id` and `index` fields make each entry self-identifying, so an entry, or its hash, can't be presented as part of another election's board or at another position (T-23, T-31).

### Allowed payloads

The payload is a complete record whose `record_type` is one of:

| `record_type` | Name                   | Why it is on the board                                                                                        |
| ------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `0x0002`      | ballot                 | A ballot cast or challenged through our API                                                                   |
| `0x0003`      | spoiled-ballot opening | A published Benaloh opening (P1-13); ordered canonically, below                                               |
| `0x0005`      | ceremony transcript    | The key ceremony's public transcript (P1-14)                                                                  |
| `0x0006`      | tally transcript       | The tally (P1-15)                                                                                             |
| `0x0008`      | contract event         | One of our contracts' L2 events, including direct-submitted ballots and the definition's registration (P1-18) |

Any other record type is rejected when the envelope is decoded, with `unexpected-record-type`, including the types [[notation]] would call unknown (`0x0000`, unassigned numbers and the test range): here the envelope fixes the allowed set, so anything outside it is unexpected. The reasons: an election definition reaches the board only as the contract event that registered it, a receipt stays with its voter, a board entry never nests, and display text is never on the board, the chain or the archive ([[display-text]], T-17). A payload shorter than a record header (3 bytes) is rejected with `truncated`. Both errors are reported at the offset of the payload's first byte.

The envelope decoder reads only the payload's `record_type`. Its version and contents are decoded when the record is used, by the admission checks for ballots and openings and by the election checks for transcripts and events ([[verifier]]). A payload that fails there is a rejected entry, listed in the report, and stays on the board: removing it would break every later proof. The board operator MUST append only payloads that decode strictly under the election's profile (our contracts already accept only such records, [[verifier]]): an undecodable payload would put up to `MAX_BOARD_PAYLOAD` arbitrary bytes into the permanent archive (T-17). A verifier can't tell an operator's mistake from a submitter's here, so it reports such an entry as rejected rather than failing the election.

## Entry hash

```
entry_hash_i = H(DS("abolish/v1/board-entry", encode(entry_i)))
```

where `encode(entry_i)` is the entry's full canonical encoding, header included. Receipts (P1-13) name an entry by its entry hash and index.

## Hash chain

The board is hash-chained: each entry's link commits to every entry before it, in order (T-23).

```
link_{−1} = 32 zero bytes
link_i    = H(DS("abolish/v1/board-chain", link_{i−1} ‖ entry_hash_i))
```

The chain head of a board of `n` entries is `link_{n−1}`. A receipt that holds `link_i` commits to the whole prefix the voter was shown, and a checkpoint carries the head, so recomputing the chain from the entries checks order and completeness independently of the tree.

## Board tree

The board's entries are committed to by the Merkle tree of [RFC 9162](https://www.rfc-editor.org/rfc/rfc9162) (Certificate Transparency 2.0), §2.1.1, over the list of entry hashes `D[n] = (entry_hash_0, …, entry_hash_{n−1})`, with its two hash functions replaced by tagged `H`:

```
MTH({d})       = H(DS("abolish/v1/merkle/leaf", d))
MTH(D[n])      = H(DS("abolish/v1/merkle/node", MTH(D[0:k]) ‖ MTH(D[k:n])))   for n > 1
```

where `k` is the largest power of two smaller than `n`, and `D[a:b]` is the list `(d_a, …, d_{b−1})`. RFC 9162 prefixes leaves with `0x00` and interior nodes with `0x01`; the two tags play that role, so no leaf hash can equal an interior node hash for any input (second-preimage resistance of the tree). The tree of an empty board is never used: every checkpoint has at least one entry.

The root of the first `n` entries is `root_n = MTH(D[n])`. A tree is append-only by construction: `root_n` is a function of the first `n` entries alone, so appending entries never changes an earlier root, and a consistency proof shows that one root extends another (below).

### Inclusion proofs

An inclusion proof that entry `i` is in the tree of size `n` (`0 ≤ i < n`) is RFC 9162's audit path `PATH(i, D[n])` (§2.1.3.1): a list of 32-byte hashes. It is verified by RFC 9162 §2.1.3.2, with its `HASH(0x01 ‖ a ‖ b)` replaced by `node(a, b) = H(DS("abolish/v1/merkle/node", a ‖ b))` and its leaf hash by `MTH({·})`:

1. If `i ≥ n`, fail.
2. Set `fn = i`, `sn = n − 1` and `r = MTH({entry_hash_i})`.
3. For each hash `p` in the path, in order:
   - If `sn = 0`, fail.
   - If `fn` is odd, or `fn = sn`: set `r = node(p, r)`; then, if `fn` is even, shift `fn` and `sn` right together until `fn` is odd or `fn = 0`.
   - Otherwise set `r = node(r, p)`.
   - Shift `fn` and `sn` right by one bit.
4. Accept only if `sn = 0` and `r = root_n`.

An inclusion proof binds the root, not the size on its own: the same path can verify for another `n` with the same `root_n` (entry 0 hashes alike in trees of sizes 3 and 4). So a verifier takes each size together with its root from a checkpoint it has already checked, for consistency proofs too, never a size from one source and a root from another.

### Consistency proofs

A consistency proof that the tree of size `m` is a prefix of the tree of size `n` (`1 ≤ m ≤ n`) is RFC 9162's `PROOF(m, D[n])` (§2.1.4.1): empty when `m = n`, otherwise a list of 32-byte hashes. It is verified by RFC 9162 §2.1.4.2, with the same `node`:

1. If `m = 0`, fail. If `m = n`, accept only if the path is empty and `root_m = root_n`. If `m > n`, or the path is empty, fail.
2. If `m` is a power of two, put `root_m` in front of the path.
3. Set `fn = m − 1` and `sn = n − 1`. While `fn` is odd, shift `fn` and `sn` right together.
4. Set both `fr` and `sr` to the first hash of the path. For each later hash `c`, in order:
   - If `sn = 0`, fail.
   - If `fn` is odd, or `fn = sn`: set `fr = node(c, fr)` and `sr = node(c, sr)`; then, if `fn` is even, shift `fn` and `sn` right together until `fn` is odd or `fn = 0`.
   - Otherwise set `sr = node(sr, c)`.
   - Shift `fn` and `sn` right by one bit.
5. Accept only if `fr = root_m`, `sr = root_n` and `sn = 0`.

Every step of either loop shifts `sn` right at least once and fails once `sn` is 0, so a path of more than 65 hashes always fails, and implementations reject one before reading it (T-52).

A voter's client uses these to check that the board it was shown when it cast is a prefix of the anchored one (T-24, T-25):

1. **At cast.** It refuses, and alarms on, an envelope whose `segment` isn't the period current at the cast by the anchoring clock, read from the time of a recent L1 block the client fetched itself (or its own clock if it has none), within a tolerance of one period, so a cast at a period boundary isn't refused. Where its time source is in doubt, it retries rather than alarming. Otherwise the operator could label the entry with a segment that is never anchored, or one far in the future.
2. **After the deadline of its segment `s`.** It reads from L1 itself every timely checkpoint anchored for its election, and checks inclusion of its entry at index `i`, and consistency from the signed size and root in its receipt, against the timely checkpoint for exactly segment `s`, and its receipt's consistency with every later timely checkpoint it sees. It alarms if there is no timely checkpoint for `s` by its deadline (the voter's own segment is never empty, so it must have one), if any timely checkpoint for the election is inconsistent with its receipt, or if more than one distinct timely checkpoint is anchored for a segment, then or at any later check.

How receipts carry the proofs, and how a client raises an alarm, is P1-13's.

## Segments and checkpoints

The segment of period `s` is the run of entries whose `segment` field is `s`. It is empty if nothing was appended in that period.

A **checkpoint** is the board's state after a segment:

| Field         | Type        | Meaning                                                    |
| ------------- | ----------- | ---------------------------------------------------------- |
| `election_id` | `bytes[32]` | The board's election.                                      |
| `segment`     | `u32`       | The period `s` it closes.                                  |
| `size`        | `u64`       | `n`: the number of entries whose `segment` is at most `s`. |
| `head`        | `bytes[32]` | `link_{n−1}`, the chain head.                              |
| `root`        | `bytes[32]` | `root_n`.                                                  |

It is a structure, not a record: it has no header, and it is only ever hashed, as

```
checkpoint_hash = H(DS("abolish/v1/board-checkpoint", encode(checkpoint)))
```

A checkpoint is valid for a board exactly when `size ≥ 1`, the board has at least `size` entries, entry `size − 1` has `segment ≤ s`, the entry after it (if any) has `segment > s`, `head = link_{size−1}` and `root = root_size`. So a checkpoint always ends at a segment boundary, and two valid checkpoints for the same segment are equal. P4-1 never anchors a period while the board is still empty: a checkpoint has `size ≥ 1`, and an anchored empty one fails the election (`checkpoint-size`). A period with no new entries may be anchored again or skipped, but a period that added entries MUST get a checkpoint, so no entry stays unanchored past its period (and, by the timing rule below, anchored within its window).

**Anchoring.** P4-1 anchors each checkpoint through the anchor contract the verifier pins, with its `election_id` and `segment` readable on L1 next to its hash, and the full checkpoint published on L1 in the same transaction (or the checkpoint itself in place of the hash). An anchor counts for an election only if it was sent by that election's anchoring authority: an address the election definition binds, or one the verifier pins (our Safe, say). The contract rejects anchors for the election from anyone else, or, failing that, verifiers and voters' clients ignore them. Otherwise anyone could anchor a bogus checkpoint for an election, or front-run the honest one, and fail it (T-52). P4-1 and P1-18 enforce this. P4-1 decides how one transaction carries several elections' checkpoints, but every anchored checkpoint MUST be attributable to its election and segment from L1 alone. A verifier checks **every** checkpoint anchored for the election, never a selection it was handed: otherwise the operator could anchor a second checkpoint for a forked board, show it only to the voters whose ballots it keeps, and publish the other (T-24). Two different checkpoints anchored for one segment are equivocation, and fail the election. An anchored hash that names the election but can't be matched to a published checkpoint makes the election unverifiable, never verified.

**Timing.** The anchoring clock has four values, set by P4-1 and pinned by the verifier for the election: an `epoch` and a `period` length (period `s` is the L1 time interval `[epoch + s·period, epoch + (s+1)·period)`), a `deadline`, and `lastSegment`, the election's seal: the last period its board may use. The definition fixes it (P1-10b) as the latest end of every post-close window, never only one of them: publishing openings (P1-13), the trustees publishing the tally (P1-15), and our contract events and close-time accumulator data reaching the board after L2 finality (P1-18, [[0005-permanent-archive]]). A tally not boarded by the seal can't be part of a valid board, so the election then has no verifiable result (T-54). An anchor for segment `s` counts only if it is in a finalized L1 block whose timestamp is at or after the end of period `s` and at most `deadline` after it, and `s ≤ lastSegment`. Verifiers and voters' clients ignore every other anchor, and P4-1's contract SHOULD reject them. So an anchor made late can neither fail a closed election nor hide a fork, an entry labelled with a far-off segment can't be anchored late, and every segment with entries must have a timely checkpoint. The seal's own period MUST get a checkpoint, anchored even if nothing was appended in it (it then repeats the board's state): that seal checkpoint authenticates the board's final extent, so a closed election without one fails (`unsealed`), attributably on L1. No anchor ever covers an entry with `segment > lastSegment`, so such an entry is never part of the board.

The **segment object** of period `s` (the bytes [[content-addressing]] turns into a CID and CAR, and [[0005-permanent-archive]] archives) is the concatenation `encode(entry_a) ‖ … ‖ encode(entry_b)` of that segment's entries in index order. Each encoded entry is self-delimiting (fixed-width fields, then a length-prefixed payload), so the object splits into entries in exactly one way. An empty segment has no object.

## Spoiled-ballot openings

Within each segment:

- the entries whose payload has `record_type` `0x0003` come after every other entry of the segment, and
- their payloads are in strictly increasing order, comparing bytes from the first: the first differing byte decides, and a payload that is a prefix of another comes first.

The board operator holds the openings it receives in a period and appends them, sorted, when the period ends, just before the checkpoint. Since every opening payload is distinct in the order, posting an identical opening twice in one segment is impossible.

**What this protects, and what it doesn't.** The rule hides when, within its period, each opening was sent, and stops the operator placing an opening where its position says something (next to another entry, or in arrival order). It does not unlink an opening from the challenged ballot it opens: the opening names that ballot by content, as it must for anyone to check it. That challenged ballot is itself a board entry, posted in the session that cast, so whether _it_ can be linked to the cast ballot (by adjacency, timing or a shared nullifier) is decided by how P1-13 places and builds challenged ballots, not by this rule. P1-13 MUST make a challenged ballot carry nothing that depends on the voter's nullifier, and MUST say how its entry is kept from being tied to the cast ballot, or state the link as a residual in T-47 ([[verifier]] 6.2; T-42, T-47).

## Board checks

A verifier ([[verifier]], checks 4.1 and 4.2) takes the election identifier it expects, the board's entries in index order from wherever it found them, every anchor for the election from the pinned anchor contract (Anchoring, above), the anchoring clock, and `now`: the time of the latest finalized L1 block it has read.

**Only anchored entries are the board.** Entries carry no signature: anyone can write a well-formed entry for any election. What makes an entry part of the board is a timely checkpoint whose size covers it. So the verifier checks exactly the prefix up to the largest size among the counted anchors (its _extent_), and ignores every entry past it, reporting how many it ignored as input it can't authenticate, never as an election failure. No one can fail an election by handing a verifier its board with entries appended (T-53). For a closed election the seal checkpoint fixes the extent.

The checks run in this order, failing at the first problem:

1. Only anchors that are timely (Timing, above) and in finalized blocks up to `now` count. For each, in order: `wrong-election`, then `checkpoint-equivocation`.
2. For each counted anchor, in order: `checkpoint-size`, then `checkpoint-missing`.
3. The copy's raw bytes against the anchors, before anything is decoded: the entry hashes, chain links and tree roots of the prefix are computed from the encodings as held, and for each counted anchor, in order, its `head` and `root` must match (`copy-mismatch`).
4. Each entry of the prefix, in order: `decode`, `wrong-election`, `wrong-index`, `segment-decreased`, `opening-order`.
5. For each counted anchor, in order: `checkpoint-boundary`.
6. `unanchored`, then `unsealed`.

`checkpoint-missing` and `copy-mismatch` say the copy the verifier holds isn't the anchored board: it is too short, or its bytes differ. They are reported as unverifiable from that source, and the verifier tries another copy, never as a failure of the election: a hostile mirror can serve a bad copy, but it can't make an election fail. Only once step 3 has passed is the prefix the anchored board, so every later failure is the operator's. Unverifiable can also mean the anchors themselves are inconsistent (two checkpoints that can't both be prefixes of one board), so that no copy can ever match; that never passes, and the voters' consistency alarms (client rule 2) are what attribute it.

| Code                      | Fails when                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wrong-election`          | An anchor's checkpoint, or an entry, names another election.                                                                                                                                     |
| `checkpoint-equivocation` | Another counted checkpoint for the same `segment`, earlier in the list, differs from it.                                                                                                         |
| `checkpoint-size`         | Its `size` is 0.                                                                                                                                                                                 |
| `checkpoint-missing`      | Its `size` is larger than the board the verifier holds: entries are missing (reported unverifiable, never pass).                                                                                 |
| `decode`                  | An entry doesn't decode strictly as a version 1 board entry (with the [[notation]] decode error code), payload header included.                                                                  |
| `wrong-index`             | An entry's `index` isn't its position.                                                                                                                                                           |
| `segment-decreased`       | An entry's `segment` is smaller than the previous entry's.                                                                                                                                       |
| `opening-order`           | An entry breaks the order of spoiled-ballot openings above.                                                                                                                                      |
| `checkpoint-boundary`     | A checkpoint's `size` isn't the end of segment `segment` within the prefix.                                                                                                                      |
| `copy-mismatch`           | The prefix as held doesn't hash to a counted checkpoint's `head` (`link_{size−1}`) or `root` (`root_size`): this copy isn't the anchored board (unverifiable from this source, never a failure). |
| `unanchored`              | A segment of the prefix whose window (end of period plus `deadline`) closed before `now` has no counted checkpoint (the first such segment).                                                     |
| `unsealed`                | The seal's window closed before `now`, and no counted checkpoint is for `lastSegment`.                                                                                                           |

Every other code is an election check: the operator writes the envelopes, the order and the segments, and the anchoring authority the checkpoints, so any such failure is theirs (T-23). A failure of the record inside a payload isn't one of these ([[verifier]], Admission checks). While an election runs, a segment whose window is still open isn't failed for lacking a checkpoint, so live monitoring (P4-5) can run these checks too.

Entries the operator dropped before anchoring are, to the public verifier, simply not part of the board: it can't tell a dropped entry from a forged one. Only the voter whose entry it was can show the drop, by the client checks above, and P1-13's receipt carries the operator's signature on the size and root it was shown so that the voter's alarm is evidence anyone can check (T-23, T-25).

## Why both a chain and a tree

The brief requires the board to be hash-chained, and the chain and the tree each give something the other doesn't. The chain head commits to the whole prefix in one 32-byte value that a client can update entry by entry, so a receipt holding `link_i` commits to everything the voter was shown, and recomputing it checks order and completeness with no tree code at all. The tree gives what a chain can't: logarithmic inclusion proofs for receipts, and consistency proofs between any two sizes, so a voter holding a receipt from before an anchor can check that the anchored board extends what they were shown (T-24). A checkpoint carries both, and a verifier checks both.

## Residuals

- **Before the first anchor after an entry,** the operator can drop or reorder unanchored entries, or show different boards to different viewers (T-23, T-24). A voter holding a receipt detects a drop or fork once its segment's deadline has passed, by the checks above; anyone else sees a fork only if the operator anchors both branches in time, which is equivocation. The window is one period plus the deadline.
- **Whoever holds the anchoring key can fail an election, but only while it runs:** by anchoring two checkpoints for one segment within that segment's window, or a wrong one. That failure is public and attributable to the key. Once a segment's deadline has passed, nothing anchored for it counts, so no later holder of the key (a compelled or seized one, T-69) can fail a closed election (T-53).
- **Inconsistent anchors leave an election unverifiable for good.** Whoever holds the anchoring key while an election runs can anchor checkpoints for different segments that no single board matches. Every copy then fails `copy-mismatch`, so the election never verifies, but it doesn't fail either; voters' consistency alarms (client rule 2) attribute it (T-24, T-69).
- **A missed deadline fails the election permanently.** If no timely checkpoint lands for a segment with entries (an operator outage, a hosting seizure, a lost anchoring key, or an anchor transaction kept off L1 by censorship or fees), the election fails `unanchored` and can't be repaired, attributably to the anchoring authority (T-49, T-50, T-53). A longer `deadline` makes this less likely but lengthens the fork window, since voters check only after it. P4-1 MUST justify the value it picks against both, and run anchoring so that one outage can't miss it.
- **The operator chooses the order** of everything except openings. Nothing that counts may depend on it: that is R3 of [[verifier]] 6.1, which P1-13's re-vote rule must meet.
- **Withholding** a submission from the board altogether (T-25) isn't detectable from the board: it is caught by the voter's receipt (P1-13) and, for direct submissions, by our contracts' event accumulators ([[0005-permanent-archive]], P1-18).
- **Opening order within a period** hides the order of arrival, not the period itself: an opening is linked to the period in which it was posted, which is why clients publish openings only after close (P1-13). It never unlinks an opening from the challenged ballot it opens (above).
- **An undecodable payload** stays in the permanent archive if an operator breaks the rule above; it is reported, not an election failure (T-17).

## Owned elsewhere

- The anchoring clock's values (period length, epoch, deadline, and how the seal follows from the definition), the anchor contract, which SHOULD reject untimely anchors and a second checkpoint for an election and segment, and how checkpoints are found again: P4-1.
- The verifier reading anchor times from finalized L1 blocks only: P1-19.
- The contract-event record (`0x0008`), its inclusion evidence, and whether it carries raw transactions ([[notation]], Result-critical fields): P1-18.
- What a receipt holds (entry hash, index, chain link, a signed size and root, the proofs above), and how challenged ballots are placed and built: P1-13.
- Where entries are stored, and the database rules that keep them append-only: P2-1.
- The verifier's report and how `checkpoint-missing` maps to unverifiable: P1-19.
