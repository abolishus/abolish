---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

`profileCombinationRule` now requires every profile to pin a board-entry version that allows the close statement (5) and contract-event version 3, which archives the close rule's board events (docs/spec/close.md, Version): a profile pinning board-entry version 1, 3 or 4, or contract-event version 1 or 2, is `profile-combination`, as is one pinning the contract-event type twice or not at all, and one pinning a contract-event version this package doesn't read is `unsupported-version` when it fails on no other ground. The verifier's 2.3 and `electionAdmission` follow it, so they fail or refuse such profiles where before they passed them.
