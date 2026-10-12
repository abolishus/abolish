# ADR 0011: Re-vote rule

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option C; confirmed by the owner (2026-10-12)
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-33, T-38, T-45, T-25, T-23, T-35 (see [[THREAT_MODEL]])

## Context

The brief allows re-voting, with the last ballot counting, as the main defence against observed coercion and vote buying (T-45). "Last" needs a definition. [[verifier]] 6.1 states six requirements any rule must meet (R1 replay, R2 no freezing, R3 order independence, R4 stable admission, R5 client state from anchors, R6 liveness), and records that each simple construction tried so far fails one of them. [[0003-tally-scheme]] fixes that a ballot whose proofs fail never displaces an earlier one, and [[0002-everlasting-privacy]] that a counted ballot excluded later counts nothing, with no fallback.

What is one-way: the rule decides what each ballot's membership proof binds ([[membership]], Message), so it is part of every ballot on the permanent board. Changing it needs a new ballot version and a second verifier path, and two rules must never both apply within one poll.

The facts that constrain it:

- **The board operator orders entries** and can withhold any of them until they are anchored ([[board]], Residuals). Direct submits on L2 are ordered by the sequencer, which can also delay them. Neither order can decide which ballot counts (R3).
- **Groth16 proofs are malleable** ([[0009-membership-proof]]): anyone can re-randomise a ballot's proof, so a replay can't be recognised by its bytes (R1).
- **A coercer can watch one cast** and can demand any value the client lets the voter choose. A rule that lets a cast-time value outrank everything later lets the coercer make that ballot final (R2).
- **A coercer can have the voter make several ballots while watching once,** and post them later, unless something unpredictable at making time is bound into each one (T-45).

## Options

### A. Board order: the last admitted ballot on the board counts

- **Pros:** no extra field; the simplest rule to state and check.
- **Cons:** fails R3 outright. The operator chooses the board order of unanchored entries, so it chooses which ballot counts, and a coercer working with it has a coerced ballot withheld and posted after the voter's re-vote. Direct submits make it worse: the board order of an L2 ballot depends on when the operator boards its event.

### B. A sequence number chosen by the client

Each ballot carries a number bound into its proof; the highest counts. Variants: any number, numbers strictly above the count of admitted ballots, or exact (dense) numbering.

- **Pros:** no external data; the client needs only its own records.
- **Cons:**
  - With free numbers, a coercer demands the maximum, and that ballot is final: fails R2.
  - Bounding numbers by the admitted count (a window) brings back the board order: whether a number is in range depends on how many ballots the operator has admitted and when, so an operator that reorders more than the window fails R3. A client that limits itself to the anchored count lets the operator withhold a coerced ballot cast at the window's edge and post it at close, which fails R2.
  - Exact numbering fails R3 outright: the operator decides which of two ballots gets which slot.
  - None of the variants stops pre-made ballots: a voter watched once can be made to produce ballots numbered far ahead.

### C. A recent L1 block bound into each ballot; the newest block counts, exact ties count nothing

Each ballot names a recent block of the election's L1 chain, by number and hash, and its membership proof's message binds both ([[revoting]]). A verifier admits a ballot only if that block is on the finalized L1 chain, no earlier than an hour before opening and no later than close. For each tier and nullifier, the admitted ballot naming the highest block number counts; two distinct ballots naming that same number tie, and then none counts.

- **Pros:**
  - **R3.** The rank is fixed by the voter when the proof is made. No board position, segment, arrival time or L2 block enters the rule, so withholding or reordering changes nothing.
  - **R2 and pre-made ballots.** A block hash is unpredictable until the block exists, so no ballot can outrank one made after it, and no ballot can be made in advance for a later block. A watched cast is outranked by any re-vote naming a newer block: L1 makes one every 12 seconds.
  - **R1.** A replay carries the message it was made with, so it is recognised by (tier, nullifier, message) whatever its proof bytes, and an earlier ballot replayed after a re-vote still ranks by its own, older block.
  - **R5.** The client needs only an L1 block it reads itself and its own records.
  - **Ties instead of a tie-break.** Within one block, two ballots can't be ranked without a value the voter chooses, which a coercer could demand (B's flaw). Counting neither instead lets a watched voter cancel a coerced ballot at once by naming the same block, before a newer one is settled.
  - The check is a lookup in finalized L1 data with no new primitive. The lower bound (an hour before opening, found by number alone) and the upper bound (the first block after close) keep every lookup inside the L1 range around the poll that the verifier reads and archives for anchors anyway ([[board]]), so a ballot naming an ancient block can't demand evidence nobody keeps, and every verifier reaches the same verdict.
- **Cons:**
  - 40 more bytes per ballot (the block number and hash), on the board and in direct-submit calldata.
  - A ballot naming a block that L1 reorganises away is rejected; clients name a block at least 2 deep and check after finality, but a ballot cast just before close may have no time to be cast again.
  - Verification of a closed election waits for L1 finality of every named block (minutes).
  - The last moments before close stay coercible, as in every last-ballot-counts scheme, widened by about 36 seconds (the time for a newer block to be 2 deep); in that window a watched voter can only void with a tie.
  - Contracts can't check an arbitrary L1 block hash from L2, so a direct-submitted ballot with a bad reference is caught by the verifier's admission check, not by the contract.
  - Re-votes stay public to anyone who knows the voter's nullifier, now with their L1 block (when they were made, to about 12 seconds). The same timing links a voter's ballots in two tiers if they are cast together, so clients cast per tier independently.
  - A block hash is unpredictable to everyone except its builder: a coercer who controls or bribes the proposers of a run of upcoming slots can have ballots made ahead for those blocks, stretching the freeze window by that run.
  - A direct submit can name a block that never comes; the admission check rejects it once L1 has finalized a block after close, so it can't hold the election unverifiable.

### D. C with a client-chosen sequence number to rank ballots within one block

As C, but within one block the higher sequence number counts, instead of a tie.

- **Pros:** an honest voter who re-votes twice within one block doesn't void themselves.
- **Cons:** brings back B's freezing within a block: a coercer demands the maximum number, and the voter can neither outrank nor void that ballot until a newer block is settled. [[verifier]] 6.1 called this the dead zone. The honest case it helps is avoided by the client waiting for the next block (12 seconds).

## Recommendation

**C.** It is the only option that meets R1 to R5, and R6 once P1-18's close rule accounts for its wait: A and B fail R3, B fails R2, and D reopens the dead zone that ties close. Its costs are 40 bytes per ballot, a wait for L1 finality before a closed election can be verified, and an inherent last-moment window that is about 36 seconds longer than with no rule at all.

What would change it: an L2 with fast, operator-independent finality whose block hashes contracts can read (the reference could then be checked on chain), or an owner decision to adopt deniable re-voting with hidden nullifiers, which needs its own ADR.

## Consequences

- [[revoting]]: the message `M`, the two admission checks (`l1-ref-unknown`, `l1-ref-after-close`), the selection rule (repeats, grouping by tier and nullifier, ranking, ties, no fallback) and the client rules. `abolish/v1/membership-message` is registered in [[domain-separation]].
- [[membership]]: `M` is now specified. [[verifier]] 5.3, 5.7 and 6.1 point at [[revoting]], and 6.1's open questions are settled: no fallback, spoiled ballots never take part, selection per tier and nullifier.
- P1-12: the ballot record (`0x0002`) carries `tier`, `l1_ref_number` and `l1_ref_hash`, and `ballot_hash` excludes the membership proof and the L1 reference.
- P1-18: direct submit doesn't check the L1 reference on chain. Calldata sizing counts the 40 bytes.
- P1-19: the verifier reads finalized L1 block hashes and timestamps, already needed for anchors.
- P2-8, P5-4: the client reads L1 itself, keeps a record of the block each cast named, waits for a newer block before re-voting, checks admission after finality, and offers the tie escape to a watched voter.
- `packages/crypto`: `membershipMessage`, `checkL1Reference` and `selectBallots` implement the message, the admission check on the block and selection, with vectors from an independent implementation.
- P1-12, P1-15, P1-18 and P1-13's receipts: whatever decides later whether a selected ballot counts binds its content (`ballot_hash`, or tier, nullifier and `M`), never its board entry, since a re-randomised copy can stand in its place ([[revoting]], Owned elsewhere).
- Known-weak: T-45's last-moment window, re-vote visibility, and verification waiting on L1 finality (see [[revoting]], Residuals).

## Decision

Under rule A (`AGENTS.md`): option C, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
