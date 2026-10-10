# P0-ops-6: one cell per electorate tier

- State: done when its PR merges
- Branch: `claude/p0-ops-6`

## Scope

Non-blocking finding from `crypto-review` on #29 (P0-ops-5): verifier check 2.8 constrains each cell but not the set of cells, so a tiers-only partition could repeat or omit a tier of the electorate. 2.8 should require exactly one cell per electorate tier.

## Notes

- 2.8 now says the tiers-only partition has exactly one cell per electorate tier and no others. A repeated tier could double-count its ballots in 7.1's derived totals, and an omitted tier could drop them (T-29, T-36).
- Tested: `vp check`.
