---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
"@abolishus/sdk": minor
---

`profileCombinationRule` now requires every profile to pin contract-event version 5, which archives the board's obligation-root event beside every other (docs/spec/contracts.md, Event tables (version 5)): a profile pinning contract-event version 4 is `profile-combination` where before it fit, and `CONTRACT_EVENT_VERSIONS` is 1 to 5. The verifier reads version 5; an `ObligationRootSubmitted` naming the election leaves 5.9 and the tally unverifiable (`not-implemented`) at its entry until roots are read, and one naming another definition is reported `delivery-stray`. The sdk's simulation pins version 5.
