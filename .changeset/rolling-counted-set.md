---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

`DeliveryBallotV4` takes an optional `step`: a version-5 ballot's delivery fields, which `checkDeliveryV2` (and its internal `With` form) hash with `ballotHashV5`, so a version-2 delivery record names a rolling poll's ballot by the hash that binds its step; the new `deliveryBallotHashV2` gives that hash. `checkDeliveryV2` throws `RangeError` for ballots of both versions together, and for a step beside a version-6 or fixed version-7 definition. `tallyRules` reads a rolling version-7 definition without an author panel, one cell per rolling tier, and still refuses one beside an author panel or one that isn't well-formed. In `@abolishus/verifier`, delivery (5.9) and the counted set (6.3, 7.1 to 7.3, 8.5) now run under a rolling definition without an author panel, with `cellTiers` and `partitionSize` giving one cell per rolling tier; beside an author panel they, and 7.4 under any rolling definition, stay `not-reached`.
