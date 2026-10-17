---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
"@abolishus/sdk": minor
---

`profileCombinationRule` now requires every profile to pin contract-event version 6, which archives the group registry's `Tier1MemberAdded` beside every board event (docs/spec/contracts.md, Event tables (version 6)): a profile pinning contract-event version 5 is `profile-combination` where before it fit, and `CONTRACT_EVENT_VERSIONS` is 1 to 6. The verifier reads version 6 (4.4's per-record check, ballot admission and the counted set). The sdk's simulation pins version 6.
