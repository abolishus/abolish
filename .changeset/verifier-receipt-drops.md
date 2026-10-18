---
"@abolishus/verifier": minor
---

Judges whether a receipt's ballot was dropped (docs/spec/receipts.md, Drops): `judgeDrop(bundle, receipt, payload, verdict)` takes a receipt, the payload it covers and the verdict `judgeReceipt` reached, and returns a `DropOutcome`: `drop`, `not-drop` with a `NotDropCode` (`not-alarm`, `present` with the entry carrying the ballot, or the payload's own admission, close-rule or L1-reference code), or `unjudged` with a `DropUnjudgedCode` until the payload's L1 reference and a sealed, authenticated board that selection (6.1) passed over are available.
