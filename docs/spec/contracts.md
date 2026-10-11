# Contracts

What our L2 contracts commit to, for a verifier that reads them from the chain and the archive alone. So far this page specifies the event accumulator every Abolish L2 contract keeps (P4-1's L1 anchor contract decides for itself) and the election registry. The trustee key registry, direct submission, the contract-event record (`0x0008`) with its inclusion evidence, and the close rule are still P1-18's, and are added here as they are built. Notation is from [[notation]], tags from [[domain-separation]].

## Event accumulator

Threats: T-71 (L2 governance or our server hiding an event), T-25 (a direct-submitted ballot withheld from the board), T-24 (equivocation). Decided by [[0005-permanent-archive]], Consequences, "L2 events".

Our server writes the board, and inclusion proofs show only that an event exists, never that none was left out. So every Abolish L2 contract keeps a running hash and a counter over every log it emits, in its own storage. Storage is committed by the L2 state root, which L1 output roots commit to, so an account and storage proof (`eth_getProof`) of these two values at an L2 block pins the contract's whole event sequence up to that block. A verifier replays the archived sequence and compares ([[verifier]] 4.4, P1-19).

### Values

- **Genesis.** At deployment the contract stores

  ```
  acc_0 = H(DS("abolish/v1/event-accumulator", u8(0) ‖ u64(chain_id) ‖ bytes[20](address)))
  ```

  and a count of 0, where `chain_id` is the chain's EIP-155 identifier (`block.chainid`) and `address` the contract's own address. Binding both means one contract's event sequence can't be presented as another's, here or on another chain where the same address is deployed (T-71). It doesn't separate the two sides of a fork after deployment, which share the stored value: that is the job of the pinned L2 and the output root the storage proof is checked against (Verification). A contract MUST revert its deployment if `chain_id` is 2⁶⁴ or more, since it has no `u64` encoding.

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

  The accumulator is the 32-byte word at `S`. The count is the word at `S + 1`, as a big-endian 256-bit integer whose top 192 bits are zero; a proven word with any of those bits set fails the check. ERC-7201's keccak derivation is an external format ([[domain-separation]]), not a protocol hash.

- `eventAccumulator()` returns `(bytes32 accumulator, uint64 count)` for convenience. A verifier relies on the storage proof, never on a call answered by an RPC node.

### Verification

Given a contract's address, the chain ID, its archived logs in L2 order (block number, then the receipt's `logIndex`, which counts within the block), and a storage proof of `S` and `S + 1` at an L2 block `B`, a verifier recomputes `acc` and the count from genesis over every archived log emitted at or before `B`. The archive matches the contract at `B` exactly when both equal the proven values. Anything else (a log left out, added, altered or reordered, or a log from another contract or chain) gives a different accumulator, except with negligible probability under SHA-256's collision resistance. The storage proof is an account proof for the contract's address as the verifier pins it ([[verifier]], Pinned trust roots; its bytecode is checked by 1.2) under the state root that the output root commits to, plus a storage proof of each slot. The storage trie holds each value as the RLP of its minimal big-endian bytes, and omits a zero value: the verifier decodes the value, left-pads it to 32 bytes, and reads an absent slot as zero. The accumulator commits to the order of logs, not to their blocks or transactions, so each log's place is bound by its own receipt inclusion evidence ([[verifier]] 4.4). [[verifier]] 4.4 says when this is checked and what the result is worth: a storage proof is only as good as the output root it is proven against ([[0004-l2-choice]], T-71 residual).

### Vectors

`vectors/event-accumulator.json` (format `abolish-event-accumulator-vectors/1`, see [[vectors/README|vectors]]) gives genesis values, event sequences with the accumulator after every step, and rejected inputs. TypeScript (`packages/crypto`) and Solidity (`packages/contracts`) tests both consume it.

### Known-weak

- The accumulator proves that the archive matches the contract's storage, not that the storage is honest: L2 governance that rewrites state can rewrite it too (T-71, detection only, through the evidence each event carries).
- Each event costs one SHA-256 precompile call over its log, plus two storage writes: 60 gas plus 12 per 32-byte word for the hash. Voters don't transact to vote, so it is mostly our gas, but a direct submitter (T-25) pays it for their own submission.

## Election registry

Threats: T-34 (definition substitution), T-24 (equivocation), T-23 (board tampering), T-17 (chosen bytes in the archive), T-37 (a ceremony carried into another definition), T-08 and T-13 (an electorate that isn't public before voting), T-25 (blocking a legitimate election), T-71 (trusting who sent a transaction).

The election registry assigns each election its identifier and records the hash of its one definition ([[election-definition]]), write-once. It is immutable: no owner, proxy, pause or upgrade path, and it inherits the event accumulator above. Every rule below is fixed when it is deployed.

### Deployment

The registry is deployed with the deployment it belongs to, as immutable values: the `board`, `trustee_registry` and `group_registry` addresses on its own chain, the L1 chain ID, the `l1_anchor` and `l1_relay` addresses, and `epoch`, the anchoring clock's start of the anchor contract `l1_anchor` names (P4-1; [[election-definition]], The seal). Its own chain ID is `block.chainid` and its own address is `election_registry`. An L2 contract can't read the L1 anchor's clock, so `epoch` is an input: the deploy script MUST read it from the deployed `l1_anchor`, and the deployment record (`packages/contracts/deployments/<chain-id>.json`) MUST carry it, so a verifier can compare it with the clock its release pins. An `epoch` set too low only weakens the registry's early refusal, since [[verifier]] 2.6 still fails an election that opens before the real one; one set too high refuses legitimate elections until a corrected registry is deployed (liveness only). Deployment reverts unless these could appear in a well-formed definition (the `chain` rule: no zero address, the four L2 addresses including its own pairwise distinct, the two L1 addresses distinct, the L1 chain ID non-zero and different from its own), and, as for every contract, unless its chain ID fits a `u64`.

### Election identifier

```
election_id = H(DS("abolish/v1/election-id", u64(chain_id) ‖ bytes[20](registry) ‖ u64(counter)))
```

where `chain_id` is the registry's chain, `registry` its address and `counter` the number of elections it created before this one, from 0. The input after the tag is exactly 36 bytes. Binding the chain and the address makes the identifier unique across every registry, here or on another chain, so a redeployed registry can't reuse one and have its checkpoints attributed to another election ([[board]], `election_id`; T-23, T-24). It is a hash output, so the creator chooses none of its bytes, beyond the few bits that creating many elections and keeping one buys at the gas cost of each (T-17). Creation reverts rather than wrap the counter.

`createElection()` takes no arguments (calldata of exactly its 4-byte selector) and makes the caller the election's **creator**, the only account that can register its definition. Anyone can create an election. Doing so costs gas and blocks no other election's registration, because no one else can register under the identifier it gets; what it does cost others is below (Events, The shared event sequence). The identifier depends only on the counter, so if an L2 reorganisation reorders two creations, each creator ends up with the other's identifier. A creator MUST therefore wait until its `ElectionCreated` event is in finalized L2 history before putting the identifier in a stub and asking the panel for a ceremony; otherwise a reorg could hand the ceremony's identifier to someone else, who could then withhold its registration (T-25). They could only ever register the exact definition the panel approved.

### Registration

`registerDefinition(bytes definition)` registers the definition of an election. It checks, in this order, and reverts on the first failure:

1. **Canonical calldata.** The calldata is exactly the standard ABI encoding of one `bytes` argument: offset `0x20`, the length, the bytes, zero padding to a 32-byte boundary, and nothing after. Solidity's decoder accepts other offsets and trailing data, so without this a transaction could carry bytes no record defines ([[notation]], Result-critical fields; T-17).
2. **Strict decoding** of `definition` as record type `0x0001`, version 1, including the profile check of [[election-definition]] (Decoding), with the decode error codes of [[notation]]. The contract knows the record types specified when version 1 was frozen: `0x0007` and `0x0009` are `unexpected-record-type`, and every other type but `0x0001`, including any specified later, is `unknown-record-type`.
3. **Well-formedness**: every rule of [[election-definition]] (Well-formedness), reporting the first that fails.
4. **This deployment**: `l2_chain_id` is the registry's chain, `l1_chain_id` the deployment's L1, `election_registry` the registry's own address, and `board`, `trustee_registry`, `group_registry`, `l1_anchor` and `l1_relay` the deployment's ([[election-definition]], What gets admitted).
5. **The election**: `election_id` was created by this registry, the caller is its creator, and it has no registered definition. One definition per election, write-once (T-34, T-24). Restricting registration to the creator stops anyone who learns a pending definition's fields (a trustee, whoever relays ceremony messages) from registering first and blocking it (T-25). This is the only check that uses the caller, and it guards only the creator's own identifier: the caller (possibly an aliased L1 sender, or a delegated account) is never trusted for anything else ([[notation]], Result-critical fields).
6. **Timing**: `opens_at ≥ epoch` (no ballot before the anchoring clock starts, [[verifier]] 2.6) and `block.timestamp < opens_at` (registered before voting opens, [[verifier]] 2.1).
7. **The electorate is in the past**: every tier's `root_l2_block` is below `block.number`, the registering block ([[election-definition]], The electorate is in the past; T-08, T-13).
8. **The ceremony**: `ITrusteeRegistry(trustee_registry).ceremonyRecorded(stub_hash, ceremony_transcript_hash, panel_id, threshold, panel_size)` is true, where `stub_hash` is computed from `definition` and the other values are the definition's ([[election-definition]], Stub hash and the ceremony). The trustee registry returns true only for a pair that a quorum of distinct seats signed, of a panel it pins whose identifier, threshold and size are exactly those ([[trustee-identity]], Ceremony registration). Passing the panel fields means a quorum of one pinned panel can't approve a definition that names another panel or another threshold, even when the deployment pins more than one panel (a civic panel, [[0006-trustees]]; T-14, T-37); verifier 2.5 and the client's panel check still apply. The check compares hashes; it never relies on who sent either transaction (T-37, T-71). A transcript hash may repeat across definitions.

It then stores `definition_hash` for `election_id` and emits `DefinitionRegistered`. A registered definition can't be changed or removed.

The registry doesn't check what only the board can show: that each root is the root of its tier's additions at `root_l2_block`, each `group_size`, each group's tier, the panel against the pinned panels, or the version pins against a verifier release ([[verifier]] 2.3 to 2.5). It doesn't bound `l1_inclusion_bound`, `sequencing_window` or `max_sequencer_drift` either: the close rule (P1-18, direct submission) says what values it needs, and no registry may be deployed before it does, since a deployed registry's rules can't change.

### Events

Each event goes through the event accumulator, with topic 0 the keccak-256 of its signature (the standard ABI):

| Event                                                                                                | Topics                                       | Data                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ElectionCreated(bytes32 indexed electionId, address indexed creator, uint64 counter)`               | `election_id`, the creator as a 32-byte word | `counter`, ABI-encoded                                                                                                          |
| `DefinitionRegistered(bytes32 indexed electionId, bytes32 indexed definitionHash, bytes definition)` | `election_id`, `definition_hash`             | The definition's full canonical encoding, ABI-encoded as `bytes`, so the board and any verifier rebuild it from the chain alone |

**The shared event sequence.** One registry serves every election it creates, so its accumulator covers every creation and registration, including elections that never get a definition (anyone can create one, for gas). The contract-event record (`0x0008`, P1-18 part 4) and [[verifier]] 4.4 (P1-19) MUST therefore replay a shared contract's whole event sequence from the archive, authenticated by the accumulator's storage proof, and require board entries only for the events that name the election being verified. Otherwise every junk creation would have to be boarded on every live election's board, a cost that grows with elections times junk creations (T-52), or a verifier looking only at the election's own board would fail every election through that registry (T-53). Whatever a creation's transaction carries besides its 4-byte calldata (an outer call from the creator's own contract, an access list) reaches the archive only if part 4 keeps raw transactions in `0x0008`; T-17 records the residual until it decides.

A verifier takes the definition's registration from `DefinitionRegistered` on the registry its release pins, recomputes `definition_hash` from the bytes, and finds the election's creation, and no second registration, in the same contract's event sequence ([[verifier]] 2.1, 4.4). The creator's address is public; it is the account that runs the election, not a voter.

### Vectors

`vectors/election-registry.json` (format `abolish-election-registry-vectors/1`, see [[vectors/README|vectors]]) gives election identifiers and inputs with no `u64` encoding. TypeScript (`packages/crypto`) and Solidity (`packages/contracts`) tests both consume it; the Solidity tests also run every vector of `vectors/election-definition.json` through the contract's decoder, rules and hashes.

### Known-weak

- **The trustee registry doesn't exist yet** (P1-18, next part). Until it does, the registry's ceremony check is tested against a stand-in, and nothing may be deployed.
- **No close-rule bounds** on the definition's timing fields (above).
- **Creation is permissionless**, so anyone can make the counter grow. Each creation costs its sender gas and reserves nothing anyone else needs.
- **Gas.** Registering a two-tier definition (about 500 bytes) costs about 115,000 gas in the tests, mostly decoding, the ceremony check, and three SHA-256 calls (stub, definition, accumulator); creating an election about 98,000. Each runs once per election, so neither is a hot path.
