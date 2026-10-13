# ADR 0028: Rolling electorates for everyday polls

- Status: Accepted (owner, 2026-10-12): rolling electorates for everyday polls; the design within it is the agent's (owner may veto)
- Date: 2026-10-12
- Deciders: owner (everyday polls get a rolling electorate, civic polls keep the fixed one); agent, owner may veto (rule A), for the design
- Threats addressed: T-01, T-02, T-03, T-06, T-08, T-12, T-13, T-16, T-18, T-25, T-34, T-36, T-45, T-52, T-53 (see [[THREAT_MODEL]])

## Context

Every poll's electorate is fixed before it opens. Each tier entry of the definition carries a `root`, the tier tree's root at `root_l2_block`, and that block is strictly before the block that registers the definition ([[election-definition]], `tier_group` and The electorate is in the past). Every ballot of the tier proves membership against that root and no other ([[verifier]] 5.1), and its nullifier scope hashes it in: `S_g = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(t_g) ‖ encode(root_g)))` ([[membership]], Scope; [[verifier]] 5.2). A commitment added after `root_l2_block` is a leaf of no tree the poll accepts, so **anyone who registers after a poll's definition can't answer it**.

That is right for civic votes, whose electorate is a fixed, published list. It breaks everyday polls, where "anyone can ask anything and anyone can answer" ([[PROJECT_BRIEF]], Design direction, owner, 2026-10-12): they spread by shared links, and the person who taps one has often never used Abolish. The first-answer journey ([[first-answer]]) registers a new identity on the spot ([[0024-tier0-registration]], option B: a shuffled batch every period of at most 10 minutes) and can't then send the answer; that is its open question 1.

On 2026-10-12 the owner decided: **everyday polls get a rolling electorate; civic polls keep the fixed one.** This ADR designs it. What is one-way: the scope formula, the tree a ballot proves against and the field naming it go into every ballot on the permanent board, freeze with their vectors once anything is anchored ([[versioning]]), and are checked by the immutable direct-submit contract (P1-18).

What a rolling electorate has to do:

1. **One counted ballot per secret, per tier, per poll,** whichever root, group or position it proves from (G-2). A rolling electorate must add no way to vote twice that the tier's own registration rule doesn't already allow (T-01, T-02, T-03).
2. **A ballot's root says nothing about its voter** beyond what the board already shows: in particular, not when they joined (T-13).
3. **No root anyone can't recompute from additions already public on L2.** That is the reason the electorate is in the past today: a root committed ahead of its additions lets an insider withhold them (T-08, T-13, T-34).
4. **Direct submission still works without us** (T-25).
5. **Civic polls are never rolling**, and that is a check, not a convention.
6. **A verifier's work stays bounded** by the chain's additions, not by additions times roots (T-36, T-52, T-53).

### The coordinator's sketch, evaluated

The sketch: a ballot may prove against any tier root published at or after the opening root and before close, or against a defined accepted set ("any root from the tier's root history between `opens_at` and `closes_at`"), perhaps required to be the latest at cast; the scope must not depend on the root; group size is reported at close and at each live release; cells are either disallowed or made to roll.

- **The root-free scope is necessary and sufficient for requirement 1.** With the root in the scope, each root is a new nullifier for the same secret (option A below). Without it, the nullifier is a function of the poll, the tier and the secret alone, whatever root the proof used (Nullifier scope).
- **"Any root in the history" is too many roots.** The tier's root changes with every addition record, so its history is one root per batch or attestation. Each would have to be recomputed by every verifier that meets a ballot naming it, and a voter's choice among them is a signal. The sound form is a fixed **root clock**: roots taken at fixed boundaries of L2 time, the same for every poll and computable by anyone (Accepted roots).
- **"Published" can't mean a root anyone posts or a group contract keeps.** The group registry keeps no tree, by design ([[contracts]], Group registry), and a posted root is only a claim. Accepted roots are the ones a verifier computes itself from the registry's events at each boundary; anything posted is checked against them.
- **"Latest root at cast time" is the right client rule, but a verifier can't see cast time.** It can see the ballot's L1 reference, which the proof already binds ([[revoting]], Message). So the client uses the newest settled step and the verifier accepts only steps within a window before the ballot's reference (Which step a ballot uses).
- **The anonymity-set analysis holds as sketched,** and favours the newest root on both counts: it is the largest set, and if everyone uses it, a voter who just joined is indistinguishable from one who joined years ago (Anonymity).
- **Cells** are disallowed (Regional cells).

So the sketch is kept, made precise in four places: a root clock instead of "every root", recomputed roots instead of "published" ones, the L1 reference instead of cast time, and a tree whose leaves are in addition order, so that a step's root costs its new additions, not the whole tier (The rolling tier tree).

## Options

### A. Many roots under the existing scope

Accept later roots (every root, or roots at intervals), keeping `S_g`'s root input; or, equivalently, re-register a fresh definition for each new root.

- Pros: no new scope, tag or circuit input.
- Cons: **unsound.** The scope, and so the nullifier, differs per root, so a member of every accepted root has one unrelated nullifier per root and the re-vote rule, which groups by (tier, nullifier), counts one ballot for each ([[revoting]], Selection). One person votes as many times as there are roots, at every tier: it breaks Tier 2's one document, one vote (T-03) and Tier 1's bound (T-02), not only Tier 0's (T-01). Rejected.

### B. A root clock, a root-free scope, and roots chosen by the L1 reference

1. Rolling tiers use a **rolling tier tree** whose leaves are the tier's listed groups' additions in chain order.
2. The accepted roots are the tree's roots at the boundaries of a protocol-wide **root clock** (`ROOT_PERIOD`).
3. Each ballot names its **step**; the client uses the newest settled step, and the verifier accepts a step only within `ROOT_WINDOW` before the ballot's L1 reference.
4. The scope is `H(DS("abolish/v1/rolling-nullifier-scope", definition_hash ‖ u8(t)))`.
5. A rolling tier is one cell.
6. Direct submission carries the root it proved against, which the verifier checks.

Pros: one nullifier per secret per tier per poll; nothing about a ballot's step that its L1 reference doesn't already say; every root recomputable from public events; a verifier's cost linear in additions; Semaphore's circuit and keys unchanged. Cons: new definition and ballot versions; direct submission's spam control drops from "members only" to "gas only" in rolling polls; a first answer waits for a root step as well as a registration batch; Tier 0 Sybils can be made during a poll. Details below.

### C. A rolling root kept on chain, with Semaphore's root history

The stock Semaphore v4 contract model: the group contract maintains the tree, and a proof is valid against its current root or any root in its history younger than a fixed duration.

- Pros: stock contracts; direct submission checks the root against contract state, so non-members still can't post.
- Cons:
  - Semaphore's contract keeps a LeanIMT, which lets one registration carry a private subtree ([[membership]], Statement), so it would have to keep the depth-32 complete tree instead: 32 Poseidon hashes in the EVM per addition, the order of a million gas each, paid by the registration paymaster for every Tier 0 registration (T-52).
  - A root kept on chain is the second answer [[contracts]] (Group registry) rules out: the verifier must still recompute every root from the events and never trust the contract's (T-71), so the contract's tree adds cost and no trust.
  - The group registry is specified and part-built without a tree (P3-2 part 1), and is immutable once deployed.
  - Root history by L2 time alone doesn't tie a root to the ballot's L1 reference, so a client's choice among the history isn't bounded by anything the verifier sees.

  Rejected. Its root history with an expiry is what B's window borrows, tied to the L1 reference instead of L2 time.

## Recommendation

**B.** It is the only option that keeps one vote per secret (A doesn't), and it does so without an on-chain tree (C). The design follows.

### Electorate mode and poll class

- The definition gains an **electorate mode**, fixed or rolling, for the whole definition: every tier of a rolling definition is rolling. A mixed definition answers no need anyone has raised and doubles every rule.
- **Civic polls are never rolling.** A rolling definition whose poll class ([[0027-trustee-panels-and-live-results]], Part 3, rule 2) is organisational vote or civic referendum is ill formed (`rolling-class`). [[verifier]] 2.1 fails it. The election registry refuses to register it, and the ballot client refuses to cast in it and never shows a rolling poll in the civic register.
- The creation flow makes every everyday poll rolling. A fixed everyday poll stays valid in the protocol, since nothing is lost by it, but the flow doesn't offer it at launch.

### The rolling tier tree

A rolling tier lists its groups, as a version-3 tier does, in strictly ascending `group_id`, each a group the registry attributes to the tier ([[verifier]] 2.4). Groups created after the definition aren't in the poll. The registration service adds to long-lived groups per tier and region ([[0019-regional-cells]], option A), and a first-time voter's client registers into a group the poll lists (Ballot client, below).

Its tree is [[membership]]'s tier tree (depth exactly 32, `Poseidon2`, empty leaves 0, at most 2³² leaves) with the **leaves in chain order**: every counted addition of every listed group, in the group registry's log order (L2 block, then log index; a batch's members in their index order), from each group's creation; a removal sets its addition's leaf to 0.

- **Why chain order, not the cell tree's group order.** The cell tree concatenates groups by `group_id` ([[membership]], Cell tree), so an addition to an early group shifts every later group's leaves, and each step's root would be a rebuild of the whole tier. A month-long poll has over 4,000 steps; at a million members that is billions of hashes for a verifier. In chain order a step's tree is the previous step's plus its own additions and removals, 32 hashes each, so the whole poll costs 32 hashes per event, the same as replaying the groups once (requirement 6; T-36, T-53). The listed groups share one registry contract, so their events have one total order, and self-paid groups ([[0024-tier0-registration]], option D) take their place in it too.
- **No first-occurrence rule.** A commitment repeated across groups, or removed and re-added, keeps a leaf per occurrence. Each is the same secret, so it has the same nullifier (Nullifier scope), and a repeat gives no second vote. The rule exists to keep one secret in one cell ([[membership]], Cell tree), and a rolling tier has one cell. The **member count** at a step is the number of distinct nonzero commitments among the live leaves, so repeats never inflate a reported anonymity set (T-16).
- Everything Tier tree proves holds unchanged: one registration is at most one identity, and the root is never 0 while the tier has a live member.

### Accepted roots: the root clock

- **The clock.** Boundary `n` of the root clock is the time `τ_n = epoch + n · ROOT_PERIOD`, with `epoch` the anchoring clock's ([[board]], Timing). `ROOT_PERIOD` is a protocol constant of the definition version, in [[parameters]], never chosen per poll (T-34).
  - Amended by P2-17 part 1 (agent, owner may veto): the clock is UNIX time, `τ_n = n · ROOT_PERIOD + ROOT_OFFSET` with `ROOT_OFFSET` 300 seconds, not the anchoring clock's `epoch`. A boundary then follows from protocol constants alone, as [[registration]]'s periods do, so a verifier needs no pinned anchor deployment to judge a step, and each root boundary falls half a period after a registration boundary, so a batch formed there lands before the next step instead of just after one ([[parameters]], `ROOT_OFFSET`).
  - Proposed: 600 seconds. That is ADR 0024's registration period (at most 10 minutes), and it divides the hourly anchoring period.
  - The registration service times each batch to land shortly before a boundary, so a new member waits one batch, not a batch and a step.
- **Step `n`'s root** for a rolling tier is the rolling tier tree over the listed groups' events in L2 blocks whose timestamp is at most `τ_n`. L2 timestamps never decrease along the chain and the accumulator binds each event's block and timestamp ([[contracts]], Event accumulator), so every verifier derives the same step from archived events alone, with no headers.
- **Which steps a poll accepts.** A rolling poll accepts step `n` for tier `t` if `τ_n` is after `root_l2_block`'s timestamp and at most `closes_at`, and the step's root isn't 0. Which of those a given ballot may name is the window (below).
- **The opening state stays in the definition.** `root_l2_block`, `root` and `group_size` keep their place and their rule (strictly before the registering block), now meaning the tier at opening, in the rolling tree's layout. [[verifier]] 2.4 recomputes them as today, so the creator can't overstate the electorate a poll opened with (T-13, T-16). Ballots never prove against the opening root as such: it is a step's root only if a boundary falls on it.
- **Roots stay in the past (requirement 3).** No root after opening is committed anywhere in advance; each is what the final chain says at its boundary. A step is **settled** once L2 history containing a block with timestamp after `τ_n` is posted to L1, since no later block can carry an earlier timestamp. It is **final** once that history is final.
  - An honest client proves only against a settled step.
  - It checks again when the step is final, and re-casts if the final root differs.
  - So an insider who sequences hidden additions before a boundary can only invalidate ballots whose clients didn't wait for L1. Making a root that only its own commitments can prove against needs an L1 reorganisation (T-08, T-13, T-25).

### Which step a ballot uses

The ballot record gains a **step** field, bound by the ballot hash and so by `M` ([[revoting]], Message), so a proof can't be relabelled to another step with the same root (T-38). The verifier takes the step's root from its own recomputation, never from the ballot.

- **Client rule.** Use the newest settled step that contains the voter's own live leaf. For a member who joined before that step, that is the newest settled step, whoever they are.
- **Verifier window.** A ballot whose L1 reference has timestamp `t` may name step `n` only if `t − ROOT_WINDOW < τ_n ≤ t`. Otherwise it is rejected at admission (`root-step-stale` or `root-step-future`). This depends only on the ballot, the definition and finalized L1, like every other admission check ([[revoting]], Admission; R4).
  - `ROOT_WINDOW` is a protocol constant in [[parameters]], proposed at 2 hours.
  - It must cover `ROOT_PERIOD`, the L2's posting delay to L1, `max_sequencer_drift` and a client's slack; P2-17 part 1 checks it against [[0004-l2-choice]]'s figures.
  - The proof is made when the ballot is sent, so a sealed answer held offline gets its step and its reference together, and direct submission's delays never age a step.

**Anonymity.** A ballot proved against step `n` hides its voter among the members at `n`. Clients following the rule all name the newest settled step, so at any moment every new ballot names one of a step or two, whoever cast it, and the step says no more than the L1 reference, which already places the ballot to about 12 seconds ([[revoting]], Residuals). Both reasons the sketch gave point the same way:

- **It is the largest set.** Members only join between steps; removals are rare and never used yet ([[0024-tier0-registration]], Consequences). So the newest step's set contains nearly every earlier one.
- **It hides join time.** If older members typically used older roots, a voter forced onto a newer root because they had just joined would stand out, and the step would be a join-time signal (T-13). With one rule for everyone, nobody is forced onto anything the others don't use.

The window is what makes this hold against a non-conforming client. A client that names older steps, or the oldest one its voter is in, is limited to steps inside `ROOT_WINDOW` of its reference, so the most its choice reveals is that its voter joined within the last couple of hours. That is a residual of T-13, and a window of hours rather than the whole poll is what bounds it.

The window also makes removals take effect in a rolling poll: a member removed during it can't make a new ballot after `ROOT_WINDOW`. A ballot it cast earlier still counts, as it would in a fixed poll.

### Nullifier scope

For a rolling definition, every ballot of tier `t` uses

```
S_t = H(DS("abolish/v1/rolling-nullifier-scope", definition_hash ‖ u8(t)))
ŝ_t = F(S_t)
```

with [[membership]]'s `F`. The input after the tag is exactly 33 bytes. The new tag goes in [[domain-separation]]'s registry: a rolling scope can't equal a fixed one even by construction, and no reader can mistake which formula an election uses. The tier stays bound, so two tiers never share a scope even if their trees are equal ([[membership]], Scope). `definition_hash` binds the poll, its chains, contracts and mode, so scopes never repeat across polls (T-12, T-30). A verifier derives `ŝ_t` from the definition alone, never from a ballot ([[verifier]] 5.2), and the prover proves only under a scope it recomputed from a definition it verified ([[membership]], Chosen-scope linkage).

**Double voting stays impossible beyond the tier's own registrations.** Within tier `t`, every admitted ballot's proof verifies with public inputs `[ρ_n, ν, m̂, ŝ_t]`, where `ρ_n` is the root the verifier computed for the ballot's step and `ŝ_t` is the same for every ballot. By the proof's soundness and Tier tree's argument, the prover knows a secret `s` whose commitment is a leaf of `ρ_n`, and `ν = Poseidon2(ŝ_t, s)`. So:

- **Across roots:** one secret has the same `ν` at every step.
- **Across groups and positions:** a commitment in two listed groups, or at two leaves, is one secret with one `ν`.
- **Removed and re-added:** a commitment removed and added again, in the same group or another, is the same secret with the same `ν`.
- **Distinct secrets with one `ν`** would need a Poseidon collision.

Selection counts at most one ballot per (tier, `ν`) ([[revoting]], Selection). So a tier's counted ballots are at most the distinct secrets whose commitments were live at some accepted step, and two counted ballots need two registered secrets. That is exactly the tier's own registration bound, now over the poll's whole span rather than at one block:

- **Tier 0:** none (T-01, below).
- **Tier 1:** [[0014-tier1-vouching]]'s bound (T-02). A re-added commitment is the same secret; a second commitment needs `k` fresh vouches, as today.
- **Tier 2:** the keyed nullifier `N` of [[0022-tier2-keyed-nullifier]] makes one document one registration. The attesters refuse a second commitment for an `N` they hold, under a `max(k, n − 1)` quorum. So one document is one secret, and one counted ballot per rolling poll, across every step. Uniqueness across roots needs nothing new: it was never about roots, but about the attesters' list (T-03, T-06). Tier 2 rolling polls are allowed.
- **A Tier 2 replacement would break this,** and none exists: a voter who loses their device and backup loses Tier 2 ([[0017-identity-recovery-backup]], Consequences). Any later design that lets a document register a new commitment (T-18's revocation) MUST keep one counted ballot per document in every rolling poll. A document's old secret may have voted in a poll its new secret could join, and nothing on the board links the two. The simplest sound rule: the attesters admit a replacement only once every rolling poll open while the old commitment was live has closed. The same constraint applies to a Tier 1 replacement that keeps its vouches.

### Anonymity set and reporting

- **Per tier, never one number.** [[verifier]] 8.1 reports, per rolling tier:
  - the member count at opening (2.4);
  - the member count at the last accepted step (**at close**);
  - the smallest member count among the steps counted ballots named, which is the anonymity set of the worst-placed ballot and the one 8.2 flags when small (T-16, T-13).
- **Growth is public.** The report also gives the additions and removals per anchoring period during the poll, so a stuffing run by the registrars (T-06) or a Sybil flood (T-01) shows as a shape anyone can see. It can't be told from a genuine surge.
- **Live releases** ([[0027-trustee-panels-and-live-results]], Part 2) each carry the member count at the newest step at or before their snapshot's cutoff, beside the ballot count.
- **What a result means.** A rolling result describes the people who answered, not a fixed population. "Turnout" against the close count is a ratio over an electorate that grew during the poll, and at Tier 0 could grow on purpose. So rolling results say what they are ("58.4% yes among 2,418 people who answered; 9,105 could answer by the close"), always per tier ([[PROJECT_BRIEF]], Design direction). The exact wording is [[first-answer]]'s open question 4, and the language work's ([[language]]).

### Regional cells

**Rolling tiers aren't split; a rolling tier is one cell.** Making cells roll is possible in principle: the tier-wide rolling scope gives a member who moves region one nullifier, so moving can't vote twice. Disallowing it is still the better choice now:

- **The fold needs fixed counts.** Which regions are cells depends on member counts against `MIN_CELL_ELECTORATE` ([[election-definition]], Regional cells). With rolling counts the fold would have to be frozen at opening, and a region could later shrink under the floor by removals, or a remainder cell's makeup drift from what its counts justified.
- **Rolling regions are paddable on demand.** At Tier 0 a region is self-declared, and identities can be added during the poll, so the floor is a gas or Turnstile cost an attacker pays only for the cell they want to expose (T-16, T-01).
- **Region moves mid-poll leak at the tally.** A member who moves region during the poll leaves one cell's counted set and enters another's. Under live results that is a re-entry pattern [[0027-trustee-panels-and-live-results]] (rule 1's open obligation) hasn't analysed yet.
- **Everyday polls don't need it.** Regional reporting is a civic-record need ([[0019-regional-cells]], Context), and civic polls are fixed.

A creator may still restrict an everyday poll to some regions by listing only those regions' groups; the tier is then one cell over them, reported with the regions its groups were created with ([[verifier]] 8.1). If regional everyday results are wanted later, a new version can freeze the fold at opening under this ADR's tier-wide scope, after the live-results re-entry question is settled.

### Live results

[[0027-trustee-panels-and-live-results]] (Part 2) applies unchanged, with the tier as the cell:

- the running set holds each (tier, `ν`) with exactly one distinct ballot, wherever its steps fall;
- a re-vote naming a newer step is a re-vote like any other and is held out until the final tally;
- the batch rule counts changed nullifiers per tier.

Each release reports its member count (above).

What changes is the cost of padding. ADR 0027's residual, an adversary casting `B − 1` known ballots into a quiet interval around a target, no longer needs identities registered before the poll. At Tier 0 they can be registered during the interval, one Turnstile solve each (or gas, through a self-paid group), after the adversary has seen the running totals. The cost per identity is the same; the timing becomes adaptive (T-16, T-01). Tiers 1 and 2 keep their registration costs.

### Re-voting, multi-question ballots, intake

- **Re-voting** ([[0011-revote-rule]], [[revoting]]) is unchanged. The newest L1 reference counts per (tier, `ν`), and ballots naming different steps compare like any others: the step never ranks. Since the window ties a step to its reference, a re-vote names a newer step whenever one has settled. `M`'s layout is unchanged; the step reaches it through `ballot_hash`.
- **Multi-question ballots** ([[0026-multi-question-ballots]]): one membership proof per ballot, so one step per ballot, whatever its questions. Nothing is per question.
- **Intake.** Trustee nodes' membership-checked intake ([[P1-12c]], [[P2-13]]) and the API's admission check a rolling ballot against the step roots they compute from the chain, with `packages/crypto`'s tree and window, never one supplied with the ballot.

### Direct submission

The direct-submit contract (P1-18) checks a fixed poll's ballot against the root registered with its definition. A rolling poll's roots aren't registered anywhere, and the group registry keeps no tree. So, for a rolling poll:

- The submitter supplies the root it proved against beside the ballot (not in the ballot record).
- The contract recomputes `ŝ_t` from the definition hash and tier, checks the proof with that root, decodes the proof strictly ([[membership]], Owned elsewhere), and logs the supplied root.
- The verifier rejects a ballot whose supplied root differs from its own step root (`root-step-mismatch`). The board still carries the ballot as a rejected entry ([[verifier]] 5.6, 8.3).

This keeps the direct path free of us: anyone can submit with nothing but the chain (T-25). The cost is spam control:

- In a fixed poll, non-members can't post at all.
- In a rolling poll, anyone can build a tree containing themselves and post well-formed junk, at their own gas. The verifier rejects it, and the board operator must still board it (T-52).
- A contract-side check against roots attested by the panel was considered and rejected: under the transitional panel that is us, the party direct submission exists to route around.

### What the verifier checks

Changed or new, for a rolling definition:

- **2.1:** the electorate mode decodes; well-formedness adds `rolling-class` (rolling only in an everyday poll) and `rolling-tier` (a rolling tier has groups and no regions or cells; at least one group; groups strictly ascending; no group in two tiers).
- **2.3:** `profile-combination`: a rolling definition pins a ballot version that carries a step, and only it does.
- **2.4:** the listed groups are replayed, as today, through the last accepted step, not only to `root_l2_block`; the opening root and count are checked in the rolling tree's layout; each step a ballot names is recomputed. The board must carry the groups' events through close, not only to `root_l2_block` ([[contracts]], Election registry, The shared event sequence; 4.4).
- **2.8:** the partition is one cell per rolling tier.
- **5.1:** the root is the verifier's step root for the ballot's step. Admission adds `root-step-range` (a step the poll doesn't accept), `root-step-stale` and `root-step-future` (the window), and, for direct submission, `root-step-mismatch`.
- **5.2:** the rolling scope.
- **5.3:** unchanged in form; the step is bound through `ballot_hash`.
- **6.1 and 7.x:** unchanged, over one cell per tier.
- **8.1 and 8.2:** the reporting above. Tier 0 rolling results are labelled as not Sybil-resistant, as all Tier 0 results are, and as open to new identities during the poll.

### What the definition carries

In the definition version P2-16 part 1 adds (with the poll class and live results), if it hasn't frozen by then, otherwise the next:

- `electorate_mode`: `enum8<1, 2>`, 1 fixed, 2 rolling.
- Under mode 2, `electorate` is a list of **rolling tiers**, each with `tier`, `root_l2_block` (opening, strictly before registration), `groups` (`list<u64, 1024>`, strictly ascending), `root` (the rolling tree's root at `root_l2_block`) and `group_size` (its member count there). There are no regions or cells.
- Nothing else: `ROOT_PERIOD` and `ROOT_WINDOW` are constants of the version. Close counts and step roots can't be known at registration, and are computed, never stated.

The ballot version gains `step` (`u32`, the boundary number). It builds on the ballot version current when part 1 is written (version 3, or P2-16's two-sharing version), as a new version if that one has frozen.

### Ballot client

Before casting in a rolling poll, the client:

- checks the definition is well formed, refusing `rolling-class` and any rolling definition it would show in the civic register;
- rebuilds the opening root from the listed groups and compares it, as for a fixed poll ([[election-definition]], The electorate is in the past);
- rebuilds the newest settled step's tree from every listed group's events (never asking a server for its path, [[membership]], Owned elsewhere), checks its own leaf is live in it, and proves with the rolling scope;
- checks the step again at finality and re-casts if its root changed.

For a first answer it registers into a group the poll lists (its region's, if listed). The sealed answer is sent once its commitment is in a settled step.

### Sybil cost, plainly

- **Tier 0.** A rolling poll lets anyone add identities after seeing the question, its live totals and its turnout, and vote with them before the close: one Turnstile solve each ([[0024-tier0-registration]], B), gas through a self-paid group (D), or nothing at all for the registrars (T-06). A fixed poll needed them registered before its definition, which cost the same but meant planning ahead.
- **What changes for a voter.** One person can now answer again from a second device, or after losing their identity, during the poll, which [[first-answer]]'s open question 5 already faces.
- **What doesn't change.** T-01 was and stays **Not mitigated** at Tier 0, and Tier 0 results stay labelled.
- **Tiers 1 and 2** are allowed to roll: their bounds hold across roots (Nullifier scope).

## Consequences

- **New versions.** A definition version (electorate mode and rolling tiers; coordinated with P2-16 part 1), a ballot version (the step), the rolling tier tree and rolling scope in [[membership]], the tag `abolish/v1/rolling-nullifier-scope` in [[domain-separation]], `ROOT_PERIOD` and `ROOT_WINDOW` in [[parameters]], the admission codes in [[ballot-validity]] and [[verifier]]. Fixed polls are unchanged.
- **Statements this ADR narrows.**
  - [[membership]] (Scope): the root is in the scope for fixed polls only.
  - [[membership]] (Checks): `ρ` comes from the step for rolling polls.
  - [[election-definition]] (The electorate is in the past): it holds for the opening state; later steps are settled before use rather than registered in advance.
  - [[contracts]] (Group registry; Owned elsewhere in [[membership]]): direct submission checks a rolling ballot against a supplied root, and the verifier, not the contract, decides it.
- **The first-answer wait.** A first answer waits for the registration batch and then for its step to settle on L1: one registration period, timed to land before a boundary, plus the L2's posting delay, not "at most 10 minutes". [[first-answer]]'s waiting copy and its open question 2 change with P2-17's client part.
- **Known-weak.**
  - Tier 0 Sybils made during a poll, adaptively, including for live-results padding (T-01, T-16).
  - Spam control on rolling direct submission is gas only (T-52).
  - A non-conforming client's step leaks join time within `ROOT_WINDOW` (T-13).
  - A new identity's first ballot is close in time to its registration batch, so in a quiet batch an observer can link the commitment's batch to a nullifier in that poll. It reveals no vote, and the step adds nothing to it; larger batches ([[0024-tier0-registration]], 4b) narrow it (T-13, T-12).
  - Rolling results describe who answered, not a fixed electorate.
  - No regional everyday results.
  - Any Tier 2 or Tier 1 replacement design must respect the rolling-poll constraint above (T-18).
- **Work item.** [[P2-17]], with parts inside the `crypto-review` gate. It blocks the first-answer journey ([[first-answer]]) and depends on P2-16 part 1 (poll class, definition version), P2-14 part 1b (ballot version 3), P3-2 part 4 (the registration service) and P1-18 (direct submission).
- **[[THREAT_MODEL]] and threat files** (in P2-17's PRs): T-01 (identities during a poll), T-13 (step choice, first-ballot timing), T-16 (padding on demand), T-18 (replacement constraint), T-52 (rolling direct submission).

## Open points for the owner

None blocks the work; each is a design choice the owner may veto.

- **The longer first-answer wait** (registration period plus settlement, typically tens of minutes) against the 10-minute figure [[first-answer]] assumed. A shorter `ROOT_PERIOD` helps only down to the registration period, and narrows T-13's timing cover.
- **Adaptive Tier 0 Sybils in live polls.** Rolling and live results together make padding cheapest. Tier 0 live polls could stay sealed until close, or show running totals only for Tiers 1 and 2. This ADR allows both, as ADR 0027 did.
- **Everyday polls are always rolling in the creation flow;** the protocol also allows a fixed everyday poll, not offered at launch.
- **No regional everyday results** until a later version freezes the fold.

## Decision

The owner's decision (2026-10-12) is accepted as stated: rolling electorates for everyday polls, fixed for civic polls. Within it, under rule A (`AGENTS.md`), **option B** with status `Accepted (agent) — owner may veto`, for listing under Decisions to review in [[STATUS]]:

- the rolling tier tree in chain order;
- the root clock (`ROOT_PERIOD` 600 s) with settled steps;
- the newest-settled-step client rule and the `ROOT_WINDOW` (2 h) check against the L1 reference;
- the rolling scope `H(DS("abolish/v1/rolling-nullifier-scope", definition_hash ‖ u8(t)))`;
- one cell per rolling tier;
- reporting at opening, at close, at the smallest step used and at each live release;
- direct submission with a supplied root;
- `rolling-class`, enforced by the verifier, the registry and the client.
