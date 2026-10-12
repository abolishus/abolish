# Contracts

What our L2 contracts commit to, for a verifier that reads them from the chain and the archive alone. So far this page specifies the event accumulator every Abolish contract keeps, the election registry, and the board anchor, our one contract on L1 (P4-1). The trustee key registry, direct submission, the contract-event record (`0x0008`) with its inclusion evidence, and the close rule are still P1-18's, and are added here as they are built. Notation is from [[notation]], tags from [[domain-separation]].

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

**The shared event sequence.** One registry serves every election it creates, so its accumulator covers every creation and registration, including elections that never get a definition (anyone can create one, for gas). The contract-event record (`0x0008`, P1-18 part 4) and [[verifier]] 4.4 (P1-19) MUST therefore replay a shared contract's whole event sequence from the archive, authenticated by the accumulator's storage proof, and require board entries only for the events the election's checks use: those that name the election, each of its tiers' group creation and group additions and removals up to each `root_l2_block`, and its panel's key and ceremony registrations ([[verifier]] 4.4). Every other event of a shared contract need only be in the archive, which the deployment keeps for every event of each of its contracts, independent of any one election's board (P1-16, part 4). Otherwise every junk creation would have to be boarded on every live election's board, a cost that grows with elections times junk creations (T-52), or a verifier looking only at the election's own board would fail every election through that registry (T-53). Whatever a creation's transaction carries besides its 4-byte calldata (an outer call from the creator's own contract, an access list) reaches the archive only if part 4 keeps raw transactions in `0x0008`; T-17 records the residual until it decides.

A verifier takes the definition's registration from `DefinitionRegistered` on the registry its release pins, recomputes `definition_hash` from the bytes, and finds the election's creation, and no second registration, in the same contract's event sequence ([[verifier]] 2.1, 4.4). The creator's address is public; it is the account that runs the election, not a voter.

### Vectors

`vectors/election-registry.json` (format `abolish-election-registry-vectors/1`, see [[vectors/README|vectors]]) gives election identifiers and inputs with no `u64` encoding. TypeScript (`packages/crypto`) and Solidity (`packages/contracts`) tests both consume it; the Solidity tests also run every vector of `vectors/election-definition.json` through the contract's decoder, rules and hashes.

### Known-weak

- **The trustee registry doesn't exist yet** (P1-18, next part). Until it does, the registry's ceremony check is tested against a stand-in, and nothing may be deployed.
- **No close-rule bounds** on the definition's timing fields (above).
- **Creation is permissionless**, so anyone can make the counter grow. Each creation costs its sender gas and reserves nothing anyone else needs.
- **Gas.** Registering a two-tier definition (about 500 bytes) costs about 115,000 gas in the tests, mostly decoding, the ceremony check, and three SHA-256 calls (stub, definition, accumulator); creating an election about 98,000. Each runs once per election, so neither is a hot path.

## Board anchor

Threats: T-23 (board tampering), T-24 (equivocation), T-52 (front-running an election's anchor), T-53 (discreditation), T-49 and T-50 (outages and censorship that miss a deadline, and finding the archive once our domain and hosting are gone), T-51 (data loss), T-17 (chosen bytes on L1), T-69 (a compelled or seized anchoring key).

The board anchor is our one contract on L1. It records, once per election and segment, the hash of the board's checkpoint after that segment ([[board]], Segments and checkpoints), and publishes the checkpoint itself in the same log, so every checkpoint is attributable to its election and segment from L1 alone. Each call may also carry the `archiveLocator` [[0005-permanent-archive]] requires (Archive objects and how they are found), so the archive is found from L1 alone. It is immutable: no owner, proxy, pause or upgrade path. Its clock and its anchoring authority are fixed at deployment as immutables, which solc writes into the runtime code. A verifier release pins the anchor's address together with its `epoch`, `period`, `deadline` and `authority`; [[verifier]] 1.2 compares the runtime code with the release build with the immutables' byte ranges masked, and requires the masked words to equal those pinned values, so the clock a verifier applies is the deployed one, read from code, never from a call. The definition's `l1_anchor` names it.

### Deployment

The anchor is deployed with the anchoring clock of [[board]], Timing, and the address of the anchoring authority, all immutable:

| Value       | Deployed value            | Meaning                                                                                                                                                                           |
| ----------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `epoch`     | a whole hour, in L1 time  | The start of period 0. The L2 registry carries the same value (Election registry, Deployment).                                                                                    |
| `period`    | 3,600 seconds             | Hourly anchoring, as the brief sets.                                                                                                                                              |
| `deadline`  | 43,200 seconds (12 hours) | How long after a period ends its checkpoint may still be anchored.                                                                                                                |
| `authority` | our Safe on L1            | The only account that can anchor. Version-1 definitions bind no authority of their own ([[election-definition]], The seal), so this is the authority [[board]], Anchoring, means. |

Deployment reverts if `period` is 0, or if `authority` has no code or only an [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) delegation (`0xef0100 ‖ address`): both are a single key. Code doesn't prove a multisig (a 1-of-1 Safe passes), so the deployment record (`packages/contracts/deployments/<chain-id>.json`) names the Safe, its owners and its threshold at deployment. A Safe's owners and threshold can change afterwards; nothing here pins them over time (Known-weak). Because the clock is in the anchor, never in a definition, no one can choose a deadline after seeing a board (T-24, T-53).

**Why 12 hours.** [[board]], Residuals, asks P4-1 to justify the deadline against two costs. A missed deadline fails the election permanently (T-49, T-50, T-53): 12 hours covers an overnight outage of the anchoring service before anyone is paged, a fee spike that prices out a few hourly attempts, a Safe signer offline for part of a day, and L1 censorship far longer than Ethereum's observed inclusion delays, with twelve hourly retries from independent runners inside the window. It assumes the custody P4-1 part 2 sets up: hourly anchoring is unattended, so each runner holds a signer key online, and the Safe's threshold is met by runners on independent hosting (T-69, Known-weak). The fork window it opens is bounded the other way: a voter's client can check a receipt against its segment's checkpoint as soon as it is anchored (the anchor admits no second one), and completes [[board]] client rule 2, which also needs every earlier segment's checkpoint, after its segment's deadline, at most `period + deadline` (13 hours) after casting; and a closed election is verifiable at most 12 hours after its seal's period ends. Elections run for days, so a same-day confirmation is enough, and anchoring runs hourly regardless: the deadline is the bound on a failure, not the normal delay. A shorter deadline would make one bad night fail an election; a longer one would let a voter's receipt stay unconfirmed into the next day.

### Anchoring

`anchor(bytes checkpoints, bytes locator)` takes zero or more checkpoints, each `encode(checkpoint)` of [[board]] (108 bytes: `election_id ‖ u32(segment) ‖ u64(size) ‖ head ‖ root`), concatenated, so one transaction can carry several elections' checkpoints, and an archive locator, possibly empty (Archive locator, below). The call reverts, anchoring nothing, unless:

1. the caller is `authority` (T-52: no one else can front-run an election's checkpoint with a bogus one);
2. the calldata is exactly the ABI encoding of the two `bytes` arguments (offsets `0x40` and `0x60 + pad32(len(checkpoints))`, tails in that order, zero padding, nothing after the second), the call carries a checkpoint or a locator, `checkpoints` is a multiple of 108 bytes, and a non-empty `locator` is well framed (T-17);
3. every checkpoint has `size ≥ 1`: an empty board's checkpoint fails the election (`checkpoint-size`), so it is never stored;
4. for every checkpoint, `end ≤ block.timestamp ≤ end + deadline`, where `end = epoch + (segment + 1)·period` is the end of its period ([[board]], Timing);
5. no checkpoint has been stored for its election and segment, in an earlier call or earlier in this one, even an equal one. Refusing an equal one too keeps the rule a plain write-once; the job that anchors (P4-1 part 2) reads the slots first, so a batch never carries a checkpoint another runner already anchored.

For each checkpoint, in order, it stores `checkpoint_hash = H(DS("abolish/v1/board-checkpoint", encode(checkpoint)))` for `(election_id, segment)`, lowers the election's lowest anchored segment if `segment` is below it (or sets it, for the election's first anchor), and emits

| Event                                                                                                                                             | Topics                                                        | Data                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------- |
| `CheckpointAnchored(bytes32 indexed electionId, uint32 indexed segment, bytes32 indexed checkpointHash, uint64 size, bytes32 head, bytes32 root)` | `election_id`, `segment` as a 32-byte word, `checkpoint_hash` | `size`, `head`, `root`, ABI-encoded |

through the event accumulator (above), which the anchor inherits like every Abolish contract, with `chain_id` the L1's. After the checkpoints, a non-empty locator is logged as

| Event                                                   | Topics                      | Data                                      |
| ------------------------------------------------------- | --------------------------- | ----------------------------------------- |
| `ArchiveLocated(uint16 indexed version, bytes locator)` | `version` as a 32-byte word | the whole locator, ABI-encoded as `bytes` |

### Archive locator

[[0005-permanent-archive]] has every L1 anchor carry a generic, versioned `archiveLocator` naming the latest confirmed archive manifest, with no storage scheme fixed in the contract, so the archive can change without a redeploy. The anchor frames it and doesn't interpret it: `locator = u16(version) ‖ body`, with `version ≠ 0` (so a zero word never reads as a locator), a body of at least 1 byte, and at most `MAX_LOCATOR_LENGTH = 128` bytes in all, which bounds the authority's chosen bytes per locator, not in total (T-17, Known-weak). Each version's body, starting with version 1 for an Arweave manifest, is specified with the manifest by P4-3, as a fixed length per version, with vectors. A verifier ignores versions it doesn't know, reporting them ([[verifier]] 4.3), and, once P4-3 fixes each version's body length, reports a locator of the wrong length for its version.

A call may carry a locator alone, with no checkpoint, at any time: the locator isn't tied to a period. Two readings of [[0005-permanent-archive]] follow, listed under Decisions to review in STATUS:

- Its "final anchor", which waits until every manifest holding a closed election's CARs is confirmed, is a locator-only call made whenever the archive confirms. The seal's checkpoint doesn't wait for it, so a slow archive can't push the seal past its deadline, and the deadline justification above is unchanged.
- "Each L1 anchor carries" a locator: the contract allows a call without one (there is none before the first manifest confirms), but the job that anchors (P4-1 part 2) MUST include the latest confirmed locator in every call that carries checkpoints once one exists, so no anchored period lacks a locator at or after it.

The anchor also keeps the last locator and the number posted in state, so the archive is found from a storage proof alone, even once the logs that carried locators have expired from L1 history ([EIP-4444](https://eips.ethereum.org/EIPS/eip-4444)):

- the last locator is a Solidity `bytes` at slot `A + 2`: for a locator of `len ≤ 31` bytes the slot holds the bytes left-aligned with `2·len` in its lowest byte; for a longer one it holds `2·len + 1`, and the bytes start at slot `keccak256(abi.encode(A + 2))`, 32 per slot;
- the count is the word at `A + 3`.

A verifier proves both at `B`, follows the last locator to its manifest, and from there walks the manifest chain back ([[0005-permanent-archive]]), which names every confirmed manifest. Every earlier locator is in an `ArchiveLocated` log; while L1 history serves them, a verifier that wants them all replays the anchor's logs against its event accumulator ([[contracts]], Event accumulator, Verification), which covers every checkpoint of every election as well, about 100 logs an hour at 100 live elections, so the latest locator from state is the path that scales.

The anchor doesn't know an election's seal ([[board]], Timing): it is computed from the definition, which lives on L2. A verifier ignores an anchor for a segment after the seal. Nor does it check that an election's checkpoints grow with their segments: with a 12-hour deadline, a later segment can be anchored before an earlier one, and [[board]], Board checks, catches an inconsistent pair from L1 alone (`checkpoint-inconsistent`).

### Verification

Rule 5 means L1 never holds two checkpoints for one election and segment, and rules 1 and 4 mean every stored one counts: it came from the authority, inside its window. So a verifier reads an election's anchors completely from state, never from a list of logs an RPC node could shorten (T-24):

- The hash for `(election_id, s)` is the word at `keccak256(abi.encode(uint256(s), keccak256(abi.encode(election_id, A))))`, where `A` is the [ERC-7201](https://eips.ethereum.org/EIPS/eip-7201) namespace `abolish.board-anchor`:

  ```
  A = keccak256(abi.encode(uint256(keccak256("abolish.board-anchor")) − 1)) & ~0xff
    = 0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00
  ```

  Zero means none was anchored. The election's **lowest anchored segment** plus one (0 if it has no anchor) is the word at `keccak256(abi.encode(election_id, A + 1))`. An election's board carries entries from before voting opens (the ceremony transcript, the contract events of its creation and registration), so no bound derived from `opens_at` would do. The verifier proves that word, then the word for every segment from the lowest one to the seal, all with `eth_getProof` against the state root of one finalized L1 block `B` (how it trusts L1 headers is [[verifier]]'s), and never trusts an `eth_call` answer. `B`'s timestamp is the `now` of [[board]], Board checks: proving at one block and taking `now` from a later one would read a segment anchored in between as `unanchored`, or miss a checkpoint anchored there, so two verifiers could disagree (T-36).

  A segment below the lowest one has no anchor, so its entries fail `unanchored` once its window has closed. For an honest authority the range from the lowest segment to the seal is as long as the election's board is, in hours. Election identifiers are predictable, so an authority could anchor a checkpoint for an election long before it exists and stretch the range. Since the operator can label junk entries with that early segment (entries are unsigned, and junk is only rejected entries), such a checkpoint can be valid, so the stretch costs every verifier and voter's client one storage proof per hour back to it, without changing a verdict (Known-weak).

- For each non-zero word it needs the checkpoint itself. A word equal to the hash of the checkpoint a board copy gives at that segment's boundary needs nothing more: the contract stored it only inside its window, so its `anchoredAt` for [[board]], Board checks, may be taken as the end of its period, which gives the same result as the true time (timely, and at most `now`, since the word is proven at `B`). Only a word no copy matches needs the `CheckpointAnchored` log that wrote it, emitted by the pinned anchor, with its receipt's inclusion in a finalized block no later than `B`, to name the checkpoint and attribute the failure. So old elections stay verifiable from state and the archive, without old L1 receipts, which ordinary nodes drop under history expiry ([EIP-4444](https://eips.ethereum.org/EIPS/eip-4444)). A non-zero word that matches no checkpoint anyone can produce makes the election unverifiable ([[board]], Anchoring).

The anchor's own event accumulator gives the same completeness for its log sequence, but the per-segment words are what a verifier needs, and they need no archive replay.

### Vectors

The checkpoint hash and the window rule are the ones `vectors/board.json` already exercises: the Solidity tests hash every checkpoint there and compare it with the published `hash`, and anchor the `valid` board's checkpoints at their vector times, under the vectors' own clock.

### Known-weak

- **The anchoring authority can fail a running election** by anchoring a checkpoint no board matches, before the honest one (rule 5 then keeps it). That is attributable on L1, but nothing prevents it (T-24, T-53, T-69). A late anchor can't do it: the window closes 12 hours after each period, and no anchor lands before its period ends.
- **The quorum is held online.** Unattended hourly anchoring means the runners hold enough signer keys to meet the Safe's threshold, so seizing or compelling those runners (T-69) is seizing the quorum. The Safe protects against one leaked key and one rogue runner, not against whoever controls the runners' hosting.
- **The Safe's configuration can change after deployment**, and the anchor pins only its address. A quorum can reduce the owners or threshold, or make one key the authority without touching either: by enabling a module (which executes as the Safe with no signatures, a common way to automate jobs), setting a guard or fallback handler, or delegatecalling to replace the proxy's singleton. P4-1 part 2 MUST use no module or guard that bypasses the threshold, and the verifier's check of the Safe (owners, threshold, modules, guard, fallback handler and singleton at each anchoring block) is still to come; until then such a change is visible only in the Safe's own public transactions.
- **An early anchor stretches the slots to prove.** An authority that anchors for a predictable `election_id` long before the election exists makes every verifier and voter's client prove one slot per hour from there (about 8,760 a year), even if the operator makes that checkpoint valid with junk entries. It costs work, never a verdict.
- **Withheld tails and late forks** remain [[board]]'s residual: an authority that anchors a checkpoint extending every receipt with entries it never publishes makes the election unverifiable, not failed. [[board]], Residuals, names binding a content address of each segment object into what is anchored as a candidate fix; this anchor's 108-byte checkpoint doesn't carry one. P4-1 leaves that fix to P4-3, which adds the segment objects' content addresses: adopting it means a new anchor deployment, a registry naming it and a new verifier pin. Before mainnet that costs only a redeploy, and nothing is deployed yet.
- **No checkpoint for a segment past the seal is refused on L1**: the anchor can't read the definition. Verifiers ignore it; it costs the authority gas and changes no result.
- **The authority chooses 108 bytes per checkpoint and up to 126 per locator**, with no limit on how many beyond gas (locator-only calls at any time, checkpoints for any identifier), that land on L1 for good, such as a checkpoint for an election that doesn't exist, or a locator body of a version no one defined (T-17). Only the authority can, and the deployment's Safe is accountable for it.
- **A locator only names where the archive is.** A wrong or stale one can send verifiers nowhere, which makes an election unverifiable, never verified: everything found is checked against the anchored checkpoints. The manifest chain ([[0005-permanent-archive]]) gives a second path to every manifest.
- **Gas.** In the tests a call with one checkpoint costs about 84,000 gas, and each further checkpoint in the same call about 34,000: a storage write, a read of the lowest-segment word, two SHA-256 calls (the hash and the accumulator) and a log. A locator adds about 24,000 (its slots and log). An election's first anchor costs about 22,000 more, for its lowest-segment word. At 100 live elections, hourly, that is about 3.4 million gas an hour, a recurring L1 cost: on testnets it is free, and spending real funds on it is the owner's decision.
- **The deployment, the Safe and the hourly job don't exist yet** (P4-1 part 2, with the worker and a `ci:` deploy workflow for Sepolia). Until then, nothing is anchored and every board is unanchored.
