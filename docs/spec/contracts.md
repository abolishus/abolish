# Contracts

What our L2 contracts commit to, for a verifier that reads them from the chain and the archive alone. So far this page specifies the event accumulator every Abolish contract keeps. The election registry, the trustee key registry, direct submission, the contract-event record (`0x0008`) with its inclusion evidence, and the close rule are still P1-18's, and are added here as they are built. Notation is from [[notation]], tags from [[domain-separation]].

## Event accumulator

Threats: T-71 (L2 governance or our server hiding an event), T-25 (a direct-submitted ballot withheld from the board), T-24 (equivocation). Decided by [[0005-permanent-archive]], Consequences, "L2 events".

Our server writes the board, and inclusion proofs show only that an event exists, never that none was left out. So every Abolish contract keeps a running hash and a counter over every log it emits, in its own storage. Storage is committed by the L2 state root, which L1 output roots commit to, so an account and storage proof (`eth_getProof`) of these two values at an L2 block pins the contract's whole event sequence up to that block. A verifier replays the archived sequence and compares ([[verifier]] 4.4, P1-19).

### Values

- **Genesis.** At deployment the contract stores

  ```
  acc_0 = H(DS("abolish/v1/event-accumulator", u8(0) ‖ u64(chain_id) ‖ bytes[20](address)))
  ```

  and a count of 0, where `chain_id` is the chain's EIP-155 identifier (`block.chainid`) and `address` the contract's own address. Binding both means one contract's event sequence can't be presented as another's, on this chain or a fork (T-71). A contract MUST revert its deployment if `chain_id` is 2⁶⁴ or more, since it has no `u64` encoding.

- **Step.** For its `n`-th log (0-based), with topics `t_0 … t_{k−1}` and data `d`, the contract sets

  ```
  acc_{n+1} = H(DS("abolish/v1/event-accumulator",
                   u8(1) ‖ acc_n ‖ u64(n) ‖ u8(k) ‖ t_0 ‖ … ‖ t_{k−1} ‖ u32(len(d)) ‖ d))
  ```

  and the count to `n + 1`. Each topic is the log's 32-byte topic as emitted, and `d` its data bytes as emitted (the ABI encoding of the event's non-indexed fields). `k` is 1 to 4. A log with no topics (a Solidity anonymous event) is never emitted, so `t_0` is always the event's signature hash.

The leading `u8` separates the two input layouts, and fixed widths plus the length of `d` make each input parse one way. The index `n` is redundant with the chain but makes each step's position explicit, so a verifier can report which event diverged.

### Rules for every contract

- Every log a contract emits goes through the accumulator, in the same internal call that emits it, with no external call in between. No contract emits an anonymous event or any log the accumulator doesn't cover. A reverted call reverts both its logs and its accumulator update, so the two can't drift apart.
- The two values live at fixed storage slots, independent of the contract's inheritance, so a verifier can request them by slot. The base slot is the [ERC-7201](https://eips.ethereum.org/EIPS/eip-7201) namespace `abolish.event-accumulator`:

  ```
  S = keccak256(abi.encode(uint256(keccak256("abolish.event-accumulator")) − 1)) & ~0xff
    = 0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600
  ```

  The accumulator is the 32-byte word at `S`. The count is the word at `S + 1`, as a big-endian 256-bit integer whose top 192 bits are zero. ERC-7201's keccak derivation is an external format ([[domain-separation]]), not a protocol hash.

- `eventAccumulator()` returns `(bytes32 accumulator, uint64 count)` for convenience. A verifier relies on the storage proof, never on a call answered by an RPC node.

### Verification

Given a contract's address, the chain ID, its archived logs in L2 order (block number, then transaction index, then log index within the transaction), and a storage proof of `S` and `S + 1` at an L2 block `B`, a verifier recomputes `acc` and the count from genesis over every archived log emitted at or before `B`. The archive matches the contract at `B` exactly when both equal the proven values. Anything else (a log left out, added, altered or reordered, or a log from another contract or chain) gives a different accumulator, except with negligible probability under SHA-256's collision resistance. [[verifier]] 4.4 says when this is checked and what the result is worth: a storage proof is only as good as the output root it is proven against ([[0004-l2-choice]], T-71 residual).

### Vectors

`vectors/event-accumulator.json` (format `abolish-event-accumulator-vectors/1`, see [[vectors/README|vectors]]) gives genesis values, event sequences with the accumulator after every step, and rejected inputs. TypeScript (`packages/crypto`) and Solidity (`packages/contracts`) tests both consume it.

### Known-weak

- The accumulator proves that the archive matches the contract's storage, not that the storage is honest: L2 governance that rewrites state can rewrite it too (T-71, detection only, through the evidence each event carries).
- Each event costs one SHA-256 precompile call over its log, plus two storage writes. That is our gas, not the voter's (voters don't transact to vote).
