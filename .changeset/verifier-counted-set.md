---
"@abolishus/verifier": minor
---

Adds the counted set and the tally checks (`docs/spec/verifier.md`, Counted set and tally). Once selection (6.1) passes, the verifier runs delivery (5.9) over the selected ballots, recomputes each cell's counted set and runs the tally checks (7.1 to 7.3), adds `tally-aggregate` and `tally-opening` to 7.4, and reports 8.5's destruction statements. The report gains `delivery`, `cells` and `destruction`; `CheckCode` gains 7.2's cell codes and `destruction-early` and `destruction-missing`, and `CheckAt` gains `{ cell }` and `{ seat }`, so an exhaustive `switch` over either needs new cases. Under formats 4 and 5, 5.9, 7.1 to 7.3 and 8.5 are now `not-reached` rather than `not-implemented` until 6.1 passes, and `TallyBreak` gains two variants.
