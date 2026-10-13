# Contracts

What our L2 contracts commit to, for a verifier that reads them from the chain and the archive alone. So far this page specifies the event accumulator every Abolish contract keeps, the election registry, the trustee registry, the group registry with its Tier 0 additions (P3-2), and the board anchor, our one contract on L1 (P4-1). The group registry's Tier 1 and Tier 2 additions (P3-3, P3-4), direct submission, the contract-event record (`0x0008`) with its inclusion evidence, and the close rule are still P1-18's, and are added here as they are built. Notation is from [[notation]], tags from [[domain-separation]].

## Event accumulator

Threats: T-71 (L2 governance or our server hiding an event), T-25 (a direct-submitted ballot withheld from the board), T-24 (equivocation). Decided by [[0005-permanent-archive]], Consequences, "L2 events".

Our server writes the board, and inclusion proofs show only that an event exists, never that none was left out. So every Abolish contract keeps a running hash and a counter over every log it emits, in its own storage, and each step also binds the block that emitted the log. Storage is committed by the L2 state root, which L1 output roots commit to, so an account and storage proof (`eth_getProof`) of these two values at an L2 block pins the contract's whole event sequence up to that block, each event with its block number and timestamp. The block is always the emitting chain's: the board anchor, our one contract on L1, binds L1 blocks, and its evidence is L1's own state (Board anchor). A verifier replays the archived sequence and compares ([[verifier]] 4.4, P1-19). This is the only evidence archived for our contracts' events: no transaction, receipt or block header ([[0025-contract-event-evidence]]).

The tag is `abolish/v1/event-accumulator-2`. The first layout, under `abolish/v1/event-accumulator`, bound no block; it stays frozen with its vectors (`vectors/event-accumulator.json`) and no Abolish contract is deployed with it ([[0025-contract-event-evidence]], Consequences).

### Values

- **Genesis.** At deployment the contract stores

  ```
  acc_0 = H(DS("abolish/v1/event-accumulator-2", u8(0) ‖ u64(chain_id) ‖ bytes[20](address)))
  ```

  and a count of 0, where `chain_id` is the chain's EIP-155 identifier (`block.chainid`) and `address` the contract's own address. Binding both means one contract's event sequence can't be presented as another's, here or on another chain where the same address is deployed (T-71). It doesn't separate the two sides of a fork after deployment, which share the stored value: that is the job of the pinned L2 and the output root the storage proof is checked against (Verification). A contract MUST revert its deployment if `chain_id` is 2⁶⁴ or more, since it has no `u64` encoding.

- **Step.** For its `n`-th log (0-based), emitted in the block with number `b` and timestamp `τ` (`block.number` and `block.timestamp`, read in the call that emits it), with topics `t_0 … t_{k−1}` and data `d`, the contract sets

  ```
  acc_{n+1} = H(DS("abolish/v1/event-accumulator-2",
                   u8(1) ‖ acc_n ‖ u64(n) ‖ u64(b) ‖ u64(τ) ‖
                   u8(k) ‖ t_0 ‖ … ‖ t_{k−1} ‖ u32(len(d)) ‖ d))
  ```

  and the count to `n + 1`. A contract reverts the emitting call if `b` or `τ` is 2⁶⁴ or more, since it has no `u64` encoding. Each topic is the log's 32-byte topic as emitted, and `d` its data bytes as emitted (the ABI encoding of the event's non-indexed fields). `k` is 1 to 4. A log with no topics (a Solidity anonymous event) is never emitted, so `t_0` is always the event's signature hash.

The leading `u8` separates the two input layouts, and fixed widths plus the length of `d` make each input parse one way. The index `n` is redundant with the chain but makes each step's position explicit, so a verifier can report which event diverged. `b` and `τ` place each event on L2 for the checks that compare it with a block or a time ([[verifier]] 2.4, 5.5), with no header or receipt: the accumulator authenticates them with the rest of the step.

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

Given a contract's address, the chain ID, its archived logs in order of `n`, each with its `b` and `τ`, and a storage proof of `S` and `S + 1` at an L2 block `B`, a verifier recomputes `acc` and the count from genesis over the logs. The archive matches the contract at `B` exactly when, for the proven count `c`:

1. the logs are numbered `0, 1, …` with no gap, and `b` and `τ` never decrease from one log to the next;
2. every log with `n < c` has `b ≤ B`, and the log `n = c`, if the archive holds one, has `b > B`;
3. the accumulator over logs `0 … c − 1` equals the proven value.

The rules are checked in that order, and the first that fails is reported: `index` (a log out of sequence: rule 1's numbering, checked over the whole archive first), `order` (a block number or timestamp that decreases, checked only once every log is numbered in sequence), `block-range` (rule 2) or `accumulator` (rule 3, including an archive holding fewer than `c` logs).

Anything else (a log left out, added, altered or reordered, a log from another contract or chain, or a log moved to another block) gives a different accumulator or breaks rule 1 or 2, except with negligible probability under SHA-256's collision resistance. The proof at `B` is of the state after `B`, so it covers `B`'s own logs; rule 2 keeps a log from being counted on the wrong side of `B` without changing the accumulator, and rule 1 holds for every honest history, since L2 block numbers and timestamps never decrease. This assumes the genesis and count the release constructor writes; until [[verifier]] 1.2 binds each deployment to the release creation code (Board anchor, Known-weak, Constructor effects aren't bound), a deployer's own initcode could start the accumulator elsewhere. The storage proof is an account proof for the contract's address as the verifier pins it ([[verifier]], Pinned trust roots; its bytecode is checked by 1.2) under the state root that the output root commits to, plus a storage proof of each slot. The storage trie holds each value as the RLP of its minimal big-endian bytes, and omits a zero value: the verifier decodes the value, left-pads it to 32 bytes, and reads an absent slot as zero. The accumulator commits to each log's order and block, never to its transaction: nothing about the transaction is archived ([[0025-contract-event-evidence]]). [[verifier]] 4.4 says when this is checked and what the result is worth: a storage proof is only as good as the output root it is proven against ([[0004-l2-choice]], T-71 residual).

### Vectors

`vectors/event-accumulator-2.json` (format `abolish-event-accumulator-vectors/2`, see [[vectors/README|vectors]]) gives genesis values, event sequences with each event's block and the accumulator after every step, proof checks, including histories that break each rule of Verification, and rejected inputs. TypeScript (`packages/crypto`) and Solidity (`packages/contracts`) tests both consume it. `vectors/event-accumulator.json` is the frozen first layout's, consumed by nothing.

### Known-weak

- The accumulator proves that the archive matches the contract's storage, not that the storage is honest: L2 governance that rewrites state can rewrite it too (T-71, detection only, through the evidence each event carries).
- Each event costs one SHA-256 precompile call over its log, plus two storage writes: 60 gas plus 12 per 32-byte word for the hash; binding `b` and `τ` adds at most one word. Voters don't transact to vote, so it is mostly our gas, but a direct submitter (T-25) pays it for their own submission.

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

The registry doesn't check what only the board can show: that each root is the root of its tier's additions at `root_l2_block`, each `group_size`, each group's tier, the panel against the pinned panels, or the version pins against a verifier release ([[verifier]] 2.3 to 2.5). It doesn't yet refuse a profile that fails [[verifier]] 2.3's `profile-combination`: one pinning ballot version 1 or 2 without board-entry version 3 or 4 ([[delivery]], Versions), tally-opening version 1 without board-entry version 4 ([[tally]], Destruction), definition version 3 or 4 with any ballot version but 2, ballot version 2 with any other definition version ([[ballot-validity]], Ballot record (version 2)), or ballot version 2 with a spoiled-ballot opening version that doesn't open its cores, which today is every one ([[challenge]], Versions). Both pages require the registry to refuse such a profile, and that check MUST be added before any registry is deployed. It doesn't bound `l1_inclusion_bound`, `sequencing_window` or `max_sequencer_drift` either: the close rule (P1-18, direct submission) says what values it needs, and no registry may be deployed before it does, since a deployed registry's rules can't change.

### Events

Each event goes through the event accumulator, with topic 0 the keccak-256 of its signature (the standard ABI):

| Event                                                                                                                                                                       | Topics                                       | Data                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ElectionCreated(bytes32 indexed electionId, address indexed creator, uint64 counter, uint64 l1OriginNumber, uint64 l1OriginTimestamp, bytes32 l1OriginHash)`               | `election_id`, the creator as a 32-byte word | `counter` and the block's L1 origin, ABI-encoded (128 bytes)                                                                                                |
| `DefinitionRegistered(bytes32 indexed electionId, bytes32 indexed definitionHash, uint64 l1OriginNumber, uint64 l1OriginTimestamp, bytes32 l1OriginHash, bytes definition)` | `election_id`, `definition_hash`             | The block's L1 origin, then the definition's full canonical encoding as `bytes`, ABI-encoded, so the board and any verifier rebuild it from the chain alone |

**The L1 origin.** Both events carry the L1 origin of the L2 block that emitted them: the number, timestamp and hash that the OP Stack's `L1Block` predeploy (`0x4200000000000000000000000000000000000015`) reports in the emitting call, as `uint64`, `uint64` and `bytes32`. The predeploy's address is a constant of the contract, never a deployment input, and on a chain without it both calls revert. The accumulator authenticates the three values with the rest of the event, so no L1-attributes transaction, header or receipt is archived for them ([[0025-contract-event-evidence]]). The creation's origin fixes the election's first segment `f` (Board anchor, Verification); the registration's is compared with a retired version's cutoff ([[versioning]], Old versions stay verifiable; [[verifier]] 2.3).

The registry doesn't check them, since it can't see L1, and a sequencer chooses a block's origin within `max_sequencer_drift`, so a verifier never takes them as read. For each of the two events it checks, failing 4.4 and naming the event otherwise ([[verifier]] 4.4):

1. `(l1OriginNumber, l1OriginTimestamp, l1OriginHash)` is one block of finalized L1: the block with that number has that hash and that timestamp, by the verifier's own trust in L1 headers ([[verifier]], Pinned trust roots);
2. `l1OriginTimestamp ≤ τ ≤ l1OriginTimestamp + D`, where `τ` is the event's L2 timestamp (Event accumulator, Step) and `D` the `max_sequencer_drift` the verifier's release pins for the deployment's L2 (1,800 seconds on Base, [[0004-l2-choice]]). Never the definition's own `max_sequencer_drift`: its creator chooses it, unbounded above ([[election-definition]]; [[verifier]] 2.6 only requires the chain to stay within it), so it can't bound its own registration's origin;
3. for `DefinitionRegistered`, the origin's number and timestamp are at or after those of the same election's `ElectionCreated`. Only the election's own two events are compared: other elections' events in the shared sequence are archived but never checked (The shared event sequence), so comparing with them would let one unchecked junk creation under a rewritten predeploy, naming a maximal origin, fail every later election through the registry.

Honest derivation always passes: an L2 block's timestamp is at or after its origin's, and the OP Stack's derivation drops a batch whose non-empty block runs more than the drift ahead of its origin, which every block holding one of these events is. So neither the sequencer nor L2 governance rewriting the predeploy (T-71, T-69) can name an origin that isn't a real L1 block, or one more than `D` before the event's own block, or a registration origin earlier than its creation's. Within `D` an earlier origin moves `f` down by at most `⌈D / period⌉` periods (one on Base, with hourly periods), which the creator's per-slot check covers, since it starts from the same event's `f` (Board anchor, Verification, Pre-creation anchors), and moves a registration's origin back past a retired version's cutoff only if the cutoff is less than `D` before the registration (T-34, [[versioning]]). A client checks the creation's origin the same way before it takes `f` from it ([[board]], Segments).

**The shared event sequence.** One registry serves every election it creates, so its accumulator covers every creation and registration, including elections that never get a definition (anyone can create one, for gas). The contract-event record (`0x0008`, P1-18 part 4) and [[verifier]] 4.4 (P1-19) MUST therefore replay a shared contract's whole event sequence from the archive, authenticated by the accumulator's storage proof, and require board entries only for the events the election's checks use: those that name the election, each of its tiers' group creation and group additions and removals up to each `root_l2_block`, and its panel's key and ceremony registrations ([[verifier]] 4.4). Every other event of a shared contract need only be in the archive, which the deployment keeps for every event of each of its contracts, independent of any one election's board (P1-16, part 4). Otherwise every junk creation would have to be boarded on every live election's board, a cost that grows with elections times junk creations (T-52), or a verifier looking only at the election's own board would fail every election through that registry (T-53). Whatever a creation's transaction carries besides its 4-byte calldata (an outer call from the creator's own contract, an access list) reaches the archive only if part 4 keeps raw transactions in `0x0008`; T-17 records the residual until it decides.

A verifier takes the definition's registration from `DefinitionRegistered` on the registry its release pins, recomputes `definition_hash` from the bytes, and finds the election's creation, and no second registration, in the same contract's event sequence ([[verifier]] 2.1, 4.4). The creator's address is public; it is the account that runs the election, not a voter.

### Vectors

`vectors/election-registry.json` (format `abolish-election-registry-vectors/1`, see [[vectors/README|vectors]]) gives election identifiers and inputs with no `u64` encoding. TypeScript (`packages/crypto`) and Solidity (`packages/contracts`) tests both consume it; the Solidity tests also run every vector of `vectors/election-definition.json` through the contract's decoder, rules and hashes.

### Known-weak

- **No close-rule bounds** on the definition's timing fields (above).
- **Creation is permissionless**, so anyone can make the counter grow. Each creation costs its sender gas and reserves nothing anyone else needs.
- **The L1 origin is checked only by verifiers and clients** (The L1 origin, above): the registry records what the predeploy reports, and within the drift the sequencer, or L2 governance rewriting the predeploy, chooses it (T-71, T-69).
- **The pinned drift must keep up with the chain.** If the L2 raises its `max_sequencer_drift` above the one a verifier release pins (Base can, without delay, [[0004-l2-choice]]), honest events whose origin lags by more than the pinned value fail 4.4, attributed to no one, until a release pins the new value; a pinned value raised past a period lengthens the creator's per-slot check to match. Liveness only.
- **The registry depends on the predeploy.** L2 governance that makes `L1Block` revert stops every creation and registration, a denial of service it can already cause in other ways (T-69, T-25).
- **Gas.** Registering a two-tier definition (about 500 bytes) costs about 125,000 gas in the tests, mostly decoding, the ceremony check, three SHA-256 calls (stub, definition, accumulator) and the three reads of the L1 origin; creating an election about 108,000. Each runs once per election, so neither is a hot path.

## Trustee registry

Threats: T-71 (trusting who sent a transaction), T-37 (a ceremony carried into another definition, a stolen identity key), T-14 (fewer than `k` parties opening ballots), T-31 (malleable signatures), T-17 (chosen bytes in the archive), T-25 (blocking a legitimate election).

The trustee registry pins the deployment's trustee panels and records, for each definition stub, the one ceremony transcript a quorum of a panel's seats approved. The election registry asks it `ceremonyRecorded` before admitting a definition (Election registry, rule 8). It is immutable: no owner, proxy, pause or upgrade path, no way to add, change or remove a panel, and it inherits the event accumulator above.

### Deployment

The registry is deployed with a non-empty list of panels. For each it takes the threshold `k`, a **quorum** `q`, the seats' keys as their `p256-key` encodings in seat order ([[trustee-identity]], Identity key), and each key's point `(x, y)`. It refuses the deployment, naming the panel's position and the first failing check, in this order (checks 3 and 4 run seat by seat, so a seat's key is checked, then compared with the earlier seats', before the next seat's):

1. `n ≤ MAX_TRUSTEES`, where `n` is the number of points (`size`);
2. `2 ≤ k ≤ n` (`threshold`);
3. the encodings are exactly `33 · n` bytes, and each seat's encoding is the encoding of its point: first byte `0x02 + (y mod 2)`, the same `x`, and `(x, y)` on the curve with `x, y < p`, checked with OpenZeppelin's `P256.isValidPublicKey` (`key`). An encoding passes this for some point exactly when `p256-key` accepts it, so the deployment pins exactly the keys a verifier decodes, the two points with `x = 0` included;
4. no point repeats an earlier seat's (`duplicate-key`);
5. `k ≤ q ≤ n` (`quorum`);
6. its `panel_id` ([[trustee-identity]], Panel identifier), computed from `k`, `n` and the encodings, isn't an earlier panel's (`duplicate-panel`). Another quorum doesn't make another panel.

Checks 1 to 4 are [[trustee-identity]]'s panel rules, with its codes. Each pinned panel is logged as `PanelPinned`, so the board and any verifier read the deployment's panels and quorums from the chain alone. As for every contract, deployment reverts unless the chain ID fits a `u64`, which the registration statement's `l2_chain_id` needs.

**The quorum.** `q` is how many distinct seats must sign a registration. It is at least `k`, because a transcript fewer than `k` seats approved could register keys no `k` honest seats checked, and at most `n`. A deployment sets it per panel, and its deployment record (`packages/contracts/deployments/<chain-id>.json`) MUST carry it. Every deployment MUST set `q = max(k, n − 1)` for every panel it pins ([[0006-trustees]] rule 7, adopted by the owner on 2026-10-12: an election opens only when at least `n − 1` seats, and never fewer than `k`, take part). The contract itself still accepts any `k ≤ q ≤ n`, so the rule binds the deployment and the release: a release pins `q = max(k, n − 1)` for each panel it pins, [[verifier]] 3.1 requires that many approvals in `CeremonyRegistered` whatever the contract's `q`, and a release MUST NOT pin a deployment whose `PanelPinned` events show another `q` for any panel. A deployment with a lower `q` could only register a transcript the verifier then fails (an election discredited and stalled, never one with weaker secrecy); checking `q` in the constructor would remove even that. A panel pinned with a lower `q` would let fewer seats register a transcript, never fewer than `k`. The participation rule is also enforced where it matters for the result, whatever `q` is: an honest seat approves only a transcript with at least `max(k, n − 1)` qualified seats ([[ceremony]], Approval and re-runs), and [[verifier]] 3.2 fails any other (`ceremony-participation`); that is a property of the transcript, not of who approved it.

### Registration

`registerCeremony(bytes registration)` takes one record:

```
registration = panel_id ‖ stub_hash ‖ ceremony_transcript_hash ‖ u8(count) ‖ approval × count
approval     = u8(index) ‖ p256-sig
```

`panel_id`, `stub_hash` and `ceremony_transcript_hash` are `bytes[32]`, and `p256-sig` is [[trustee-identity]]'s 64-byte `r ‖ s`. The record is exactly `97 + 65 · count` bytes. Anyone may submit it. The registry checks, in this order, and reverts on the first failure (checks 7 and 8 run approval by approval: an approval's seat, then its signature, before the next approval's):

1. **Canonical calldata**, as for the election registry's `registerDefinition` (T-17).
2. **Length**: at least the 97-byte header, and exactly `97 + 65 · count` bytes. Nothing can be appended, so the record carries no bytes the layout doesn't define (T-17).
3. **The panel** is pinned.
4. **The transcript hash** isn't zero, the value a stub carries in its place ([[election-definition]], Stub hash and the ceremony).
5. **Quorum**: `count ≥ q`.
6. **Write-once**: nothing is recorded yet for this `stub_hash` and panel.
7. **The seats**: the approvals' indices are strictly increasing, the first at least 1 and the last at most `n`, so each seat counts once. ECDSA lets one key make many valid signatures on one statement, so counting signatures instead of seats would let one seat, or one stolen key, reach a quorum alone ([[trustee-identity]], Ceremony registration; T-14, T-37).
8. **The signatures**: each approval's signature verifies, under its seat's pinned key, on the ceremony registration statement ([[trustee-identity]], Ceremony registration) with `l2_chain_id = block.chainid`, `trustee_registry` this contract, and the record's `panel_id`, the approval's `index`, `stub_hash` and `ceremony_transcript_hash`. The registry builds the 125-byte statement and its digest `H(DS("abolish/v1/sig/ceremony-registration", m))` itself, and verifies through OpenZeppelin's `P256.verify` after checking `1 ≤ r < n` and `1 ≤ s ≤ (n − 1) / 2` itself ([[trustee-identity]], On chain). Every approval must verify, including any beyond the quorum, so no record holds a signature the panel didn't make.

It then records `ceremony_transcript_hash` for (`stub_hash`, `panel_id`) and emits `CeremonyRegistered`. A recorded transcript can't be changed or removed, and a second registration for the same stub and panel reverts, with the same transcript or another: a quorum can't hold a second set of keys in reserve for a definition ([[ceremony]], Approval and re-runs). The sender is never checked or recorded (T-71).

**Per stub and panel.** A stub names one panel, and an honest seat signs only for a stub that names its own ([[ceremony]], Stub checks). Recording per stub alone would let a quorum of another panel the deployment pins register first and block the stub's own panel for good (T-25); keyed by panel, its record is simply never asked for, since the election registry passes the definition's own panel.

`ceremonyRecorded(stub_hash, transcript_hash, panel_id, threshold, panel_size)` returns true exactly when `panel_id` is pinned with that threshold and size, and the transcript recorded for (`stub_hash`, `panel_id`) is non-zero and equals `transcript_hash`. `panel_id` already binds `k` and `n`; comparing them as well costs nothing and keeps the answer right whatever the caller passes.

### Events

Each event goes through the event accumulator, with topic 0 the keccak-256 of its signature:

| Event                                                                                                                       | Topics                                              | Data                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| `PanelPinned(bytes32 indexed panelId, uint8 threshold, uint8 quorum, bytes keys)`                                           | `panel_id`                                          | `k`, `q` and the `33 · n` bytes of encodings, ABI-encoded |
| `CeremonyRegistered(bytes32 indexed stubHash, bytes32 indexed panelId, bytes32 indexed transcriptHash, bytes registration)` | `stub_hash`, `panel_id`, `ceremony_transcript_hash` | The whole registration record, ABI-encoded as `bytes`     |

The panels are logged at deployment, so they are the first events of the registry's sequence (which, until 1.2 binds creation code, only the release constructor guarantees: Board anchor, Known-weak, Constructor effects aren't bound). A verifier finds an election's ceremony registration by its stub and panel, checks every approval against the panel its release pins ([[trustee-identity]], Ceremony registration), and counts the distinct seats whose approvals verify against the quorum its release pins for that panel, never the `q` in `PanelPinned`, which it compares with its own and reports if they differ (P1-19, [[verifier]] 3.1). It needs nothing else from the contract's state. Like the election registry, the trustee registry is shared by every election, so its event sequence is replayed whole from the archive ([[verifier]] 4.4; Election registry, The shared event sequence). Only a quorum can add an event to it, so it grows with ceremonies, not with junk.

### Vectors

The Solidity tests consume `vectors/trustee.json`: the deployment check accepts every key vector `p256Key` accepts and refuses every other, at any length; every signature vector verifies exactly when it is marked valid; every panel vector is pinned with its `panel_id`, or refused with its code; and every registration vector's message and digest are the ones the registry builds.

### Known-weak

- **The precompile is the chain's code, not ours or OpenZeppelin's.** The contract is built for `cancun`, which has no `P256VERIFY`, so the tests' default run takes `P256.verify`'s Solidity fallback (about 250,000 gas a signature). The package's test script runs the trustee registry's tests again on `osaka`, where Foundry provides the precompile (EIP-7951), so both paths pass every vector; a 7-seat registration then costs about 180,000 gas. Base implements the precompile itself (RIP-7212), and a disagreement between its implementation and Foundry's would first show on a testnet deployment.
- **The vendored library is checked against itself.** `test/vendor.test.ts` pins the vendored files' hashes, which the package README records with their upstream tag and commit; re-fetching them from upstream in CI needs a `ci:` change (rule B).
- **A quorum can register a transcript for any stub**, including one no election will register. It costs gas, blocks nothing, and needs `q` seats' signatures, but each such event puts 64 bytes the quorum chose (`stub_hash`, `ceremony_transcript_hash`) into the shared archive every verifier replays (T-17).
- **The quorum is the deployer's choice.** `q` is a constructor input held in storage, so verifier 1.2's bytecode check doesn't pin it, and a deployer can pick any `q` from `k` to `n`, or pin extra panels. The `k` floor holds whatever it picks. A verifier must not inherit the choice: it counts the distinct valid seats in the `CeremonyRegistered` record itself (Events, above), against the quorum its release pins.

## Group registry

Threats: T-06 (group stuffing by the operator), T-62 (contract admin abuse), T-71 (trusting who sent a transaction), T-08 and T-13 (an electorate that isn't public before voting), T-31 (malleable signatures), T-17 (chosen bytes in the archive), T-52 (junk in a shared event sequence), T-12 (linking a member to a poll).

The group registry holds the deployment's Semaphore groups. It fixes each group's tier when it creates the group and logs every addition and removal together with the authorisation a verifier rechecks, so [[verifier]] 2.4 rebuilds each tier tree ([[membership]], Tier tree) from the chain and the board alone. It keeps no Merkle tree: the roots elections use are tier-tree roots that verifiers compute from these events, and direct submission checks a ballot's proof against the root registered with its definition ([[membership]], Owned elsewhere), so a root kept on chain would be a second answer nothing may use. It is immutable: no owner, proxy, pause or upgrade path, and it inherits the event accumulator above.

This version adds members to **Tier 0** groups only. Tier 1 additions (anonymous vouches, [[0014-tier1-vouching]], P3-3) and Tier 2 additions (document proofs, [[0010-tier2-identity-provider]], P3-4) will be specified here before any group registry is deployed, since a deployed registry's rules can't change; until then `createGroup` refuses those tiers.

### Deployment

The registry is deployed with its **registrars**: `n` Ethereum addresses (secp256k1 keys) and a threshold `t`. [[0004-l2-choice]] (Governance as an adversary) has Tier 0 additions carry a threshold signature of our Safe's owners, checked by the contract and again by the verifier. This registry keeps that rule's purpose (no transaction spoofed from any address, by L2 governance or anyone else, adds members without `t` keys) with two departures, listed under Decisions to review in STATUS:

- **Pinned, not read from the Safe.** A Safe's owners, threshold and modules can change after deployment (Board anchor, Known-weak), and a verifier reading them would have to prove the Safe's state at every addition's block. Pinned, the set a verifier checks is the one the registry's first event logs and its release pins.
- **Dedicated keys, not the Safe's owner keys.** Tier 0 registration is automatic, so the signing service holds `t` registrar keys online (Known-weak). Registrar keys MUST be used for nothing else, never as owners of the Safe that holds the anchoring authority or any timelock, so that seizing the registration service seizes Tier 0 additions and nothing more (T-69, T-62). The deployment record names the registrars and who holds each key.

`t`, the cached EIP-712 domain separator and the chain ID it was computed for are immutables, which [[verifier]] 1.2 masks and compares with the values its release pins; the addresses are in storage, so the verifier checks them through `RegistrarsPinned` (Verification). Rotating the registrars means deploying a new registry, whose groups are new groups. Deployment reverts unless, in this order:

1. `2 ≤ n ≤ MAX_REGISTRARS = 16` (`size`);
2. `2 ≤ t ≤ n` (`threshold`): no single key adds or removes members (T-62);
3. no address is zero, and the addresses are strictly ascending as 160-bit integers (`order`), so none repeats and the set has one encoding;
4. the chain ID fits a `u64`, as for every contract.

`RegistrarsPinned` logs `t` and the addresses, and the deployment record (`packages/contracts/deployments/<chain-id>.json`) carries them.

### Groups

`createGroup(uint8 tier)` takes calldata of exactly its 4-byte selector and one word holding the tier, and creates group `group_id`, the number of groups the registry created before it, counted from 0 (the `group_id` of [[election-definition]]), with that tier, fixed for good. It reverts unless the tier is 0 (`1` and `2` are refused until their addition paths exist), and rather than let `group_id` leave the `u64` range.

Anyone can create a group. A new group has no members until the registrars add some, so creating one gives its sender nothing, and costs others only an event in the registry's shared sequence (Election registry, The shared event sequence; T-52). A group's tier is the one its `GroupCreated` event logs: the verifier takes it from there, never from a definition's label ([[election-definition]], A group's tier; [[verifier]] 2.4).

The identifier depends only on the counter, so an L2 reorganisation that reorders two creations swaps their identifiers. Every signed message binds the group's tier as well as its identifier (Signed messages, below), so a batch signed for one group can never land in a group of another tier; registrars MUST still sign for a group only once its `GroupCreated` event is in finalized L2 history, or a reorg could move a batch into a stranger's group of the same tier.

### Additions

`addMembers(bytes record)` takes one record:

```
record   = u64(group_id) ‖ u64(first_index) ‖ u16(count) ‖ field<bn254> × count ‖ u8(approvals) ‖ approval × approvals
approval = u8(seat) ‖ bytes[32](r) ‖ bytes[32](s) ‖ u8(v)
```

so the record is exactly `19 + 32 · count + 66 · approvals` bytes, with `approvals` the byte at offset `18 + 32 · count`. `r` and `s` are big-endian integers. Anyone may submit a record. The registry checks, in this order, and reverts on the first failure (the approvals are checked one by one, seat then signature, in record order):

1. **Canonical calldata**, as for the election registry's `registerDefinition` (T-17).
2. **Length**: at least 19 bytes, and exactly `19 + 32 · count + 66 · approvals`. Nothing can be appended (T-17).
3. **The group** was created by this registry, and its tier is 0.
4. **The batch**: `1 ≤ count ≤ MAX_BATCH = 256`, which bounds the gas, the log and the accumulator step of one call.
5. **The position**: `first_index` equals the group's member count, the number of commitments added to it so far (removals don't lower it), and `first_index + count ≤ 2³²`, the leaves of a tier tree ([[membership]], Tier tree).
6. **The commitments**: none is forbidden ([[membership]], Commitments and removals). Each is a canonical `field<bn254>` (below `r`), and none is `0`, `1` or `Poseidon2(0, 1)`:

   ```
   Poseidon2(0, 1) = 0x1bd20834f5de9830c643778a2e88a3a1363c8b9ac083d36d75bf87c49953e65e
   ```

   (circomlib's Poseidon with two inputs, the hash of the tier tree; Vectors, below, says where the value comes from).

7. **Enough seats**: `approvals ≥ t`.
8. **The seats and signatures**: each approval's `seat` is greater than the previous one's, at least 1 and at most `n`, so each registrar counts once; its `v` is 27 or 28, `1 ≤ r < N` and `1 ≤ s ≤ (N − 1) / 2` with `N` secp256k1's group order (the low-s rule of EIP-2, so a signature has one encoding, T-31); and `ecrecover` of the `AddMembers` digest (Signed messages) under `(v, r, s)` returns registrar `seat`'s address. Every approval must verify, including any beyond `t`, so no record carries a signature the registrars didn't make.

It then adds `count` to the group's member count and emits `MembersAdded`. Member `first_index + i`, leaf `first_index + i` of the tier tree, is the record's `i`-th commitment.

**Why the position is signed.** Binding `first_index` makes each signed batch land at one place, at most once: a replay, or a batch submitted out of order, reverts. So the group's sequence is exactly the one the registrars signed, and no relay can inflate a group's size by replaying a batch (T-06, T-13). Two batches signed for one position can't both land; the one submitted second is dead, and its members must be signed again at a later position. So the signing service MUST sign at most one batch per position, submit its records itself, and sign the next position only once the previous batch is final; a record handed to anyone else could be withheld to stall the group's queue (liveness only).

A commitment may repeat, within a group or across groups ([[membership]], Commitments and removals): the registry can't refuse a repeat without storing every commitment, and a repeated commitment is one identity with two leaves, which adds no voting identity but counts twice in `group_size`. The signing path MUST refuse a commitment the group already holds, and the forbidden ones (above).

### Removals

`removeMembers(bytes record)` takes one record:

```
record = u64(group_id) ‖ u64(size) ‖ u16(count) ‖ u64(index) × count ‖ u8(approvals) ‖ approval × approvals
```

exactly `19 + 8 · count + 66 · approvals` bytes, with `approvals` the byte at offset `18 + 8 · count`. `size` is the group's member count when the registrars signed. The registry checks, in this order: canonical calldata; the length; the group, as for additions (it exists and its tier is 0); `1 ≤ count ≤ MAX_BATCH`; `size` is at most the group's member count; index by index, that it is greater than the one before, below `size` and not removed already; then rules 7 and 8 of Additions over the `RemoveMembers` digest. It then marks each index removed and emits `MembersRemoved`. A removal sets that leaf of the tier tree to 0 ([[membership]], Commitments and removals); the member count doesn't change, so leaf numbering never shifts.

**Why `size` is signed.** Without it, a removal signed (by mistake or in a race) for an index no member has reached yet would stay valid for good: whoever holds it could submit it once a legitimate member lands there, removing that member at a moment of their choosing, just before an election's `root_l2_block`, say. With it, every index a signed removal names was a member's when it was signed. The signing path MUST set `size` to the member count in finalized L2 history and remove only members it has identified there.

[[membership]] lets a verifier meet stray removals (an index no addition has reached, a leaf already removed) and ignore them. This registry refuses them, so each of its removals changes exactly the leaves it names; a replayed removal reverts.

### Signed messages

Registrars sign [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data, an external format ([[domain-separation]]), so a registrar's signer, and anyone auditing it, sees what is signed in the standard's readable form ([[0004-l2-choice]]). The domain is

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name = "Abolish group registry", version = "1", chainId = block.chainid, verifyingContract = the registry
```

and the two message types are

```
AddMembers(uint64 groupId,uint8 tier,uint64 firstIndex,uint256[] commitments)
RemoveMembers(uint64 groupId,uint8 tier,uint64 size,uint64[] indices)
```

with `tier` the group's tier as the registry recorded it, `commitments` and `indices` the record's in record order. As EIP-712 defines them, `hashStruct(s) = keccak256(typeHash ‖ enc(s))`, where each integer is one 32-byte big-endian word and an array is `keccak256` of its elements' words concatenated, and the digest is

```
keccak256(0x19 ‖ 0x01 ‖ hashStruct(domain) ‖ hashStruct(message))
```

The domain binds the chain ID and the registry's address, and the message the group, its tier and, for additions, the position (for removals, `size`), so a signed batch can't be replayed on another chain or deployment, into another group or tier, or at another place in its group ([[verifier]] 2.4; T-30, T-32, T-06). The record carries the signatures, never the digest: the registry and every verifier recompute it.

### Events

Each event goes through the event accumulator, with topic 0 the keccak-256 of its signature:

| Event                                                                           | Topics                                         | Data                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `RegistrarsPinned(uint8 threshold, address[] registrars)`                       | none beyond topic 0                            | `t` and the addresses, ABI-encoded                |
| `GroupCreated(uint64 indexed groupId, uint8 indexed tier)`                      | `group_id` and the tier, as 32-byte words      | empty                                             |
| `MembersAdded(uint64 indexed groupId, uint64 indexed firstIndex, bytes record)` | `group_id` and `first_index`, as 32-byte words | the whole addition record, ABI-encoded as `bytes` |
| `MembersRemoved(uint64 indexed groupId, bytes record)`                          | `group_id`, as a 32-byte word                  | the whole removal record, ABI-encoded as `bytes`  |

The registrars are logged at deployment, so they are the registry's first event (which, until 1.2 binds creation code, only the release constructor guarantees: Board anchor, Known-weak, Constructor effects aren't bound).

### Verification

Like the other registries, the group registry is shared by every election, so a verifier replays its whole event sequence from the archive, authenticated by the accumulator ([[verifier]] 4.4; Election registry, The shared event sequence). For each tier group a definition names, the verifier ([[verifier]] 2.4):

- requires the registry's `RegistrarsPinned` to name exactly the set and `t` its release pins, and otherwise fails every group of that registry: a registry deployed from the release's bytecode with other registrars would accept additions the verifier doesn't count, and its removals, which name indices in the registry's numbering, would then zero other members' leaves in the verifier's;
- takes the group's tier from its `GroupCreated` event;
- selects the group's records by their events' `group_id` topic, and fails the group (`group-history`) if a record's own `group_id`, or an addition's `first_index`, differs from its event's topic;
- **replays the group's records itself**, in log order up to the tier's `root_l2_block`, keeping its own member count `c` (from 0) and removed set, and applies to each record every check the registry applies, with no state taken from the chain: the record decodes strictly as above (no forbidden commitment); its digest, recomputed with the chain ID and registry address its release pins and the tier from `GroupCreated`, carries at least the threshold its release pins of approvals, by distinct registrars of the set its release pins, in increasing seat order, every one of which verifies (rules 7 and 8); an addition's `first_index` equals `c` and `c + count ≤ 2³²`, after which its member `i` is leaf `c + i` and `c` grows by `count`; a removal's `size` is at most `c`, its indices are below `size` and none is removed already, after which those leaves are 0. For each record the verifier reports the first failing check in this order, so conforming verifiers name the same reason: decoding (`length`, `batch`, `forbidden-commitment`, `index-order`, `index-range`), the group (`group`), the approvals (`approvals`, `seat`, `signature`), the position or size (`position`, `size`), then removed leaves (`removed`). The registry's own revert order differs; only the verifier's is fixed;
- rebuilds the root and the member count from those leaves as [[membership]] defines them.

**A record that fails any of these checks fails every definition naming the group** (`group-history`, naming the record): the chain then shows a history this registry's rules forbid, so it was rewritten by L2 governance or a false output root (T-71), or comes from code other than the release's (1.2), and the verifier fails closed rather than guess which leaves were meant. On the release's bytecode with the pinned registrars, on an honest chain, no logged record fails them, so no registrant or relay can trigger this (the registry refuses forbidden commitments, so [[membership]]'s leaf-0 rule never applies to this registry's records). Rechecking the signed `first_index` and `size` against the verifier's own count is what makes a rewritten history detectable: a replayed or reordered batch, or one omitted before a later batch, breaks the signed sequence (T-71, T-06, T-13). Two omissions still check, and are caught only by an honest accumulator storage proof (4.4, the T-71 residual): dropping the **latest additions** before `root_l2_block`, which leaves a shorter sequence; and dropping **any removal**, anywhere, since removals don't move the count and carry no sequence number of their own, which keeps a member the registrars removed in the electorate. A per-group counter signed by every record would narrow the second to the tail as well; it isn't worth a second sequence while the first residual stands.

`applyGroupRecords` in `packages/crypto` performs exactly this replay for one group, with vectors for honest sequences and for replayed, reordered, omitted, stale and unsigned records, so independent verifiers agree (T-36).

`packages/crypto` decodes both records, computes both digests, counts a record's valid seats and replays a group (`group-registry.ts`), for the verifier and for the signing service; the contract and that code are checked against the same vectors.

**No member is linked to a poll.** The registry takes no election identifier, definition or nullifier, and an addition names only a group, a position and commitments. An election names a group and a root, never a member; a ballot proves membership in zero knowledge and carries a nullifier unrelated to the commitment ([[membership]], Scope). So nothing on chain joins a member to the polls they vote in (T-12, T-13). When a commitment is added is public, and a passkey account's timing is the account holder's; T-13 records that residual.

### Vectors

`vectors/group-registry.json` (format `abolish-group-registry-vectors/1`, see [[vectors/README|vectors]]), printed by `packages/crypto/scripts/group-registry-vectors.py`, an implementation written from this page and the EIP-712 and secp256k1 standards with Python's standard library only, gives: the domain separator and type hashes; addition and removal records with their digests, signed by fixed test keys, and each approval's recovered signer; records each check refuses; and the forbidden commitments. TypeScript (`packages/crypto`) and Solidity (`packages/contracts`) tests both consume it.

`Poseidon2(0, 1)` can't be computed by the generator, which has no Poseidon: the value was computed with `poseidon-lite` 0.3.0 (circomlib's constants), which in the same run gave circomlib's published `Poseidon2(1, 2) = 0x115cc0f5…189a` and the tier tree's `Z_1 = Poseidon2(0, 0)`. P1-17b's Poseidon, built from circomlib's parameters, MUST check this value.

### Known-weak

- **Tier 0 is the registrars' word** (T-06, not mitigated): any `t` registrars can add any commitments. What this registry adds is that each addition is attributable to `t` named keys, that no one else (no relay, no single registrar) can add, replay or reorder one, that L2 governance rewriting the history to do so is detected by every verifier (Verification; dropping the latest additions, or any removal, isn't), and that group sizes are public.
- **The quorum is held online.** Tier 0 registration is automatic (a passkey account behind Turnstile, P2-5), so the signing service holds `t` registrar keys hot, and seizing it is seizing Tier 0 additions (T-69). Hardware-held keys would need a person per registration.
- **The registrars can't rotate.** A lost or compromised key means a new registry, and every member registers again in its new groups. That is the cost of a set a verifier can check without the Safe's history.
- **Duplicates are the signing path's to refuse** (Additions): a repeated commitment overstates `group_size` by one.
- **Tiers 1 and 2 have no addition path yet** (P3-3, P3-4), and no registry may be deployed until they do.
- **No paymaster yet.** [[0004-l2-choice]] sponsors registration through our own ERC-4337 paymaster (P2-6, this item's later part); until then whoever submits an addition pays its gas.
- **Gas.** In the tests, adding one member with two of three approvals costs about 67,000 gas beyond the transaction's base cost and calldata, each further commitment in the same batch about 1,500, and a batch of 256 about 430,000: two `ecrecover` calls, the keccak hashes of the digest, the storage write and the accumulator step. Removing one member costs about 85,000, mostly its first write to the removed-index bitmap.

## Board anchor

Threats: T-23 (board tampering), T-24 (equivocation), T-52 (front-running an election's anchor), T-53 (discreditation), T-49 and T-50 (outages and censorship that miss a deadline, and finding the archive once our domain and hosting are gone), T-51 (data loss), T-17 (chosen bytes on L1), T-69 (a compelled or seized anchoring key), T-26 (unprovable drops: receipt keys fixed before voting).

The board anchor is our one contract on L1. It records, once per election and segment, the hash of the board's checkpoint after that segment ([[board]], Segments and checkpoints), and publishes the checkpoint itself in the same log, so every checkpoint is attributable to its election and segment from L1 alone. Each call may also carry the `archiveLocator` [[0005-permanent-archive]] requires (Archive objects and how they are found), so the archive is found from L1 alone. It also keeps the record of receipt keys that [[0023-receipt-evidence]] requires (Receipt keys, below), so the keys that judge an election's receipts are the same authority's. It is immutable: no owner, proxy, pause or upgrade path. Its clock and its anchoring authority are fixed at deployment as immutables, which solc writes into the runtime code. A verifier release pins the anchor's address together with its `epoch`, `period`, `deadline` and `authority`; [[verifier]] 1.2 compares the runtime code with the release build with the immutables' byte ranges masked, and requires the masked words to equal those pinned values, so the clock a verifier applies is the deployed one, read from code, never from a call. The definition's `l1_anchor` names it.

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

### Receipt keys

[[0023-receipt-evidence]] has the anchoring authority register every receipt key on L1 before any election lists it, and retire it there, so the keys that judge an election's receipts ([[election-definition]], Receipt keys) are fixed by L1 records only that authority writes, and evidence under them is attributed to it alone (T-26). The anchor keeps the record itself, so the writer is the deployment's immutable `authority` with no second contract, address or verifier pin. L2 governance can forge any sender on the L2, which is why the record is on L1 (T-71, [[0004-l2-choice]]).

`registerReceiptKey(bytes key)` and `retireReceiptKey(bytes key)` each revert unless:

1. the caller is `authority`;
2. the calldata is exactly the ABI encoding of one `bytes` argument of 33 bytes: the selector, offset `0x20`, length 33, the 33 bytes, 31 zero bytes, nothing after (T-17);
3. `key[0]` is `0x02` or `0x03`.

The contract doesn't check that `x` is on the curve, which would need a modular square root on chain: a definition can list only canonical keys ([[trustee-identity]], Identity key), so a registered non-key judges nothing, and only the authority can pay to register one. Then:

- `registerReceiptKey` reverts if the key has ever been registered, retired or not, or if its twin has: the key with the other prefix and the same `x`, which is its negation, whose secret key anyone holding the key's own also holds (so retiring a seized key also keeps its negation out); otherwise it sets the key's `registered_at` to `block.timestamp`.
- `retireReceiptKey` reverts unless the key is registered and not retired; otherwise it sets its `retired_at` to `block.timestamp`.

Nothing else writes either field and neither is ever cleared, so the record is append-only: a key is registered once, retired at most once, and never re-registered (T-69). Each emits, through the event accumulator,

| Event                                                   | Topics                       | Data                             |
| ------------------------------------------------------- | ---------------------------- | -------------------------------- |
| `ReceiptKeyRegistered(bytes32 indexed x, uint8 prefix)` | `x`, the key's last 32 bytes | `prefix` (`key[0]`), ABI-encoded |
| `ReceiptKeyRetired(bytes32 indexed x, uint8 prefix)`    | `x`                          | `prefix`                         |

The record of key `p ‖ x` is the word at `keccak256(abi.encode(x, keccak256(abi.encode(uint256(p), A + 4))))`: `registered_at` in its low 64 bits, `retired_at` in the next 64, the rest zero (Solidity's `mapping(uint8 => mapping(bytes32 => Record))` at `A + 4`, with `struct Record { uint64 registeredAt; uint64 retiredAt; }`). Zero means never registered, or not retired. A word with any of its high 128 bits set, or with `retired_at` set and `registered_at` zero or above it, can't be written by the release code, so [[verifier]] 2.9 fails the election on it (`receipt-key-record`) rather than reading either field from it, and the client refuses to cast. A verifier proves each listed key's word with `eth_getProof` at its finalized L1 block `B`, as it proves anchors (Verification, below), never from an `eth_call` or a list of logs, and applies [[election-definition]]'s judging rule ([[verifier]] 2.9); the ballot client reads the same words before casting. The words stay in state, so they survive L1 history expiry as the anchors do.

Custody and use:

- The receipt keys themselves sit in the board server's key service ([[receipts]], Residuals); the authority's quorum only registers and retires them, so it holds no receipt key.
- The authority registers a key well before any election lists it, and retires it as soon as a leak is suspected, and every key when it rotates it, so a seized key can't be listed in a later election by a hostile creator ([[0023-receipt-evidence]]). A retirement after an election's `opens_at` changes nothing for it.
- A registration costs about 65,000 gas, its transaction's base cost included (a new storage word, the accumulator and a log), once per key, never per election.

The anchor doesn't know an election's seal ([[board]], Timing): it is computed from the definition, which lives on L2. A verifier ignores an anchor for a segment after the seal. Nor does it check that an election's checkpoints grow with their segments: with a 12-hour deadline, a later segment can be anchored before an earlier one, and [[board]], Board checks, catches an inconsistent pair from L1 alone (`checkpoint-inconsistent`).

### Verification

Rule 5 means L1 never holds two checkpoints for one election and segment, and rules 1 and 4 mean every stored one counts: it came from the authority, inside its window. So a verifier reads an election's anchors completely from state, never from a list of logs an RPC node could shorten (T-24):

- The hash for `(election_id, s)` is the word at `keccak256(abi.encode(uint256(s), keccak256(abi.encode(election_id, A))))`, where `A` is the [ERC-7201](https://eips.ethereum.org/EIPS/eip-7201) namespace `abolish.board-anchor`:

  ```
  A = keccak256(abi.encode(uint256(keccak256("abolish.board-anchor")) − 1)) & ~0xff
    = 0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00
  ```

  Zero means none was anchored. The election's **lowest anchored segment** plus one (0 if it has no anchor) is the word at `keccak256(abi.encode(election_id, A + 1))`. An election's board carries entries from before voting opens (the ceremony transcript, the contract events of its creation and registration), so no bound derived from `opens_at` would do. The election's **first segment** `f` is the period containing `l1OriginTimestamp` of its `ElectionCreated` event, the L1 origin of the L2 block holding it, which is on its board and authenticated by the registry's accumulator, and which the verifier checks against finalized L1 and the event's L2 timestamp (Election registry, Events, The L1 origin; [[verifier]] 4.4). Every entry of an honest board is appended after creation, so none has a segment below `f`. The verifier proves the lowest-segment word, then the word for every segment from `max(lowest, f)` to the seal, all with `eth_getProof` against the state root of one finalized L1 block `B` (how it trusts L1 headers is [[verifier]]'s), and never trusts an `eth_call` answer. `B`'s timestamp is the `now` of [[board]], Board checks: proving at one block and taking `now` from a later one would read a segment anchored in between as `unanchored`, or miss a checkpoint anchored there, so two verifiers could disagree (T-36).

  An anchor for a segment below `f` doesn't count for the election: it isn't passed to [[board]], Board checks, and an entry with a segment below `f` is in no counted checkpoint's segment, so it fails `unanchored` once its window has closed. A segment from `f` up and below the lowest anchored one has no anchor, so its entries fail `unanchored` the same way. The verifier proves the `lowest` word only to take that maximum; the range is then as long as the election's board is, in hours.

  **Pre-creation anchors.** Election identifiers are predictable (`electionIdAt` is a public view of the registry's counter), so whoever holds the anchoring quorum at some moment (a compelled or seized one, T-69) could anchor checkpoints with random heads and roots for elections not yet created. Rule 5 would keep them, and once those elections run, a verifier would find a word no board matches and fail them (`checkpoint-inconsistent`): one short compulsion failing elections that didn't exist yet. Two rules stop that:

  - The `f` rule above ignores every anchor for a segment that ended before the election's L1 origin, which covers any anchor made before the creation's L1 origin block.
  - That leaves anchors made between the origin block and the creation itself, at most the L2's `max_sequencer_drift` (1,800 seconds on Base, [[0004-l2-choice]]) plus a period boundary. So a creator MUST, after its `ElectionCreated` event is final ([[contracts]], Election registry, Election identifier) and before it asks the panel for a ceremony, prove at a finalized L1 block `C` whose time is after the creation's L1 origin plus `max_sequencer_drift` that the checkpoint word is zero for every segment from `f` to the last period that ended before `C` (a handful of slots: no later segment can have been anchored by then), or, if any of them is set, abandon the identifier and create another. It checks those slots, never `lowestSegmentPlusOne`: anchors below `f` don't count, and a quorum held briefly could anchor the current segment for thousands of upcoming identifiers in one transaction, so refusing any identifier with an anchor at all would let one compulsion block every future election. An abandoned identifier gets no definition, so it holds no result. After that check, an anchor no board matches can only be made while the election exists, the residual [[board]] already states (attributable, and only while it runs).

- For each non-zero word it needs the checkpoint itself. A word equal to the hash of the checkpoint a board copy gives at that segment's boundary needs nothing more: the contract stored it only inside its window, so its `anchoredAt` for [[board]], Board checks, may be taken as the end of its period, which gives the same result as the true time (timely, and at most `now`, since the word is proven at `B`). Only a word no copy matches needs the checkpoint itself, to name it and attribute the failure. Its hash is the word, so it is authenticated by the word whatever its source, typically the `CheckpointAnchored` log that wrote it; the word, proven at `B`, already attributes it to the authority inside its window, so no receipt proof is needed ([[verifier]], Anchors from L1). So old elections stay verifiable from state and the archive, without old L1 receipts, which ordinary nodes drop under history expiry ([EIP-4444](https://eips.ethereum.org/EIPS/eip-4444)). A non-zero word that matches no checkpoint anyone can produce makes the election unverifiable ([[board]], Anchoring).

The anchor's own event accumulator gives the same completeness for its log sequence, but the per-segment words are what a verifier needs, and they need no archive replay.

### Vectors

The checkpoint hash and the window rule are the ones `vectors/board.json` already exercises: the Solidity tests hash every checkpoint there and compare it with the published `hash`, and anchor the `valid` board's checkpoints at their vector times, under the vectors' own clock.

### Known-weak

- **The anchoring authority can fail a running election** by anchoring a checkpoint no board matches, before the honest one (rule 5 then keeps it). That is attributable on L1, but nothing prevents it (T-24, T-53, T-69). A late anchor can't do it: the window closes 12 hours after each period, and no anchor lands before its period ends.
- **The quorum is held online.** Unattended hourly anchoring means the runners hold enough signer keys to meet the Safe's threshold, so seizing or compelling those runners (T-69) is seizing the quorum. The Safe protects against one leaked key and one rogue runner, not against whoever controls the runners' hosting.
- **The Safe's configuration can change after deployment**, and the anchor pins only its address. A quorum can reduce the owners or threshold, or make one key the authority without touching either: by enabling a module (which executes as the Safe with no signatures, a common way to automate jobs), setting a guard or fallback handler, or delegatecalling to replace the proxy's singleton. P4-1 part 2 MUST use no module or guard that bypasses the threshold, and the verifier's check of the Safe (owners, threshold, modules, guard, fallback handler and singleton at each anchoring block) is still to come; until then such a change is visible only in the Safe's own public transactions.
- **Pre-creation anchors depend on the creator's check.** An anchor for a not-yet-created election in the drift window before its creation counts, and fails the election if no board matches it, unless the creator ran the per-slot check above and abandoned the identifier. A creator that skips the check can lose its election to an earlier compelled quorum; nothing on L1 enforces the check, and the anchor can't see L2. An anchor made after creation but before the check also forces a discard, which costs liveness only. A creator-chosen salt in `election_id` would make identifiers unpredictable before creation and remove the check; that is a registry change (P1-18), cheap while nothing is deployed.
- **Constructor effects aren't bound.** [[verifier]] 1.2 compares runtime code only, so a deployer's own initcode can do anything a constructor can and then return the release runtime code. That covers its whole effect: storage (here checkpoint words for predictable future elections or segments past the creator's check, `lowestSegmentPlusOne`, the latest archive locator, receipt-key words; in every contract, the accumulator's genesis and count) and every log it emits. Examples: a pre-written anchor word fails an election with the blame on an authority that never anchored; a constructor-emitted `DefinitionRegistered` for a predictable future `election_id` makes verifier 2.1 find two registrations and fail that election; a `PanelPinned` or `RegistrarsPinned` log naming the pinned keys while storage holds others lets the deployer block ceremony registrations or group additions, or record ones signed by its own keys, which the verifier refuses, failing every election that names that group (`group-history`) or stub (T-25). A pre-written receipt-key word is worse than a forged failure: it registers a key the authority never registered, so receipts under a deployer-held key would yield `unanchored`, `forked` or drop verdicts attributed to the authority; attributing receipt verdicts is sound only once 1.2 passes. Apart from that, none makes a false result verify: the verifier rechecks every signature- and hash-based rule itself (approvals against its pinned panels and registrars, definition and transcript hashes, timing). But it does forge failures: while 1.2 isn't a pass, a failure that rests on contract storage or constructor logs may be the deployment's doing, so a report naming such a failure must name the unbound deployment as a possible cause, and attributing it to an authority isn't sound until 1.2 passes. The creator's check, the accumulator's Verification argument and the registries' first-event rules hold only for the release constructor. The fix binds each deployment to the release creation code plus pinned constructor arguments, never to selected slots (a pinned CREATE2 factory with the address recomputed from both, or the creation transaction's input with inclusion evidence); until it is specified and checked, 1.2 is unverifiable, and it MUST be specified before anything is deployed (T-64).
- **`f` rests on the creation's L1 origin.** `ElectionCreated` carries it, authenticated by the registry's accumulator, and the verifier checks that it names a finalized L1 block no more than `max_sequencer_drift` before the event's L2 timestamp (Election registry, Events, The L1 origin): a forged, lower `f` would let pre-creation anchors count. Within the drift a sequencer or a rewritten predeploy can still name an earlier origin, moving `f` down by at most `⌈D / period⌉` periods for the release's pinned drift `D` (one on Base), which the creator's per-slot check covers, since it starts from the same event's `f` (T-71, T-69).
- **Withheld tails and late forks** remain [[board]]'s residual: an authority that anchors a checkpoint extending every receipt with entries it never publishes makes the election unverifiable, not failed. [[board]], Residuals, names binding a content address of each segment object into what is anchored as a candidate fix; this anchor's 108-byte checkpoint doesn't carry one. P4-1 leaves that fix to P4-3, which adds the segment objects' content addresses: adopting it means a new anchor deployment, a registry naming it and a new verifier pin. Before mainnet that costs only a redeploy, and nothing is deployed yet.
- **The authority can fail an election through its receipt keys.** Retiring a key a registered definition lists, at or before its `opens_at`, fails the election ([[verifier]] 2.9), as a bogus anchor does: attributable on L1, not prevented (T-53, T-69). A quorum seized for good can also register a key of its own, and a creator working with it can list that key and forge evidence against the authority; that authority can fail elections anyway ([[board]], Residuals).
- **Receipt keys aren't checked on the curve,** only framed: the authority can register 33 bytes of its choice per call, once per value (T-17). No definition can list one that isn't a key.
- **No checkpoint for a segment past the seal is refused on L1**: the anchor can't read the definition. Verifiers ignore it; it costs the authority gas and changes no result.
- **The authority chooses 108 bytes per checkpoint and up to 126 per locator**, with no limit on how many beyond gas (locator-only calls at any time, checkpoints for any identifier), that land on L1 for good, such as a checkpoint for an election that doesn't exist, or a locator body of a version no one defined (T-17). Only the authority can, and the deployment's Safe is accountable for it.
- **The latest locator in state can be overwritten** by the authority at any time, so a seized quorum can replace it with one naming a fake or empty archive. Earlier locators stay in `ArchiveLocated` logs while L1 history serves them, and the manifest chain names every earlier confirmed manifest from any genuine one; once the logs have expired, a verifier with no earlier locator or mirror is left with the overwritten one, which makes elections unverifiable, never verified (T-69, T-51).
- **A locator only names where the archive is.** A wrong or stale one can send verifiers nowhere, which makes an election unverifiable, never verified: everything found is checked against the anchored checkpoints. The manifest chain ([[0005-permanent-archive]]) gives a second path to every manifest.
- **Gas.** In the tests a call with one checkpoint costs about 84,000 gas, and each further checkpoint in the same call about 34,000: a storage write, a read of the lowest-segment word, two SHA-256 calls (the hash and the accumulator) and a log. A locator adds about 24,000 (its slots and log). An election's first anchor costs about 22,000 more, for its lowest-segment word. At 100 live elections, hourly, that is about 3.4 million gas an hour, a recurring L1 cost: on testnets it is free, and spending real funds on it is the owner's decision.
- **The deployment, the Safe and the hourly job don't exist yet** (P4-1 part 2, with the worker and a `ci:` deploy workflow for Sepolia). Until then, nothing is anchored and every board is unanchored.
