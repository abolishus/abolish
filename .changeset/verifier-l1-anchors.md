---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

The verifier can read an election's anchors and `now` from the board anchor's L1 state (`docs/spec/verifier.md`, Anchors from L1): a format-2 bundle (`abolish-verifier-bundle/2`) gives a block header, the `eth_getProof` trie nodes and any checkpoints no copy matches, and the report gains an `l1` member with the block's hash, number and time and the anchors read. New exports: `anchorsFromState`, `decodeHeader`, `decodeRlp`, `NodePool`, `L1Error`, `RlpError`, the slot helpers, `BUNDLE_FORMAT_L1` and the `LocalBundle` and `L1Bundle` types. `Bundle` is now their union, so code reading `bundle.now` or `bundle.anchors` must check `bundle.format` first. `@noble/hashes` is a new runtime dependency of the verifier.

`@abolishus/crypto` adds `copyCheckpoints` (the checkpoint a raw board copy gives after each segment), `encodeCheckpoint` and `decodeCheckpoint`.
