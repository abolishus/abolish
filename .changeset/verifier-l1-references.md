---
"@abolishus/verifier": minor
---

Adds bundle format 5 (`abolish-verifier-bundle/5`): format 4 with `l1Blocks`, a run of finalized L1 headers (consecutive, parent-linked, with increasing timestamps, and holding `l1.header` wherever it reaches its number). Ballot admission then judges each ballot's L1 reference (5.8) against the run before repeats (5.7), by `@abolishus/crypto`'s `l1RefMin` and `checkL1Reference`: `l1-ref-before-open`, `l1-ref-after-close` and `l1-ref-unknown` reject the entry, a reference beyond a head at or before close is pending (5.8 unverifiable with `l1-ref-pending`, listed in the report's `ballots.pending`), and a run that starts inside the window leaves 5.8 unverifiable with `l1-blocks-short`. `decodeHeader` now also returns `parentHash`, and rejects a header whose first field isn't 32 bytes. The run is a local input (`l1Blocks`), so the verdict stays unverifiable (`docs/spec/verifier.md`, L1 references).
