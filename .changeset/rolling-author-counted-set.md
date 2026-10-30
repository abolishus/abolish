---
"@abolishus/crypto": patch
"@abolishus/verifier": patch
---

`@abolishus/verifier` runs delivery (5.9), the counted set (6.3, 7.1 to 7.3, 8.5) and 7.4 under a rolling version-7 definition beside an author panel (`docs/spec/verifier.md`, Counted set and tally; Tally openings): each version-5 ballot delivered over every seat of both panels by version 5's ballot hash, which binds the step, and each rolling tier's cell tallied per panel under tally-opening version 3, with version-2 destruction statements. Before, those rows were `not-reached` beside a rolling author panel. `countedSet`, which reads delivery the same way, now gives such a poll's counted set too, where it stopped at 5.9; `countedTally` still refuses an author panel. In `@abolishus/crypto`, `checkDeliveryV2` given a rolling definition requires each ballot to name its step (and given any other, none to), and `panelTallyRules` reads a rolling definition with an author panel; every other per-election check still refuses a rolling definition.
