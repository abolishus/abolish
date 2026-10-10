# P0-ops-6: one cell per electorate tier

- State: in progress
- Branch: `claude/p0-ops-6`

## Scope

Non-blocking finding from `crypto-review` on #29 (P0-ops-5): verifier check 2.8 constrains each cell but not the set of cells, so a tiers-only partition could repeat or omit a tier of the electorate. 2.8 should require exactly one cell per electorate tier.
