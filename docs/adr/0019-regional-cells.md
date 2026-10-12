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

- **Region at registration.** The group registry fixes each group's region when it creates the group, as it fixes its tier: `createGroup(tier, region)`, with `region` a `u32` code from a published list (P5-1), 0 meaning "no stated region". A member's region is the region of the group they were added to, decided when they register, never when they vote. Moving region is a removal and an addition in another group of the same tier.
- **Cells are unions of groups.** A definition lists, per tier, its cells; each cell names one or more groups of that tier (in ascending `group_id`), no group is in two cells, and a tier's electorate is the union of its cells. An unsplit tier is one cell, which may name several groups. So the creator can draw cells at any granularity the registry's groups allow (districts, or states as unions of districts), and the remainder cell is simply a cell naming several small regions' groups.
- **One cell tree per cell.** A cell's root is the root of its **cell tree**: the depth-32 tier tree of [[membership]] (Tier tree) whose leaves are its groups' leaves concatenated in the listed order (each group's leaves as that page numbers them, removals at 0), with at most 2³² leaves in all. For a cell of one group it is exactly that group's tier tree, so version 1's tiers are the one-group case. The verifier rebuilds it from the groups' additions on the board, as 2.4 does a tier tree. Every voter in a cell proves against the same root, so a ballot in the remainder cell shows the cell, never the region within it.
- **The ballot names its cell.** A ballot version 2 carries the cell's position in the partition in place of version 1's `tier`, and the verifier takes the cell's tier, root and scope from the definition. The scope keeps [[membership]]'s formula with the cell's root, `S = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(t) ‖ encode(root_c)))`, so cells have unrelated scopes. The message and the ballot hash bind the cell.
- **Disjointness.** No commitment counted (unremoved, not forbidden) in one cell of a tier at its root block is counted in another cell of that tier, and no two cells share a root; a definition that breaks either fails 2.8 (`cell-overlap`). So one secret registered once in a tier sits in exactly one cell, has one nullifier for the tier, and the re-vote rule ([[0011-revote-rule]]), which ranks per tier and nullifier, is unchanged. One person registered twice with two secrets is the tier's own Sybil problem, as it is today (T-01; Tier 2's per-deployment document nullifier, T-03).
- **The floor.** In a tier with two or more cells, every cell's member count (the cell tree's counted, unremoved additions at its root block, as 2.4 counts them) is at least `MIN_CELL_ELECTORATE` = 1,000; a tier with one cell has no floor and is flagged by 8.2 when small. The creator applies the owner's rule from the registered counts: regions at or above the floor may be cells on their own, the rest fold into a remainder cell, and if that cell would be below the floor the tier isn't split (or the creator merges more). The verifier checks only the outcome (every cell of a split tier at or above the floor), so it never depends on which grouping the creator preferred.

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
- Cons: it moves the small-region problem outside the floor rather than removing it: a creator who wants a region of three members runs it as its own election, which no rule can stop, and a national referendum needs one ceremony and definition per region. Rejected.

## Recommendation

A. It is the only option that keeps a ballot's region out of the voter's hands at voting time, keeps the remainder's regions hidden, and needs no new proof. The cost is honest about what a region is: the registration path's word, at every tier until a credential proves residence.

The floor is 1,000 registered members. US precincts, whose results are published routinely, are of that order, so a regional cell is never finer than results voters already see; with typical turnout it holds hundreds of ballots, and smaller regions fold. 100 would allow cells where a few dozen voters, or unanimity, reveal votes; 10,000 would make most districts' results impossible in a young deployment. A larger deployment can raise it by a new definition version, never lower it in place ([[parameters]]).

What would change it: a credential with residence (mDL) at Tier 2 changes how a group is chosen at registration, not this design; a proof system that could hide the cell in the ballot would change the ballot, and is not on the horizon.

## Consequences

- **[[P1-15]] part 4b** specifies and builds it: election definition version 2 (cells per tier, each with its groups, root, member count and `root_l2_block`), the cell tree in [[membership]], `MIN_CELL_ELECTORATE` in [[parameters]], [[verifier]] 2.8 (its regional rule, `cell-overlap` and the floor) and 8.1 (per-cell results, labelled by their groups' registered regions), [[tally]]'s partition, and vectors from an independent implementation. Definition version 1 stays as it is (tiers only, one group each).
- **Ballot version 2** (P1-12, after #131 merges): the `cell` field and its admission checks, with [[revoting]]'s message binding the cell; [[verifier]] 2.3's `profile-combination` refuses a definition version 2 with ballot version 1. P1-12c's membership-checked intake and P1-18's direct-submit contract read the cell at a fixed offset.
- **The group registry** (P3-2) gains the region at creation, logged in `GroupCreated` and bound by every signed addition and removal (EIP-712 struct), before any registry is deployed. Its `GroupCreated` region is what results show; a definition's display text naming a different region is reported (P1-19).
- **Region provenance.** At Tiers 0 and 1 a member's region is what they declared when registering, unverified, and results say so (P3-6). At Tier 2 it comes only from a proven credential attribute; passport-registered members sit in region 0. [[0010-tier2-identity-provider]] says a removal never frees a document nullifier; P3-4 must define a region move that keeps exactly one live addition per nullifier across the deployment's Tier 2 groups.
- **The floor counts registrations, not people.** At Tier 0 (and at Tier 1 up to its collusion bound) an attacker can pad a target's region past the floor with identities whose votes they know, isolating the target's ballot in the cell's opening. This is T-16's existing Tier 0 residual, made easier by smaller cells; it is not mitigated, and 8.2's small-count flag still applies per cell.
- **Region turnout is public**, per cell, as tier turnout is today. Folding hides it for the regions in the remainder.
- **Trustee nodes and the ballot client** run 2.8 with the floor before releasing a share or casting (P2-13, P2-8), unchanged in principle.

## Decision

Option A with `MIN_CELL_ELECTORATE` = 1,000, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto before part 4b merges costs only this ADR; after it, a new definition and ballot version.
