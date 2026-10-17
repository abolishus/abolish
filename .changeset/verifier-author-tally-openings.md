---
"@abolishus/verifier": minor
---

Beside an author panel (definition version 6, tally-opening version 3), 7.4 now reads the partial openings: each sorted by its panel byte and attributed only by that panel's registered key set, with `tally-second` and `tally-repeat` per cell, panel and seat and a new break, `tally-early`, for a default partial opening boarded before every cell had a passing author one; `tallies` entries gain `panel`. 8.5 reads destruction-statement version 2 for every seat of both panels: `destruction.seats`, `duplicates` and `stray` gain `panel`, and the row's `at` gives `panel` and `seat`. A profile pinning tally-opening version 1 beside an author panel now reports 7.4 `unsupported-version` instead of `not-reached`.
