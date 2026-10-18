# Board data availability

Whether the board an election's result rests on was available to the trustees before any result existed, decided from L1 and the L2's events alone: the trustee seats' signed **availability attestations** (record type `0x001b`) and **availability complaints** (record type `0x001c`), each version 1, at two points, the **ballot extent** and the **counted extent**; their windows; what a seat does; the contract path they count through; and the **availability check** ([[verifier]] 4.6), which fails the election `unavailable` when a panel's threshold of seats didn't attest in time. Decided by [[0029-board-data-availability]] (option D): the checkpoint's content addresses ([[board]], Segments and checkpoints) name what must be published, and the election's own trustee panels are the committee that says whether it was. Notation and decoding rules are from [[notation]], tags from [[domain-separation]], signatures from [[trustee-identity]], windows from [[delivery]] and [[tally]]. Threats: T-24, T-25, T-53, T-54, T-17, T-52, T-31, T-71.

This page is [[P4-3]] part 2c-1: the records, their windows, the seats' duties, the requirements on the contract path and the check, with the records' codec, the windows and the check (`checkAvailability`) in `packages/crypto`. The board contract's call and events, with contract-event version 8, which archives them, are part 2c-2 ([[contracts]], Board, Availability records; Event tables (version 8)); the registry's pin and 2.3 moving to version 8, part 2c-3a; the verifier's inputs for the check (the board's events and their accumulator proof in its bundle, format 6) and its ballot extent, part 2c-3b ([[verifier]], Availability), with the counted extent once the verifier knows `s_S`; the trustee node's fetch, attest and publish job part 2c-4 ([[P2-13]]); the reference election's withholding run part 2d. Each is named below where this page relies on it.

## Terms

- `s_A = period(closes_at) + 1` and `s_S` are [[close]]'s board-path window end (Window) and [[tally]]'s counted extent's last segment (Tally window), with `period(t)` under the anchoring clock ([[board]], Timing). `t_S` is when `s_S`'s checkpoint is due.
- The **counted checkpoints** are the anchored checkpoints that count after [[board]]'s board checks steps 1 and 2, which read L1 alone: timely, in finalized blocks, for the election, with no equivocation, size 0 or inconsistency among them.
- `C_A`, the **ballot-extent checkpoint**, is the counted checkpoint with the largest `segment ≤ s_A`; `C_S`, the **counted-extent checkpoint**, the counted checkpoint with the largest `segment ≤ s_S`. Each is fixed once its last segment's anchoring deadline has passed on finalized L1, since no anchor for a segment counts after its deadline. Either may not exist (no counted checkpoint at or before its segment), and then no attestation can name it.
- The **ballot extent** is the board through `C_A`'s `size`: every ballot cast through the operator by the close is in it ([[close]], Window; a board-path ballot boarded after `s_A` is rejected, `window-boarded-late`). The **counted extent** is the board through `C_S`'s `size`, from which [[tally]]'s counted set is computed. Direct-submitted ballots and every contract-path record are in neither by their board copies alone: a seat reads those from its own L2 node ([[delivery]], What a node owes).
- `F` and `R` are the forced-inclusion delay with its missed-slot margin and the margin for L1 finality and a node's reaction, the values the release pins and `deliveryWindowFits` checks ([[delivery]], Direct submit). `c_I = t_D − F − R` is [[delivery]]'s intake cutoff.
- A seat's **panel key set** is the registered key set of its panel: for the default panel, the one the trustee registry's `CeremonyRegistered` record for the definition's stub carries ([[contracts]], Trustee registry; [[verifier]] 3.1), and for an author panel, the one the election registry's `AuthorPanelRegistered` record for the definition carries ([[contracts]], Election registry, Author panel registration; [[0035-author-key-set-on-l2]]; [[delivery]], Version 2). Both are read from the L2's events, never from the board's ceremony transcripts, which may be withheld with the rest of the board. `k_P` is panel `P`'s threshold (`threshold` for the default panel, `k_A` for an author panel, [[election-definition]]).

## Records

### Availability attestation (`0x001b`, version 1)

A seat's signed statement that it held every segment object and entry-hash list of an extent, by its deadline, and that it serves them.

| Field             | Type                  | Meaning                                                                                                                                                |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `definition_hash` | `bytes[32]`           | The election's definition hash                                                                                                                         |
| `panel`           | `enum8<1, 2>`         | The seat's panel: 1 the default panel, 2 the author panel                                                                                              |
| `seat`            | `u8`                  | The seat's index in its panel                                                                                                                          |
| `point`           | `enum8<1, 2>`         | 1 for the ballot extent, 2 for the counted extent                                                                                                      |
| `checkpoint_hash` | `bytes[32]`           | `checkpoint_hash` of the extent's checkpoint, `C_A` or `C_S` ([[board]], Segments and checkpoints)                                                     |
| `roots`           | `list<bytes[32], 32>` | At point 2, the record hashes of the obligation roots whose leaf objects the seat holds and has found consistent, strictly ascending; at point 1, none |
| `signature`       | `p256-sig`            | The seat's signature under `abolish/v1/sig/availability-attestation`                                                                                   |

`signature` is an ECDSA P-256 signature by the seat's per-election signing key ([[trustee-identity]], Which key signs what), registered in its panel key set, under `abolish/v1/sig/availability-attestation`, over the record's encoding without its signature:

```
u16(0x001b) ‖ u8(1) ‖ definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u8(point) ‖ checkpoint_hash ‖ u32(r) ‖ roots
```

`74 + 32·r` bytes for `r` roots; an attestation is `138 + 32·r` bytes, 138 at point 1 and at most 1,162. The header is signed so that a later version giving the same fields another meaning can't reuse a version 1 signature, and the attestation's own tag keeps its statement from ever reading as another record's (T-31). The definition hash fixes the chain, the election and its panels, and so the key set the signing key must be in; the checkpoint hash fixes the extent, by its election, segment, size, head, root and both CIDs, so an attestation states exactly which bytes the seat held. A seat signs a counted-extent attestation only over a checkpoint it read from L1 itself, so two honest seats' attestations of one point are equal but for `panel`, `seat`, `roots` where their leaf objects differ, and the signature.

**The roots.** Each entry is `H(DS("abolish/v1/obligation-root", record))` over an obligation root's whole record ([[delivery]], Leaf availability), and names a root whose leaf object the seat holds, has fetched and checked as [[delivery]] (Leaf availability, Fetched and Consistency) says, and serves. `32 = 2 · MAX_TRUSTEES` bounds the list: only ballot versions 1 to 3 fix an obligation root, under which there is no author panel, and the contract path takes one root of each kind per seat (Contract path). The list is strictly ascending, so a set of roots has one encoding (T-31). A counted-extent attestation is how the seat names a root as held; a seat names no root at point 1, whose extent ends before any root is due.

### Availability complaint (`0x001c`, version 1)

A seat's signed word that it couldn't fetch an extent, naming the first object it couldn't get.

| Field             | Type          | Meaning                                                                                                  |
| ----------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `definition_hash` | `bytes[32]`   | The election's definition hash                                                                           |
| `panel`           | `enum8<1, 2>` | The seat's panel                                                                                         |
| `seat`            | `u8`          | The seat's index in its panel                                                                            |
| `point`           | `enum8<1, 2>` | 1 for the ballot extent, 2 for the counted extent                                                        |
| `checkpoint_hash` | `bytes[32]`   | `checkpoint_hash` of the extent's checkpoint the seat read from L1                                       |
| `cid`             | `bytes[36]`   | The binary CID ([[content-addressing]]) of the first segment object of the extent the seat couldn't read |
| `signature`       | `p256-sig`    | The seat's signature under `abolish/v1/sig/availability-complaint`                                       |

`signature` is by the seat's per-election signing key under `abolish/v1/sig/availability-complaint`, over the record's encoding without its signature:

```
u16(0x001c) ‖ u8(1) ‖ definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u8(point) ‖ checkpoint_hash ‖ cid
```

106 bytes; a complaint is 170. The `cid` is an `object_cid` of a counted checkpoint through the extent's ([[board]], A copy from L1's CIDs): the object of the first run the seat's copy stopped at, as unavailable, inconsistent or the wrong number of entries. A complaint changes no verdict: it is the seat's signed word, against the anchoring authority and the board operator, that it tried, and the report lists it beside the seats that attested and those that did neither ([[0029-board-data-availability]], option D). A seat that complains and then holds the extent before its cutoff also attests (What a seat does), and its attestation counts as any other.

### Decoding

Each record decodes strictly ([[notation]]): `panel` and `point` are `enum8<1, 2>` (`invalid-enum` otherwise, at offsets 35 and 37), and `signature` is a canonical low-`s` `p256-sig` (`non-canonical` otherwise), with nothing trailing. In an attestation, a `roots` count above 32 is `length-over-max` at its count (offset 70), a count other than 0 at point 1 is `non-canonical` there, and a root that isn't above the one before is `non-canonical` at that root. In a complaint, `cid` (offset 70) must begin `0x01 0x55 0x12 0x20` (a raw block's CID) or `0x01 0x70 0x12 0x20` (a dag-pb root's), the only CIDs [[content-addressing]] gives a segment object, and is `non-canonical` there otherwise. Each field is read and validated before the next, so each rejection has one code at one offset. Decoding doesn't compare `definition_hash`, `panel`, `seat`, `point` or `checkpoint_hash` with the election; the availability check does, so a record naming another election, seat or checkpoint is still read, and reported.

### Versions

No profile pins either record: the contract-event version whose tables carry the board contract's availability events fixes their versions, as it does the close statement's ([[versioning]], Three levels; [[close]], Close statement, Version), and contract-event version 8 is that version, fixing version 1 of both ([[contracts]], Event tables (version 8); P4-3 part 2c-2). No earlier contract-event version carries them. No board-entry version allows either record: they count only through the contract path (Contract path), so one that reaches the board through the board path is a rejected entry (`unexpected-record-type`), never an attestation or a complaint.

## Windows

Version 1 of both records fixes two **fetch allowances**:

| Name                      | Value  | Meaning                                                                                                                         |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `BALLOT_FETCH_ALLOWANCE`  | 43,200 | `A`: seconds the windows leave, at least, between the ballot-extent checkpoint's anchoring deadline and the intake cutoff `c_I` |
| `COUNTED_FETCH_ALLOWANCE` | 43,200 | `A'`: seconds after `t_S` within which a seat must fetch the counted extent and attest it                                       |

From them, the definition and the release's `F` and `R`, every seat and verifier computes the same moments:

| Point             | A seat sends its record by | It counts if its submission time is at or before |
| ----------------- | -------------------------- | ------------------------------------------------ |
| 1, ballot extent  | `c_I = t_D − F − R`        | `t_A = c_I + F`                                  |
| 2, counted extent | `c_A' = t_S + A'`          | `t_A' = t_S + A' + F`                            |

and no summed share over the counted set is sent before `t_A' + R` (What a seat does). A record's submission time is the timestamp of the L2 block that emitted its event (Contract path), so a record sent by its cutoff is in time even if the sequencer refuses it and it is forced through L1. A seat stands down only once its record is **recorded by the contract** in [[delivery]]'s sense (Direct submit): its event derivable from finalized L1 data, read through sources the seat chose itself, never a sequencer's soft confirmation; a record the sequencer took into an unsafe block, but whose batch isn't on L1 by the cutoff, is forced through L1 by the cutoff all the same. So a sequencer can delay a record but not exclude it (T-25, T-71). A record that isn't in time is ignored, wherever its event is on the board.

**The bound.** `A` enters [[delivery]]'s window bound (Direct submit):

```
DELIVERY_WINDOW ≥ max(2 · period + deadline + A, W_C) + F + R
```

A ballot cast by the close is in a segment at most one period after it, `s_A`, whose checkpoint is due by `closes_at + 2 · period + deadline`, and the delivery windows count from `closes_at + l1_inclusion_bound`, so the bound leaves every seat at least `A` between the ballot extent's last anchoring deadline and `c_I`, whatever the operator withholds until that deadline, less the minutes L1 takes to finalize the anchor (`l1_inclusion_bound`, at least 10 minutes, roughly makes them up). `deliveryWindowFits` checks it, and P4-1 and P1-18 MUST keep their values within it. With hourly periods, a 12-hour anchoring deadline, `F` and `W_C` of 13 hours, the bound needs 26 + 13 + `R` hours of `DELIVERY_WINDOW`'s 48, so the release's `R` can be at most 9 hours, where before `A` it could be 21 ([[delivery]], Capacity).

Why these values:

- **Twelve hours to fetch the ballot extent.** A seat follows the board while the poll runs, fetching each segment object as its checkpoint lands on L1 (What a seat does), so at `C_A`'s deadline an honest operator has left it only the last segments to read. `A` covers a seat that was briefly offline, or an operator that published late but before the deadline; an operator that withholds the extent for longer fails the election `unavailable`, which is what the rule is for. A longer `A` would shrink the `R` the windows allow, and with it the forced path's capacity for a seat's receipts ([[delivery]], Capacity), or lengthen `DELIVERY_WINDOW` and with it the seal (T-54).
- **Twelve hours to fetch the counted extent.** After `C_A` the board gains mostly delivery records and contract events every seat already reads from its own L2 node, and a root's leaf object can be fetched from the moment its root is sent, by `c_D` for receipt roots and by `c_K` for complaint roots ([[delivery]], Leaf availability, Summing), days before `t_S`. `A' + F + R`, 26 hours with the deployed constants, comes out of `TALLY_WINDOW`'s 7 days, and out of `AUTHOR_OPENING_WINDOW`'s 4 for an author panel, before any summed share; a longer `A'` would leave less of either for the exchange and the combination ([[tally]], Tally window).

Both are constants of the records' version, never chosen per election (T-34). `A` and `A'` are each followed by `F`, so a seat that is censored at its cutoff is still in time, and the tally waits `R` more for L1 finality.

## What a seat does

Every qualified seat of every panel, through its own node, never our API:

1. **Follows the board.** While the poll runs and until the counted extent, it reads each counted checkpoint from finalized L1 through sources it chose itself and fetches its segment object by `object_cid` from any source (IPFS, the archive, the operator, other seats), reading the board as [[board]] (A copy from L1's CIDs) does: every block checked against its CID, every run against the anchored head and root.
2. **Attests each point.** Once the point's checkpoint (`C_A`, then `C_S`) is fixed on finalized L1, if its copy reaches that checkpoint's size and passes [[board]]'s board checks steps 1 to 3 and `checkpoint-cid` for every counted checkpoint through it, it signs an attestation of the point naming that checkpoint's hash, stores it before sending it, and sends the stored bytes through the contract path as soon as it can, resending them, forced through L1, until they are recorded by the contract (Windows), and by the point's cutoff (`c_I`, `c_A'`) at the latest, whatever the sequencer accepted. At point 2 it names in `roots` every obligation root in time for the election that it holds and has checked ([[delivery]], Leaf availability), read from its own L2 node, and only those. A retry resends the stored bytes.
3. **Complains if it can't.** A seat that can't attest a point by its cutoff, less what it needs to send, signs a availability complaint naming the checkpoint and the `object_cid` of the first run its copy stopped at, and sends it the same way, by the same cutoff. It keeps fetching, and if it then holds the extent before the cutoff it attests as well.
4. **Serves what it attested.** From the moment it attests, to every other seat of either panel first and publicly: every segment object and entry-hash list of the extent, by their CIDs, pinned on IPFS, until the archive confirms them and through the verification period after the seal ([[0029-board-data-availability]], Consequences; P4-5), and every leaf object it names, as [[delivery]] (Leaf availability) requires.
5. **Signs once per point.** A seat signs at most one attestation and one complaint per point. A second attestation with other contents would be its own signed word against itself; the contract path keeps only the first (Contract path), so a seat that finds its attestation wrong leaves it.

**No summed share before the quorum.** A seat MUST NOT send any summed share over the counted set ([[tally]], Summed shares) before `t_A' + R`, and then only once its own L2 node's chain derived from finalized L1 ([[close]], Terms, `head(L)`) has reached an L2 block with a timestamp after `t_A'`, so that it reads every record that can count and no other seat reads more, and it has read there, never from the operator or another seat, at least `k_P` attestations of each panel `P` at each point that count (Availability check), and holds every available root's leaf object ([[delivery]], Leaf availability, Summing). If either point lacks a panel's quorum, it sends none: the election has failed `unavailable`, and a tally of it would only publish a result that can never verify. So no seat attests knowing a result, and no seat's attestation can be withheld once a result exists (T-54, T-14). The derived head can reach `t_A'` later than `t_A' + R` when batches lag, and the seat then waits for it. Running openings during a live poll come before the ballot extent and aren't held back by this rule ([[tally]], Live results; Residuals).

**The ballot extent and what a node owes.** A seat attests the ballot extent by `c_I`, the same moment it decides what it owes ([[delivery]], What a node owes), and an attesting seat holds every segment through `s_A`, so it can show absent every ballot that isn't on the board through `s_A` or recorded by the contract. A seat that can't attest still decides at `c_I` over the view it holds, as before.

## Contract path

Both records count **only through the L2 contract path**, never through the board: the board copy is exactly what may be withheld, so the verdict must be decidable without it ([[0029-board-data-availability]], option D). The board contract ([[contracts]], Board, Availability records; P4-3 part 2c-2) MUST, before any election registry accepts a definition whose profile pins the contract-event version that carries the calls:

- accept an attestation or a complaint only if it decodes strictly under the version the profile's contract-event version fixes, names a registered definition and a seat of the named panel's key set, and its signature verifies under that seat's registered per-election signing key (P-256 verification on L2);
- accept at most **one attestation and one complaint per definition, panel, seat and point**: the first that verifies fills that slot, a byte-identical repeat is a no-op, and any other is refused, so only the seat's own signature fills its slot and no seat can archive more than four records per election (T-52, T-17);
- accept an attestation only if every entry of its `roots` is the record hash of an obligation root the contract accepted for that definition, so the list carries no bytes the seat chooses beyond which roots it names (T-17);
- emit each accepted record as an event under the board's event accumulator, with the block timestamp that is its submission time.

It can't judge `checkpoint_hash` or `cid`, which name L1 data the L2 doesn't read, so a seat can archive 32 chosen bytes in each, and its ECDSA nonce, per record: within what a registered seat could disclose anyway, attributed to it (T-17, T-14). The election registry MUST refuse every profile whose contract-event version carries no availability event, now that version 8 carries them, as it refuses a profile without the close rule's calls ([[contracts]], Election registry, Registration, rule 9); the deployable registry pins version 8 since P4-3 part 2c-3a, and [[verifier]] 2.3 requires it ([[contracts]], Event tables (version 8)).

An author seat's records need the author panel's key set on L2, which the election registry records with the definition ([[contracts]], Election registry, Author panel registration) and the board's `availability-seat` and `availability-signature` read for panel 2 ([[contracts]], Board, Availability records), as specified in [[P2-16]] part 5a. Until the rest of part 5 builds them, no author seat's attestation can count, so every election with an author panel would fail `unavailable` (Availability check); the election registry refuses such a definition until then.

## Availability check

[[verifier]] 4.6, an election check. Its inputs come from L1 and the L2's events alone, never from the board copy:

- the definition, whose hash is registered on L2 (2.1), with `closes_at`, `l1_inclusion_bound` and each panel's threshold;
- the counted checkpoints from L1 ([[verifier]], Anchors from L1), and with them `C_A` and `C_S`;
- each panel's key set from the L2's registration events (Terms);
- the board contract's events of both record types, from any L2 source or the archive, as contract-event records in the contract's event order, each with its submission time (which never decreases in that order), replayed with every other event of the contract against its event accumulator, proven at an L2 block whose timestamp is at or after the point's `t_A` or `t_A'` ([[contracts]], Event accumulator, Verification; [[0025-contract-event-evidence]]). If no such proof is held, or the replay doesn't match ([[verifier]] 4.4's codes), that point is unverifiable, never failed, so a withheld or erased attestation event can't fail an honest election.

Each record of either type, in event order, is decoded strictly (one that doesn't is a rejected entry, listed in 8.3, though the contract path never emits one) and then judged once; the first of these codes that applies is its code:

| Code                      | When                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `availability-stray`      | `definition_hash` isn't this definition's. Listed with the seat this election's keys attribute it to, if any                                                                             |
| `availability-seat`       | `seat` isn't a seat of panel `panel`'s key set (an author panel's in a poll without one included)                                                                                        |
| `availability-signature`  | The signature doesn't verify under that seat's registered signing key. Attributed to no one                                                                                              |
| `availability-repeat`     | An earlier record of the same type, panel, seat and point has passed the codes above: the contract keeps only the first                                                                  |
| `availability-late`       | Its submission time is after its point's `t_A` or `t_A'`. Attributed to its seat, which sends by its cutoff (What a seat does)                                                           |
| `availability-checkpoint` | `checkpoint_hash` isn't its point's checkpoint's, or that checkpoint doesn't exist. Attributed to its seat for an attestation; a complaint names the checkpoint only as the seat read it |

A record that passes them all is **valid**, and an attestation that is valid **counts**. Then, for each point and each panel of the election, in that order (the ballot extent, then the counted extent; the default panel, then the author panel):

- each seat of the panel key set **attested** if it has an attestation of the point that counts, and otherwise **complained** if it has a valid complaint of the point, or else is **silent**;
- the panel **holds** the point if at least `k_P` seats attested. Otherwise 4.6 fails `unavailable`, naming the point and the panel.

4.6 fails if some panel doesn't hold some point, and passes once every panel holds both points. It is attributed to no single party, like `tally-missing`: the report lists the seats that attested, those that complained, each complaint with its CID being that seat's signed word against the anchoring authority and the board operator, and those that were silent ([[0029-board-data-availability]], option D). A point's verdict waits on its evidence alone: while the verifier's finalized L1 block is before the anchoring deadline of `s_A`, or no proof at or after `t_A` is held, the ballot extent is unverifiable, and so for `s_S`, `t_A'` and the counted extent; a failure at one point fails the election whatever the other's evidence.

**Precedence.** 4.6 reads no board copy, so it is decided whether or not any copy of the board can be found. A board that was withheld leaves 4.1 and 4.2 unverifiable from every source (`checkpoint-missing`, `copy-mismatch`, [[board]], Board checks), and if the panels didn't attest it, 4.6 fails, so the election's verdict is `failed` ([[verifier]], Verdicts), never unverifiable for good. Where every panel held both points but no copy can be found, the result stays unverifiable, with the attesters named (Residuals).

**The counted extent's attestations elsewhere.** The attestations of the default panel that count at point 2 are the counted-extent attestations [[delivery]] (Leaf availability) reads, each with its `roots`, to decide which obligation roots are available.

**Report.** For each point: its checkpoint (`segment` and hash, or that there is none) and, for each panel, whether it holds the point, the seats that attested (at point 2, each with the roots it names), the seats that complained with each complaint's CID, and the silent seats; and every record with its code. [[verifier]], Report (`availability`), lays out the ballot extent's, the only point the verifier decides so far ([[verifier]], Availability).

## What it closes

Once the contract path, the check and the seats' job are built (P4-3 parts 2c-2 to 2c-4), and not before:

- **Withheld extents fail.** An operator or anchoring authority that withholds any part of the ballot or counted extent from the seats past its allowance can't reach a panel's quorum unless `k_P` seats attest to data they don't have, a coalition that can already open ballots (T-14). The election then fails `unavailable`, reproducibly from L1 and the L2's events, instead of staying unverifiable for good ([[board]], Residuals, withheld tails; T-24, T-53).
- **What a node owes.** A seat that attested the ballot extent at `c_I` holds every counted ballot that reached the board through the operator, so the newest-ballot residual and the complaint-scope residual of [[delivery]] (Residuals) need withheld data that a quorum then attests falsely, or a failed election (T-25, T-54).
- **Roots.** An obligation root's leaves become available only through these attestations, so elections that commit roots ([[delivery]], Elections that commit roots) can deliver once the contract path exists.

## Residuals

- **The transitional panel.** Until independent trustees are named ([[P1-7]]), the default panel is the operator's alone, so its attestations are the operator vouching for its own board, and this check adds only signed self-attestations to the CIDs ([[0029-board-data-availability]], Cons; T-24, T-14).
- **Attest, then withhold.** A quorum can attest and then, with the operator, withhold everything; the election then stays unverifiable, never failed, with the attesters named on L2 (T-24, T-53).
- **A colluding quorum** can attest data it doesn't hold, as it can open ballots, and compelling one to sign a false attestation leaves less trace than a decryption would (T-14, T-69).
- **The tail after the counted extent** (spoiled-ballot openings, tally openings, destruction statements) stays unverifiable, never failed, when withheld: a quorum over it would come after the result and hand the trustees a veto (T-54).
- **The verdict rests on the L2's history.** The events are retrievable from L1 blobs for about 18 days and then from L2 archive nodes or our archive, and the accumulator proof rests on an output root that the proposer can make false, which can make 4.6 unverifiable but never `unavailable` (T-71, T-50).
- **A live poll's panel can refuse a trend.** Its running totals are public during voting, so a panel threshold that dislikes them can refuse to attest and fail the election, as it can refuse the tally ([[0027-trustee-panels-and-live-results]]; T-54).
- **Silence fails the election.** `n − k + 1` seats of a panel that are offline through a cutoff fail the election `unavailable` before any result, as the same seats can by refusing the tally; the liveness duty comes earlier, at `c_I` and `c_A'` (T-54).
- **Growing an extent costs the seats their fetch.** Anyone can grow the counted extent through the contract path (postings and junk records each are a contract event, boarded whatever they carry, [[delivery]], Residuals), and the operator can grow either extent with rejected entries, up to `MAX_BOARD_PAYLOAD` each. A seat that follows the board through the poll fetches each segment as it is anchored, so the allowances need only cover the last segments, but nothing bounds how much an extent can grow in them: a funded adversary or an operator that fills them past what the seats can fetch in `A` or `A'` fails the election `unavailable`, before any result, with the complaints naming the CIDs (T-52, T-54). It is a liveness attack, priced in gas for the contract path; a cap on what one period may add would bound it and is not specified.
- **The forced path doesn't reserve the seats' records.** A seat may have to force up to four records per election through L1, at `c_I` when its receipt interval starts and at `c_A'`; `forcedPathFits` counts only receipts and complaints ([[delivery]], Capacity). They are a few deposits per seat, small against the portal's per-block maximum, so at a cap they cost a higher deposit price rather than a missed deadline (T-25, T-52).
- **Chosen bytes.** A registered seat can archive up to 64 chosen bytes in `checkpoint_hash` and `cid`, and its ECDSA nonces, in at most four records per election, attributed to it (Contract path; T-17).
- **Until it is built** nothing fails an election for withholding at the counted extent, and nothing at all against authenticated inputs: the verifier decides only the ballot extent, from an output root that is a local input until it is read from L1, and with the key set the copy's transcript gives ([[verifier]], Availability; P4-3 part 2c-3b); no seat attests (part 2c-4); no root can deliver ([[delivery]], Capacity). The board takes the records since part 2c-2, and every registered profile pins the version that archives them since part 2c-3a.

## Test vectors

`docs/spec/vectors/availability.json` ([[vectors/README|vectors]]): attestations at both points (with no roots, one and several) and availability complaints re-made byte for byte with their signed messages; every decode rejection with its offset (truncation inside each field, another record type, an unpinned version, a `panel` or `point` of 0 and 3, roots at point 1, roots out of order or repeated, more than 32 roots, a complaint CID of another codec, version or hash, a high `s`, `r = 0`, a trailing byte); the windows `c_I`, `t_A`, `c_A'`, `t_A'` and `t_A' + R` for several closes and margins; and availability checks with each record code and each verdict: every panel holding both points, a quorum exactly at `k` and one short, complaints beside attestations, a seat that complained and then attested, late records at a second past `t_A` and `t_A'`, attestations naming another checkpoint or another definition, unregistered seats, signatures by another seat's key, repeats, a point with no checkpoint, an author panel without a key set, and records in another order giving the same verdicts. They are printed by `packages/crypto/scripts/availability-vectors.py`, which uses `trustee-vectors.py`'s P-256 ECDSA and its own decoder and check, and shares nothing with `packages/crypto`.
