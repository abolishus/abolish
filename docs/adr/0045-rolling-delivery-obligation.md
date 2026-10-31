# ADR 0045: The delivery obligation of a rolling poll

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-31
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-25, T-52, T-54, T-01, T-16, T-17, T-53 (see [[THREAT_MODEL]])

## Context

A trustee node lends its keys to an election only if everything its seat may owe fits the forced path through L1 by the deadlines, together with every other election it has approved whose intervals can overlap ([[delivery]], Capacity; [[ceremony]], Stub checks, step 4). What a seat may owe is bounded by the electorate: at most two receipts and two complaints per (`tier`, `ν`), so `2M` of each for an election of `M` members ([[delivery]], What a node owes). A fixed poll's `M` is in its stub, which the node recounts from the chain before it approves.

A rolling poll's `M` is its **members over the poll**: the distinct commitments live at some step the poll accepts ([[membership]], Root clock and steps; [[0028-rolling-electorates]]). Nobody knows it when the node approves the stub, before the poll opens, and nothing bounds it:

- self-paid groups take any commitment for a fee and a call's gas, with no solve ([[contracts]], Self-paid additions);
- Tier 0 identities can be made during a poll, adaptively (T-01, T-16; [[0028-rolling-electorates]], Known-weak);
- a poll over a region's long-lived Tier 0 group, the everyday case, has the whole group as its members, however few people answer.

So the spec has the node refuse every rolling stub, and requires the forced path to be sized for a rolling poll's growth before any registry accepts one ([[delivery]], What a node owes; [[P2-17]] part 7c). Rolling polls are the everyday default (the brief, Priority), so until this is decided no everyday poll can be served.

What is one-way: an election's delivery rule is fixed by the release that registers it, and every verifier judges its delivery by that rule for good. A later release can change it only for later polls.

## Options

### A. Cap the members over the poll

The poll stops accepting steps once its members over the poll would pass a cap, from the definition (a new definition version) or a release parameter. A node reserves the batch figures at the cap.

- Pros: every rolling poll stays on batches, whose receipts and complaints are L2 data every reader holds.
- Cons: a poll over a shared Tier 0 group already has more members at opening than any useful cap (one election alone fits at most 20,992 members with 3 seats at `R` of one hour), so the everyday case can't use it. Anyone can fill a poll's listed self-paid groups for the fee, closing it to newcomers (T-52, T-53). It needs a new admission rule and a new definition version, with vectors.

### B. Cap the answerers

Admission accepts at most `N` distinct (`tier`, `ν`) in board order, later ones rejected. A node stops intake for a new (`tier`, `ν`) past `N` and caps its complaint scope the same way.

- Pros: the bound follows what happens, not the group's size, so small polls fit batches.
- Cons: who is inside the cap depends on board order, which the operator sets, so the operator chooses who answers (T-25). Tier 0 identities made during the poll fill it (T-01, T-16). Under withheld board data, nodes and the delivery check disagree about who is inside it. Worst, a capped complaint scope lets a flood of failing postings exhaust it, so a real failing posting goes without a complaint and a bad share is counted: an integrity loss, not a liveness one. It also changes ballot version 5's admission, which is frozen by its vectors.

### C. Every rolling poll commits roots

A rolling election commits roots whatever its size ([[delivery]], Elections that commit roots; [[0031-national-delivery-obligation]]): each seat sends one receipt root and one complaint root over exactly what it decided at `c_I`. A root costs `ROOT_CALL_GAS` per seat and interval whatever `M` is, so the node reserves `s · ROOT_CALL_GAS` for each interval at approval, without knowing `M`. A root's `count` is bounded by `2M` with `M` the members over the poll: the sum over its rolling tiers of the eligible count `E(n_c)` ([[membership]], Rolling report), which the verifier computes from the rolling chain through close before any leaf is fetched (`root-count`).

- Pros: no new admission rule (5.9 reads the eligible count the rolling report already computes) and no reservation that growth can overrun. Every node and client decides it alike from the definition alone (`electorate_mode`). A rolling poll costs the portal about 600,000 gas per interval with 3 seats, against 13.5 million for the smallest batch figure, so many more polls can close together.
- Cons: every rolling poll's receipts and complaints rest on the availability committee ([[0029-board-data-availability]]; [[delivery]], Residuals, A root's leaves rest on the availability committee). Under the transitional panel every seat is ours, so a root's availability is our word ([[0031-national-delivery-obligation]], Consequences). What stays the voter's: nodes still send receipts through the board path at intake, may send batches beside the root, and the client keeps sending its receipts through every path, the contract path included, until one is anchored or recorded by the contract, and never stands down on a leaf ([[delivery]], Client rules). It also waits on the root path: nodes send roots in [[P1-12f]] part 3c and the verifier reads them in part 3b.

### D. Batches up to a small size, roots above

A rolling poll whose members over the poll are at most a fixed small number (256: one batch call per seat and kind, since a call carries 512 complaints and a seat may owe `2M`) delivers by batches, and a larger one commits roots. The node reserves the batch figure for every rolling poll.

- Pros: small polls over small groups keep their receipts as L2 data.
- Cons: it reserves 22 to 25 times the root figure per interval for every rolling poll (13.5 and 15 million gas with 3 seats, against 600,000), while most of them, over shared Tier 0 groups, pass the size and commit roots anyway. Nodes need the root path either way, so it waits on the same work as C and adds a second rule.

## Recommendation

C. Option A doesn't serve the everyday case. Option B trades an integrity loss for capacity. Option D keeps C's dependency and adds a rule. C leaves admission unchanged, has no bound to overrun, and costs the forced path least. Its cost is the availability committee, which [[0031-national-delivery-obligation]] (accepted by the owner) already uses for every election batches can't carry. A rolling poll is such an election: no node can show at approval that batches will carry it.

What would change it: a bound on a rolling poll's growth that the chain enforces and that no one can fill cheaply, which would let batches be sized (A or D); or a delivery path whose cost per receipt doesn't grow with `M` and keeps receipts as L2 data.

## Consequences

- [[delivery]]: a rolling election commits roots (What a node owes, Elections that commit roots, Obligation root's Bound, Capacity); [[ceremony]] stub check 4 counts it with the root figure. Nodes still refuse every rolling stub until they can send roots and the verifier can read them, now because the root path isn't built rather than because the obligation is unsized.
- Building it: `forcedPathElectionOf` and the capacity check in `packages/crypto` reading a rolling definition as one that commits roots, and the trustee node reading version-6 and version-7 stubs and taking ballot version 5 through `intakeBallotV5` ([[P2-17]] part 7c, after this part). The root path itself is [[P1-12f]] parts 3b and 3c, which wait on [[P4-3]] and on `claude/p1-12f` (STATUS.md, Blocked).
- Known-weak: delivery of every everyday rolling poll rests on the availability committee, which is ours under the transitional panel, so until independent trustees hold seats a voter can't check a root's availability against us. The voter's own contract-path receipts are what still delivers a ballot an operator and its seats want dropped (T-25, T-54).
- Known-weak: a rolling poll's leaf bound `2M` grows with every self-paid addition anyone pays for during the poll, so a seat signing a root of junk leaves up to it makes every seat and verifier fetch more, for `SELF_PAID_FEE` and one call's gas per addition, and no node can size its leaf storage when it approves the poll ([[delivery]], Residuals; T-52, T-17).

## Decision

Under rule A (`AGENTS.md`): option C, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
