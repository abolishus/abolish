---
"@abolishus/verifier": minor
---

`countedSet` and `countedTally` take a rolling poll's chain with the block it is proven through (`CountedExtentInputs.rolling`, `CountedChain`), as `electionAdmission` takes the chain: given the chain the caller built from its own proven read of both registries, proven past the close and every `root_l2_block` (else undecided at 5.1), a rolling poll's counted set is decided over ballots judged against its step roots, one cell per rolling tier; without it the poll is still `unsupported-version`.
