# P0-ops-5: partition and verifier follow-ups from #27

- State: in progress
- Branch: `claude/p0-ops-5`

## Scope

Non-blocking findings from `crypto-review` and `claude-review` on #27 (P0-ops-4): verifier check 2.8 joins the election checks and pins down the partition (cells within one tier, a total rule over bound fields, unplaceable ballots rejected at admission, proven region membership); the minimum-cell-size question is recorded as open for P1-15 with the owner's [[0006-trustees]]; 8.1 reports a regional cell's real anonymity set; the remaining ElGamal wording in 3.1 and 8.4 follows [[0002-everlasting-privacy]]; T-14 and T-16 record the registered partition; T-28 notes that P1-12 is blocked by the owner's questions.

## Notes

- `crypto-review` on #29 found two blocking holes in the first draft of 2.8: a partition rule reading per-ballot fields could put each ballot in its own cell (every ballot opened), and voter-chosen or ground regions plus "open every cell" gave a vote seller a receipt. 2.8 now allows tiers only until P1-15 specifies regional cells, whose region must come from a membership proof against per-region roots, with a protocol-wide floor on each cell's electorate; trustee nodes and the ballot client run 2.8 before releasing a share or casting.
- Known-weak: the protocol-wide floor in `parameters.md` and the regional-cell rules are P1-15's to write.
