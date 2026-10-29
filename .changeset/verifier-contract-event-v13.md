---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

The verifier reads contract-event version 13 (docs/spec/contracts.md, Event tables (version 13)) wherever it reads version 12: 4.4's event check, ballot admission's contract paths, delivery, 3.1's author registrations, the electorate recount and 4.6. `CONTRACT_EVENT_VERSIONS` lists 13, so `profileCombinationRule` judges a profile pinning it, which fits wherever version 12 does, and a version-7 definition pinning contract-event version 8 to 12 now fails 2.3 (`profile-combination`) under either electorate mode, since none of them reads its own registration (docs/spec/verifier.md, 2.3).
