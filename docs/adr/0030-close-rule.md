# ADR 0030: The close rule

- Status: Accepted (agent) — owner may veto (2026-10-13, rule A): option E, with the forced-ballot relay and the board path as below
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

An ordinary ballot in block `b` counts if `τ_b ≤ closes_at` and some valid dispute game, created at L1 time at most `closes_at + δ`, claims an L2 block at or after `N_c`. The game is on L1 for good, so every verifier decides the same way, and 0025's evidence already archives games. A game's claim is judged against the L1 data up to its `l1Head`, which is what makes it an upper bound on derivation time.

Pros: no new party; evidence that outlives the blobs.

Cons: δ must exceed the game cadence plus L1 finality, which Base sets and is raising to over 3 hours, so the sequencer's window is that long, and grows whenever Coinbase changes the cadence, with no delay. If no game lands in time (a proposer outage, or a choice), no ordinary ballot near close can be shown in time, so the proposer, Coinbase's allowlist, can drop every direct-submitted ballot near close or fail the election. A variant has our own seats create a ZK-proven game for `N_c` right after `closes_at + δ` on Base's permissionless path, which removes the cadence for the cost of one proof per election: spending the owner hasn't approved, and a ZK prover outside our audited libraries; the owner can choose it later (What would change it). A TEE-only game is only as good as the proposer allowlist until someone challenges it (T-71).

### C. Re-derivation from archived batches

The archive keeps the batcher's blobs for the L1 blocks from a little before close to `closes_at + δ`, with their KZG commitments and inclusion proofs against L1 block headers, plus the deposits and `SystemConfig` logs derivation reads, and the verifier re-runs the OP Stack's derivation over them to find the last L2 block derived from L1 up to `closes_at + δ`.

Pros: trustless, with δ as small as the batcher's normal latency (minutes), and independent of L1 history expiry once the proofs are archived.

Cons: the verifier would have to implement the derivation pipeline (frames, channels, span batches, compressed with zlib or brotli, deposits and system-config updates, under rules that change with each hard fork) and KZG verification with the ceremony's setup, all inside the gated trust base ([[verifier]], Principles; AGENTS.md), with a decompressor outside `@noble/*`. Each Base hard fork would need a verifier release before the next election closes. The archive grows by the chain's whole batch traffic around each close (several blobs of 128 KB per L1 block), not ours.

### D. A trustee close statement as the rule

After close, each seat of the election's default panel signs a **close statement**: the definition hash, `L_δ` (the number and hash of the last L1 block with a timestamp at or before `closes_at + δ`) and `B_i`, the number and hash of the highest L2 block derivable, under the derivation rules the verifier's release pins, from L1 data in blocks at or before `L_δ`, which it computes with its own L2 node over its own finalized-L1 source, as [[delivery]] (Direct submit) already requires of it. The verifier takes the **close head** `B`, the `k`-th largest `B_i` among valid statements, and counts an ordinary ballot in block `b` only if `τ_b ≤ closes_at` and `b ≤ B`.

Pros: δ can be as small as the batcher's latency allows, so a sequencer that rebuilds blocks gets only δ unless `k` seats lie with it. With at least `k` honest statements and fewer than `k` liars, `B` is the honest value.

Cons: it hands the panel's threshold power over which ballots count. `k` seats stating low (the block at `opens_at`, say) drop every ordinary direct-submitted ballot after it, with no sequencer's help, and the direct path exists to bypass us (T-25). Under the transitional panel, which is ours alone until independent trustees are named ([[PROJECT_BRIEF]], Threshold trust), that is us dropping ballots, provably only while the blobs live (about 18 days), which the brief's "no single party, including us, can … alter a tally undetected" forbids; its launch exception covers secrecy, not integrity. A permanent floor from dispute games (a game created by `L_δ` claiming block `g` shows the true head is at least `g`) narrows this to the game cadence, hours, but doesn't remove it. And a batcher outage longer than δ drops honest ballots from the outage's whole length, silently.

### E. A trustee close statement as a check

As D, the seats sign close statements and the verifier computes the close head `B`, but `B` never decides which ballots count. The rule is the contract's (`τ_b ≤ closes_at`, as in A). The verifier also computes each cell's counted set with the ordinary ballots in blocks after `B` removed; if any cell's set differs from the counted one, the election fails `close-contested`: a ballot whose block wasn't derivable by `closes_at + δ` would change the result, so the verifier can't tell an honest late batch from a rebuild, and it fails rather than guess. The same design as [[tally]]'s `tally-late`, which recomputes and fails rather than silently picking a set.

Pros: no one can change which ballots count. Liars stating low can at most fail an election, loudly, which `k` seats can already do by refusing the tally, and which under the transitional panel we can already do; liars stating high can only hide a rebuild. A sequencer that rebuilds blocks gets δ silently; beyond δ its rebuilt ballots fail the election instead of counting, unless `k` seats lie with it (T-35, T-45). A batcher outage at close drops no ballot: it fails the election only if a late-batched ballot would have changed a result.

Cons: an honest batcher outage longer than δ around close can fail an election (`close-contested`, unattributed), which the poll must then rerun (T-50, T-53). A new duty for every trustee node at close. A false statement can be shown false only while the blobs live, unless it is below a dispute game's floor or two statements disagree.

## Recommendation

**E for ordinary ballots**, with the relay for forced ballots, the operator's rule for the board path, and dispute games for attribution and as the statements' permanent floor:

- **Ordinary ballots (E).** D was this ADR's first choice, and the in-session review showed it gives the panel, and so us during launch, the power to drop direct-submitted ballots that integrity forbids; E keeps D's detection and gives that power to no one. C is the right end state and A the wrong one: C makes the verifier's trust base track a third party's hard forks, with a decompressor and KZG beside it; A leaves a 12-hour rebuild window with nothing to detect it. B hands Coinbase's proposer a window of hours and a veto. A later definition version can move to C, or to B with our own ZK game, without a contract change, since the board's check is the same.
- **Forced ballots (0004's relay).** Our L1 relay records each call in its own accumulator in L1 state, binding the call's index, the L1 block's number and timestamp and the ballot's hash, and sends the ballot on through the portal as a deposit to the board. The board accepts a relayed ballot only from the relay's aliased address and only if `opens_at ≤ stamp ≤ closes_at`. The verifier matches each relayed event with exactly one relay call, checking the stamp against the header of that L1 block ([[verifier]] 4.5), so a message forged from the aliased address by L2 governance fails (T-71). Its submission time is the stamp. An L1 block's timestamp is its slot's start and proposers may publish a few seconds into the slot, so a forced ballot's window after close is seconds, not hours.
- **Board-path ballots (unchanged).** [[0029-board-data-availability]] already counts a board-path ballot only if it is first boarded by `s_A = period(closes_at) + 1`, and the operator MUST refuse board-path ballots that reach it after `closes_at`. Nothing public shows when within that window it arrived: trustee intake sees arrival too, but stays open after close until `c_I` so that a client retrying a ballot made before close still gets receipts ([[delivery]], What a node owes), so it can't refuse by time either. A close mark on L1 (the operator anchoring its board size at close, ballots beyond it not counted) was considered and rejected: its window would still be the mark's L1 inclusion delay, and an operator that marks short drops ballots it has already receipted, after close, when the voter can no longer re-vote or submit directly.
- **Dispute games.** For attribution in 5.6 and `tally-late`, the operator is blamed only for a contract event derivable early enough to board in time ([[tally]], Tally window), shown by the first game claiming its block or a later one, by its creation time; a slow proposer turns blame into an unattributed settlement overrun, which fails the election as loudly. Coinbase, as sequencer and allowlisted proposer, can create an early game for blocks not yet posted, so only games resolved in the claim's favour count, and an attribution resting on a TEE-only game is reported as such (T-71). For the close statements, a resolved game created by `L_δ` claiming block `g` is a permanent floor: a statement below `g` is false, for good.

What would change it: a ZK-proven derivation of Base's history that the verifier can check with audited code (then C, or B with ZK-only games, which would also let the rule tighten from detection to exclusion); Base committing to a short game cadence it can't change without delay (then B); or the owner preferring D's tighter exclusion once independent trustees hold the panel, a change to who can alter a tally that is the owner's to make.

## Consequences

**The rule** (5.5): a ballot is in the poll's window if

- it is an ordinary contract-path ballot whose L2 block `b` has `opens_at ≤ τ_b ≤ closes_at`; or
- it is a relayed ballot whose matched L1 call has `opens_at ≤ stamp ≤ closes_at`; or
- it is a board-path ballot, first boarded by `s_A`.

A ballot outside it is rejected as an admission failure: it counts nothing and displaces nothing (R4).

**The close check** (a new election check after selection and delivery):

- **Statements.** Each seat of the default panel owes one close statement, sent by `c_I` through the board path and the contract path, like a receipt, so it is in the counted extent. A statement is valid if it names this definition, its `L_δ` is the right block of finalized L1, and it is signed by the seat's registered per-election signing key ([[trustee-identity]]); a seat with two valid statements that differ is reported, attributed to it for good (equivocation), and none of its statements count. A statement below a resolved game's floor `g` is false, reported against its seat, and doesn't count. In `tally-late`'s recomputation over the whole sealed extent, statements are read under their own window, so a late one never changes `B` there.
- **The close head** `B` is the `k`-th largest `B_i` among the valid statements, `k` the default panel's threshold. With at least `k` honest statements and fewer than `k` liars it is the honest value.
- **The check.** If any cell's counted set, recomputed without the ordinary ballots in blocks after `B`, differs from its counted set, the election fails `close-contested`, unattributed: the verifier can't tell a late honest batch from a rebuild, and never guesses. With fewer than `k` valid statements there is no close head; the election isn't failed (a missing statement must not let `n − k + 1` seats fail it by silence), but the report says the close is unchecked, names the seats that sent none and lists the ordinary ballots after `N_c − δ` that it couldn't check.
- **Report only.** A verifier that still holds the L1 data and finds a statement false, or its own derived head different from `B`, reports it against the seats that signed, and never changes its verdict, so every verifier with the same board and finalized L1 reaches the same verdict whatever blob data it holds (T-36). Valid statements that disagree with each other are always reported, since they prove a liar without any L1 data.

**δ.** `l1_inclusion_bound` stays the definition's, with bounds the election registry enforces at registration, constants of the immutable registry: a floor that covers the batcher's normal latency and L1 inclusion, so an honest ballot cast at close is derivable through `L_δ` unless the batcher is down, and a ceiling that keeps the sequencer's silent window short. The spec part sets both from Base Sepolia's measured batch latency, noting that mainnet's latency and Base's batcher policy can differ and that the constants then need a new registry; the agent's starting point is 10 minutes to 1 hour, with 30 minutes the default the admin CLI proposes. [[verifier]] 2.6 calls δ the "drift bound"; the spec part corrects that, and has 2.6 check δ against the bounds the release pins.

**Re-voting.** [[revoting]] says the close rule MUST NOT admit ballots made after close. Under E it admits them only within δ, and only when the sequencer withholds batches; beyond δ, or with any delay of a batch that changes a result, the election fails instead. The spec part amends that MUST to say so, and R6: the last moment to re-vote by the ordinary path is close less the reference wait (about 36 seconds) less the time to land in an L2 block, since a ballot must be in a block by `closes_at`; by the relay, close less one L1 slot.

**Client.** A client that watches a ballot it cast and finds its block not yet derivable from L1 well before close MAY also relay it (the copies share `M`, so they are one ballot, [[revoting]] Selection; the spec part MUST define the check's recomputation to remove late ordinary copies before repeats are resolved, so that the relayed copy then stands), which keeps it from contributing to `close-contested`; nothing is lost if it doesn't. A relayed ballot costs L1 gas, needs a deposit gas limit enough for the board's check, fits the portal's calldata cap (about 120 KB, [[0004-l2-choice]]), and links the paying address to the ballot as any direct submission does (T-11, T-13); P2-8 and P4-2 say who pays and how.

**Work it creates**, all before any registry or board is deployed:

- **The spec** (P1-18 part 4c-2): the close statement record (a new record type and its signing tag, in [[versioning]] and [[trustee-identity]]), its boarding and contract-path rules and its deadline; `B`'s definition by the pinned derivation rules, not a node's reported safe head (op-node's safe-head-at-L1 index is optional and can't be rebuilt after the blobs expire); the close head, `close-contested` and the report's entries; 5.5's codes; the relay's call, accumulator and events; contract-event version 3 with the board's relayed-ballot event and the statements' contract path (version 2 is frozen, [[contracts]], Contract-event record); the registry's fields (`opens_at`, `closes_at`, δ and its bounds); the amendments to [[revoting]] and 2.6 above; vectors for each.
- **The contracts** (part 4c-3 and on): the registry recording the window, the board's `submitBallot` refusing outside it, never inside `BallotCheckLib.checkWithLayout`, which postings reuse after close ([[P1-18]] part 4b-3d-1, Known-weak); the relayed-ballot call; the statements' call; the L1 relay with the portal's address as an immutable that a verifier release pins and [[verifier]] 1.2 checks. A forced ballot must fit the deposit calldata cap, so the registry MUST refuse a definition whose largest ballot can't, or the spec MUST bound ballot size so none exceeds it.
- **The trustee node** ([[P2-13]]): computing and sending the close statement from its own L2 node over its own finalized-L1 source, never our API.
- **The verifier** ([[P1-19]]): 5.5 and the close check above; 4.5 for relayed events, reporting relay calls stamped inside the window that produced no L2 event (out of gas, priced out of the deposit gas budget, or censored); 5.6's and `tally-late`'s attribution by resolved games.
- **The reference election** ([[P1-20]]): an ordinary ballot after close refused, a relayed ballot stamped before close counted although its L2 block is after it, and a ballot after the close head that changes a cell failing `close-contested`.

**Threats.** T-35's residual becomes: within δ, a sequencer that withholds batches can admit ballots made after close; beyond δ, only with `k` seats lying; and the operator, through the board path, within `s_A`. T-50: a batcher outage longer than δ at close can fail an election, never silently drop a ballot. T-54: a new duty for the panel, whose absence leaves the close unchecked, never failed. T-71: a relayed ballot forged by L2 governance fails 4.5, and only resolved games count. T-53: `k` seats stating low can fail an election, as they already can by refusing the tally.

**Known-weak.**

- The board path's close is the operator's word (above). A compromised operator working with a coercer can admit a coerced ballot made up to about two periods after close; it still needs the voter's identity secret, so the coercer must have the voter make it (T-45).
- Within δ, the sequencer can still rebuild unposted pre-close blocks silently. Its rebuilding is visible as it happens (the unsafe head reorganises and the safe head stalls) but is not evidence anyone can archive.
- A close statement above the floor can be shown false only while the L1 blobs are retrievable (about 18 days). After that, `k` colluding seats stating high can hide a rebuild that went past δ, and at any time `n − k + 1` seats staying silent leave the close unchecked, which the report says but which fails nothing.
- An honest batcher outage longer than δ at close can fail an election whose result a late-batched ballot would change.
- Attribution of a late contract event rests on dispute games' cadence and resolution; a slow or absent proposer turns the operator's breach into an unattributed overrun, which still fails the election.

## Decision

Under rule A (`AGENTS.md`): **option E** for ordinary contract-path ballots, the L1 relay for forced ballots, the operator's `s_A` rule with its stated residual for the board path, and resolved dispute games for attribution and as the statements' floor, with status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. E changes nothing about who can alter a tally, so it stays within rule A; D, which would let the panel exclude ballots, would not, and is left to the owner. A veto of E means A (the 12-hour silent rebuild window stated in T-35) or B (a proposer outage dropping or failing the elections it overlaps, stated in T-35 and T-50); either needs only the spec part changed, since the contracts' checks are the same.

## Amendment (2026-10-13, P1-18 part 4c-2a)

[[close]] specifies this decision with three changes, which it, not this ADR, states normatively:

- **The floor only reports.** A claim below a resolved game's floor is listed against its seat but still counts toward the close head. Excluding it, as Consequences says, would let one false game, or a game type L2 governance re-points, raise the floor over every honest claim and leave a rebuild after `L_δ` unchecked (T-71, T-35). The head reads no game evidence.
- **The statement's deadline** is `t_C = closes_at + δ + CLOSE_WINDOW`, with a node sending through the contract path by `t_C − F`, rather than `c_I`; it is in the counted extent either way.
- **The unchecked report** lists the counted ballots that have only ordinary copies, rather than those "after `N_c − δ`".

[[revoting]]'s MUST now lists five ways a ballot made after close can count: the three of Known-weak, the relay's seconds after close, and a rebuild past δ when `n − k + 1` seats stay silent and the close is unchecked, which needs fewer seats than `k` whenever `k > (n + 1) / 2` and no false statement.
