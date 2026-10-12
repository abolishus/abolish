---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

The verifier reads election-definition versions 3 (regional cells) and 4 (receipt keys), which it used to report as unsupported under 2.3. Each version is checked under its own well-formedness rules, and both its reported hash and the stub hash the key-ceremony check binds are computed over that version's own encoding. 2.9 passes versions 1 and 3 and stays unverifiable for version 4. `CheckCode` gains `cells` and `receipt-keys`.

`profileCombinationRule` now returns `unsupported-version` where it returned `profile-combination` in two cases, when the profile fails on no other ground: a profile that pins ballot version 2 beside a spoiled-ballot opening version this package doesn't know, and a definition version 3 or 4 that pins a ballot version it doesn't know. A later release may know those versions, so this one no longer fails an election that release could verify. In the verifier, an unsupported combination like these leaves 2.3 unverifiable and the board checks still run. A client that refuses on any result other than `undefined` behaves as before.
