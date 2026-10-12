---
"@abolishus/crypto": minor
---

Adds the trustees' destruction statement (`docs/spec/tally.md`, Destruction): record type `0x000f` (`RECORD_TYPES.destructionStatement`), `encodeDestructionStatement`, `decodeDestructionStatement`, `signDestructionStatement`, `destructionStatementMessage`, `destructionSegment`, `checkDestruction`, the `DESTRUCTION_STATEMENT` codec and their types, `PARAMETERS.DESTRUCTION_WINDOW`, and the `abolish/v1/sig/destruction` tag in the registry. Also adds board-entry version 4 (`BOARD_PAYLOAD_TYPES_V4`), which is version 3's set plus the statement. `BoardEntryVersion` now includes 4, so an exhaustive `switch` over it needs a new case. Nothing else that exists changes.
