# P0-ops-8: a ballot's cell is its own tier

- State: done when its PR merges
- Branch: `claude/p0-ops-8`

## Scope

Non-blocking finding from `crypto-review` on #34 (P0-ops-7): verifier check 2.8 doesn't tie a cell's declared tier to the ballots its rule puts there, so an author could send Tier 0 ballots to the cell labelled Tier 2 and swap the per-tier results (T-01, T-29, T-36). Fix the tiers-only rule so each ballot goes to the cell of the tier it proved, with no author-chosen mapping.

## Notes

- The tiers-only rule is now fixed by the spec (a ballot goes to the cell of the tier it proved), so no definition can relabel one tier's aggregate as another's. 2.4 now also ties each tier's root to that tier's own group additions and forbids shared roots, since labels are only as good as the tier roots. Tested: `vp check`; in-session subagent review with the `crypto-review` checklist.
