# @abolishus/contracts

Abolish's L2 contracts, built with Foundry 1.8.3 and solc 0.8.30. Internal and source-only: deployed bytecode is checked against the release build of this source (verifier check 1.2, T-64).

**Status: early (P1-18).** So far there are the event accumulator and the election registry. The trustee key registry, direct submission and the wagmi bindings follow in later P1-18 changes. Nothing is deployed, and nothing may be until the trustee registry and the close rule exist ([`docs/spec/contracts.md`](../../docs/spec/contracts.md), Election registry).

## Event accumulator

`src/EventAccumulator.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md):

- Every contract inherits `EventAccumulator` and emits only through `_log1` … `_log4`.
- Each of those emits the log and, in the same call, folds it into a SHA-256 running hash and a count, at the ERC-7201 slot `abolish.event-accumulator`.
- The verifier replays the archived logs (`replayEventAccumulator` in `@abolishus/crypto`) and compares them with a storage proof of that slot. So a log left off the board, such as a direct-submitted ballot, is detected (T-71, T-25).
- There is no admin, proxy or upgrade path.

## Election registry

`src/ElectionRegistry.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Election registry:

- `createElection()` assigns `election_id = H(DS("abolish/v1/election-id", u64(chain_id) ‖ registry ‖ u64(counter)))` and makes the caller the election's creator.
- `registerDefinition(bytes)` admits the creator's one definition, write-once, only with canonical calldata, if it decodes strictly (`src/ElectionDefinition.sol`), is well formed, names this deployment, opens after the anchoring epoch and after registration, has every electorate root in an earlier block, and its stub was recorded with its ceremony transcript hash by the trustee registry (`src/ITrusteeRegistry.sol`; T-34, T-17, T-37, T-08, T-13, T-25).
- The trustee registry is the next part of P1-18; tests use a stand-in (`test/utils/DefinitionHarness.sol`).

- `test/source-rules.test.ts` checks every file in `src/`:
  - it has no `emit` statement or anonymous event;
  - only `EventAccumulator.sol` uses raw `log0` … `log4`;
  - it has no `selfdestruct`, `delegatecall` or `callcode`;
  - its pragma is exactly the pinned compiler.
- Builds are reproducible:
  - no metadata hash, no CBOR metadata, no compilation cache;
  - the build script deletes `out/build-info`, whose id hashes absolute paths.

  `repro-build` compares two builds byte for byte.

- No dependencies are vendored yet. The tests declare only the Foundry cheatcodes they use (`test/utils/Vm.sol`) instead of vendoring forge-std. Any dependency added later is vendored as plain files from an audited release, never as a git submodule, and listed here with its upstream repository, tag, commit and tree hash.

## Test

```sh
.github/scripts/install-toolchain.sh   # forge, from the repository root
vp run --filter @abolishus/contracts test
FOUNDRY_PROFILE=ci vp run --filter @abolishus/contracts test   # deeper fuzz and invariant runs, as in CI
```

The tests cover:

- the cross-language vectors in `docs/spec/vectors/event-accumulator.json`, `election-definition.json` and `election-registry.json`, which independent Python implementations produced;
- fuzz tests that replay the logs the EVM recorded;
- a test per admission rule of the election registry, and fuzz tests that any one-bit change to an approved definition, or arbitrary bytes, is refused;
- invariant suites (`test/invariant/`) whose invariants are stated in prose in each file.

## License

AGPL-3.0-only, as the rest of the repository.
