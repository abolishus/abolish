---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
"@abolishus/sdk": minor
---

`profileCombinationRule` now requires every profile to pin contract-event version 7, which archives the group registry's `SelfPaidGroupCreated` and `SelfPaidMemberAdded` beside every board event and `Tier1MemberAdded` (docs/spec/contracts.md, Event tables (version 7)): a profile pinning contract-event version 6 is `profile-combination` where before it fit, and `CONTRACT_EVENT_VERSIONS` is 1 to 7. The verifier reads version 7 (4.4's per-record check, ballot admission and the counted set). The sdk's simulation pins version 7.
