---
"@abolishus/crypto": patch
---

`@abolishus/crypto` adds `ROOT_FINALITY` (2,400 seconds) to `PARAMETERS` and `rootStepFinal(step, l1Timestamp)`: a live rolling poll's running sets read step `n` as final at an L1 head whose timestamp is at least `τ_n + ROOT_FINALITY` (`docs/spec/membership.md`, Root clock and steps; `docs/spec/tally.md`, Running set), by the clock and the head alone, since a bundle's L1 headers don't show the L2's derivation.
