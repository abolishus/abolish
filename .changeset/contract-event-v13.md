---
"@abolishus/crypto": minor
---

`checkContractEvent` reads contract-event version 13 (docs/spec/contracts.md, Event tables (version 13)): version 12's tables, with the election registry's `DefinitionRegistered` decoding a version-7 definition as well as versions 1 and 3 to 6. `ContractEventVersion` gains 13, and a `DefinitionRegistered` event's `decoded` may now be an `ElectionDefinitionV7Record`, so a consumer that switches on `decoded.version` has one more case. `CONTRACT_EVENT_VERSIONS` doesn't list 13 yet: `profileCombinationRule` leaves a profile pinning it `unsupported-version` until the verifier reads it.
