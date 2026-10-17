---
"@abolishus/crypto": minor
---

Read the group registry's self-paid Tier 0 groups: `decodeSelfPaidAddition`, `encodeSelfPaidAddition` and `applySelfPaidRecords` replay a self-paid group strictly; `firstOccurrence` and `deriveTierCells` take each self-paid group's chain positions and rank signed groups first, then self-paid additions in chain order; `groupRegistryEvents` reads `SelfPaidGroupCreated` and `SelfPaidMemberAdded`, and `tierMembership` and `statedTierElectorate` replay both kinds of group.
