---
"@abolishus/verifier": minor
---

`loadBundle` and `readBoardByCid` take an optional last argument, `registries` (default `PINNED_REGISTRIES`), the group and election registries the bundle will be verified under, as `verifyBundle` already does. A rolling poll's copy is read by CID only where its board checks run, which needs its chain built under those registries; pass the same ones to both calls. Callers that pass nothing see no change.
