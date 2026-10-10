# P0-ops-5: partition and verifier follow-ups from #27

- State: done when #29 merges
- PR: #29
- Branch: `claude/p0-ops-5`

## Scope

Follow-ups from the reviews on #27 (P0-ops-4): verifier check 2.8 becomes an election check that allows a tiers-only partition until P1-15 specifies regional cells (region proven against per-region roots, never a voter-chosen, grindable or per-ballot field; recomputed cell electorates above a protocol-wide floor), with trustee nodes and the ballot client running it before releasing a share or casting; the small-tier question stays with the owner in [[0006-trustees]]; 8.1, 3.1 and 8.4 follow [[0002-everlasting-privacy]]; T-14 and T-16 record the registered partition; T-28 notes that P1-12 is blocked by the owner's questions.

## Notes

- `crypto-review` on #29 found two blocking holes in the first draft of 2.8: a partition rule reading per-ballot fields could put each ballot in its own cell (every ballot opened), and voter-chosen or ground regions plus "open every cell" gave a vote seller a receipt. 2.8 now allows tiers only until P1-15 specifies regional cells, whose region must come from a membership proof against per-region roots, with a protocol-wide floor on each cell's electorate; trustee nodes and the ballot client run 2.8 before releasing a share or casting.
- Known-weak: the protocol-wide floor in `parameters.md` and the regional-cell rules are P1-15's to write.
- Known-weak: [[0006-trustees]]'s trustee-node rule still refers to "the minimum size the election definition sets"; it must be reconciled with 2.8's protocol-wide floor when the owner answers the small-tier question.
