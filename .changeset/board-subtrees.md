---
"@abolishus/crypto": minor
---

Adds board-tree roots and proofs from stored perfect subtrees, so a server can answer heads and proofs from O(log n) stored hashes rather than every entry hash: `appendSubtrees` (the subtrees a new leaf completes), `rootSubtrees`, `inclusionProofSubtrees` and `consistencyProofSubtrees` (which subtrees each hash folds), and `foldSubtrees`. Their results equal `merkleRoot`, `inclusionProof` and `consistencyProof` exactly.
