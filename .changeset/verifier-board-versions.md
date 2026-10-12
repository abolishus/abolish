---
"@abolishus/verifier": minor
---

Reads board-entry versions 3 and 4 when a format-3 or format-4 bundle's definition pins them, and adds 2.3's `profile-combination` check code (`docs/spec/verifier.md`, Definition). A definition that pins ballot version 1 without board-entry version 3 or 4, or tally-opening version 1 without version 4, now fails 2.3. The board and ceremony checks still run, so for such bundles `verdictAgainstInputs` becomes `failed`; before, it was `unverifiable` unless a board check had already failed. `verdict` is unchanged, because local inputs never verify or fail an election. Any other board-entry version is still `unsupported-version`.
