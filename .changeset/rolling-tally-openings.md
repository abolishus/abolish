---
"@abolishus/verifier": minor
---

7.4 now sorts and attributes a rolling poll's tally openings without an author panel: `tallyChecks` reads one cell per rolling tier, in `rolling_electorate` order, an opening naming any other cell is stray, and once the counted set is known each opening's `tally-aggregate` and `tally-opening` breaks settle it, as under a fixed poll. Beside an author panel a rolling poll's 7.4 stays `not-reached`, whatever key sets or counted set a caller passes.
