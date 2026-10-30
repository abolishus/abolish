---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

`profileCombinationRule` takes an optional third argument, `readsRolling`: a caller that judges a rolling poll's ballots against step roots from its chain passes a rolling profile that fits instead of getting `unsupported-version`. Every other verdict, and every existing call, is unchanged.

`@abolishus/verifier` adds `rollingChain`, a rolling poll's chain (the group registry's events through close and the definition's registration time) from the registries' records, given only where 2.4's rolling recount passes and the definition's registration is found; `rollingElectorate`, the recount with the events it replayed; and `definitionRegistration`, the registration check's steps 1 to 3 over the election registry alone, which returns the matched record. `readElection` and `electionAdmission` take an optional rolling chain as a fifth argument and, given one, admit a rolling poll's ballots by 5.1 to 5.4 against its step roots; an admitted version-5 ballot's `BallotAdmission` carries its `step`. Without a chain a rolling poll is refused `unsupported-version`, as before. `verifyBundle` still stops a rolling poll at 2.3.
