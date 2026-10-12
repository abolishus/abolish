# @abolishus/sdk

The client SDK for [Abolish](https://github.com/abolishus/abolish): the API, CLI and simulation surface for apps and agents.

Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Simulations

`parseScenario`, `planElection` and `runSimulation` run a simulated election in memory through `@abolishus/crypto`'s own code (docs/status/P1-21.md): each voter's sharing, share encryption and validity proof, each online trustee's intake, the summed shares, each tier's cell opened from the `k` lowest passing seats, and the verifier's check of every opening. The report compares each cell with the plan the scenario's seed fixes (T-29, T-54).

```ts
const parsed = parseScenario({
  voters: 10_000,
  election: "plurality",
  options: 2,
  trustees: { panel: 7, threshold: 4, offline: [3, 6] },
  tiers: { "0": 60, "1": 25, "2": 15 },
  outage: { from: 0.5, to: 1 },
  seed: 1,
});
if (parsed.ok) console.log(runSimulation(parsed.scenario).ok);
```

The seed decides only the plan; every secret comes from the CSPRNG. Every report lists in `stubs` what this part models only in outline (no registered definition, ceremony rounds, membership proofs, board, receipts, challenges, re-voting or anchoring yet). A run costs about 0.3 s per ballot at 7 seats.

## Test

```sh
vp run --filter @abolishus/sdk test
```

## License

[Apache-2.0](LICENSE).
