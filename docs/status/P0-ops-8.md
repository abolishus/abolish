# P0-ops-8: a ballot's cell is its own tier

- State: done when its PR merges
- Branch: `claude/p0-ops-8`

## Scope

Non-blocking finding from `crypto-review` on #34 (P0-ops-7): verifier check 2.8 doesn't tie a cell's declared tier to the ballots its rule puts there, so an author could send Tier 0 ballots to the cell labelled Tier 2 and swap the per-tier results (T-01, T-29, T-36). Fix the tiers-only rule so each ballot goes to the cell of the tier it proved, with no author-chosen mapping.

## Notes

- The tiers-only rule is now fixed by the spec (a ballot goes to the cell of the tier it proved), so no definition can relabel one tier's aggregate as another's. 2.4 now also ties each tier's root to that tier's own group additions, since labels are only as good as the tier roots, and asks P1-17 to domain-separate roots by tier so identical memberships can't give two tiers the same root (a first draft failed such elections outright; `claude-review` on #36 caught it). T-01 records the change. `crypto-review` on #36 found that the first wording over-specified P1-17 (tier-separated roots inside the circuit) in a way that conflicted with ADR 0002's Groth16 fallback. The final 2.4/2.8/5.3 state the property instead: the proof's public inputs fix the tier, additions count toward a tier only through an authorisation that binds it, and P1-17's status file carries the requirement with the ADR and fallback constraints. Tested: `vp check`; in-session subagent review with the `crypto-review` checklist.
