# @abolishus/contracts

Abolish's contracts (the L2 contracts and the L1 board anchor), built with Foundry 1.8.3 and solc 0.8.30. Internal and source-only: deployed bytecode is checked against the release build of this source (verifier check 1.2, T-64; Release build, below).

**Status: early (P1-18, P3-2, P4-1).** So far there are the event accumulator, the election registry, the trustee key registry, the group registry with its Tier 0 additions, the board (direct submission of ballots, share receipts, postings and complaints, with its membership-proof, ballot and delivery checks, the close rule's window, relayed ballots and close statements), the L1 board anchor, the L1 relay and the registration paymaster. The deployable contracts have typed wagmi bindings (Bindings, below), and contract-event version 3 archives every event the board emits. Nothing is deployed: the registry's and the board's remaining pre-deployment requirements are in [`docs/spec/contracts.md`](../../docs/spec/contracts.md) (Known-weak sections).

## Event accumulator

`src/EventAccumulator.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md):

- Every contract inherits `EventAccumulator` and emits only through `_log1` … `_log4`.
- Each of those emits the log and, in the same call, folds it, with the block number and timestamp of the call, into a SHA-256 running hash and a count, at the ERC-7201 slot `abolish.event-accumulator` (tag `abolish/v1/event-accumulator-2`; [`docs/adr/0025-contract-event-evidence.md`](../../docs/adr/0025-contract-event-evidence.md)).
- The verifier replays the archived logs (`replayEventAccumulator` in `@abolishus/crypto`) and compares them with a storage proof of that slot. So a log left off the board, such as a direct-submitted ballot, is detected (T-71, T-25).
- There is no admin, proxy or upgrade path.

## Election registry

`src/ElectionRegistry.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Election registry:

- `createElection()` assigns `election_id = H(DS("abolish/v1/election-id", u64(chain_id) ‖ registry ‖ u64(counter)))` and makes the caller the election's creator.
- `registerDefinition(bytes)` admits the creator's one definition, write-once, only with canonical calldata, if it decodes strictly (`src/ElectionDefinition.sol`), is well formed, names this deployment, opens after the anchoring epoch and after registration, has every electorate root in an earlier block, and its stub was recorded with its ceremony transcript hash by the trustee registry (`src/ITrusteeRegistry.sol`; T-34, T-17, T-37, T-08, T-13, T-25).
- It decodes definition versions 1 and 3 to 6, each under its own layout and rules, and records with each definition the parameters the board reads (`parameters`, `cellTiers`, `cell`, `ceremony`): the ballot pin, the default and author panels' thresholds and sizes, each question and their total, each cell's tier and root, and the stub hash and panel its ceremony was recorded under, where the board finds the key set ([`docs/adr/0028-board-contract-checks.md`](../../docs/adr/0028-board-contract-checks.md), 1C).
- A listed `p256-key` (receipt and author keys) decodes only if its `x` is on P-256: a candidate square root from `Math.modExp` must pass `P256.isValidPublicKey` (both OpenZeppelin, vendored, below), so a definition can't list a key that names no point (T-31, T-17).
- Rule 9 admits only the profile the deployment serves for the definition's version: the ballot version the board checks (1, 2 or 3; none for version 6, so every version-6 definition is refused), the spoiled-ballot opening that opens it, board-entry version 5, contract-event version 3 and the display-text version the definition needs, refusing any other with `ProfileNotServed(record_type, version)` (T-25, T-50, T-53).
- Its unit tests use a stand-in trustee registry (`test/utils/DefinitionHarness.sol`); `test/TrusteeRegistry.t.sol` runs it against the real one. `test/ElectionDefinition.t.sol` runs every vector of `election-definition.json` and its version-3 to version-6 files through the decoder, rules and hashes.

## Trustee registry

`src/TrusteeRegistry.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Trustee registry, and the on-chain rules of [`docs/spec/trustee-identity.md`](../../docs/spec/trustee-identity.md):

- The deployment pins its panels, write-once: each panel's threshold `k`, its quorum `q` (`k ≤ q ≤ n`) and its seats' keys, each given as its 33-byte encoding and its `(x, y)`, checked against each other. Panels are refused in the spec's order (size, threshold, key, duplicate key), then for their quorum and for repeating a panel. `PanelPinned` logs each one.
- `registerCeremony(bytes)` takes `panel_id ‖ stub_hash ‖ transcript_hash ‖ u8(seats) ‖ seats × (u8(index) ‖ kem_key_hash ‖ x ‖ y) ‖ u8(count) ‖ count × (u8(index) ‖ r ‖ s)` with canonical calldata: the registered key set, then the approvals. It records the transcript and the key set for the stub and panel, write-once, only if the set has at least `k` seats in increasing order, each signing key a valid point that repeats no earlier seat's and no identity key of the panel, and at least `q` distinct seats, in increasing order, signed the ceremony registration statement over the set's `key_set_hash` with every signature verifying under its seat's pinned key. Anyone may submit; the sender counts for nothing (T-71, T-37, T-14). `CeremonyRegistered` logs the whole record.
- `keySetOf(stub, panel_id)` returns the recorded `key_set_hash` and the set's seats as a bitmask, and `signingKeyOf(stub, panel_id, index)` a seat's signing key as `(x, y)`; the board takes qualified seats and signing keys from them (ADR 0028, 2B).
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

## Membership proofs

`src/MembershipProof.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Board, Membership proofs, the first part of direct submission ([`docs/adr/0028-board-contract-checks.md`](../../docs/adr/0028-board-contract-checks.md)):

- `MembershipProofLib.check(proof, signals)` decodes Semaphore v4's 256-byte Groth16 proof strictly (canonical coordinates, no identity, `A` and `C` on the curve), refuses a signal at or above `r` and a root of 0, and checks Groth16's equation under the pinned depth-32 key, held as constants, through the `ecMul`, `ecAdd` and `ecPairing` precompiles (EIP-196, EIP-197), which also refuse a `B` off the twist or outside its subgroup (T-05, T-31). The pairing gets a fixed 600,000 gas, so a failed call means a broken `B`, never a lack of gas.
- `scope(definition_hash, tier, root)` and `field(x)` compute `ŝ = F(S)` and Semaphore's `F` on chain, so a contract takes no signal from a submitter (T-12).
- It is a library for the board contract, which follows in later parts of P1-18 part 4b-3; nothing deployable uses it yet. `test/MembershipProof.t.sol` runs `docs/spec/vectors/membership-proof.json` and `membership.json` through it.

## Ballot check

`src/BallotCheck.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Board, Ballots:

- `BallotCheckLib.check(record, registry, qualified)` checks a direct-submitted ballot record (`0x0002`, versions 1 to 3) against the parameters the election registry recorded for the definition it names (`IElectionParameters`, which `ElectionRegistry` implements), never against anything the submitter supplies (T-25, T-71): the header, `ballot-stray`, the pinned version, strict framing of every field (counts before what they count, enums, `field<bn254>` values, scalars below `ℓ`, and each ristretto255 element's encoding canonical, even and non-zero), then `ballot-tier` (`ballot-cell`), `validity-shape`, `share-hash-unqualified` and the membership proof over `M`, which it recomputes from the record, reverting on the first failure (T-17, T-31, T-52).
- It runs no ristretto255 arithmetic (ADR 0028, 3B): the validity proofs and whether an element decodes to a point are the verifier's, which sets such a record aside as a rejected entry.
- `qualified` (the registered key set's seats) is an input, which the board reads from the trustee registry. `test/BallotCheck.t.sol` runs `ballot.json`, `ballot-v2.json`, `ballot-v3.json` and `ballot-validity.json` through it, and once against a real election registry.

## Board anchor

`src/BoardAnchor.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Board anchor, our one contract on L1:

- Its clock (`epoch`, `period`, `deadline`) and its anchoring `authority` are immutable; deployment refuses a zero period and an authority without code or with only an EIP-7702 delegation (a single key; T-53, T-69).
- `anchor(bytes checkpoints, bytes locator)` takes concatenated checkpoint encodings (checkpoint version 2, 180 bytes, with the segment object's and entry-hash list's CIDs; ADR 0029) from the authority only, with canonical calldata, each with both CIDs framed as raw or dag-pb sha2-256 CIDv1, non-empty, inside its window (`[end, end + deadline]` after its period ends) and the first for its election and segment, and stores `H(DS("abolish/v1/board-checkpoint-2", encode(checkpoint)))` at a per-segment slot under the ERC-7201 namespace `abolish.board-anchor`, so a verifier proves every anchor of an election from state (T-23, T-24, T-52).
- `CheckpointAnchored` publishes the full checkpoint, CIDs included, through the event accumulator, so a board can be fetched by CID from L1 alone (T-49, T-51).
- A call may carry the `archiveLocator` of ADR 0005 (`u16(version) ‖ body`, at most 128 bytes, framed but not interpreted), alone or with checkpoints; `ArchiveLocated` logs it and the latest one stays in state with a count, so the archive is found from L1 alone, even after history expiry (T-49, T-51).
- `registerReceiptKey(bytes key)` and `retireReceiptKey(bytes key)` keep the append-only record of receipt keys ([`docs/adr/0023-receipt-evidence.md`](../../docs/adr/0023-receipt-evidence.md)): from the authority only, with canonical calldata, a 33-byte key framed as compressed P-256 (not checked on the curve); a key is registered once and retired at most once, each time in one word (`registeredAt`, `retiredAt`) under the same namespace, so a verifier proves both with one storage proof, and `ReceiptKeyRegistered` and `ReceiptKeyRetired` go through the event accumulator (T-26, T-69, T-17).
- `src/CanonicalCalldata.sol` is the calldata check it shares with the election registry.
- The hourly job and the Sepolia deployment are P4-1 part 2.

## L1 relay

`src/BallotRelay.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), L1 relay, our second contract on L1, which carries ballots the sequencer censors to the board ([`docs/adr/0030-close-rule.md`](../../docs/adr/0030-close-rule.md); T-50, T-71):

- It pins the portal (which must have code) and the board's L2 address; there is no admin, proxy or upgrade path, and it holds no funds.
- `relayBallot(uint64 gasLimit, bytes record)` takes canonical calldata and a record of at most `MAX_RELAY_RECORD` bytes with a ballot header, stores call `i`'s hash `H(DS("abolish/v1/relay-call", u64(l1_chain_id) ‖ relay ‖ u64(i) ‖ u64(b) ‖ u64(τ) ‖ u64(gasLimit) ‖ record))` at the ERC-7201 namespace `abolish.ballot-relay`, emits `BallotRelayed` through the event accumulator, and only then deposits `submitRelayedBallot(i, b, τ, gasLimit, record)` to the board through the portal.
- `test/BallotRelay.t.sol` runs every call, framing, calldata, alias-slot and accumulator vector of `relay.json` at the vector's own address, chain, block and time.

## Board

`src/Board.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Board, Deployment, Calls and Events, and `src/DeliveryCheck.sol` its Delivery records: the direct-submit path for ballots and every share receipt, posting and complaint ([`docs/spec/delivery.md`](../../docs/spec/delivery.md), Direct submit; T-25, T-54).

- It pins the election and trustee registries and the L1 relay at construction and reads each election's parameters, ceremony (`ceremony(definition_hash)`) and registered key set (`keySetOf`, `signingKeyOf`) from them alone (ADR 0028, 1C and 2B).
- `submitBallot(bytes)` runs the ballot check with the key set's seats as `qualified`; `submitReceipts(bytes)` takes one or more 164-byte share receipts in one call, each signed by its seat's registered per-election key (P-256 through OpenZeppelin's `P256`); `submitComplaint(bytes)` the same for a complaint; `submitPosting(bytes posting, bytes ballot)` requires the ballot record it binds to pass the whole ballot check, membership proof included, and to be the one the posting names (its definition hash and ballot hash), and compares the ciphertext's hash with the ballot's share hash for the seat; the ballot is never admitted or emitted. Elements and scalars are framed as the ballot check frames them (ADR 0028, 3B).
- Each accepted record is emitted whole (`BallotSubmitted`, `ShareReceiptSubmitted`, `SharePosted`, `ShareComplaintSubmitted`, topics `definitionHash` and `ballotHash`) through the event accumulator; a byte-identical repeat succeeds and emits nothing, and any other passing record is accepted, so none occupies a slot. Calldata must be canonical (T-17).
- The close rule ([`docs/spec/close.md`](../../docs/spec/close.md)): `submitBallot` refuses a ballot outside `[opens_at, closes_at]` by its block's timestamp (`BallotWindow`); `submitRelayedBallot(uint64, uint64, uint64, uint64, bytes)` accepts only the relay's L2 alias (`RelaySender`), checks the ballot as an ordinary one and its stamp against the window (`RelayWindow`), and emits `RelayedBallotSubmitted` for every deposit it accepts, a byte-identical record included; `submitCloseStatement(bytes)` (`src/CloseStatement.sol`) takes a version-1 statement signed by a seat of the default panel's registered key set, at most two per seat and election, the second only with another claim (T-35, T-50, T-71, T-17).
- `test/Board.t.sol` runs the ballot and delivery vectors through it against stubs set from the files, and once against a real election registry. `test/BoardCloseRule.t.sol` replays `contract-event-v3.json`'s board sequence through the board at the file's address and chain, log for log and accumulator for accumulator, and runs `close-statement.json`'s statements, decode rejections and window verdicts and `relay.json`'s aliases; `test/invariant/BoardCloseRule.invariant.t.sol` holds the close rule's paths and the statement limit over random interleavings.

## Registration paymaster

`src/RegistrationPaymaster.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Registration paymaster: our own ERC-4337 paymaster for EntryPoint v0.8, which pays for the signing service's Tier 0 batches ([`docs/adr/0024-tier0-registration.md`](../../docs/adr/0024-tier0-registration.md), [`docs/spec/registration.md`](../../docs/spec/registration.md)) and nothing else.

- It pins the EntryPoint, the group registry, the signing service's account, its admin (the timelock behind our Safe) and `maxCost` as immutables; deployment refuses an EntryPoint, registry or admin without code (or with only an EIP-7702 delegation), no service and a zero cap (T-62).
- `validatePaymasterUserOp` sponsors an operation only if, in this order: its sender is the service's account, it deploys no account, `paymasterAndData` is the 52-byte prefix with no data after it, its call is exactly the standard ABI encoding of `execute(registry, 0, inner)` with `inner` exactly the standard ABI encoding of `addMembers(record)`, and its `maxCost` is at most the cap. It returns no context (so `postOp` is never called, and reverts) and no time range, and reads no storage, so bundlers accept it unstaked (ERC-7562). Refusals name the rule (`NotSponsored(Refusal)`).
- Anyone may `deposit()`; only the admin may `withdrawTo`, `addStake`, `unlockStake` and `withdrawStake`. Nothing else can change: a new service account or cap is a new paymaster. It emits no log and holds nothing a verifier reads, so it doesn't inherit the event accumulator.
- `test/RegistrationPaymaster.t.sol` runs it against a stand-in EntryPoint and account (`test/utils/MockEntryPoint.sol`) and a real group registry: a sponsored operation lands a signed batch from the vectors' registrars; every rule refuses its case (by fuzzing too: any sender but the service, any cost over the cap, any byte of the call changed outside the record); a changed record is sponsored and refused by the registry, costing the deposit at most the cap; and only the admin moves funds. `test/RegistrationEntryPoint.t.sol` runs it through EntryPoint v0.8 itself (Registration account, below).

## Registration account

`src/RegistrationAccount.sol` implements [`docs/spec/contracts.md`](../../docs/spec/contracts.md), Registration account: the signing service's ERC-4337 account, the paymaster's `service`, which submits each Tier 0 batch as `execute(registry, 0, addMembers(record))`.

- It is eth-infinitism's `BaseAccount` (v0.8, vendored, below) with one owner key and the EntryPoint as immutables: `execute` and `executeBatch` run only for the EntryPoint, and an operation validates only if its 65-byte, low-`s` signature with `v` 27 or 28 over EntryPoint v0.8's `userOpHash` recovers to the owner; any other signature is a failed validation (`SIG_VALIDATION_FAILED`), never a revert. Deployment refuses an EntryPoint without code (or with only an EIP-7702 delegation) and a zero owner.
- Nothing can change it: no proxy, no upgrade entry, no delegatecall, no owner change. It has no `receive` or fallback, so it holds no ether unless someone sends it some (an EntryPoint deposit or a forced transfer), which only the owner key could spend; it emits no log (T-62, T-69).
- `test/RegistrationEntryPoint.t.sol` runs it and the paymaster through EntryPoint v0.8 itself (vendored, compiled for the test): the owner's signed operation lands the batch, paid from the paymaster's deposit to the bundler within the cap; the signed hash is the EIP-712 digest computed from ERC-4337's definition; a replay is refused by nonce; a record the registry refuses costs at most the cap and adds nothing; a signature by any other key (fuzzed), any changed byte of it (fuzzed), a malformed, high-`s` or other-`v` one, or one over another operation fails validation; each paymaster rule reaches the EntryPoint as `AA33`, with another call, a batch of one, extra paymaster data, a fee over the cap and another account with the same owner; only the EntryPoint runs the account (`execute` and `executeBatch`); its code has no storage, create, delegatecall, callcode or selfdestruct opcode; and nothing it logs is text.

## Bindings

`src/generated/abi.ts` holds the typed ABIs (`as const`) of the seven deployable contracts, `BallotRelay`, `Board`, `BoardAnchor`, `ElectionRegistry`, `GroupRegistry`, `RegistrationPaymaster` and `TrusteeRegistry`, made by the wagmi CLI's Foundry plugin from the build's `out/` (`wagmi.config.ts`). It is generated and never hand-edited:

- the package build compiles, then runs `wagmi generate` and formats the file with `vp fmt`, so `repro-build` fails if a commit's bindings don't match its contracts (it rejects a build that changes a tracked file);
- `test/bindings.test.ts` checks that the file binds exactly the concrete contracts in `src/`, each with the ABI in its compiled artifact.

The file is plain data with no imports. `@wagmi/cli` is a dev dependency only; nothing it pulls in (viem, esbuild) reaches the generated file.

## Release build

The release build, whose bytecode and immutable ranges verifier 1.2 pins and from which every deployment must be made, is `forge build` alone of the contracts commit the verifier's release pins (a commit on `main`, verifier 1.2), with the default profile, run on a fresh runner (no restored cache) in a job that runs no npm code: the pinned forge 1.8.3 from `install-toolchain.sh`, working directory `packages/contracts`, failing if any `.env` exists in `packages/contracts`, `packages/` or the repository root (forge reads one at its project root as well as in its working directory), no `FOUNDRY_*` or `DAPP_*` variable set and no global `~/.foundry/foundry.toml`, with `forge config --json` checked before building against the settings in this package's `foundry.toml`; then `out/build-info` removed and the remaining artifacts hashed before anything else runs; the hashes are the job's output, and later jobs check against them. It is never the `out/` of `vp run build`: that build runs under `vp` and runs `@wagmi/cli` and Prettier after forge, and either could rewrite forge's artifacts without changing an ABI, in both of `repro-build`'s builds alike (T-55, T-64). Verifier 1.2 compares runtime code only, so nothing yet proves a deployment came from this build's creation code; until that binding exists, 1.2 is unverifiable for every deployment (P1-18 status, Known-weak).

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

`vendor/openzeppelin-contracts/` holds eighteen unmodified files of [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) (MIT, its `LICENSE` beside them) at tag `v5.6.1`, commit `5fd1781b1454fd1ef8e722282f86f9293cacf256`: `P256.sol` and the four files it imports, `ECDSA.sol`, which imports nothing, and, for the tests' EntryPoint only (below), `ReentrancyGuardTransient.sol`, `ERC165.sol` and `EIP712.sol` with the files they import. They are byte-identical to the same paths in that commit and in the npm package `@openzeppelin/contracts@5.6.1`. `foundry.toml` maps `@openzeppelin/contracts/` to them and nothing else. The `P256` library has been in OpenZeppelin's audited releases since 5.1, and `ECDSA` for much longer.

`test/vendor.test.ts` checks that each directory holds exactly its files with these sha256 sums (the `sha256sum` lines below), and that the tree hash, the sha256 of those lines, is the one recorded here:

<!-- vendored:openzeppelin-contracts -->

```text
20aebc68b11c063133aa2af0ef4bb29875477c6d16d715718f0daec563938b84  LICENSE
f89772d2d4fafcbef8b73bb10ee9a3373edec2eedb2f1b302320915b351dc3d1  contracts/interfaces/IERC5267.sol
3ce9120a27934c75a074cb785d3a88868069ef6529dbe4dc6b845af0836f3c70  contracts/utils/Bytes.sol
0704b9d6c032cca8512a3bc3f30f49f86f1f03102d2896a3d23e794b82efea66  contracts/utils/Errors.sol
270fc8401c1a13fae6a7a4a2dd6e381b95d658896701e51f0d3e2688acab3dec  contracts/utils/Panic.sol
cff7c20aed945d939b764d876adbd42e1b7725d62d5b1f2bd303db237567b575  contracts/utils/ReentrancyGuardTransient.sol
1cfa08d3c551e9ec0b9cd249b09987f04e7e90f352e1a5e3b0d6a3bc426b3de7  contracts/utils/ShortStrings.sol
75704538dcb223239280c6726d9a31cf769a7816718517c997fc7d63bdb70778  contracts/utils/StorageSlot.sol
e318709bbe73a7831d64c1351e8bdc43780b245f25191234e361e6ab9b98c67b  contracts/utils/Strings.sol
ea92f361d697ba8b1fbd322b4d84b989998862c21fbebfa4b45289dc94a9eea2  contracts/utils/TransientSlot.sol
ba7c2d314fcd61c9783e0b3f0c664d004b76b408fda6a84edc8267d17c5012d6  contracts/utils/cryptography/ECDSA.sol
2845caaaf70757b6cce612ae4ffbec2c382cb3d1cb9765c98fa649c0f5f1c794  contracts/utils/cryptography/EIP712.sol
538a0d7c4f0ec5a8562f58561890f7b49d14580674ecf58bc5f505b45c73df65  contracts/utils/cryptography/MessageHashUtils.sol
0d7bb2f2b5e0ceb0e1a28523ee179c1aee5980cb793df739dd9ccf87170dffe2  contracts/utils/cryptography/P256.sol
61a2b12c96857aaa35f48aeda67a4281637a42494c0b3795be0ae976aa7b3793  contracts/utils/introspection/ERC165.sol
9055c2994b37dea1a41b7b7926dcb510f05dbe2540b0aafc5fbee9558fffd0ca  contracts/utils/introspection/IERC165.sol
bdfdbe133991c0c78042957ff5cd97167926fcaf6d15664f3835a076cb066457  contracts/utils/math/Math.sol
5779bc848bde39f1ad7bc02b4f708a0040888e0083b1a33f119cd94639350134  contracts/utils/math/SafeCast.sol
1ed50b1056af886752f0fb48a0165d381e69bb4a4b18b893b066dc144a7e08d7  contracts/utils/math/SignedMath.sol
```

Tree hash: `a78db2cd0a731aa74865b24a46a0ce8d34cbd8d30215f1f9338e3d784c988cde`.

`vendor/account-abstraction/` holds eighteen unmodified files of [eth-infinitism's account-abstraction](https://github.com/eth-infinitism/account-abstraction), ERC-4337's reference implementation, at tag `v0.8.0`, commit `4cbc06072cdc19fd60f285c5997f4f7f57a588de` (EntryPoint v0.8): `core/EntryPoint.sol` and every file it imports, among them `BaseAccount.sol`'s own imports, and `core/BaseAccount.sol`. They are byte-identical to the same paths in that commit and in the npm package `@account-abstraction/contracts@0.8.0` (whose `@openzeppelin/contracts` range, `^5.1.0`, admits the 5.6.1 files above). The paymaster uses the interfaces only; the registration account inherits `BaseAccount`, so its `execute` and validation are the reference account's; and only the tests deploy `EntryPoint`, compiled with this package's settings, so its bytecode isn't the canonical deployment's (the deployment record names the canonical one). The interfaces, `BaseAccount.sol` and the helpers declare `SPDX-License-Identifier: MIT`, and `EntryPoint.sol`, `StakeManager.sol`, `NonceManager.sol` and `SenderCreator.sol` declare `GPL-3.0`, as the npm package's do; the repository's `LICENSE`, beside them, is GPL-3.0, which this AGPL-3.0-only package can include either way (AGPL-3.0, section 13). No GPL-3.0 file is part of a contract we deploy. `foundry.toml` maps `@account-abstraction/contracts/` to them.
<!-- vendored:account-abstraction -->

```text
3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986  LICENSE
d1cdb2bc26b1acc1c6217cba0060f0608d51267526f736f6bbbd14e49d2c655f  contracts/core/BaseAccount.sol
e3f6dc4d80f0e1094c822f0124dff8672b848bb11ff9329ff15245c36ab27e99  contracts/core/Eip7702Support.sol
c6572f5f940c32c8f9e0ba8f8db0b5b01f59a3626d27bc0fc2e08eca0148926f  contracts/core/EntryPoint.sol
c3da33a3d7916abc048af7c5a7ccafc5df7eb18c7b335315d2f4492a6133fc5c  contracts/core/Helpers.sol
5206bd20e1b46ed89f62cc53ef3cc12d8b032571c9471663e4f68e15833eb662  contracts/core/NonceManager.sol
b38ebc6a7c0b16ddb373e07f01448e21c6b3ac7aa72970be427ffbfaeae249f0  contracts/core/SenderCreator.sol
32936cfbf289cb67b874c1684873d93b3395035914ffa2de91f48f69e6174f83  contracts/core/StakeManager.sol
5eb7ed0461f6157d641ae38e60564067c49459415701edcd206115a12ea4289b  contracts/core/UserOperationLib.sol
2c1b8edec106515424e725970139d0bdb1f624377e3452c82095310642647ac8  contracts/interfaces/IAccount.sol
2fe4601d013ae48c9960aba8918843abe0ff11391a71c7d1d167f5f0aff72a20  contracts/interfaces/IAccountExecute.sol
f2986a91e9b3c694241af5803d6657c985af962620a0646e4fdaea95ddc4d35e  contracts/interfaces/IAggregator.sol
a3f1fa434462383b862082f062228eb1075dc90aab6ab2981522a58add4d5bba  contracts/interfaces/IEntryPoint.sol
46717d66cbde8176989a4a320f6d8a937fddae42abc772a8e22abe22c62f57b5  contracts/interfaces/INonceManager.sol
afa15dcc078da38975c9c34320f4312ec5fe4cd02d3e88f40dcf0cdaab6a7856  contracts/interfaces/IPaymaster.sol
a1448e8754f7a1e9f2fd97cba36a951b55c6ab422164250913904bd587c905a2  contracts/interfaces/ISenderCreator.sol
b5b638a2d9f046c7f77b83a1bb2a1f5804527cac17ca9726febdbe3607c86a2a  contracts/interfaces/IStakeManager.sol
e1c1f25c071c981fa03901e86a85e7ac4300cdc5c54165a1b96962427d9a1930  contracts/interfaces/PackedUserOperation.sol
fb027b5d2397bf767cc1caa5660c408ea900c1a8c48b8e2db1b19ae6e856972d  contracts/utils/Exec.sol
```

Tree hash: `efa4d5c9136075d04d5eff8ff1396e8e13398357c6eb3763d45c3553cffca405`.

The check proves the files haven't changed since they were vendored, not that they match upstream: re-deriving them from the tag in CI needs a `ci:` change (rule B), recorded as known-weak in [`docs/status/P1-18.md`](../../docs/status/P1-18.md).

## Test

```sh
.github/scripts/install-toolchain.sh   # forge, from the repository root
vp run --filter @abolishus/contracts test
FOUNDRY_PROFILE=ci vp run --filter @abolishus/contracts test   # deeper fuzz and invariant runs, as in CI
```

The tests cover:

- the cross-language vectors in `docs/spec/vectors/event-accumulator-2.json`, `election-definition.json`, `election-registry.json`, `trustee.json`, `key-set.json`, `group-registry.json`, the checkpoints of `board.json` and the receipt-key records of `election-definition-v4.json`'s judging cases, which independent Python implementations produced;
- fuzz tests that replay the logs the EVM recorded;
- a test per admission rule of the election registry, per refusal of the trustee registry, of the group registry (its stateful ones included) and of the board anchor (with its window's exact boundaries), and fuzz tests that any one-bit change to an approved definition or a signed group record, or arbitrary bytes, is refused;
- the group registry's gas for one member with two approvals, two members, a batch of 256 and a removal, each bounded in its own test;
- invariant suites (`test/invariant/`) whose invariants are stated in prose in each file.

The test script also runs the trustee registry's tests under the `precompile` profile (`osaka`, with Foundry's `P256VERIFY`), so OpenZeppelin's `P256` is tested on its precompile path as well as its Solidity fallback; that profile writes to `out-precompile/`, never to the release build's `out/`.

## License

AGPL-3.0-only, as the rest of the repository.
