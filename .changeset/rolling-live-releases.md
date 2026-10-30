---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

`@abolishus/crypto` adds `stepMembershipV5`: a version-5 ballot's membership check (verifier 5.1 to 5.3) alone, with its step, whatever its other admission checks find, failing for a step the poll doesn't accept or a supplied root other than the step's, as live results' running sets read it (`docs/spec/tally.md`, Running set, condition 1). `@abolishus/verifier` reads a live rolling poll's releases: 7.5 and 7.6 run under a live rolling definition once 7.1 passes, each version-5 copy pending while its step isn't final at a snapshot's head (`docs/spec/verifier.md`, Releases, step 3), and each ballot receipted only under its version-5 hash, which binds the step.
