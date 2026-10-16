# @abolishus/sdk

The client SDK for [Abolish](https://github.com/abolishus/abolish): the API, CLI and simulation surface for apps and agents.

Prereleases are published as `next`, signed and with provenance (see the repository README, "Releases").

## Simulations

`parseScenario`, `planElection` and `runSimulation` run a simulated election in memory through `@abolishus/crypto`'s own code (docs/status/P1-21.md): a well-formed version-4 election definition built from the scenario, each tier one cell, listing the board operator's receipt key, which the anchoring authority registers in the anchor's receipt-key record a day before opening (`docs/spec/election-definition.md`, Receipt keys), the four signed rounds of the key ceremony with every seat, checked with its context rebuilt from the definition, then each voter's client checking that record before casting, each voter's sharing and share encryption to the registered keys, its ballot (version 2) naming its tier's cell, the tracking code shown before the cast-or-challenge choice, a challenged attempt's opening checked by the voter's checker against the recorded code and the voter's choice (`docs/spec/challenge.md`), the cast attempt's validity proof over a fresh sharing, each online trustee's intake and the receipt's check under the seat's registered key, each online seat's share receipt on the board, a ballot cast while the servers are down submitted instead to a simulated board contract (`docs/spec/contracts.md`, Board (direct submit)) with each seat's share receipt, and every posting sent to that contract with the ballot it delivers, each record the contract accepts an event under its event accumulator that the operator boards as a contract-event record once the servers are up, each ballot's L1 reference on a simulated L1 with its admission check and the re-vote rule's selection of each voter's counted ballot (`docs/spec/revoting.md`), the delivery check that keeps only ballots every qualified seat receipted or the voter posted (`docs/spec/delivery.md`), the summed shares of the counted ballots, sent between seats in signed, sealed summed-share messages, each tier's cell opened by every honest seat from the `k` lowest passing seats, and the verifier's check of every opening. An anchoring authority anchors the checkpoint of every period that added entries, and the seal's, in the first simulated L1 block after the period ends (`docs/spec/board.md`, Anchoring), and three reads of the board run the board checks over the anchors in blocks up to the reader's finalized L1 time: the trustees' read of the counted extent, a node's of the tally openings before it destroys, and the verifier's 4.1 and 4.2 over the whole board once the seal's window has closed. The report lists every anchor (`board.anchors`) and the seal (`board.seal`). The ceremony transcript is the board's first entry. Once the seal's window has closed, the closed election is handed to `@abolishus/verifier` as a format-4 bundle (`docs/spec/verifier.md`, Bundle): the definition, the clock, the panel, the board copy, and the board anchor's storage in a simulated L1 state, so the verifier reads every anchor, the receipt key's record and `now` from Merkle–Patricia proofs under a simulated header (the trie is checked against ethereum/tests' secure-trie vectors). Its report must pass 2.9 (the listed key registered before `opens_at`, read from that state), 3.2 (registering every seat from the board's first entry), 4.1, 4.2, 5.4, 5.5 and 5.7, reject every ballot for its placeholder membership proof (5.1 to 5.3), report every published and tally opening without a break (6.2, 7.4) and fail nothing else; any other result throws. Three of those passes check little yet: admission stops at the membership proof, so 5.4 covers only a ballot's shape and qualified share hashes, and 5.5 and 5.7 see no admitted ballot. The report's `verifier` gives its verdicts, the rows it passed and failed and the ballots it rejected, and the `onBundle` option hands the caller the bundle's two files before the verifier judges them. Before each checkpoint is anchored, the operator publishes its period's segment object and entry-hash list to a simulated IPFS store under the CIDs the checkpoint names (`docs/spec/board.md`, Segment objects). After the verifier's read, the operator's copy of the board and everything derived from it are wiped, and `rebuildElection` rebuilds every result from the public record alone (AGENTS.md, Reference election, stage 8): the definition, panel and recorded key set from the simulated L2 registries, the anchors and L1 blocks, the board contract's event accumulator, which the board's contract-event records must replay to, so none is left off, and the board fetched by CID and split with `@abolishus/crypto`'s `splitSegmentObject`, then authenticated by `verifyBoard`, the ceremony transcript checked again and the counted set, tally, destruction and published openings read from it. Any result other than the run's throws; the report's `rebuild` gives the objects fetched and the entries they held, and the `onPublicRecord` option hands the caller that record. The report compares each cell with the plan the scenario's seed fixes (T-23, T-24, T-29, T-37, T-49, T-51, T-54).

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
  postings: 0.9,
  seed: 1,
});
if (parsed.ok) console.log((await runSimulation(parsed.scenario, { workers: 3 })).ok);
```

The seed decides only the plan; every secret comes from the CSPRNG. Every report lists in `stubs` what this part models only in outline (placeholder contracts, chains and tier roots, an unpinned panel, a simulated L1 on which every ballot is admitted and every voter's last ballot selected, anchors held in memory during the election and proven from a simulated L1 state only for the verifier's final read, and no membership proofs yet). `challenges` is the share of voters who challenge one attempt before casting a fresh one (0 when absent); the seed draws them apart from the rest of the plan, so changing the share changes no voter's tier, votes or time. `revotes` is the share of voters who cast an earlier ballot, at a time drawn before their last, then re-vote (0 when absent): each ballot names the newest L1 block 2 deep at its time, or, if that isn't newer than the voter's last, the next block once it settles, and only the last ballot counts. A positive share counts two ballots per voter against the work bound. `publications` is the share of challengers who ask, once the counted extent has ended, for their challenged attempt's opening to be published (0 when absent; `docs/spec/challenge.md`, Publication): the operator boards each only if it passes the opening checks, falls in the openings' window, opens no counted ballot's commitment and repeats no core, sorted at the end of its period. Since each opening is compared with every counted ballot, a scenario that can publish keeps `voters × ballots × options` within `MAX_SIMULATED_OPENING_LOOKUPS`. Offline seats take part in the ceremony and are down from the opening on, so a ballot counts only if its voter posts each offline seat's share publicly, which lowers that share's long-term privacy (with `threshold` or more seats down at its cast, offline or departed, a posting voter's ballot is readable whole to anyone who later breaks the shares' classical encryption): `postings` is the share of voters who choose to (0 when absent; `docs/spec/delivery.md`, Client rules), and every other voter's ballot is undelivered and counts nothing, as the plan expects. With no offline seat nobody posts. `trustees.departures` lists seats that go down partway, each `{ seat, at }` with `at` a share of the voting period in `(0, 1]`, ascending by seat and neither offline nor faulty: a departing seat takes every ballot cast before `at`, its receipts boarded with them, and none from then on, so a ballot cast later counts only if its voter posts it as well; it takes no part in the tally or destruction, so a departure at `1` takes every ballot and only shrinks the tally's seats. A run costs about 0.3 s to 0.8 s per ballot at 7 seats in one thread, most of it each seat's intake. `runSimulation` returns a promise; its `workers` option (0 to `MAX_INTAKE_WORKERS`, default 0) runs that intake in as many worker threads, each holding every seat's intake keys for the run, while the calling thread makes each voter's ballot and boards, checks and counts in cast order, so the report doesn't depend on it: on 4 cores, 3 workers about halve a run's time. The packed worker is `dist/intake-worker.mjs`, loaded by its path beside `dist/index.mjs`, so `workers` needs the sdk loaded from its own `dist`, never bundled into another file.

## Direct submit

`directSubmitBallot` sends a cast ballot record straight to the election's board contract on L2 through the voter's own wallet, for when our servers refuse it or can't be reached (`docs/spec/contracts.md`, Board (direct submit); T-25). It takes any EIP-1193 provider and holds no key. One call is one attempt: it checks the wallet is on the definition's `l2_chain_id` (and names that chain in the transaction), asks the board with `eth_call` first and returns the board's own refusal decoded to the spec's codes (`decodeBoardBallotRevert`: `malformed` with its decode error and offset, `refused` with its admission code, `window`, `gas`), so nothing the board refuses is sent; finds a byte-identical copy the board already holds, through either path (the relay's deposit included), since a repeat is a silent no-op on chain, rather than resending; and otherwise sends `submitBallot` in its one canonical encoding (`submitBallotCalldata`) with a quarter more gas than the estimate, then reports where the board's event is. The record's hashes are `@abolishus/crypto`'s `frameBallot`'s, never the caller's. Its answers are only what the provider's node reports: a client MUST NOT stand down on an acceptance (`docs/spec/delivery.md`, Client rules), and should confirm a refusal through a node it chose. The paying account is public and linked to the ballot on chain, and the wallet's RPC sees it with the record and the voter's network address, so the account should be fresh and privately funded (T-25, Residual; T-11).

```ts
const result = await directSubmitBallot({
  provider: window.ethereum,
  chainId: definition.l2_chain_id,
  board: definition.board,
  from: account,
  record,
  fromBlock: registrationBlock,
});
if (result.status === "refused") console.log(result.refusal);
```

### Forced through L1

`relayBallot` forces the same record through the L1 relay with the voter's own L1 wallet, for when the sequencer censors the direct submission (`docs/spec/contracts.md`, L1 relay; T-50). The relay records the call with its L1 block and timestamp, the stamp the close rule judges, and deposits the record to the board through the L2's portal, which the L2 must include within its sequencing window. One call is one attempt, and each that lands is paid for and archived, since the board takes every relayed deposit, a repeat included. So it first frames the record as the relay does, locally; checks both providers' chains and that the relay deposits to the election's board; asks the board on L2 as the deposit will run (from the relay's alias, with the L1 head's time as the stamp) and returns its refusal (`decodeRelayedBallotRevert`) without spending L1 gas; finds a relayed copy the board already holds, whose call the relay's stored word matches, rather than paying for another (an ordinary copy doesn't count, since the sequencer can withhold its batch, and neither does a deposit forged from the alias); gives the deposit the board's own gas estimate and a quarter, never below what the deposit needs by its size alone (`relayDepositGasFloor`, so an L2 node that understates its estimate can't starve it) or the portal's minimum for the data (`portalMinimumGasLimit`); asks the relay (`decodeRelayRevert`); and returns `over-cap` rather than sending a call whose L1 transaction the deposit market's price puts past EIP-7825's 2²⁴ gas (`MAX_TRANSACTION_GAS`). After sending it checks the relay's `BallotRelayed` event against the call hash it recomputes from the call's block, and returns the call: index, L1 block, stamp, gas limit and call hash. `findRelayedBallot` then looks on L2 for the board's `RelayedBallotSubmitted` naming exactly that call, which arrives minutes to hours later. As on the ordinary path, these are the providers' reports, never grounds to stand down, and the paying L1 account is linked to the ballot for good (T-25, Residual; T-11).

```ts
const relayed = await relayBallot({
  l1Provider: window.ethereum,
  l1ChainId: definition.l1_chain_id,
  relay: definition.l1_relay,
  l2Provider,
  l2ChainId: definition.l2_chain_id,
  board: definition.board,
  from: account,
  record,
  fromBlock: registrationBlock,
});
if (relayed.status === "relayed")
  await findRelayedBallot({
    provider: l2Provider,
    chainId: definition.l2_chain_id,
    board: definition.board,
    record,
    call: relayed.call,
    fromBlock: registrationBlock,
  });
```

## Test

The direct-submit and relay tests run the board and the relay contracts on Anvil, built by `forge` from `packages/contracts`, so they need the toolchain (`.github/scripts/install-toolchain.sh`) on `PATH`.

```sh
vp run --filter @abolishus/sdk test
```

## License

[Apache-2.0](LICENSE).
