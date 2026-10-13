---
"@abolishus/verifier": minor
---

`@abolishus/verifier` reads the tally openings of definition versions 3 and 4 once a format-4 bundle's key set is registered (7.4, `docs/spec/verifier.md`, Tally openings): each is sorted into a cell of the partition the definition states (every tier's cells, numbered across the tiers) or stray, attributed by the registered signing keys, and judged against the boarding rule as under version 1, and the report's `tallies` lists them. Where 7.4 was `not-implemented` under these definitions it now passes, fails or stays `not-implemented` per the openings on the copy; it never fails the election.
