---
"@abolishus/sdk": minor
---

The simulated election pins board-entry version 5 and contract-event version 3, and `SimulatedElectionRegistry` refuses a definition whose profile pins other ballot, opening, board-entry, contract-event or display-text versions than the deployment serves for definition version 4 (`ProfileNotServed`, after `CeremonyNotRecorded`), as the election registry does (`docs/spec/contracts.md`, Registration, rule 9). `DefinitionRefusal` gains `"ProfileNotServed"`, so an exhaustive `switch` over it needs a new case.
