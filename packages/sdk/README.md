# @abolishus/sdk

The client SDK for [Abolish](https://github.com/abolishus/abolish): the API, CLI and simulation surface for apps and agents.

Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Simulations

`parseScenario`, `planElection` and `runSimulation` run a simulated election in memory through `@abolishus/crypto`'s own code (docs/status/P1-21.md): a well-formed election definition built from the scenario, the four signed rounds of the key ceremony with every seat, checked with its context rebuilt from the definition, then each voter's sharing and share encryption to the registered keys, the tracking code shown before the cast-or-challenge choice, a challenged attempt's opening checked by the voter's checker against the recorded code and the voter's choice (`docs/spec/challenge.md`), the cast attempt's validity proof over a fresh sharing, each online trustee's intake and the receipt's check under the seat's registered key, each ballot's L1 reference on a simulated L1 with its admission check and the re-vote rule's selection of each voter's counted ballot (`docs/spec/revoting.md`), the summed shares of the selected ballots, sent between seats in signed, sealed summed-share messages, each tier's cell opened by every honest seat from the `k` lowest passing seats, and the verifier's check of every opening. The report compares each cell with the plan the scenario's seed fixes (T-29, T-54).

```ts
const parsed = parseScenario({
  voters: 10_000,
  election: "plurality",
  options: 2,
  trustees: { panel: 7, threshold: 4, offline: [3, 6] },
  tiers: { "0": 60, "1": 25, "2": 15 },
  outage: { from: 0.5, to: 1 },
  challenges: 0.1,
  revotes: 0.05,
  seed: 1,
});
if (parsed.ok) console.log(runSimulation(parsed.scenario).ok);
```

The seed decides only the plan; every secret comes from the CSPRNG. Every report lists in `stubs` what this part models only in outline (placeholder contracts, chains and tier roots, an unpinned panel, the verifier's opening check (6.2) not yet run over published openings, a simulated L1 on which every ballot is admitted and every voter's last ballot selected, and no membership proofs or anchoring yet). `challenges` is the share of voters who challenge one attempt before casting a fresh one (0 when absent); the seed draws them apart from the rest of the plan, so changing the share changes no voter's tier, votes or time. `revotes` is the share of voters who cast an earlier ballot, at a time drawn before their last, then re-vote (0 when absent): each ballot names the newest L1 block 2 deep at its time, or, if that isn't newer than the voter's last, the next block once it settles, and only the last ballot counts. A positive share counts two ballots per voter against the work bound. `publications` is the share of challengers who ask, once the counted extent has ended, for their challenged attempt's opening to be published (0 when absent; `docs/spec/challenge.md`, Publication): the operator boards each only if it passes the opening checks, falls in the openings' window, opens no counted ballot's commitment and repeats no core, sorted at the end of its period. Since each opening is compared with every counted ballot, a scenario that can publish keeps `voters × ballots × options` within `MAX_SIMULATED_OPENING_LOOKUPS`. Offline seats take part in the ceremony and are down from the opening on. A run costs about 0.3 s per ballot at 7 seats.

## Test

```sh
vp run --filter @abolishus/sdk test
```

## License

[Apache-2.0](LICENSE).
