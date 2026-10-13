---
"@abolishus/verifier": minor
---

Adds `electionAdmission(definition, panel, entries)`: the verifier's ballot admission for one ballot at a time, as a board operator runs it before boarding. It refuses an election whose ballots the verifier can't admit (the definition's decoding, well-formedness and profile, the pinned panel, the transcript check), or returns `admit(payload)`, which strictly decodes one ballot and runs 5.1 to 5.4 with the same judge the report uses.
