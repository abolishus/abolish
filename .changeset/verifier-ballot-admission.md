---
"@abolishus/verifier": minor
---

Runs ballot admission (5.1 to 5.4) on format-4 bundles once 3.2 passes: every ballot record of the election on the copy is checked by `@abolishus/crypto`'s `checkBallot` against the definition and the registered key set, and the report gains `ballots` (`admitted` and every rejected entry with its code). Each admission row fails at its first rejected entry, which rejects that entry only and never changes the verdict. A format-3 or format-4 definition naming a membership key other than the pinned one now fails 1.3 (`membership-key`), so `verdictAgainstInputs` becomes `failed` for such bundles; `verdict` is unchanged, because local inputs never verify or fail an election (`docs/spec/verifier.md`, Ballot admission).
