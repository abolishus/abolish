# ADR 0019: Regional cells

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-12
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-16, T-13, T-14, T-01, T-03, T-06, T-29, T-31, T-34, T-38 (see [[THREAT_MODEL]])

## Context

The brief's civic referendums are national, state and district contests (Phase 5), and their results are naturally reported by region. [[0002-everlasting-privacy]] (Tally) and [[0003-tally-scheme]] allow a tally partition of tier × region "where results are regional", provided it is one disjoint partition, fixed in the election definition before voting opens, with coarser totals derived and never opened. [[verifier]] 2.8 sets the conditions any regional design must meet: a ballot's region comes only from a membership proof against a per-region root fixed in the definition, never from a field the voter chooses or can grind or from any per-ballot value; the per-region memberships of one tier are disjoint; each cell's electorate is recomputed from the board; and no cell's electorate is below a protocol-wide floor in [[parameters]]. On 2026-10-12 the owner answered the small-cell question ([[0006-trustees]], Small cells): tiers are never merged or withheld; within a tier, regions below the floor fold into one remainder cell, decided from the registered electorate before voting opens and named in the definition; if the remainder is also below the floor, the tier isn't split.

Three things are still open, and each is one-way once an election uses it:

1. **Where a member's region comes from.** Groups today are one per tier, and nothing records a region. A passport, the Tier 2 document of [[0010-tier2-identity-provider]], carries no address.
2. **What a ballot proves.** Ballot version 1 (P1-12, `0x0002`) names its `tier`, and the verifier takes the tier's one root and scope from the definition ([[membership]], Checks). A tier split into several cells needs the ballot to name its cell, and the remainder cell, which spans several regions, needs one root, or its ballots would show which region they came from.
3. **The floor's value**, a constant of the definition version that introduces regions ([[parameters]]).

The definition, ballot and group-registry layouts this fixes are frozen by their vectors once anything under them is anchored, testnet included ([[versioning]]), and the group registry can't change once deployed ([[contracts]], Group registry).

## Options

### A. Registered region groups; each cell a union of groups with one cell tree

- **Region at registration.** The group registry fixes each group's region when it creates the group, as it fixes its tier: `createGroup(tier, region)`, with `region` a `u32` code from a published list (P5-1), 0 meaning "no stated region". The registrars add members to exactly one published group per tier and region, and refuse a commitment already live in any group of the same tier. A member's region is the region of the group they were added to, decided when they register, never when they vote. Moving region is a removal and an addition in another group of the same tier.
- **Regions are unions of groups; cells follow from them.** A definition lists, per tier, its **regions**, each naming one or more groups of that tier (in ascending `group_id`), with no group in two regions, so the creator picks the granularity the registry's groups allow (districts, or states as unions of districts). The tier's electorate is the union of its regions. The cells are then fixed by the owner's rule (The floor, below), never drawn freely.
- **One cell tree per cell.** A cell's root is the root of its **cell tree**: the depth-32 tier tree of [[membership]] (Tier tree) whose leaves are its groups' leaves concatenated in ascending `group_id` (each group's leaves as that page numbers them, removals at 0), with at most 2³² leaves in all. For a cell of one group it is exactly that group's tier tree, so version 1's tiers are the one-group case. The verifier rebuilds it from the groups' additions on the board, as 2.4 does a tier tree. Every voter in a cell proves against the same root, so a ballot in the remainder cell shows the cell, never the region within it.
- **One root block per tier.** All cells of a tier are built at one `root_l2_block`, the tier's, and every count and comparison below is taken at that block. Per-cell blocks would let a member removed from one region's group and re-added to another between the two blocks hold a live leaf in both cells, with two scopes and two nullifiers in one tier (G-2).
- **The ballot names its cell.** A ballot version 2 carries the cell's position in the partition in place of version 1's `tier`, and the verifier takes the cell's tier, root and scope from the definition. The scope keeps [[membership]]'s formula with the cell's root, `S = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(t) ‖ encode(root_c)))`, so cells have unrelated scopes. The message and the ballot hash bind the cell.
- **One leaf per commitment in a tier.** If a commitment is counted (unremoved, not forbidden) more than once across a tier's groups at the root block, only its first occurrence in (`group_id`, index) order counts; the others are leaf 0 in their cell trees and aren't counted, as a forbidden commitment isn't ([[membership]], Commitments and removals). So a repeat can neither inflate a cell past the floor nor give one secret a leaf in two cells, and, being resolved rather than failed, it can't let one registrant veto a split. No two cells share a root (a definition that has two fails 2.8). So one secret registered in a tier sits in exactly one cell and has one nullifier for the tier, and the re-vote rule ([[0011-revote-rule]]), which ranks per tier and nullifier, is unchanged. One person registered twice with two secrets is the tier's own Sybil problem, as it is today (T-01; Tier 2's per-deployment document nullifier, T-03).
- **The floor and the remainder, as the owner decided** ([[0006-trustees]], Small cells). A region's member count is its groups' counted leaves at the tier's root block (as above). Each region with at least `MIN_CELL_ELECTORATE` = 1,000 members is a cell on its own; every other region folds into one **remainder cell**; if the remainder has members but fewer than the floor, or there would be only one cell, the tier isn't split and is one cell of all its regions. A tier that isn't split has no floor, is never withheld and is flagged by 8.2 when small. The definition states the cells it derived (each region's cell, the remainder last), and the verifier recomputes them from the registered counts and fails 2.8 if they differ, so the creator's only choice is the regions, all fixed before voting opens, never from turnout or counted ballots. The fold is deterministic: no region at or above the floor is merged to rescue a split.

Pros: meets every condition of 2.8 with the circuit, keys and scope formula unchanged; a region is fixed before any election and can't be picked per ballot; the remainder hides its regions; one definition shape covers national, state and district results. Cons: a new tree construction (several groups, one tree) and a ballot version; the registry gains a field before deployment; regions are only as trustworthy as registration (below).

### B. One root per region, several roots per remainder cell

As A, but each cell lists its groups' own tier-tree roots and a ballot proves against its own group's root.

- Pros: no cell tree; every member's path is the one they already hold.
- Cons: the ballot names the root it proved against, so the remainder cell reveals each small region's turnout, exactly for the regions too small to be safe on their own, and in a region of a handful of members shows who voted (T-16, T-13). It also needs per-group scopes, and a commitment in two groups of one remainder cell would vote twice in the cell (G-2). Rejected.

### C. Region proven with each ballot

The ballot carries a second proof that the voter's credential has an attribute (a state, a district) and the verifier puts the ballot in that attribute's cell.

- Pros: no region field in the registry; a voter's region follows their current credential.
- Cons: a new statement and proof system to bind beside Semaphore's, with its own zero-knowledge analysis ([[0002-everlasting-privacy]]); Tiers 0 and 1 have no credential to prove from; the cell would come from a per-ballot proof, which 2.8 allows only if the voter can't choose among credentials, a property each credential type would have to show. Where a credential does prove residence (an ISO 18013-5 mDL's address, [[0010-tier2-identity-provider]]), it belongs at registration, choosing the group under A, not at voting. Rejected for now.

### D. No regional cells

Results stay per tier; a regional result is a separate election per region.

- Pros: no new exposure inside one election; no new layouts.
- Cons: it leaves small regions with no floor at all: a creator who wants a region of three members runs it as its own election, which no rule can stop (under A too, Consequences), and a national referendum needs one ceremony and definition per region. Within one election A at least folds small regions and hides them in a remainder; D gives up regional results to gain nothing a creator can't undo. Rejected.

## Recommendation

A. It is the only option that keeps a ballot's region out of the voter's hands at voting time, keeps the remainder's regions hidden, and needs no new proof. The cost is honest about what a region is: the registration path's word, at every tier until a credential proves residence.

The floor is 1,000 registered members. US precincts (counted in registered voters), whose results are published routinely, are of that order, so a regional cell is never finer than results voters already see; with typical turnout it holds hundreds of ballots, and smaller regions fold. 100 would allow cells where a few dozen voters, or unanimity, reveal votes; 10,000 would make most districts' results impossible in a young deployment. A larger deployment can raise it by a new definition version, never lower it in place ([[parameters]]).

What would change it: a credential with residence (mDL) at Tier 2 changes how a group is chosen at registration, not this design; a proof system that could hide the cell in the ballot would change the ballot, and is not on the horizon.

## Consequences

- **[[P1-15]] part 4b** specifies and builds it: election definition version 2 (per tier, one `root_l2_block` and its regions, each naming its groups, and the derived cells, each with its root and member count), the cell tree and per-cell scope in [[membership]] (Scope, Checks), [[verifier]] 2.4 and 5.1 to 5.3 for cells, `MIN_CELL_ELECTORATE` in [[parameters]], [[verifier]] 2.8 (its regional rule, which no longer speaks of a tier's root, the first-occurrence rule, the derived cells and the floor, which binds split tiers only) and 8.1 (per-cell results, labelled by their groups' registered regions), [[tally]]'s partition, and vectors from an independent implementation. Definition version 1 stays as it is (tiers only, one group each).
- **Ballot version 2** (P1-12, after #131 merges): the `cell` field and its admission checks (`ballot-tier` becomes `ballot-cell`; [[revoting]] ranks per tier, derived from the cell, and nullifier), with [[revoting]]'s message binding the cell. If #131's vectors haven't frozen ballot version 1 when 4b starts, the field goes into version 1 instead; [[verifier]] 2.3's `profile-combination` refuses a definition version 2 with ballot version 1. P1-12c's membership-checked intake and P1-18's direct-submit contract read the cell at a fixed offset.
- **The group registry** (P3-2) gains the region at creation, logged in `GroupCreated` and bound by every signed addition and removal (EIP-712 struct), before any registry is deployed. Anyone can create a group, so several groups may carry one region code; the registrars publish the one group per tier and region they add to, and P1-19 reports a definition naming any other. Its `GroupCreated` region is what results show; a definition's display text naming a different region is reported (P1-19).
- **Region provenance.** At Tiers 0 and 1 a member's region is what they declared when registering, unverified, and results say so (P3-6). At Tier 2 it comes only from a proven credential attribute ([[0010-tier2-identity-provider]], Nullifier uniqueness); passport-registered members sit in region 0. [[0010-tier2-identity-provider]] says a removal never frees a document nullifier; P3-4 must define a region move that keeps exactly one live addition per nullifier across the deployment's Tier 2 groups.
- **The floor counts registrations, not people.** At Tier 0 (and at Tier 1 up to its collusion bound) an attacker can pad a target's region past the floor with identities whose votes they know, isolating the target's ballot in the cell's opening. This is T-16's existing Tier 0 residual, made easier by smaller cells; it is not mitigated, and 8.2's small-count flag still applies per cell.
- **Region turnout is public**, per cell, as tier turnout is today. Folding hides it for the regions in the remainder.
- **Each commitment's declared region is public.** The group registry's events already show which tier group a commitment joined; with regions they also show its declared region, permanently, and a move (a removal and an addition) links the old region to the new one by timing. The commitment is not the person, but whoever can link a commitment to a person (the registration path, T-10) learns nothing new, and everyone else learns a region per pseudonymous member (T-13).
- **Several elections can still difference a region.** The single-partition rule binds one definition. A creator can register two definitions of the same question whose remainders differ by one small region; if voters vote the same way in both, subtracting the results estimates that region's votes. Nor does the floor stop a creator from listing one small region as a whole tier (an unsplit tier, flagged by 8.2), any more than a tiny group can be a tier today. Neither is mitigated (T-16).
- **Trustee nodes and the ballot client** run 2.8 with the floor before releasing a share or casting (P2-13, P2-8), unchanged in principle.

## Decision

Option A with `MIN_CELL_ELECTORATE` = 1,000, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto before part 4b merges costs only this ADR; after it, a new definition and ballot version.
