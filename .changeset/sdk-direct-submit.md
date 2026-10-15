---
"@abolishus/sdk": minor
---

`runSimulation` sends a ballot cast while the servers are down to a simulated board contract, the new `SimulatedBoardContract`, with each seat's share receipt through its contract path, and every posting with the ballot it delivers; the operator boards each event as a contract-event record once the servers are up, and the delivery check reads them by their L2 time. `rebuildElection` reads them from the board and replays them against the contract's event accumulator (`events-incomplete` otherwise), and `PublicRecord` takes `board` in place of `postings`. The report's `board` gains `contractEvents`, and `SimulatedElectionRegistry` gains `parametersOf`.
