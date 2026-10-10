# P0-ops-7: no merged tiers in 2.8

- State: done when its PR merges
- Branch: `claude/p0-ops-7`

## Scope

#33 (P0-ops-6) merged before its fix landed, so verifier check 2.8 on `main` says only "exactly one cell for each tier … and no other cells". That lets one cell cover two tiers, which loses the Sybil-resistant per-tier result for good (T-01, T-29, T-36). Restore "each cell is exactly one tier" alongside it.

## Notes

- 2.8 keeps both halves: each cell is one tier, and each tier has one cell. Tested: `vp check`; in-session subagent review with the `crypto-review` checklist.
