# ADR 0030: The close rule

- Status: Accepted (agent) — owner may veto (2026-10-13, rule A): option D, with the forced-ballot relay and the board path as below
- Date: 2026-10-13
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-35, T-50, T-25, T-33, T-45, T-71, T-69, T-54, T-36, T-53 (see [[THREAT_MODEL]])

## Context

[[0004-l2-choice]] (Consequences, Close rule) leaves the close rule to P1-18, and [[verifier]] 5.5 needs it: a ballot counts only if it is inside the poll's window "using only L2 data derived from finalized L1 data". [[0025-contract-event-evidence]] (Consequences) also left P1-18 part 4c to decide how **derivation time**, when an event's L2 block became derivable from L1, is evidenced, which 5.5 and the attribution in 5.6 and `tally-late` need ([[tally]], Tally window). The rule must hold two lines at once:

- **Lose no ballot sent in time.** A ballot forced through L1 before close can reach L2 up to Base's 12-hour sequencing window later (T-50), and a ballot the voter's client sent just before close normally reaches L1 in a batch some minutes later.
- **Admit no ballot made after close.** [[revoting]] (Residuals, Ballots made after close) requires it: `l1-ref-after-close` bounds the block a ballot names, not when it was made, so a ballot made after close can still name a block just before it. A coercer who can get such a ballot in can meet the voter after close, have them make one, and outrank every re-vote the voter made while the poll was open (T-35, T-45, T-33).

What the chain gives us:

- **L2 timestamps are fixed by block number.** On the OP Stack an L2 block's timestamp is its parent's plus the block time, so `block.timestamp ≤ closes_at` says the transaction is in an L2 block numbered at most `N_c`, the last block with a timestamp at or before close. The sequencer doesn't choose the time; it chooses the contents, and the L1 origin, which may lag the timestamp by `max_sequencer_drift` (1,800 seconds).
- **But a block isn't final until its batch is on L1.** Until the batcher posts it, the sequencer can rebuild any unposted block, timestamp unchanged, with other transactions, and derivation accepts the rebuilt one as long as its batch lands within the sequencing window (3,600 L1 blocks, 12 hours) of its origin. So "in a block at or before `N_c`" doesn't mean "made before close": a sequencer that withholds batches for the last stretch before close can fill those blocks hours later. 0004 names this attack (rebuilding unposted blocks with earlier timestamps).
- **Derivation time isn't on chain.** A contract on L2 can't see when its block's batch reaches L1, and after about 18 days the blobs holding the batches are pruned, so a later verifier can't re-derive it from L1 alone. What stays on L1 is the dispute games' output roots: a valid game created at L1 time `T` for an L2 block at or after `b` shows `b` was derivable by `T`, an upper bound, as 0025 says. Base's games are made on a block-interval cadence that its on-chain verifier contract sets, and Base's own proposer sources move it from about 600 to about 6,000 L2 blocks (roughly 20 minutes to over 3 hours) in a scheduled upgrade (base/base pull request 4930), a value Coinbase can change without delay, as it can the TEE proposer allowlist ([[0004-l2-choice]], Option B, Cons).

It is one-way because the rule is written into immutable contracts (the board refuses ballots outside the window; the forced-ballot relay on L1 has no upgrade path), into the election registry's recorded fields, which a deployed registry can't change ([[contracts]], Election registry, Parameters), and into how every verifier judges every past election. Nothing is deployed yet.

Three paths reach the board, and each needs an answer:

1. **Ordinary contract-path ballots**, an L2 transaction to the board's `submitBallot`.
2. **Forced ballots**, sent through L1 because the sequencer censors (T-50).
3. **Board-path ballots**, boarded by the operator after trustee intake.

Paths 2 and 3 are settled below with little choice. The options are about path 1: how a verifier knows, years later, that a ballot in a block at or before `N_c` wasn't put there after close.

## Options

Every option shares the contract's own check: `submitBallot` refuses a ballot unless `opens_at ≤ block.timestamp ≤ closes_at`, read from the registry's parameters. That alone dominates 0004's second candidate (an L1 origin at or before close), which admits blocks up to the drift after close and has the same rebuild window.

### A. No derivation evidence

An ordinary ballot counts if its block's timestamp is at or before close, and nothing more. The definition's `l1_inclusion_bound` (δ) is then only the allowance windows are counted from.

Pros: nothing to build or archive; every verifier decides from the accumulator alone (T-36).

Cons: the sequencer can rebuild every unposted pre-close block for up to the sequencing window, so its window to admit ballots made after close is 12 hours, not δ (T-35, T-45). This is 0004's third candidate in effect: the result rests on the sequencer for 12 hours.

### B. Dispute games bound derivation time

An ordinary ballot in block `b` counts if `τ_b ≤ closes_at` and some valid dispute game, created at L1 time at most `closes_at + δ`, claims an L2 block at or after `N_c`. The game is on L1 for good, so every verifier decides the same way, and 0025's evidence already archives games.

Pros: no new party; evidence that outlives the blobs.

Cons: δ must exceed the game cadence plus L1 finality, which Base sets and is raising to over 3 hours, so the sequencer's window is that long, and grows whenever Coinbase changes the cadence, with no delay. If no game lands in time (a proposer outage, or a choice), no ballot near close can be shown in time: the proposer, which is Coinbase's allowlist unless someone pays for a ZK proof, can fail every election closing in that window. And a TEE-only game is only as good as the proposer allowlist until someone challenges it (T-71).

### C. Re-derivation from archived batches

The archive keeps the batcher's blobs for the L1 blocks from a little before close to `closes_at + δ`, with their KZG commitments and inclusion proofs against L1 block headers, and the verifier re-runs the OP Stack's derivation over them to find the last L2 block derived from L1 up to `closes_at + δ`.

Pros: trustless, with δ as small as the batcher's normal latency (minutes).

Cons: the verifier would have to implement the derivation pipeline (frames, channels, span batches, compressed with zlib or brotli, under rules that change with each hard fork) and KZG verification with the ceremony's setup, all inside the gated trust base ([[verifier]], Principles; AGENTS.md), with a decompressor outside `@noble/*`. Each Base hard fork would need a verifier release before the next election closes. The archive grows by the chain's whole batch traffic around each close (several blobs of 128 KB per L1 block), not ours. And it rests on L1 block bodies, which EIP-4444's history expiry lets nodes prune.

### D. A trustee close statement

After close, each seat of the election's default panel runs its own L2 node over its own finalized-L1 source, as [[delivery]] (Direct submit) already requires of it, and signs a **close statement**: the definition hash, `L_δ` (the number and hash of the last L1 block with a timestamp at or before `closes_at + δ`) and `B_i`, the number and hash of the L2 safe head derived from L1 through `L_δ`. Derivation is deterministic, so every honest seat signs the same values. The statement reaches the board like a receipt, through the board path and the board contract's path. The verifier takes, among the statements of registered seats that name the right `L_δ` (checked against finalized L1), at most one per seat, the **close head** `B`: the `k`-th largest `B_i`, with `k` the panel's threshold. An ordinary ballot in block `b` counts if `τ_b ≤ closes_at` and `b ≤ B`.

Pros: δ can be as small as the batcher's latency allows, so a sequencer that rebuilds blocks has only δ, and needs `k` seats of the panel to lie with it to get more (T-35, T-45). If at least `k` seats state honestly and fewer than `k` lie (with 4 of 7, any three liars), `B` is the honest value: fewer than `k` statements can sit above it, and at least `k` sit at it. With fewer honest statements than `k`, liars stating low can pull `B` down and drop honest ballots near close, which is why statements are owed by every seat, as receipts are. The verifier stays small: one more signed record, checked like a receipt, under the seats' per-election signing keys ([[trustee-identity]]). It needs no liveness beyond what the tally needs already: fewer than `k` live seats fail the tally too (T-54). A statement is attributable: its seat signed it, so a verifier that still has the L1 data, any time in the 18 days after close, can show it false and name the seat.

Cons: the boundary rests on the panel's threshold, which until now guarded only privacy and the tally's liveness, never which ballots count. A false statement can be shown false only while the blobs live; after that it is a signed claim nobody can check, and `k` colluding seats can then move the close head within the chain's real history: lower to drop honest ballots near close, higher to keep the sequencer's rebuilt blocks (T-69, T-54). A new duty for every trustee node at close.

## Recommendation

**D for the counting rule**, with δ small, plus the relay for forced ballots, the operator's rule for the board path, and B's games only for attribution:

- **Ordinary ballots (D).** C is the right end state and A the wrong one. C would make the verifier's trust base track a third party's hard forks, with a decompressor and KZG beside it, which this project can't keep sound before deployment; A leaves the coercion window at 12 hours on the sequencer's word. B looks free but isn't: its window is the cadence Coinbase sets (over 3 hours soon), and a missing game fails the election, so it hands Coinbase both a larger window and a veto. D bounds the window by δ unless `k` seats collude (or, to drop ballots, unless honest seats are too few to outvote low statements), a party the design already must trust for privacy, and it is attributable while the data lives. A later definition version can move to C without a contract change, since the board's check (`τ ≤ closes_at`) is the same.
- **Forced ballots (0004's relay).** Our L1 relay stamps each call with its L1 block's number and timestamp, appends it to its own accumulator in L1 state, and sends it on through the portal as a deposit to the board; the board accepts a relayed ballot only from the relay's aliased address and only if `opens_at ≤ stamp ≤ closes_at`; the verifier matches each relayed event with exactly one call in the relay's L1 accumulator ([[verifier]] 4.5), so a message forged from the aliased address by L2 governance fails (T-71). Its submission time is the stamp. No L1 proposer can backdate an L1 block, so a forced ballot has no window after close at all.
- **Board-path ballots (unchanged).** [[0029-board-data-availability]] already counts a board-path ballot only if it is first boarded by `s_A = period(closes_at) + 1`. Nothing outside the operator shows when within that it arrived, so the operator MUST refuse board-path ballots that reach it after `closes_at`; an operator that doesn't can admit ballots made in the hour or two after close, which no one can detect (Consequences, Known-weak). A close mark on L1 (the operator anchoring its board size at close, with board-path ballots beyond it not counted) was considered and rejected: its window would still be the mark's L1 inclusion delay, and an operator that marks short drops ballots it has already receipted, after close, when the voter can no longer re-vote or submit directly, a new censorship vector worse than the residual it narrows.
- **Attribution (B).** 5.6 and `tally-late` blame the operator only for a contract event derivable early enough to board in time ([[tally]], Tally window). That uses the first valid dispute game claiming the event's block or a later one, by its creation time: an upper bound, so an honest operator is never blamed, and a slow proposer only turns blame into an unattributed settlement overrun, which fails the election as loudly. 0025's open question is closed this way.

What would change it: a ZK-proven derivation of Base's history that the verifier can check with audited code (then C, or B with ZK-only games, at no trust in the panel); Base committing to a short game cadence it can't change without delay (then B); or the owner preferring not to extend the panel's role (then B, with its window stated in T-35).

## Consequences

**The rule** (5.5): a ballot is in the poll's window if

- it is an ordinary contract-path ballot whose L2 block `b` has `opens_at ≤ τ_b ≤ closes_at` and `b ≤ B`, the close head; or
- it is a relayed ballot whose matched L1 call has `opens_at ≤ stamp ≤ closes_at`; or
- it is a board-path ballot, first boarded by `s_A`.

A ballot outside the window is rejected by 5.5 as an admission failure: it counts nothing and displaces nothing (R4). An election with fewer than `k` valid statements in the counted extent has no close head; its close is unsettled, and it fails, unattributed, as a settlement overrun does ([[tally]], Tally window), never silently counting or dropping the ballots near close. Verifiers that read the same board and finalized L1 reach the same verdict, since `B` comes from records on the board and `L_δ` from L1 headers (T-36).

**δ.** `l1_inclusion_bound` stays the definition's, now with bounds the election registry enforces at registration, constants of the immutable registry: a floor that covers the batcher's normal latency and L1 inclusion (so an honest ballot cast at close is derived through `L_δ`), and a ceiling that keeps the sequencer's window short. The spec part sets both from Base Sepolia's measured batch latency; the agent's starting point is 10 minutes to 1 hour, with 30 minutes the default the admin CLI proposes. A batcher outage at close longer than δ excludes ballots sent in the last moments by the ordinary path (T-50), which is why the ballot client MUST, for a ballot cast within δ of close, watch for its block to become safe and, if it hasn't by close, also send it through the relay while the stamp can still be at or before `closes_at`, or tell the voter it can't (P2-8, P4-2).

**Work it creates**, all before any registry or board is deployed:

- **The spec** (P1-18 part 4c-2): the close statement record (a new record type and its signing tag, in [[versioning]] and [[trustee-identity]]), its boarding and contract-path rules and its deadline (by `c_D`, so it is in the counted extent, [[delivery]]); the close head; 5.5's codes; the relay's call, accumulator and events; contract-event version 3 with the board's relayed-ballot event (version 2 is frozen, [[contracts]], Contract-event record); the registry's fields (`opens_at`, `closes_at`, δ and its bounds); vectors for each.
- **The contracts** (part 4c-3 and on): the registry recording the window, the board's `submitBallot` refusing outside it, never inside `BallotCheckLib.checkWithLayout`, which postings reuse after close ([[P1-18]] part 4b-3d-1, Known-weak); the relayed-ballot call; the L1 relay with the portal's address as an immutable that a verifier release pins and [[verifier]] 1.2 checks. A forced ballot must fit the portal's deposit calldata cap (about 120 KB, [[0004-l2-choice]]), so the registry MUST refuse a definition whose largest ballot can't, or the spec MUST bound the ballot size so none exceeds it.
- **The trustee node** ([[P2-13]]): signing and sending the close statement from its own L2 node's safe head at `L_δ`, read over its own finalized-L1 source, never our API.
- **The verifier** ([[P1-19]]): 5.5 as above; 4.5 for relayed events; reporting a statement that contradicts the chain, attributed to its seat, when it has the L1 data; 5.6's and `tally-late`'s attribution by dispute games.
- **The reference election** ([[P1-20]]): an ordinary ballot after close refused, a relayed ballot stamped before close counted although its L2 block is after it, and a ballot in a block past the close head rejected.

**Threats.** T-35's residual becomes: within δ, a sequencer that withholds batches can admit ballots made after close; beyond δ, only with `k` seats lying; and the operator, through the board path, within `s_A`. T-50 gains the client rule for the last δ before close. T-54 records the panel's new duty. T-71: a relayed ballot forged by L2 governance fails 4.5.

**Known-weak.**

- The board path's close is the operator's word (above). A compromised operator working with a coercer can admit a coerced ballot made up to about two periods after close; it still needs the voter's identity secret to make one, so the coercer must have the voter make it (T-45).
- A close statement can be checked only while the L1 blobs are retrievable (about 18 days). After that, `k` colluding seats could have moved the close head anywhere within the chain's real history without anyone being able to show it, as the output root is already the root of trust for position after expiry ([[contracts]], Contract-event record, Known-weak; T-71).
- Within δ, the sequencer can still rebuild unposted pre-close blocks. Its rebuilding is visible as it happens (the unsafe head reorganises, and the safe head stalls) but is not evidence anyone can archive.
- Attribution of a late contract event rests on dispute games' cadence and the proposer allowlist; a slow or absent proposer turns the operator's breach into an unattributed overrun, which still fails the election.

## Decision

Under rule A (`AGENTS.md`): **option D** for ordinary contract-path ballots, the L1 relay for forced ballots, the operator's `s_A` rule with its stated residual for the board path, and dispute games for attribution only, with status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto of D means B (δ above Base's game cadence, and a proposer outage failing the elections it overlaps, stated in T-35 and T-50) or A (the 12-hour sequencer window stated in T-35); either needs only the spec part changed, since the contracts' checks are the same.
