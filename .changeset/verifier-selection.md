---
"@abolishus/verifier": minor
---

Adds re-vote selection (6.1) for bundle format 5: `@abolishus/crypto`'s `selectBallots` over the ballots every admission check admitted from the anchored extent, decided only once that set is fixed. 6.1 stays unverifiable until every admission row (5.1 to 5.5, 5.7, 5.8) has passed or failed, 4.1 and 4.2 pass (`not-reached`), the seal's window has closed (`not-sealed`, a new check code), no ordinary-path ballot waits on 4.4 (`not-reached` at its entry), and no admitted ballot is above the floor of `s_S` (`not-implemented` at its entry). Once it passes, the report's `ballots` gains `selected` and `ties`, each in copy order with `entry`. Where the definition stops the board checks, 6.1 is `not-reached` beside 5.8 (`docs/spec/verifier.md`, Selection).
