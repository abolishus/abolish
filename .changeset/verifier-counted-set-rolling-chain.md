---
"@abolishus/verifier": minor
---

`countedSet` and `countedTally` take a rolling poll's chain (`CountedExtentInputs.rolling`), as `electionAdmission` does: given the chain the caller built from its own proven read of both registries, a rolling poll's counted set is decided over ballots judged against its step roots, one cell per rolling tier; without it the poll is still `unsupported-version`.
