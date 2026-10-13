---
"@abolishus/verifier": minor
---

`@abolishus/verifier` admits the ballots of definition versions 3 and 4 (ballot version 2, which names its cell) once a format-4 bundle's key set is registered (5.1 to 5.4 and 5.7, `docs/spec/verifier.md`, Ballot admission): each is judged against the root and scope of the cell it names and `M` under that cell's tier, and the report's `ballots` lists them, with `ballot-cell` for a cell past the partition. Where these rows were `unsupported-version` they now pass or fail per entry; a rejected ballot never fails the election. 1.3 now also fails a definition pinning ballot version 2 that names a membership key other than the pinned one, and 6.2 is `unsupported-version` under these definitions wherever either pin isn't version 1. `RejectedBallot`'s code widens to the new exported `AdmissionCode`, which adds `ballot-cell`.
