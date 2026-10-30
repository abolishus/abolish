---
"@abolishus/verifier": patch
---

`@abolishus/verifier` reads a rolling version-7 definition's author panel run as it reads a fixed one's (`authorRunOf`; `docs/spec/verifier.md`, Key ceremony, step 5): 2.5's `default-seat`, the author part of 3.1 and 3.2 over version 7's author stub, and ballot admission (5.1 to 5.5, 5.7) judging each version-5 ballot's author half against the author panel's own approved key set, in `verifyBundle`'s ceremony and in `electionAdmission`. Before, under a rolling definition only the default run was read, so 3.2 could pass over an author run nobody read (no ballot was judged then). `registrationCheck` now leaves a rolling definition with an author panel unverifiable with `author-panel`, as it does a fixed one.
