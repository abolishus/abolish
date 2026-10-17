---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
"@abolishus/sdk": minor
---

`profileCombinationRule` now requires every profile to pin contract-event version 8, which archives the board's `AvailabilityAttestationSubmitted` and `AvailabilityComplaintSubmitted` beside every other board and group-registry event (docs/spec/contracts.md, Event tables (version 8)): a profile pinning contract-event version 7 is `profile-combination` where before it fit, and `CONTRACT_EVENT_VERSIONS` is 1 to 8. The verifier reads version 8 (4.4's per-record check, ballot admission and the counted set). The sdk's simulation pins version 8.
