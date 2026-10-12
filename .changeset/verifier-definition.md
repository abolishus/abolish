---
"@abolishus/verifier": minor
---

Bundle format 3: the election identifier, the pinned board-entry version and the board anchor's address come from the election definition. The verifier decodes it strictly and checks its well-formedness (check 2.1), reports a board-entry version it can't read under 2.3, and gives the definition's hash in the report.

New exports: `BUNDLE_FORMAT_DEFINITION` and the `DefinitionBundle` type, now part of the `Bundle` union, which has no `electionId` or `boardEntryVersion` of its own: code reading them must check `bundle.format` first. `InputSource` gains `"definition"`, `InputSources` an optional `definition`, `Report` an optional `definition` (`{ hash }`), and `CheckCode` the definition's well-formedness codes and `unsupported-version`.
