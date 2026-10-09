---
name: contracts
description: Rules for packages/contracts (Solidity + Foundry) — immutability, admin model, direct-submit, PII ban, fuzz/invariant testing, bindings and testnet deploys. Load before touching any Solidity.
---

# contracts

Also load `crypto-review`: contracts are protocol code.

## Layout

```
packages/contracts/
  foundry.toml      # profiles: default, ci (deeper fuzz/invariant runs)
  src/              # contracts
  test/             # *.t.sol unit + fuzz; invariant/ for invariant suites
  script/           # deploy scripts (run only from GitHub Actions)
  package.json      # build: forge build; test: forge test; check: forge fmt --check && forge build --sizes
  wagmi.config.ts   # wagmi CLI Foundry plugin -> generated typed bindings
```

- Solidity version: exact pragma (`pragma solidity 0.8.x;`), and the same in `foundry.toml`. Settings: `via_ir` decided once, optimizer runs fixed, `bytecode_hash = "none"` and `cbor_metadata = false` for reproducible bytecode.
- Remappings are explicit. Dependencies (OpenZeppelin, Semaphore) are vendored as plain files inside `packages/contracts`, copied from an audited release, never git submodules: a submodule bump shows reviewers only a commit hash. Record each one's upstream repo, tag and commit, and a tree hash CI re-derives, in the package README.

## Rules

- **Bulletin-board contracts are immutable:** no proxy, no owner, no pause, no selfdestruct, no delegatecall to mutable targets.
- **Per-election records are write-once** in non-upgradeable storage: the election-definition hash, verification-key hash, trustee keys and election public key. The verifier and the ballot client take the first registration event as authoritative and fail on any later change, and the client checks the election key against the DKG transcript before encrypting. Upgrading a registry must never be able to swap a key or re-scope a poll's nullifiers.
- Anything upgradeable (registry logic that can't affect a recorded election, paymaster config) sits behind a **Safe multisig + TimelockController**. There is no single-key admin anywhere: no `Ownable` with an EOA owner. Tests assert the admin is the timelock.
- **No PII on-chain.** Inputs are commitments, hashes, ciphertexts, proofs and public keys only. Every external function has a test that feeds representative inputs through a PII detector (no ASCII names, emails or document numbers in calldata; fixed-size typed fields) and asserts that events carry no user-supplied free text. A test asserts that no on-chain data links a group member to a poll.
- **Direct-submit:** anyone can post a registration or ballot commitment directly. Bind every signed or proved payload to `block.chainid`, the contract address, and the poll ID; reject replays; never let a third party alter or front-run a submission into a different meaning.
- One person, one vote: weight never depends on balance or token holdings. Keep contracts coin-ready (a future ERC-20 on the same L2 funds the project) without coupling voting to it.
- Events carry everything needed to rebuild state from chain alone (Ponder indexer, verifier).
- Gas sponsorship (paymaster) covers registration only. Voters never transact to vote.
- Checks-effects-interactions; no external calls into untrusted contracts from board logic.

## Tests

- Unit tests for each function and revert path.
- Fuzz tests for each external function (`FOUNDRY_PROFILE=ci` raises runs).
- Invariant suites with handlers, invariants stated in prose in the test file. Examples: board length never decreases; entry hashes chain; at most one counted ballot per (poll, nullifier), the latest in board order, with superseded ballots kept on the board (re-voting must work, so never use a proof check that records the nullifier and reverts on reuse, such as Semaphore's `validateProof`, on the ballot path); root history is append-only.
- Gas snapshots (`forge snapshot --check`) for hot paths.
- Cross-language vectors from `docs/spec/vectors/` checked in Solidity.

## Bindings

`vp run --filter @abolishus/contracts build` runs `forge build` and then the wagmi CLI to regenerate `src/generated/`. Generated files are committed and never hand-edited; CI fails if regeneration changes them.

## Deploys

- Testnets only (the chosen L2's testnet, Sepolia for L1 anchoring, Anvil locally) until the owner signs off on mainnet.
- Deploys run only in GitHub Actions with `TESTNET_DEPLOYER_KEY`. Never from a session, and never with a key in the repo.
- Every deployment verifies source on the explorer (`ETHERSCAN_API_KEY`), and records addresses + tx hashes + bytecode hashes in `packages/contracts/deployments/<chain-id>.json`.
