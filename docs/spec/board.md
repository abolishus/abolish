# Bulletin board

The public bulletin board: the envelope that places a record on it, how its entries are hash-chained and committed to by an append-only Merkle tree, the inclusion and consistency proofs over that tree, how entries are grouped into anchoring segments, and the checkpoints that get anchored on L1. Threats: T-23 (board tampering), T-24 (equivocation), T-31 (encoding ambiguity), T-42 and T-47 (spoiled-ballot openings linked to their cast ballot by position), T-52 (bounded inputs), T-17 (no free text on the board), T-36 (third-party verifiers implement this page alone). Notation is from [[notation]]; `H` and `DS` are from [[group]] and [[domain-separation]].

## Model

- **One board per election.** Every entry names its election. Entries are appended by whoever runs the board (our server, A-2), one at a time, and never changed or removed (T-23).
- **Position.** Entry `i` is the `i`-th entry appended, counting from 0. Its position is part of the entry, and so of its hash.
- **Segments.** Entries are grouped by anchoring period: each entry carries the number of the period in which it was appended, its segment: the period in which it was appended, by L1 time, and never below the election's first segment `f` (the period of its creation's L1 origin, which the operator counts as seen once it boards the creation; [[contracts]], Board anchor, Verification). A voter's client takes `f` from the L1 origin that the creation's `ElectionCreated` event carries, checked against finalized L1 and the event's L2 timestamp as a verifier checks it ([[contracts]], Election registry, Events, The L1 origin) when it checks the registration's finality before casting. Segment numbers never decrease along a board. Periods are fixed intervals of L1 time under the anchoring clock (Anchoring, below), whose values P4-1 sets (hourly).
- **Checkpoints.** After each period, the board's state (its size, chain head and Merkle root after that period's segment, and the content addresses of the segment's bytes) is summarised as a checkpoint, and P4-1 anchors it on L1 so that its election and segment can be read there. Every period that adds entries gets one, and a verifier checks every checkpoint anchored for the election. Anyone holding the entries can recompute every checkpoint, and anyone holding a receipt can check it against an anchored checkpoint with a logarithmic-size proof (T-24).
- **What the board doesn't decide.** Whether a ballot or opening counts is decided by the admission checks on the record an entry carries ([[verifier]]), never by the envelope. The board's order matters only where this page says so (openings, below); P1-13's re-vote rule must not depend on the order in which the operator writes unanchored entries ([[verifier]] 6.1, R3).

## Board entry (record type `0x0007`, versions 1 and 3 to 7)

Versions 1 and 3 to 7 have the same layout and differ only in the record types they allow (Allowed payloads): version 3 adds [[delivery]]'s receipts and complaints to version 1's, version 4 adds [[tally]]'s destruction statement to version 3's, version 5 adds [[close]]'s close statement to version 4's, version 6 adds [[tally]]'s running opening to version 5's, for live polls only (Tally-opening version 2), and version 7 adds [[ceremony]]'s author approvals to version 5's, for an election with an author panel only ([[verifier]] 2.3). Version 7 doesn't allow the running opening, since a live poll with an author panel can't run yet ([[tally]], Live results). Version 2 is never assigned: a frozen vector uses it as the version that doesn't exist. An election uses the version its profile pins ([[versioning]]).

| Field         | Type                       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `election_id` | `bytes[32]`                | The election's identifier: the value the election registry assigns when the election is created, before its key ceremony, which the definition and the ceremony context also bind (P1-10b, P1-14, P1-18). Equal for every entry of a board. It MUST be unique across every election whose checkpoints go through the same anchor contract: P1-18 derives it from the chain ID, the registry's address and the registry's own counter, never a bare counter, so a redeployed registry can't reuse one and have its checkpoints attributed to another election. |
| `index`       | `u64`                      | The entry's position on the board, from 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `segment`     | `u32`                      | The anchoring period in which the entry was appended (P4-1). Never smaller than the previous entry's.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `payload`     | `bytes<MAX_BOARD_PAYLOAD>` | One complete record, header included, of a type allowed on the board (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`MAX_BOARD_PAYLOAD` is in [[parameters]]. The `election_id` and `index` fields make each entry self-identifying, so an entry, or its hash, can't be presented as part of another election's board or at another position (T-23, T-31).

### Allowed payloads

The payload is a complete record whose `record_type` is one the entry's version allows:

| `record_type` | Name                   | Versions | Why it is on the board                                                                                                                              |
| ------------- | ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x0002`      | ballot                 | 1, 3–7   | A ballot cast through our API ([[ballot-validity]], Ballot record); cast ballots only, never a challenged one                                       |
| `0x0003`      | spoiled-ballot opening | 1, 3–7   | A published Benaloh opening, after close ([[challenge]]); ordered canonically, below                                                                |
| `0x0005`      | ceremony transcript    | 1, 3–7   | The key ceremony's public transcript (P1-14)                                                                                                        |
| `0x0006`      | tally opening          | 1, 3–7   | One cell's opening of the tally (P1-15, [[tally]])                                                                                                  |
| `0x0008`      | contract event         | 1, 3–7   | One of our contracts' L2 events, including direct-submitted ballots and the definition's registration (P1-18)                                       |
| `0x000c`      | share receipt          | 3–7      | A trustee's receipt for one seat's share of a ballot ([[delivery]])                                                                                 |
| `0x000e`      | share complaint        | 3–7      | A trustee's proof that a posted share is invalid ([[delivery]])                                                                                     |
| `0x000f`      | destruction statement  | 4–7      | A trustee's signed statement that it destroyed its per-election key material after the tally ([[tally]], Destruction)                               |
| `0x0015`      | close statement        | 5–7      | A trustee seat's signed statement of the L2 head derivable from L1 at close ([[close]], Close statement); versions 5 to 7 fix its version, 1        |
| `0x0018`      | running opening        | 6        | One cell's opening of one release of a live poll's running totals ([[tally]], Running opening record); tally-opening version 2 fixes its version, 1 |
| `0x0019`      | author approvals       | 7        | An author panel's approvals of its ceremony transcript, which no contract records ([[ceremony]], Author panel)                                      |

Any other record type, including one the entry's version doesn't allow, is rejected when the envelope is decoded, with `unexpected-record-type`, including the types [[notation]] would call unknown (`0x0000`, unassigned numbers and the test range): here the envelope fixes the allowed set, so anything outside it is unexpected. The reasons: an election definition reaches the board only as the contract event that registered it, and so does a share posting (`0x000d`), whose data must be on L2 for every trustee to read ([[delivery]], Direct submit); a voter's receipt (`0x0004`) stays with its voter, a summed-share message never leaves the trustees ([[tally]], Summed-share message), a board entry never nests, and display text is never on the board, the chain or the archive ([[display-text]], T-17). A payload shorter than a record header (3 bytes) is rejected with `truncated`. Both errors are reported at the offset of the payload's first byte.

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

1. **At cast.** It refuses an envelope whose `segment` isn't the period current at the cast by the anchoring clock, read from the time of a recent L1 block the client fetched itself (or its own clock if it has none), within a tolerance of one period, so a cast at a period boundary isn't refused. Where its time source is in doubt, it retries rather than refusing. Otherwise the operator could label the entry with a segment that is never anchored, or one far in the future.
2. **After the deadline of its segment `s`.** It judges its receipt by [[receipts]], Later checks: from every segment's entry-hash list (Segments and checkpoints, below) and every checkpoint counted for the election, read from L1 itself, never from a query about its own entry. Its alarms are the verdicts `board-failed` (which covers two distinct checkpoints for one segment), `unanchored` (no checkpoint for `s`, which is never empty), `forked` (a checkpoint for an earlier segment that covers its index, or one for `s` or later that doesn't, or an anchored board the receipt's root isn't a prefix of) and `unresolved` (no copy of the anchored board to prove either way). It checks roots only: a checkpoint's `head` needs every entry up to its size, so a wrong head with an honest root is caught by verifiers (Board checks, step 3), never by this rule. A segment labelled beyond rule 1's tolerance was already refused at cast.

The receipt, the check at cast, the later checks and what a receipt is evidence of to a third party are in [[receipts]].

## Segments and checkpoints

The segment of period `s` is the run of entries whose `segment` field is `s`. It is empty if nothing was appended in that period.

A **checkpoint** is the board's state after a segment, with the content addresses of the bytes it commits to ([[0029-board-data-availability]]):

| Field         | Type        | Meaning                                                                                             |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `election_id` | `bytes[32]` | The board's election.                                                                               |
| `segment`     | `u32`       | The period `s` it closes.                                                                           |
| `size`        | `u64`       | `n`: the number of entries whose `segment` is at most `s`.                                          |
| `head`        | `bytes[32]` | `link_{n−1}`, the chain head.                                                                       |
| `root`        | `bytes[32]` | `root_n`.                                                                                           |
| `object_cid`  | `bytes[36]` | The binary CID ([[content-addressing]]) of the segment object of `t`, the segment of entry `n − 1`. |
| `hashes_cid`  | `bytes[36]` | The binary CID of the entry-hash list of `t`.                                                       |

It is a structure, not a record: it has no header, and it is only ever hashed, as

```
checkpoint_hash = H(DS("abolish/v1/board-checkpoint-2", encode(checkpoint)))
```

This is checkpoint version 2. Version 1, without the two CIDs and hashed under `abolish/v1/board-checkpoint`, was never anchored, and its tag is retired ([[domain-separation]]), so no encoding of either version can be taken for the other. `encode(checkpoint)` is 180 bytes.

**The CIDs.** `t` is the last segment at or before `s` that has entries: `s` itself when the period added entries, otherwise the one before it that did, so a checkpoint for a period with no new entries (a re-anchor, or the seal of a board that stopped growing) carries the CIDs of the checkpoint before it, and one with new entries names fresh ones. Each CID is `objectCid` of exactly those bytes under [[content-addressing]]'s parameters, so it is canonical: no other CID of the same bytes (a single raw block over 1 MiB, which IPFS peers won't transfer, or another chunking) is valid. With them, L1 names the exact objects behind every anchor, so a verifier or a trustee node can fetch the board by CID from L1 and IPFS alone, with our servers offline, and check every byte against the anchored roots (T-24, T-49, T-51).

A checkpoint is valid for a board exactly when `size ≥ 1`, the board has at least `size` entries, entry `size − 1` has `segment ≤ s`, the entry after it (if any) has `segment > s`, `head = link_{size−1}`, `root = root_size`, and `object_cid` and `hashes_cid` are the CIDs above. So a checkpoint always ends at a segment boundary, two valid checkpoints for the same segment are equal, and two of the same size differ only in `segment`. P4-1 never anchors a period while the board is still empty: a checkpoint has `size ≥ 1`, and an anchored empty one fails the election (`checkpoint-size`). A period with no new entries may be anchored again or skipped, but a period that added entries MUST get a checkpoint, so no entry stays unanchored past its period (and, by the timing rule below, anchored within its window).

**Anchoring.** P4-1 anchors each checkpoint through the anchor contract the verifier pins, with its `election_id` and `segment` readable on L1 next to its hash, and the full checkpoint published on L1 in the same transaction (or the checkpoint itself in place of the hash). An anchor counts for an election only if it was sent by that election's anchoring authority: an address the election definition binds, or one the verifier pins (our Safe, say). The contract rejects anchors for the election from anyone else, or, failing that, verifiers and voters' clients ignore them. Otherwise anyone could anchor a bogus checkpoint for an election, or front-run the honest one, and fail it (T-52). P4-1 and P1-18 enforce this. P4-1 decides how one transaction carries several elections' checkpoints, but every anchored checkpoint MUST be attributable to its election and segment from L1 alone. A verifier checks **every** checkpoint anchored for the election, never a selection it was handed: otherwise the operator could anchor a second checkpoint for a forked board, show it only to the voters whose ballots it keeps, and publish the other (T-24). Two different checkpoints anchored for one segment are equivocation, and fail the election. An anchored hash that names the election but can't be matched to a published checkpoint makes the election unverifiable, never verified.

**Timing.** The anchoring clock has four values: an `epoch` and a `period` length (period `s` is the L1 time interval `[epoch + s·period, epoch + (s+1)·period)`) and a `deadline`, which P4-1 sets as immutable constants of the anchor contract the definition's `l1_anchor` names, the same for every election through it (a verifier release pins that contract's address and its deployment's clock, never a clock value for one election), and `lastSegment`, the election's seal: the last period its board may use. The definition fixes it ([[election-definition]], The seal) as the latest end of every post-close window, never only one of them: publishing openings (P1-13), the trustees publishing the tally (P1-15), and our contract events and close-time accumulator data reaching the board after L2 finality (P1-18, [[0005-permanent-archive]]). A tally not boarded by the seal can't be part of a valid board, so the election then has no verifiable result (T-54). An anchor for segment `s` counts only if it is in a finalized L1 block whose timestamp is at or after the end of period `s` and at most `deadline` after it, and `s ≤ lastSegment`. Verifiers and voters' clients ignore every other anchor, and P4-1's contract SHOULD reject them (it can reject one past the seal only if the seal, or what it is computed from, reaches L1). So an anchor made late can neither fail a closed election nor hide a fork, an entry labelled with a far-off segment can't be anchored late, and every segment with entries must have a timely checkpoint. The seal's own period MUST get a checkpoint, anchored even if nothing was appended in it (it then repeats the board's state): that seal checkpoint authenticates the board's final extent, so a closed election without one fails (`unsealed`), attributably on L1. No anchor ever covers an entry with `segment > lastSegment`, so such an entry is never part of the board.

The **segment object** of period `s` (the bytes [[content-addressing]] turns into a CID and CAR, and [[0005-permanent-archive]] archives) is the concatenation `encode(entry_a) ‖ … ‖ encode(entry_b)` of that segment's entries in index order. Each encoded entry is self-delimiting (fixed-width fields, then a length-prefixed payload), so the object splits into entries in exactly one way. An empty segment has no object.

The **entry-hash list** of period `s` is `entry_hash_a ‖ … ‖ entry_hash_b`, the entry hashes of the same entries in the same order, 32 bytes each. Anyone holding the segment object derives it, and it is published and content-addressed beside the object ([[content-addressing]]), so a voter's client can rebuild every root of the board tree from the lists alone, without the entries ([[receipts]], Entry-hash lists). It is authenticated only by the anchored roots, never by its source.

## Spoiled-ballot openings

Within each segment:

- the entries whose payload has `record_type` `0x0003` come after every other entry of the segment, and
- their payloads are in strictly increasing order, comparing bytes from the first: the first differing byte decides, and a payload that is a prefix of another comes first.

The board operator holds the openings it receives in a period and appends them, sorted, when the period ends, just before the checkpoint. Since every opening payload is distinct in the order, posting an identical opening twice in one segment is impossible.

**What this protects, and what it doesn't.** The rule hides when, within its period, each opening was sent, and stops the operator placing an opening where its position says something (next to another entry, or in arrival order). A challenged ballot is never boarded on its own: its core travels inside its opening, which carries nothing that depends on the voter's nullifier, and openings are boarded only in segments after the counted extent's last ([[challenge]], Publication; [[0021-challenged-ballots]]). So nothing reaches the board when a voter challenges, and an opening's position links it only to a period after close, never to the casting session. What an opening's content links it to (the vote it shows, which is usually the voter's real one, and its publisher's network metadata) is [[challenge]]'s residual (T-42, T-47, T-11, T-12).

## Board checks

A verifier ([[verifier]], checks 4.1 and 4.2) takes the election identifier it expects, the board's entries in index order from wherever it found them, every anchor for the election from the pinned anchor contract (Anchoring, above) for a segment at or after the election's first segment ([[contracts]], Board anchor, Verification), the anchoring clock, and `now`: the time of the latest finalized L1 block it has read, the same block at which it proves the anchors ([[contracts]], Board anchor, Verification).

**Only anchored entries are the board.** Entries carry no signature: anyone can write a well-formed entry for any election. What makes an entry part of the board is a timely checkpoint whose size covers it. So the verifier checks exactly the prefix up to the largest size among the counted anchors (its _extent_), and ignores every entry past it, reporting how many it ignored as input it can't authenticate, never as an election failure. No one can fail an election by handing a verifier its board with entries appended (T-53). For a closed election the seal checkpoint fixes the extent.

The checks run in this order, failing at the first problem:

1. Only anchors that are timely (Timing, above) and in finalized blocks up to `now` count. For each, in order: `wrong-election`, then `checkpoint-equivocation`.
2. From L1 alone, before any copy is read: for each counted anchor, in order, `checkpoint-size`, then `checkpoint-inconsistent` if a counted checkpoint for a smaller `segment` has a larger `size`, or the same `size` and a different `head`, `root`, `object_cid` or `hashes_cid`. A board only grows, and two checkpoints of one size name the same last entry and so the same segment's bytes, so no board matches such a pair.
3. The copy's raw bytes against the anchors, before anything is decoded: the entry hashes, chain links and tree roots of the prefix are computed from the encodings as held, and each counted anchor whose `size` the copy reaches has its `head` compared with `link_{size−1}` and its `root` with `root_size`. First, for each of those anchors, in order, `checkpoint-inconsistent` if exactly one of the two matches, or if neither matches while the copy matches both of another of those checkpoints whose `size` is at least as large. Then, for each counted anchor, in order, `checkpoint-missing` if the copy doesn't reach its `size`. Then, for each of the compared anchors, in order, `copy-mismatch` if either doesn't match. So a checkpoint larger than the copy can't hide one that no board matches.
4. Each entry of the prefix, in order: `decode`, `wrong-election`, `wrong-index`, `segment-decreased`, `opening-order`.
5. For each counted anchor, in order, its `checkpoint-boundary` and then its `checkpoint-cid`, so an anchor's CIDs are checked before the next anchor's boundary.
6. `unanchored`, then `unsealed`.

`checkpoint-missing` and `copy-mismatch` say the copy the verifier holds isn't the anchored board: it is too short, or its bytes differ. They are reported as unverifiable from that source, and the verifier tries another copy, never as a failure of the election: a hostile mirror can serve a bad copy, but it can't make an election fail. Only once step 3 has passed is the prefix the anchored board, so every later failure is the operator's.

`checkpoint-inconsistent` is an election failure, attributable to the anchoring authority: a chain head and a tree root are both functions of the same entries, so under collision resistance of the tagged hashes no board matches a checkpoint whose head the copy matches while its root doesn't (or the reverse), and a checkpoint the copy fully matches admits only that copy's prefix up to its size. A mirror can't bring either about without a collision, so a mirror still can't fail an election. What remains unverifiable rather than failed is a copy that matches no checkpoint at or above some size, which is the copy's problem until a matching copy turns up (Residuals).

`checkpoint-cid` is an election failure, attributable to the anchoring authority too: it runs only once step 3 has fixed the prefix as the anchored board, and the CIDs are a function of that prefix's bytes, so no mirror can bring it about. A checkpoint whose CIDs don't name its bytes would send anyone fetching by CID from L1 to another object or none, which is the withholding [[0029-board-data-availability]] makes attributable.

| Code                      | Fails when                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wrong-election`          | An anchor's checkpoint, or an entry, names another election.                                                                                                                                     |
| `checkpoint-equivocation` | Another counted checkpoint for the same `segment`, earlier in the list, differs from it.                                                                                                         |
| `checkpoint-size`         | Its `size` is 0.                                                                                                                                                                                 |
| `checkpoint-inconsistent` | No board can match it: from L1 alone (step 2), or against the copy (step 3). An election failure, attributable to the anchoring authority.                                                       |
| `checkpoint-missing`      | Its `size` is larger than the board the verifier holds: entries are missing (reported unverifiable, never pass).                                                                                 |
| `decode`                  | An entry doesn't decode strictly as a board entry of the pinned version (with the [[notation]] decode error code), payload header included.                                                      |
| `wrong-index`             | An entry's `index` isn't its position.                                                                                                                                                           |
| `segment-decreased`       | An entry's `segment` is smaller than the previous entry's.                                                                                                                                       |
| `opening-order`           | An entry breaks the order of spoiled-ballot openings above.                                                                                                                                      |
| `checkpoint-boundary`     | A checkpoint's `size` isn't the end of segment `segment` within the prefix.                                                                                                                      |
| `checkpoint-cid`          | A checkpoint's `object_cid` or `hashes_cid` isn't the CID of the segment object or entry-hash list it names (The CIDs, above). An election failure, attributable to the anchoring authority.     |
| `copy-mismatch`           | The prefix as held doesn't hash to a counted checkpoint's `head` (`link_{size−1}`) or `root` (`root_size`): this copy isn't the anchored board (unverifiable from this source, never a failure). |
| `unanchored`              | A segment of the prefix whose window (end of period plus `deadline`) closed before `now` has no counted checkpoint (the first such segment).                                                     |
| `unsealed`                | The seal's window closed before `now`, and no counted checkpoint is for `lastSegment`.                                                                                                           |

Every other code is an election check: the operator writes the envelopes, the order and the segments, and the anchoring authority the checkpoints, so any such failure is theirs (T-23). A failure of the record inside a payload isn't one of these ([[verifier]], Admission checks). While an election runs, a segment whose window is still open isn't failed for lacking a checkpoint, so live monitoring (P4-5) can run these checks too.

Entries the operator dropped before anchoring are, to the public verifier, simply not part of the board: it can't tell a dropped entry from a forged one. Only the voter whose entry it was can detect the drop, by the client checks above, and, once the receipt keys are the anchoring authority's (P1-13b part 2b), its receipt is evidence a third party can check: an `unanchored` or `forked` receipt, and a drop when no admitted entry carries its ballot by content ([[receipts]], Later checks; T-23, T-25, T-26).

### A copy from L1's CIDs

A verifier, a trustee node or a community node that holds no copy of the board reads one from L1 and IPFS alone, by the CIDs the counted checkpoints name ([[0029-board-data-availability]]; T-24, T-49, T-51). Take the checkpoints that count after steps 1 and 2. Their distinct sizes `n_1 < n_2 < … < n_m` cut the board into runs: run `i` is entries `n_{i−1}` to `n_i − 1`, with `n_0 = 0`. A period that added entries MUST get a checkpoint (Segments and checkpoints), so on an honest board each run is exactly one segment, the segment of entry `n_i − 1`, and the `object_cid` of the checkpoints of size `n_i` names its segment object. The reader:

1. reads each run's object by that CID within `(n_i − n_{i−1}) · (51 + MAX_BOARD_PAYLOAD)` bytes, the most that many entries encode ([[content-addressing]], Reading within a bound), and within what is left of its own byte budget for the whole copy, once per size however many checkpoints name it. An object over the first bound is inconsistent: it is no run of that many entries. One within it but over the budget is **over-budget**: this reader can't hold it, which is unverifiable for this reader and never a verdict;
2. splits it into entries (Segments and checkpoints, segment object) and requires exactly `n_i − n_{i−1}` of them;
3. stops at the first run whose object is unavailable, inconsistent, over-budget or not exactly that many entries. The copy is the runs before it, in order.

The budget is the reader's, not the protocol's. The anchoring authority chooses the sizes, and so the first bound, and a segment object of identical chunks takes only a few distinct blocks to serve at any length within it ([[content-addressing]], Reading within a bound). Without a budget a few cached blocks would exhaust any reader that rebuilds the board from L1 (T-52).

The board checks then run on the copy as on any other. The entry-hash lists aren't read: the checks derive each one from the entries and compare its CID (`checkpoint-cid`). Nothing read by CID is trusted beyond being the bytes its CID names. The board checks authenticate every byte against the anchored heads and roots, so a source can only leave the copy short: `checkpoint-missing`, unverifiable from those sources, and never an election failure (T-53). A CID of other bytes that split into the run's count of entries gives a full-length copy that fails `copy-mismatch` instead. That is unverifiable too, but every source serves the same bytes for it, so trying other sources by CID doesn't help. `packages/crypto`'s `readBoardCopy` is this reader.

## Why both a chain and a tree

The brief requires the board to be hash-chained, and the chain and the tree each give something the other doesn't. The chain head commits to the whole prefix in one 32-byte value that a client can update entry by entry, so a receipt holding `link_i` commits to everything the voter was shown, and recomputing it checks order and completeness with no tree code at all. The tree gives what a chain can't: logarithmic inclusion proofs for receipts, and consistency proofs between any two sizes, so a voter holding a receipt from before an anchor can check that the anchored board extends what they were shown (T-24). A checkpoint carries both, and a verifier checks both.

## Residuals

- **Before the first anchor after an entry,** the operator can drop or reorder unanchored entries, or show different boards to different viewers (T-23, T-24). A voter holding a receipt detects a drop or fork once its segment's deadline has passed, by the checks above; anyone else sees a fork only if the operator anchors both branches in time, which is equivocation. The window is one period plus the deadline.
- **Whoever holds the anchoring key can fail an election, but only while it exists and runs** (anchors for segments before the election's first segment are ignored, and its creator checks the few slots from that segment on before the ceremony, [[contracts]], Board anchor, Verification): by anchoring checkpoints no single board matches (`checkpoint-inconsistent`), or one that no published board matches before the honest one. Two checkpoints for one segment would fail it too, but the anchor refuses a second ([[contracts]], Board anchor). That failure is public and attributable to the key. Once a segment's deadline has passed, nothing anchored for it counts, so no later holder of the key (a compelled or seized one, T-69) can fail a closed election (T-53).
- **Withheld or forked tails can't be mitigated yet.** Whoever holds the anchoring key while an election runs can anchor a checkpoint (the seal, say) that extends every voter's receipt but whose extra entries are never published, or one of the honest size that forks only in entries after the last receipt (the tally phase, say). Every voter's consistency proof then succeeds, so no client alarms; every published copy fails `checkpoint-missing` or `copy-mismatch`; and the election stays unverifiable for good, never failed, with nothing naming the key (T-24, T-53, T-69). Client rule 2 ([[receipts]], Later checks) attributes only a root that isn't a growth of the board a voter was shown; a receipt it can't resolve stays `unresolved` and, committed on L1, evidence until a copy turns up. [[0029-board-data-availability]] closes this through the counted extent: checkpoint version 2 names each segment's CIDs on L1 (above), and P4-3 part 2c adds the trustee panels' availability attestations, so a withheld ballot or counted extent fails the election `unavailable`. Until 2c is built, the CIDs name what was withheld but nothing fails the election for it, and the tail after the counted extent stays unverifiable, never failed, when withheld. A head that is wrong while the root is right is caught by step 3 from any copy that matches the root.
- **A missed deadline fails the election permanently.** If no timely checkpoint lands for a segment with entries (an operator outage, a hosting seizure, a lost anchoring key, or an anchor transaction kept off L1 by censorship or fees), the election fails `unanchored` and can't be repaired, attributably to the anchoring authority (T-49, T-50, T-53). A longer `deadline` makes this less likely but lengthens the fork window, since voters check only after it. P4-1 MUST justify the value it picks against both, and run anchoring so that one outage can't miss it.
- **A copy read by CID can't show what the anchored CIDs hide.** When the CIDs don't name the run between two checkpoints' sizes, the copy from L1's CIDs stops there and is short, or, for a CID of other bytes that split into the run's count of entries, fails `copy-mismatch`. That happens with a segment with entries left without a timely checkpoint, a checkpoint inside a segment, an anchored entry whose payload length is over `MAX_BOARD_PAYLOAD` (which no segment object splits into), or a CID of other bytes. The result is unverifiable, where a whole copy from elsewhere would fail the election (`unanchored`, `checkpoint-boundary`, `checkpoint-cid`, or an entry check on the run). For a closed election such a run is the anchoring authority's doing. But while an election runs, one period's anchor can land after the next period's, within its deadline, so a short run isn't failed from the CIDs alone. The availability attestations and complaints of [[0029-board-data-availability]] (P4-3 part 2c) make withholding attributable (T-24, T-53).
- **The operator chooses the order** of everything except openings. Nothing that counts may depend on it: that is R3 of [[verifier]] 6.1, which P1-13's re-vote rule must meet.
- **Withholding** a submission from the board altogether (T-25) isn't detectable from the board: the voter's client sees no receipt and submits directly (P4-2), which leaves no evidence of the refusal, and, for direct submissions, it is caught by our contracts' event accumulators ([[0005-permanent-archive]], P1-18).
- **Opening order within a period** hides the order of arrival, not the period itself: an opening is linked to the period in which it was posted, which is why clients publish openings only after close ([[challenge]], Publication). It never unlinks an opening from the challenged ballot it opens (above).
- **An undecodable payload** stays in the permanent archive if an operator breaks the rule above; it is reported, not an election failure (T-17).

## Owned elsewhere

- The anchoring clock's values, the anchor contract (which rejects untimely anchors and a second checkpoint for an election and segment) and how a verifier finds every anchored checkpoint again: [[contracts]], Board anchor (P4-1). The job that anchors hourly: P4-1 part 2.
- The verifier reading anchor times from finalized L1 blocks only: P1-19.
- The board contract's events (direct-submitted ballots and the contract path of [[delivery]]) and the close rule: P1-18. The contract-event record that carries every contract event, and its evidence, are [[contracts]]' (Contract-event record).
- What a receipt holds and its later checks: [[receipts]]. How challenged ballots are built, opened and published: [[challenge]]. Where entry-hash lists and segment objects are found: by the CIDs each checkpoint names (A copy from L1's CIDs); the verifier's local block store and gateways are [[verifier]], Board by CID; the availability attestations and mirroring are P4-3's.
- Where entries are stored, and the database rules that keep them append-only: P2-1.
- The verifier's report and how `checkpoint-missing` maps to unverifiable: P1-19.
