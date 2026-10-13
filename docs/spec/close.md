# Close rule

Which ballots are inside a poll's window ([[verifier]] 5.5), and how a verifier checks, years later, that an ordinary contract-path ballot in a block at or before close wasn't put there after close by a sequencer rebuilding unposted blocks: the trustees' **close statements** (record type `0x0015`), the **close head** they give, and the **close check** ([[verifier]] 6.3). Decided by [[0030-close-rule]] (option E): the contract's timestamp rule decides which ballots count, and the close head only checks it, so no one, the panel included, can change which ballots count. Notation and decoding rules are from [[notation]], tags from [[domain-separation]], signatures from [[trustee-identity]]. Threats: T-35, T-50, T-25, T-33, T-45, T-53, T-54, T-36, T-71.

This page is P1-18 part 4c-2a. Part 4c-2b adds the L1 relay that carries forced ballots (its call, accumulator and events), contract-event version 3 with the board's relayed-ballot event and the statements' contract path, the board-entry version that allows the statement, and the election registry's fields with the bounds on `l1_inclusion_bound`; each is named below where this page relies on it.

## Terms

- `δ` is the definition's `l1_inclusion_bound`, in seconds ([[election-definition]]).
- `τ_b` is the timestamp of L2 block `b`, as the contract-event record carries it (`l2_timestamp`, [[contracts]], Contract-event record) and the event accumulator authenticates it.
- `L_δ` is the last block of the definition's finalized L1 chain (`l1_chain_id`) whose timestamp is at or before `closes_at + δ`. It is known once L1 has finalized a block with a timestamp after `closes_at + δ`; a verifier or node needs the headers of `L_δ` and the block after it to show which block it is. `closes_at + δ` fits in a `u64` (the `timing` rule), and L1 timestamps strictly increase with the block number, so exactly one block is `L_δ`.
- `head(L)` is the **derived head at `L`**: the highest-numbered L2 block, with its block hash, that the L2 derivation rules the verifier's release pins ([[verifier]], Pinned trust roots) derive from the L2's genesis and the L1 chain up to and including block `L` alone. On the OP Stack it is the safe head once the derivation pipeline has consumed every L1 block through `L` and no later one. It is defined by the rules, never as what a node reports: op-node's safe-head-at-L1 index is optional and can't be rebuilt once the blobs it read have expired, so no rule here reads it.
- `N_c` is the last L2 block with `τ ≤ closes_at`. It is never read: L2 timestamps are fixed by block number, so `τ_b ≤ closes_at` says `b ≤ N_c`.
- The **default panel's registered key set** is the registered key set of the election's default panel ([[ceremony]], Transcript check): each qualified seat and its per-election signing key. Under definition version 6 an author panel makes no close statement.

## Window

Three paths bring a ballot to the board, and each has its own test of being inside the poll's window. The test reads the entry that carries the ballot, never the ballot's bytes, so copies of one ballot are judged each by its own path.

| Path                                                                                                 | Inside the window when                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ordinary**: a `BallotSubmitted` contract event of the board ([[contracts]], Board, Events)         | `opens_at ≤ τ_b ≤ closes_at`, `b` the L2 block that emitted the event                                                                                                              |
| **Relayed**: the board's relayed-ballot event, for a ballot forced through our L1 relay (part 4c-2b) | `opens_at ≤ stamp ≤ closes_at`, `stamp` the L1 block timestamp the relay recorded for the call that [[verifier]] 4.5 matches with the event, never a value the event carries alone |
| **Board path**: a ballot record (`0x0002`) in a board entry ([[board]])                              | the entry's `segment` is at most `s_A = period(closes_at) + 1`, with `period(t) = ⌊(t − epoch) / period⌋` under the anchoring clock ([[board]], Timing)                            |

This is 5.5, an admission check ([[verifier]], Principles): a ballot entry outside its window is rejected, listed in the report with its code, and never counts or displaces another ballot (R4). It runs after [[ballot-validity]]'s admission checks (5.1 to 5.4) and before [[revoting]]'s L1-reference checks (5.8), so its code is reported before theirs. Its codes:

| Code                  | Rejects a ballot entry when                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window-before-open`  | An ordinary ballot's `τ_b`, or a relayed ballot's `stamp`, is before `opens_at`.                                                                                                 |
| `window-after-close`  | An ordinary ballot's `τ_b`, or a relayed ballot's `stamp`, is after `closes_at`.                                                                                                 |
| `window-boarded-late` | A board-path ballot is in a segment after `s_A`. It is also reported against the board operator: an operator that refuses board-path ballots after `closes_at` never boards one. |

Repeats ([[verifier]] 5.7) are found among the entries 5.5 admits, so a late copy never stands in for a timely one, and a timely copy stands whatever happened to the others. A board-path ballot first boarded by `s_A` is therefore counted even if the operator boards it again later.

Why each path's test:

- **Ordinary.** The board refuses a ballot outside the window by the same test ([[0030-close-rule]], Options; part 4c-3), and the verifier repeats it, so a board deployed without the check, or L2 governance rewriting state, never admits one (T-71). The block's timestamp is fixed by its number, so the sequencer can't choose it; what it can do is rebuild unposted blocks before close with other transactions, which the close check below detects beyond `δ`. An L1 origin at or before close would admit blocks up to `max_sequencer_drift` after close with the same rebuild window, so it is never the test.
- **Relayed.** A forced ballot reaches L2 up to the sequencing window after its L1 transaction (T-50); its time is when L1 included it, which no sequencer chooses. An L1 timestamp is its slot's start and a proposer may publish a few seconds into the slot, so a forced ballot's window after close is seconds.
- **Board path.** Nothing public shows when within the anchoring period a board-path ballot reached the operator ([[0029-board-data-availability]]), so its window is the operator's word up to `s_A`, which [[board]]'s client rule 1 needs: a ballot cast in close's period may carry the next segment. The operator MUST refuse every board-path ballot that reaches it after `closes_at` (T-35, Residuals).

## Close statement

After close, each seat of the default panel's registered key set states which L2 block was derivable from L1 data up to `L_δ`, in a signed **close statement**, record type `0x0015`, version 1.

| Field             | Type        | Meaning                                                                         |
| ----------------- | ----------- | ------------------------------------------------------------------------------- |
| `definition_hash` | `bytes[32]` | The election's definition hash                                                  |
| `signer`          | `u8`        | The seat making the statement, a seat of the default panel's registered key set |
| `l1_number`       | `u64`       | The number of `L_δ`                                                             |
| `l1_hash`         | `bytes[32]` | `L_δ`'s execution-layer block hash (its header's Keccak-256)                    |
| `l2_number`       | `u64`       | The number of `head(L_δ)`, the seat's **claim**                                 |
| `l2_hash`         | `bytes[32]` | `head(L_δ)`'s L2 block hash                                                     |
| `signature`       | `p256-sig`  | The seat's signature (below)                                                    |

`signature` is an ECDSA P-256 signature by seat `signer`'s per-election signing key ([[trustee-identity]], Which key signs what), under `abolish/v1/sig/close-statement`, over the record's encoding without its signature:

```
u16(0x0015) ‖ u8(1) ‖ definition_hash ‖ u8(signer) ‖ u64(l1_number) ‖ l1_hash ‖ u64(l2_number) ‖ l2_hash
```

116 bytes; a statement is 180. The header is signed so a later version that gives the same fields another meaning can't reuse a version 1 signature (T-31). The definition hash fixes the chain, the election, `closes_at`, `δ` and the ceremony transcript, and with it the key set the signing key is in. `L_δ` is named so that a statement made against another L1 block is the seat's signed mistake, never one a verifier must guess at. A statement's **claim** is its pair (`l2_number`, `l2_hash`); two statements **agree** when their claims are equal. `head(L_δ)` is one block of one chain, so statements that disagree show that one of them is false, without any L1 data. The L2 block hash binds the claim to one chain: a verifier holding L2 headers, or an output root at that block, can check it.

**Decoding** is strict ([[notation]], Strict decoding): fixed lengths, a canonical low-`s` `p256-sig`, nothing trailing. It doesn't compare `definition_hash`, `signer` or the L1 block with the election; the checks below do.

**Version.** No profile pins the close statement: the board-entry version that allows it fixes its version, together with the contract-event version that carries its contract path (part 4c-2b), as the tally-opening version fixes the destruction statement's ([[versioning]], Three levels). Before any election registry is deployed, [[verifier]] 2.3 MUST require a profile to pin a board-entry version that allows the statement, and the registry MUST refuse every other profile, so no registered election leaves its seats without a way to state the close (part 4c-2b).

**Window.** Version 1 fixes the **close window**, `CLOSE_WINDOW = 172,800` seconds (2 days), counted from `closes_at + δ` ([[parameters]]):

```
t_C = closes_at + δ + CLOSE_WINDOW
s_C = period(t_C)
```

A statement is **in time** if it reached the board through the board path in a segment at most `s_C`, or through the contract path with a submission time (its L2 block's timestamp) at or before `t_C`, whatever segment its contract event is boarded in. The window, followed by the contract-event window, is a term of [[tally]]'s `W_S`; it equals the delivery records' `DELIVERY_WINDOW`, so it moves no `s_S`. Two days cover a node that is offline at close and forced inclusion of a statement sent at the end, and every statement in time is then in the counted extent, so the close check can be decided once the counted set is. A longer window would postpone the counted set (T-54). It is a constant of the version, never chosen per election (T-34).

**What a node does.** Each seat's node, once its own finalized-L1 source ([[delivery]], Direct submit) has finalized a block with a timestamp after `closes_at + δ`:

1. finds `L_δ` from headers it read itself;
2. runs the pinned derivation rules on its own L2 node over that L1 source, through `L_δ` and no further, and takes `head(L_δ)`, never from our API, the sequencer, another node or an RPC provider's safe head;
3. signs the statement, stores it before sending it, and sends the stored bytes through the board path and the contract path, as soon as it can and through the contract path by `c_C = t_C − F` at the latest (`F` as in [[delivery]], Direct submit), unless by then its statement is anchored on the board. A retry resends the stored bytes.

A node signs **one** statement per election. A second statement with another claim is equivocation, and none of the seat's statements then counts (Close head). So a node that finds its statement wrong (a bug in its derivation, say) leaves it: the close head tolerates fewer than `k` false statements, and a seat that equivocates loses its say altogether. The node computes the head promptly: the blobs it derives from are pruned from L1 after about 18 days.

**Boarding.** The board operator boards a close statement through the board path only if it decodes strictly under the version the pinned board-entry version fixes, names this election's definition, its signature attributes it to a seat of the default panel's registered key set, its `l1_number` and `l1_hash` are `L_δ`'s, it is in time, and the board doesn't already hold a statement of that seat with the same claim, nor two of that seat with different claims; it refuses every other. Admitting a second, different claim lets the board show equivocation that a seat sent only through the board path, and stopping there bounds what a seat can archive through the board path to two statements' 64-byte nonces and 40 bytes of claim each (T-17). The operator doesn't judge the claim: its own L2 view is not evidence. Statements through the contract path are boarded as contract events like any other, late or not ([[verifier]] 4.4).

## Close head

The verifier reads every close-statement payload in the board's sealed extent, each with its path and its segment (board path) or submission time (contract path), and judges each in board order; the first that applies is its code:

1. A payload that doesn't decode strictly is a rejected entry ([[verifier]] 8.3).
2. `close-stray`: `definition_hash` isn't this definition's. Listed with the seat this election's keys attribute it to, if any.
3. `close-unattributed`: `signer` isn't a seat of the default panel's registered key set, or the signature doesn't verify under that seat's signing key.
4. `close-l1`: `(l1_number, l1_hash)` isn't `L_δ`. Attributed to its seat, which signed a false L1 block.
5. `close-late`: not in time (Window). Attributed to its seat, unless it reached the board through the board path, where the operator may have held it back.

A statement that passes all five is **valid**. Then, for each seat of the default panel's registered key set:

- A seat with no valid statement is `close-missing`.
- A seat whose valid statements don't all agree is `close-equivocation`, attributed to it for good, and none of its statements counts. Statements that agree are one statement, whatever their signatures (ECDSA lets the signer make many).
- A seat whose valid statements agree, with a claim below the **floor** `g` (below), is `close-below-floor`: the claim is false, for good, attributed to the seat, and doesn't count.
- Otherwise the seat is `close-counted`, with its claim.

The **close head** `B` is the `k`-th largest `l2_number` among the counted seats' claims, with `k` the default panel's threshold. With at least `k` honest seats counted and fewer than `k` false claims, `B` is the honest value: false claims above it are at most `k − 1` of the largest, and false claims below it can't reach the `k`-th place while `k` honest claims stand above them. With fewer than `k` counted seats there is no close head. Only `l2_number` enters `B`; the claims' hashes enter equivocation and the report.

Statements are judged by their own window, wherever they are in the sealed extent, so `B` is the same over the counted extent and over the whole sealed extent, and no late statement changes it in [[tally]]'s `tally-late` recomputation. A statement is never a record that changes a counted set.

**The floor.** `g` is the highest L2 block number claimed by a dispute game that:

- is a game of a type the verifier's release pins as permissionless, settled by a fault or zero-knowledge proof anyone can challenge or check. A TEE-only game never counts: Base's proposer allowlist and its sequencer are one operator, so a TEE-only game could raise the floor over every honest claim and leave the close unchecked (T-71);
- has an L1 head (the block whose data its claim is judged against) at or before `L_δ`, so the block it claims was derivable by `L_δ` and `head(L_δ)` is at least it;
- was resolved in its claim's favour in an L1 block with a timestamp at or before `t_S` ([[tally]], Tally window), so the floor is the same for every verifier once L1 has finalized a block after `t_S`, and a game resolved later never changes it (T-36).

With no such game there is no floor. The games are read from L1 state, as [[0025-contract-event-evidence]]'s evidence already reads them; until L1 has finalized a block after `t_S`, the close check is unverifiable.

## Close check

[[verifier]] 6.3, an election check, run after selection (6.1) and delivery (5.9) over the counted extent:

1. **No close head.** The check passes, and the report says the close is **unchecked** (`close-unchecked`), names the seats that aren't counted, and lists every counted ballot with no admitted copy outside the ordinary path, whose block it couldn't check. A missing statement must not let `n − k + 1` seats fail an election by silence (T-54).
2. **Late ordinary ballots.** Otherwise let `A` be every ballot entry in the counted extent that the admission checks admit (5.1 to 5.5 and 5.8, before repeats), and `A'` the same with every ordinary entry whose L2 block is after `B` removed. The removed entries are the **late ordinary ballots**, whatever they would have counted.
3. **Recompute.** Each cell's counted set is computed from `A'` exactly as from `A`: repeats (5.7), then selection ([[revoting]], Selection), then delivery and complaints ([[delivery]], Delivery check), with the same delivery records. Late ordinary copies are removed before repeats are resolved, so a ballot that also has a timely copy (relayed, board-path, or ordinary in a block at or before `B`) keeps it, and its group selects the same ballot.
4. **Compare.** If any cell's counted set from `A'` differs from its counted set from `A`, as sets of (`tier`, `ν`, `M`), the election fails `close-contested`, unattributed, naming the first such cell in partition order. Otherwise the check passes.

The counted set the tally opens is always the one from `A` (7.1): `B` never decides which ballots count, so neither the panel nor anyone holding `k` seats can drop a ballot by stating low, only fail the election, loudly, as `k` seats refusing the tally can already (T-53, T-54). A ballot in a block after `B` that changes a result fails the election because the verifier can't tell a batch an honest batcher posted late from a block the sequencer rebuilt after close, and it never guesses, as `tally-late` recomputes and fails rather than pick a set (T-35, T-45). A late ordinary ballot that changes no counted set (one a newer timely ballot of its voter outranks, a copy of a ballot that also has a timely copy, a voter's only ballot left undelivered) fails nothing. One that changes a set by counting nothing does fail it: a late re-vote that is undelivered, or that ties a timely ballot, leaves its group counting nothing, and without it an earlier ballot counts ([[revoting]], No fallback).

Delivery is unchanged between the two computations: every delivery record names a ballot hash, never an entry, so a ballot counted in both is delivered in both ([[revoting]], Owned elsewhere: Keyed by content).

**Report.** Beside the verdict, the report gives `B` (or that there is none), each seat's code with its claim, each statement's code, the late ordinary ballots, and for `close-contested` the first cell that differs. Valid statements whose claims differ (counted or not) are always listed, since they prove a false statement without any L1 data. A verifier that still holds the L1 data (the blobs, for about 18 days) and derives `head(L_δ)` itself MAY report every statement whose claim differs from its own, against its seat, and a close head that differs from its own; it never changes its verdict for it, so every verifier with the same board and finalized L1 reaches the same verdict whatever blob data it holds (T-36). How the report lays these out is P1-19's, with its implementation.

## Residuals

- **Within `δ` the sequencer can rebuild silently.** A sequencer that withholds batches can rebuild unposted pre-close blocks with ballots made after close, and if their batches land by `L_δ` they are below `B` and count. The rebuild is visible while it happens (the unsafe head reorganises, the safe head stalls) but leaves no evidence anyone can archive. `δ`'s ceiling bounds it (part 4c-2b; T-35, T-45).
- **Beyond `δ`, only with `k` seats lying.** A rebuild whose batches land after `L_δ` fails the election if it changes a result, unless `k` seats state a head above the true one. A false claim above the floor can be shown false only while the L1 blobs are retrievable (about 18 days), unless two statements disagree; after that, `k` colluding seats stating high can hide such a rebuild (T-35, T-14).
- **An honest batcher outage longer than `δ` around close** can fail an election whose result a late-batched ballot would change (`close-contested`, unattributed); the poll must then be run again (T-50, T-53). A client that sees its ballot's block not yet derivable from L1 well before close MAY relay a copy through L1 (part 4c-2b), which keeps that ballot out of the comparison.
- **Silence leaves the close unchecked.** `n − k + 1` seats that send no statement, or whose statements equivocate or fall below the floor, leave the close unchecked: reported, never failed (T-54).
- **The board path's close is the operator's word.** A compromised operator working with a coercer can board a ballot made up to about two periods after close, by `s_A`. It still needs the voter's identity secret, so the coercer must have the voter make it (T-45, T-35).
- **The floor rests on dispute games.** A slow or absent permissionless proposer leaves no floor, which only means a statement below the true head isn't excluded, so `k` low statements can fail the election, as they could anyway.

## Test vectors

`docs/spec/vectors/close-statement.json` ([[vectors/README|vectors]]): close statements re-made byte for byte with their signed messages; decode rejections (truncation, a trailing byte, another record type, version 2, a high `s`, `r = 0`); `L_δ` found in L1 headers, at and around `closes_at + δ`; the close head over a board's statements, with every statement code and every seat code (all honest, liars above and below, `k` liars above, equivocation, the floor excluding a claim, too few counted seats, a late statement through each path, a wrong `L_δ`, stray, unattributed and rejected statements, disagreeing claims); and close checks over admitted ballots (no late ballot, a late ballot that changes its cell, one that changes nothing, one whose relayed, board-path or earlier ordinary copy stands, an undelivered late ballot, a tie a late ballot would break, an unchecked close listing its ordinary ballots). They are printed by `packages/crypto/scripts/close-statement-vectors.py`, an implementation of this page in Python that uses `trustee-vectors.py`'s P-256 ECDSA and its own selection, and shares nothing with `packages/crypto`.
