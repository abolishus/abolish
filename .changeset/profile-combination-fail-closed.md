---
"@abolishus/crypto": minor
---

Adds `boardPayloadTypes(version)`, which gives the record types a board-entry version allows. `profileCombinationRule` now returns `profile-combination` when the ballot or tally-opening type is pinned twice or not at all, where before it returned `undefined`, so a client that skipped `electionDefinitionRule` still refuses. It also decides what a board-entry version carries from that version's allowed types. Results for well-formed definitions don't change.
