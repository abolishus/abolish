---
"@abolishus/crypto": minor
---

Adds `profileCombinationRule` and its type `ProfileCombinationRule`: 2.3's profile combination (`docs/spec/verifier.md`) as a library function, so any client can refuse an election that is bound to fail verification. It returns `profile-combination` when ballot version 1 is pinned without board-entry version 3 or 4, or tally-opening version 1 without version 4. It returns `unsupported-version` when the board-entry version isn't one this package reads, and `undefined` when the pins fit. Nothing that exists changes.
