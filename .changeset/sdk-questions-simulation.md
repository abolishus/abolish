---
"@abolishus/crypto": minor
"@abolishus/sdk": minor
---

The sdk's simulation runs polls of several questions on one ballot: a scenario with `election: "questions"` and `questions: [{ options, min, max }]` in place of `options` registers definition version 5 with ballot version 3, and each cell's report gives `questions`, each question's slice of the expected and opened counts. `Scenario.election` gains `"questions"`, `Scenario.questions` and `CellReport.questions` are new, and `selectionRange` now throws for a questions scenario; one-question scenarios run as before. `@abolishus/crypto` exports `shapeOkV3`, the shape check of a version-3 committed vote, which was already its own.
