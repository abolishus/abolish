---
"@abolishus/crypto": minor
---

`readObject` reads an object of known length by its CID from untrusted sources block by block (docs/spec/content-addressing.md, Reading by CID): it walks only the canonical DAG for that length, checks each block against its CID, and returns the bytes, `unavailable` (no source served some block) or `inconsistent` (blocks that hash but don't form the canonical object). Breaking: `DeliveryRoots.leafObjects(cid)` is replaced by `leafBlocks(cid, limit)`, which returns each source's answer for one block; `checkDelivery` reads an available root's leaf object with `readObject`, so a non-canonical DAG of its leaves is now the seat's `root-inconsistent` rather than unverifiable.
