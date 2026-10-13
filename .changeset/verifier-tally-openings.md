---
"@abolishus/crypto": minor
"@abolishus/verifier": minor
---

`@abolishus/crypto` adds `sortTallyOpenings` and the `SortedTallyOpening` type: every tally-opening payload decoded under the pinned version, sorted into an opening of a cell or a stray opening and attributed by the registered signing keys, without the counted set. `checkTally` now sorts through it; its results are unchanged.

`@abolishus/verifier` reads the tally openings of a format-4 bundle once its key set is registered (7.4, `docs/spec/verifier.md`, Tally openings): the report gains `tallies`, each opening's cell or stray, its attributed seat and the boarding-rule breaches decided without the counted set (`tally-stray`, `tally-missing`, `tally-unattributed`, `tally-second`, `tally-repeat`), and 7.4 fails on a settled breach, is unverifiable while any opening is undecided, and passes with none. 7.4 is report-only, so no verdict changes. A consumer that compares a report's members exactly sees the new `tallies` member.
