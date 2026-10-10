# P0-ops-8: a ballot's cell is its own tier

- State: in progress
- Branch: `claude/p0-ops-8`

## Scope

Non-blocking finding from `crypto-review` on #34 (P0-ops-7): verifier check 2.8 doesn't tie a cell's declared tier to the ballots its rule puts there, so an author could send Tier 0 ballots to the cell labelled Tier 2 and swap the per-tier results (T-01, T-29, T-36). Fix the tiers-only rule so each ballot goes to the cell of the tier it proved, with no author-chosen mapping.
