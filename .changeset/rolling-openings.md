---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

`checkChallengeOpeningV3` (and its internal `With` form) takes a `rollingBallotElection` context as well as a `panelBallotElection` one, so a version-3 opening of ballot version 5's cores is checked under a rolling definition; a passing opening's `coreHash` is the core hash of the ballot version its context checks, `coreHashV5` under a rolling definition, never version 4's. `openingV3CoreHash` takes an optional `ballotVersion`, 4 (the default) or 5, and throws `RangeError` for any other. In `@abolishus/verifier`, 6.2 now runs under a rolling definition wherever admission runs, against the context made from the same chain; without the chain it stays `not-reached`. Delivery, the counted set, the tally openings and a live rolling poll's releases aren't reached yet.
