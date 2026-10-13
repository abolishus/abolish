---
"@abolishus/verifier": minor
---

Runs 6.2 on format-4 bundles wherever ballot admission runs: every spoiled-ballot opening of the election on the copy is checked by `@abolishus/crypto`'s `checkChallengeOpening` against the definition and the registered key set, and judged against the publication rules the bundle decides (`opening-early` and `opening-cast` at or below `period(closes_at) + 1`, the floor of the counted extent's last segment, and `opening-repeat`). The report gains `openings` (each opening's failed check, or its tracking code and vote, and the rules it breaks), exported as `OpeningReport` and `OpeningBreak`. 6.2 was always `not-implemented`; it now passes with no opening on the copy, fails at the first settled opening, and is otherwise unverifiable, which never changes `verdict` (`docs/spec/verifier.md`, Spoiled-ballot openings).
