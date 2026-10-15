---
"@abolishus/sdk": minor
---

`runSimulation` publishes each period's segment object and entry-hash list to a simulated IPFS store before its checkpoint is anchored, and after the verifier's read wipes the operator's copy of the board and rebuilds every result from chain and IPFS alone with the new `rebuildElection`, throwing on any difference. The report gains `rebuild` (the objects fetched and the entries they held), the options gain `onPublicRecord`, and `SimulatedElectionRegistry` and `SimulatedTrusteeRegistry` gain `definitionOf` and `panelOf`.
