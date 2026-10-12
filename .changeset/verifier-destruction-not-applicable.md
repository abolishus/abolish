---
"@abolishus/verifier": minor
---

Check 8.5 (destruction statements, report-only) is now `unverifiable` with the new code `not-applicable` when the pinned board-entry version can't carry a destruction statement, which means versions 1 and 3; before, it was `not-implemented`. Verdicts don't change, because 8.5 is report-only. 2.3's profile combination now comes from `@abolishus/crypto`'s `profileCombinationRule`, with the same results.
