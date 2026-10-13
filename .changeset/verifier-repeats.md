---
"@abolishus/verifier": minor
---

Ballot admission finds repeats (5.7): admitted ballots with the same tier, nullifier and recomputed membership message, whatever their proof bytes. Until the close rule (5.5) runs, 5.7 passes only when there is none, and the report's `ballots.repeats` lists each candidate.
