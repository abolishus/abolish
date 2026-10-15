---
"@abolishus/verifier": minor
---

Reads board-entry version 5 and contract-event version 3, the versions the election registry now requires (`docs/spec/contracts.md`, Election registry, Registration, rule 9). A version-5 board is read as version 4's, its close statements left to 6.3, which stays unverifiable. Under contract-event version 3, 4.4 checks the board's two new events, ordinary ballots are found as under version 2, and a ballot relayed through L1 that passes 5.1 to 5.4 is set aside until 4.5 matches its relay call: 5.5, 5.7 and 5.8 are then unverifiable (`not-implemented`) at its entry, and selection (6.1) and the openings' `opening-cast` (6.2) aren't reached, so no stamp the verifier hasn't proven decides anything. Profiles pinning either version used to be `unsupported-version`; they now get these rows, and a profile pinning contract-event version 4 or above is `unsupported-version` instead.
