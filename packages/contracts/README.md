# @abolishus/contracts

Abolish's contracts (the L2 contracts and the L1 board anchor), built with Foundry 1.8.3 and solc 0.8.30. Internal and source-only: deployed bytecode is checked against the release build of this source (verifier check 1.2, T-64).

**Status: early (P1-18, P3-2, P4-1).** So far there are the event accumulator, the election registry, the trustee key registry, the group registry with its Tier 0 additions and the L1 board anchor. Direct submission and the wagmi bindings follow in later P1-18 changes. Nothing is deployed, and nothing may be until the close rule exists ([`docs/spec/contracts.md`](../../docs/spec/contracts.md), Election registry).

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
- Its unit tests use a stand-in trustee registry (`test/utils/DefinitionHarness.sol`); `test/TrusteeRegistry.t.sol` runs it against the real one.

## Trustee registry

`src/TrusteeRegistry.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Trustee registry, and the on-chain rules of [`docs/spec/trustee-identity.md`](../../docs/spec/trustee-identity.md):

- The deployment pins its panels, write-once: each panel's threshold `k`, its quorum `q` (`k ≤ q ≤ n`) and its seats' keys, each given as its 33-byte encoding and its `(x, y)`, checked against each other. Panels are refused in the spec's order (size, threshold, key, duplicate key), then for their quorum and for repeating a panel. `PanelPinned` logs each one.
- `registerCeremony(bytes)` takes `panel_id ‖ stub_hash ‖ transcript_hash ‖ u8(count) ‖ count × (u8(index) ‖ r ‖ s)` with canonical calldata, and records the transcript for the stub and panel, write-once, only if at least `q` distinct seats, in increasing order, signed the ceremony registration statement and every signature verifies under its seat's pinned key. Anyone may submit; the sender counts for nothing (T-71, T-37, T-14). `CeremonyRegistered` logs the whole record.
- `ceremonyRecorded(stub, transcript, panel_id, k, n)` answers the election registry: true only for a recorded pair, of a pinned panel with that threshold and size.
- Signatures are checked through OpenZeppelin's `P256` (vendored, below), which uses the `P256VERIFY` precompile where the chain has it and its own Solidity code where it doesn't; the contract checks the range and low-s rules itself as well.

## Group registry

`src/GroupRegistry.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Group registry:

- The deployment pins its registrars, write-once: 2 to 16 Ethereum addresses (dedicated registration keys, never the Safe's owners), non-zero and strictly ascending, and a threshold `t` from 2 to their number, refused in the spec's order (size, threshold, order). `RegistrarsPinned` logs them as the registry's first event (T-62).
- `createGroup(uint8)` takes exactly a selector and one word, creates the next group (`group_id` counted from 0, up to `2⁶⁴ − 1`) with its tier fixed for good, and refuses every tier but 0 until the Tier 1 and Tier 2 addition paths exist (P3-3, P3-4). Anyone may create one; `GroupCreated` logs it.
- `addMembers(bytes)` takes `u64(group_id) ‖ u64(first_index) ‖ u16(count) ‖ count × field<bn254> ‖ u8(approvals) ‖ approvals × (u8(seat) ‖ r ‖ s ‖ u8(v))` with canonical calldata, and admits it only for a Tier 0 group it created, with 1 to 256 commitments, at exactly the group's member count and within the tier tree's `2³²` leaves, with no forbidden commitment (`≥ r`, `0`, `1`, `Poseidon2(0, 1)`), and with at least `t` approvals from strictly increasing seats, every one a low-s signature by its seat's registrar on the EIP-712 `AddMembers` digest (T-06, T-13, T-31). Anyone may submit; `MembersAdded` logs the whole record.
- `removeMembers(bytes)` takes `u64(group_id) ‖ u64(size) ‖ u16(count) ‖ count × u64(index) ‖ u8(approvals) ‖ approvals` likewise. `size` is the member count the registrars signed at: it must be at most the group's count, and each index strictly greater than the one before, below `size` and not removed already, so a removal signed before a member landed at an index can never remove that member later, and a replay reverts. The member count never changes. `MembersRemoved` logs the whole record.
- Signatures are recovered through OpenZeppelin's `ECDSA.tryRecover` (vendored, below); the contract checks `v ∈ {27, 28}`, `1 ≤ r < N` and `1 ≤ s ≤ (N − 1) / 2` itself as well. The EIP-712 domain binds `block.chainid` and the registry's address, and each message the group, its tier and, for additions, the position (for removals, `size`; T-30, T-32). The threshold, the cached domain separator and its chain ID are immutables, which verifier 1.2 masks; the registrars are in storage and logged by `RegistrarsPinned`.
- It keeps no Merkle tree, and takes no election identifier, definition or nullifier, so nothing it holds or logs links a member to a poll (T-12).

## Board anchor

`src/BoardAnchor.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Board anchor, our one contract on L1:

- Its clock (`epoch`, `period`, `deadline`) and its anchoring `authority` are immutable; deployment refuses a zero period and an authority without code or with only an EIP-7702 delegation (a single key; T-53, T-69).
- `anchor(bytes checkpoints, bytes locator)` takes concatenated checkpoint encodings from the authority only, with canonical calldata, each non-empty, inside its window (`[end, end + deadline]` after its period ends) and the first for its election and segment, and stores `H(DS("abolish/v1/board-checkpoint", encode(checkpoint)))` at a per-segment slot under the ERC-7201 namespace `abolish.board-anchor`, so a verifier proves every anchor of an election from state (T-23, T-24, T-52).
- `CheckpointAnchored` publishes the full checkpoint, through the event accumulator.
- A call may carry the `archiveLocator` of ADR 0005 (`u16(version) ‖ body`, at most 128 bytes, framed but not interpreted), alone or with checkpoints; `ArchiveLocated` logs it and the latest one stays in state with a count, so the archive is found from L1 alone, even after history expiry (T-49, T-51).
- `src/CanonicalCalldata.sol` is the calldata check it shares with the election registry.
- The hourly job and the Sepolia deployment are P4-1 part 2.

## Rules

- `test/source-rules.test.ts` checks every file in `src/`:
  - it has no `emit` statement or anonymous event;
  - only `EventAccumulator.sol` uses raw `log0` … `log4`;
  - it has no `selfdestruct`, `delegatecall` or `callcode`;
  - its pragma is exactly the pinned compiler.
- Builds are reproducible:
  - no metadata hash, no CBOR metadata, no compilation cache;
  - the build script deletes `out/build-info`, whose id hashes absolute paths.

  `repro-build` compares two builds byte for byte.

- The tests declare only the Foundry cheatcodes they use (`test/utils/Vm.sol`) instead of vendoring forge-std. Dependencies are vendored as plain files from an audited release, never as a git submodule (Vendored code, below).

## Vendored code

`vendor/openzeppelin-contracts/` holds six unmodified files of [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) (MIT, its `LICENSE` beside them) at tag `v5.6.1`, commit `5fd1781b1454fd1ef8e722282f86f9293cacf256`: `P256.sol` and the four files it imports, and `ECDSA.sol`, which imports nothing. They are byte-identical to the same paths in that commit and in the npm package `@openzeppelin/contracts@5.6.1`. `foundry.toml` maps `@openzeppelin/contracts/` to them and nothing else. The `P256` library has been in OpenZeppelin's audited releases since 5.1, and `ECDSA` for much longer.

`test/vendor.test.ts` checks that the directory holds exactly these files with these sha256 sums (the `sha256sum` lines below), and that the tree hash, the sha256 of those lines, is the one recorded here:

<!-- vendored:openzeppelin-contracts -->

```text
20aebc68b11c063133aa2af0ef4bb29875477c6d16d715718f0daec563938b84  LICENSE
0704b9d6c032cca8512a3bc3f30f49f86f1f03102d2896a3d23e794b82efea66  contracts/utils/Errors.sol
270fc8401c1a13fae6a7a4a2dd6e381b95d658896701e51f0d3e2688acab3dec  contracts/utils/Panic.sol
ba7c2d314fcd61c9783e0b3f0c664d004b76b408fda6a84edc8267d17c5012d6  contracts/utils/cryptography/ECDSA.sol
0d7bb2f2b5e0ceb0e1a28523ee179c1aee5980cb793df739dd9ccf87170dffe2  contracts/utils/cryptography/P256.sol
bdfdbe133991c0c78042957ff5cd97167926fcaf6d15664f3835a076cb066457  contracts/utils/math/Math.sol
5779bc848bde39f1ad7bc02b4f708a0040888e0083b1a33f119cd94639350134  contracts/utils/math/SafeCast.sol
```

Tree hash: `4629cf8a19588eecd38051c0dbd0966ca3187c1651d3187136e411eedff90771`.

The check proves the files haven't changed since they were vendored, not that they match upstream: re-deriving them from the tag in CI needs a `ci:` change (rule B), recorded as known-weak in [`docs/status/P1-18.md`](../../docs/status/P1-18.md).

## Test

```sh
.github/scripts/install-toolchain.sh   # forge, from the repository root
vp run --filter @abolishus/contracts test
FOUNDRY_PROFILE=ci vp run --filter @abolishus/contracts test   # deeper fuzz and invariant runs, as in CI
```

The tests cover:

- the cross-language vectors in `docs/spec/vectors/event-accumulator.json`, `election-definition.json`, `election-registry.json`, `trustee.json`, `group-registry.json` and the checkpoints of `board.json`, which independent Python implementations produced;
- fuzz tests that replay the logs the EVM recorded;
- a test per admission rule of the election registry, per refusal of the trustee registry, of the group registry (its stateful ones included) and of the board anchor (with its window's exact boundaries), and fuzz tests that any one-bit change to an approved definition or a signed group record, or arbitrary bytes, is refused;
- the group registry's gas for one member with two approvals, two members, a batch of 256 and a removal, each bounded in its own test;
- invariant suites (`test/invariant/`) whose invariants are stated in prose in each file.

The test script also runs the trustee registry's tests under the `precompile` profile (`osaka`, with Foundry's `P256VERIFY`), so OpenZeppelin's `P256` is tested on its precompile path as well as its Solidity fallback; that profile writes to `out-precompile/`, never to the release build's `out/`.

## License

AGPL-3.0-only, as the rest of the repository.
