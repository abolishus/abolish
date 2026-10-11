# Re-voting

Which of a voter's ballots counts. A voter may cast any number of ballots in a poll; for each tier and nullifier at most one counts. This page fixes what each ballot's membership proof binds so that ballots can be ranked ([[membership]], Message), the admission check on that binding, and the selection rule that [[verifier]] 5.7 and 6.1 apply. It meets requirements R1 to R6 of [[verifier]] 6.1. The choice of rule, and the options rejected, are in [[0011-revote-rule]]. Threats: T-33 (re-vote resolution), T-38 (substitution and replay), T-45 (observed coercion), T-25 (withholding), T-23 (board order), T-31 (one encoding). Notation is from [[notation]]; `H` and `DS` are from [[group]] and [[domain-separation]].

## Model

- **A fresh L1 reference.** Every ballot names a recent block of the election's L1 chain (`l1_chain_id` in the election definition) by its number and hash, and its membership proof binds both. A block's hash can't be known before the block exists, so a ballot is at least as new as the block it names, and can't be made in advance for a later one (T-45).
- **The newest reference counts.** For each tier and nullifier, the admitted ballot with the highest block number counts. If two distinct ballots share that number, neither counts, and nor does any other ballot of that nullifier in that tier (a tie).
- **Nothing else ranks.** The board position, the segment, the arrival time and the L2 block of a ballot never enter the rule, so whoever writes the board or orders the L2 can't choose which ballot counts (R3).

## Message

The membership proof's message ([[membership]], Message) is

```
M = H(DS("abolish/v1/membership-message",
         definition_hash ‖ u8(tier) ‖ ballot_hash ‖ u64(l1_ref_number) ‖ l1_ref_hash))
m̂ = F(M)
```

- `definition_hash` is the election definition's hash (P1-10b), the same value the nullifier scope binds.
- `tier` is the ballot's tier (0, 1 or 2), the same value its scope binds ([[membership]], Scope).
- `ballot_hash` is the ballot's hash under `abolish/v1/ballot` (P1-12): its commitments, ciphertexts and validity proofs, never its membership proof (which can't bind its own hash) and never the L1 reference (which `M` binds itself).
- `l1_ref_number` (`u64`) and `l1_ref_hash` (`bytes[32]`) name the L1 block: its number, and its execution-layer block hash as the block header's Keccak-256 (the `hash` that Ethereum's JSON-RPC `eth_getBlockByNumber` returns).
- The input after the tag is exactly 105 bytes. `F` is [[membership]]'s field mapping.

The ballot record (`0x0002`, P1-12) MUST carry `tier`, `l1_ref_number` and `l1_ref_hash` as fields, so a verifier recomputes `M` from the record and the definition alone, never from anything a server supplies.

**Why each part is bound.** The ballot hash stops a proof from being moved to another ballot (T-38). The definition hash and tier are bound by the scope already; binding them again makes `M` self-describing, so no message is valid for two polls or two tiers even if a scope were mistaken. The block hash is what makes the reference unpredictable: a block number alone could be chosen in advance, so a coercer could have a voter make ballots for future numbers while watching once and post them later (T-45). The number is bound so a verifier looks up exactly one block, never searches for one.

## Admission

These are admission checks ([[verifier]], Admission checks): a ballot that fails one is rejected, listed in the report with its code, and never counts or displaces another. Each depends only on the ballot, the definition and the finalized L1 chain, never on another entry, so admission is stable (R4).

A verifier reads the L1 chain named by the definition's `l1_chain_id` up to `head`, the number of the latest finalized block it has read, from `l1_ref_min` on: the number of the first finalized L1 block whose timestamp is at or after `opens_at − 3600` (one hour before opening). It checks a ballot's reference in this order, and the first step that decides is the verdict:

1. `l1-ref-before-open` if `l1_ref_number < l1_ref_min`. This compares numbers only, with no lookup.
2. Let `b` be the finalized block numbered `min(l1_ref_number, head)`. `l1-ref-after-close` if `b`'s timestamp is later than `closes_at`. When `l1_ref_number > head` this holds for the named block too, whether or not it exists yet: Ethereum's block timestamps strictly increase with the block number (one slot of 12 seconds or more per block).
3. If `l1_ref_number > head`, the ballot is **pending**: neither admitted nor rejected, and checked again once `head` has moved. Live monitoring (P4-5) reports it.
4. `l1-ref-unknown` if block `l1_ref_number` has a hash other than `l1_ref_hash`. A ballot naming a block that was reorganised away, or that never existed, fails.
5. Otherwise the reference is admitted.

| Code                 | Rejects a ballot when                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `l1-ref-before-open` | It names a block before `l1_ref_min` (step 1).                                                            |
| `l1-ref-after-close` | Its named block, or a finalized block numbered below it, has a timestamp later than `closes_at` (step 2). |
| `l1-ref-unknown`     | Its named block is finalized before close with another hash (step 4).                                     |

**Every verifier reaches the same verdict.** Once `head` is past close, the verdict doesn't depend on `head`: step 2 decides every number at or above the first block after close, and every smaller number is at or below `head`. Verifiers that have read different heads past close therefore report the same code for each ballot (T-36).

**Pending never lasts.** Once L1 finalizes its first block after `closes_at`, every ballot is decided, including one naming a number far beyond any block L1 will ever reach (`2⁶⁴ − 1`, say), which anyone can put on L2 by direct submit since contracts can't check it (Owned elsewhere). A verifier of a closed election waits for that block; until it is finalized the result is unverifiable, never verified. So no voter can keep an election unverifiable by naming a block that never comes (T-53).

**Bounded evidence.** Every lookup falls between `l1_ref_min` and the first finalized block after `closes_at`: the L1 range around the poll that the verifier reads for anchors anyway ([[board]], Anchoring; P1-19 archives it). Without the lower bound, a ballot naming an ancient block would need evidence nobody archives, and verifiers with different L1 sources would disagree (T-36, T-53).

**What it costs honest voters.** Nothing: a ballot cast after opening names a block a few seconds old, well inside the hour's margin, and a ballot cast by close names a block before close. Neither bound limits when a ballot is _made_: `l1-ref-after-close` stops a ballot from naming a block after close, not a ballot made after close from naming one just before it. Keeping those out is the close rule's ([[verifier]] 5.5, P1-18; Residuals).

Membership, validity and timing ([[verifier]] 5.1 to 5.6) are checked as before; [[membership]] Checks step 4 recomputes `m̂` as above.

## Selection

A verifier applies this to the ballots that passed every admission check, in any order. Each ballot gives a tuple (`tier`, `ν`, `M`, `l1_ref_number`, `index`), where `ν` is its nullifier as a `field<bn254>` and `index` its board position.

1. **Repeats (R1, [[verifier]] 5.7).** Ballots with equal (`tier`, `ν`, `M`) are one ballot: the one with the smallest `index` stands, and every other is a repeat, rejected with `repeat` and listed. Groth16 proofs can be re-randomised by anyone, so a repeat's bytes can differ from the original's; `M` can't, because a new `M` needs a new proof, and that needs the voter's secret. The ballot that stands has the same `ballot_hash` as every repeat of it, so which entry stands never changes what is counted.
2. **Grouping.** The remaining ballots are grouped by (`tier`, `ν`). Ballots in different tiers are never compared: one secret in two tier groups has two unrelated nullifiers ([[membership]], Scope; T-13).
3. **Ranking.** In each group, let `n*` be the largest `l1_ref_number`. If exactly one ballot has `n*`, it is the group's **selected** ballot. If two or more do, the group is a **tie**: no ballot of the group is selected, each of them is listed with `revote-tie`, and the group counts nothing.
4. **No fallback.** A selected ballot that a later election check excludes (the share-delivery rules of [[0002-everlasting-privacy]], or a proven complaint, P1-12, P1-15) makes its group count nothing. No earlier ballot is selected in its place, so a complaint after close can't revert a re-vote, and no exclusion re-evaluates another ballot (R4).
5. **Spoiled ballots never take part.** A challenged ballot and its opening ([[verifier]] 6.2) aren't ballots for this rule; P1-13's challenge part keeps them out of the input.

The selected ballots, one per group at most, are the input to the tally ([[verifier]] 7.1).

The result is a function of the set of admitted ballots alone: permuting the board, delaying an entry or moving it to another segment changes no selection (R3). Only a ballot's own `M` and `l1_ref_number`, both fixed by the voter when the proof was made, decide its rank.

## Client rules

A conforming ballot client (P2-8, P5-4):

1. **Reads L1 itself.** It takes the reference from a block it fetched from L1 through sources it chose (a light client, or several independent RPC providers that agree), never from our API or any one server's claim (R5).
2. **Names a recent, settled block.** It names the newest block it sees that is at least 2 blocks deep, so an ordinary one- or two-block reorganisation doesn't void the ballot.
3. **Never ties itself.** Each ballot it casts names a block strictly newer than every block it named before for the same election and tier, from its own records, except the tie escape of rule 5, which the voter chooses explicitly. If none is available yet, it waits (L1 makes a block every 12 seconds). It persists the record of a ballot's block before the ballot leaves the device, and a retry after a failure or crash resends the identical ballot (the same `M`, so at worst a repeat), never a new ballot on the same block. After casting, it alarms if the board shows any ballot under its nullifier that isn't in its records, on the same block (a self-tie) or any other: someone else holds the voter's secret, or a client the voter didn't use cast for them (T-46).
4. **Checks admission after finality, without a targeted query.** Once the named block is finalized, it checks the block's hash against its records. It reads that hash from a light client following finalized headers, or from a contiguous range of headers it fetches anyway (for its anchor checks, [[board]]), never by asking a provider for that one block: few clients would ask for one old block at that time, so the request would link the voter's network address to the ballot and its nullifier (T-11). If the block was reorganised away, the ballot will be rejected: it tells the voter and offers to cast again, with a new reference.
5. **Escapes a watched cast.** A voter who was made to cast while watched can, at once, cast again naming the same block as the watched ballot (from the client's own record of it): the two tie, so neither counts. Once a newer block is at least 2 deep, a ballot naming it outranks the watched one outright. The client offers both, the second as the normal re-vote.
6. **Proves only what is cast.** It computes the membership proof, and so `M`, only after the voter has chosen to cast, and never over a challenged ballot: a challenged ballot carries nothing that depends on the nullifier ([[board]], Spoiled-ballot openings). A proof made before that choice (to hide proving latency, say) would let whoever received it post the challenged ballot as cast, where it ties the real one and voids the vote.
7. **Casts in each tier independently.** A voter in two tiers casts and re-votes in each at independent times. Each ballot's block fixes when it was made to about 12 seconds, so casts made together in two tiers give their two unrelated nullifiers matching sequences of blocks, a public link between them ([[membership]], Scope; T-13).

## Requirements

How the rule meets [[verifier]] 6.1:

- **R1 Replay.** A replay has the same `M` as its original, so it is a repeat (Selection, step 1), whatever its proof bytes. Replaying an earlier ballot after a re-vote can't make it last: its `l1_ref_number` is still the one it was made with, which is lower than the re-vote's.
- **R2 No freezing.** Nothing a ballot carries can stop a later ballot from counting: a ballot made after a newer block exists can name that block, and then outranks it. The only value fixed at a cast that matters is the block, and blocks keep coming. The bound is in R6.
- **R3 Order independence.** Selection reads no position, segment or time. An operator who withholds an earlier ballot and posts it later, alone or with a coercer, posts a ballot that still ranks by the block it was made with. Direct-submitted ballots and ballots through our API are ranked alike.
- **R4 Stable admission.** The L1-reference checks read only the ballot, the definition and finalized L1. Repeats and ties are decided over admitted ballots and never feed back into admission. Later exclusions have no fallback (step 4).
- **R5 Client state.** The client needs only an L1 block it read itself and its own records of what it cast (Client rules 1 and 3).
- **R6 Liveness** (with P1-18's close rule). A ballot made at time `t` can name at most the newest L1 block existing at `t`. An honest client sees that block 2 deep, and then casts a ballot naming a newer one, about 3 L1 slots (36 seconds) after `t` plus its own view's lag. Until then it can void the watched ballot with a tie (Client rule 5). A ballot then counts if it is admitted under the close rule ([[verifier]] 5.5), whose L1-inclusion allowance `l1_inclusion_bound` covers the time to land it, so the effective last moment to re-vote is close itself, less that wait. R6 holds only once P1-18 specifies that close rule and its `l1_inclusion_bound` (a field of the election definition, P1-10b) to account for this wait; until then it is a requirement on P1-18, not a property shown here.

## Residuals

- **The last moments before close.** A coercer who watches a cast in the last few blocks before close leaves no time for a newer block: the voter can only void it with a tie, and only while a cast still lands before close. Every last-ballot-counts scheme has this window (a coercer who watches until close defeats re-voting, T-45); the L1 reference widens it by the wait in R6, about 36 seconds.
- **A voter who has lost their records** (a new device, say) can't check Client rule 3. A new ballot still names the newest settled block, so it ties with an earlier ballot of theirs only if both name the same block: cast within about 12 seconds of each other, from two devices. Waiting a few blocks after the last cast the voter remembers avoids it.
- **Cast time and challenged ballots.** A ballot's block publishes when it was made, to about 12 seconds, and the operator can't blur that by batching or delaying cast ballots. Anyone who knows the nullifier can then look for challenged entries posted around that block, and their openings usually show the real choice. P1-13's challenge part MUST keep challenged entries from being matched to a cast ballot by time (by deferring or batching their posting, say), or state the link in T-42 and T-47 ([[verifier]] 6.2).
- **Ballots made after close.** `l1-ref-after-close` bounds the block a ballot names, not when it was made. A ballot made after close that the close rule still admits (sequencer drift, or the L1-inclusion allowance) can name the last blocks before close, while an honest client's newest reference is about 2 blocks older than that. A coercer working with the sequencer could then outrank every honest re-vote with no chance to respond, so the window extends past close by the close rule's slack plus about 2 blocks. P1-18's close rule MUST NOT admit ballots made after close ([[verifier]] 5.5, T-35).
- **Withholding a later ballot.** An operator that never posts a voter's re-vote, or holds it past close, keeps the earlier ballot counted. That is censorship (T-25), not reordering: the voter's receipt (P1-13) shows it, and direct submit to L2 (P4-2) bypasses the operator.
- **Re-votes are public.** Anyone who knows a voter's nullifier, from one of their ballots or receipts, sees every later ballot under it, its L1 block and so roughly when it was made, and whether a tie voided it (T-45). Deniable re-voting needs hidden nullifiers and its own ADR ([[verifier]] 6.1).
- **A coercer holding the voter's secret** can always cast last (T-46).
- **L1 reorganisations.** A ballot whose named block is reorganised away is rejected. Naming a block 2 deep makes that rare outside an attack on L1 finality, and the client checks after finality (Client rule 4), but a ballot cast near close may have no time to be cast again.
- **An L1 proposer as coercer.** A block hash is unpredictable to everyone except whoever builds the block. A coercer who proposes, or bribes the proposers of, a run of upcoming slots (Ethereum publishes proposers about an epoch ahead) knows those blocks' hashes once built, and can have a watched voter make ballots for them in advance. That stretches the window a watched cast stays final by that run of slots; outranking it then needs a block after the run (T-45, state actor).
- **Timing.** Every ballot's block is public and fixes when it was made to about 12 seconds, so delaying a ballot's submission doesn't hide when it was made, and a voter's ballots in two tiers can be linked by matching times unless the client casts them independently (Client rule 7; T-13, T-11).
- **L1 finality stalls.** If L1 stops finalizing, ballots stay pending and the result can't be verified until it resumes; nothing is rejected meanwhile.

## Owned elsewhere

- The ballot record that carries `tier`, `l1_ref_number`, `l1_ref_hash` and the membership proof, and `ballot_hash`: P1-12.
- `l1_chain_id`, `closes_at` and `l1_inclusion_bound`: fields of the election definition (P1-10b).
- **The voter's check covers ranking.** A ballot's `M`, `l1_ref_number` and `l1_ref_hash` are made after the cast-or-challenge choice (Client rule 6), so Benaloh's challenge doesn't audit them: a malicious client could cast a correctly encrypted re-vote with a wrong hash, an older block or a self-tie, and the coerced earlier ballot would keep counting. P1-13's receipt check, run on a device or verifier the voter chooses, MUST show the ballot's admission verdict ([[verifier]] 5.8) and whether it is the selected ballot of its tier and nullifier, not only that it is on the board (T-41, T-42).
- **Keyed by content, never by entry.** Anyone can re-randomise a ballot's proof and get the copy placed at a smaller index (by front-running a direct submit, or by the operator's ordering), so the copy stands and the voter's own entry is listed as a `repeat` (Selection, step 1). That is harmless only if everything that later decides whether the selected ballot counts binds the ballot's content, `ballot_hash` or (`tier`, `ν`, `M`), never an entry hash or index: the share-delivery receipts, postings and complaints of [[0002-everlasting-privacy]] (P1-12, P1-15), the voter's receipt checks (P1-13), and direct submit (P1-18), whose contract MUST NOT revert a repeat in a way the client reads as a failed cast.
- Benaloh challenge and spoil, published openings, and receipts: P1-13's later parts.
- Direct submit (P1-18): a contract can't check an arbitrary L1 block hash from L2, so it MUST NOT reject a ballot for its L1 reference. The verifier's admission check rejects a bad one, and the membership proof still keeps non-members off the chain ([[membership]], Owned elsewhere).
- The close rule ([[verifier]] 5.5): P1-18.
- Reading finalized L1 blocks and their hashes: P1-19.
