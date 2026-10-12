# ADR 0025: Contract events are evidenced by the event accumulator alone

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-12
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-17, T-71, T-25, T-50, T-35, T-52, T-51, T-53, T-24 (see [[THREAT_MODEL]])

## Context

Every result-affecting event of our L2 contracts reaches the board as a contract-event record (`0x0008`, [[board]], [[versioning]]): direct-submitted ballots (T-25), share postings and contract-path receipts and complaints ([[delivery]]), the election registry's creations and registrations, the trustee registry's ceremony records and the group registry's additions and removals ([[verifier]] 4.4). Its layout and "its inclusion evidence" are P1-18's (part 4), and they are what is still open.

[[0005-permanent-archive]] (Consequences, "L2 events") answered the evidence question first: the archive keeps, for each event, the L2 block header and transaction and receipt inclusion proofs, plus an account and storage proof of each contract's event accumulator ([[contracts]], Event accumulator) at every anchored period and at close. Two later findings reopened it:

- **Raw evidence archives chosen bytes.** A transaction and its receipt carry far more than our event: the sender's signature, an access list, the calldata of an outer contract that called ours, and every other log in the receipt, including logs the sender's own contract emits. Anyone can put arbitrary bytes into the permanent, irrevocable archive for the price of gas ([[notation]], Result-critical fields; T-17). [[notation]] already names the alternative this ADR weighs, "only the decoded event plus the accumulator storage proofs", and says it would close the residual and amend 0005. The registry's shared event sequence ([[contracts]], Election registry) makes it worse: every junk creation's transaction would be archived.
- **The accumulator already carries completeness, and could carry position.** Inclusion proofs show that an event exists; only the accumulator shows that none is missing, added or reordered, and it does so for every event of a contract at once. What it doesn't bind today is where each event sits on L2: its block. The checks need that: the close rule (verifier 5.5, T-35, T-50) needs each ballot's L2 block and timestamp, and 2.4 compares group additions with each tier's `root_l2_block` (P1-10b recorded that `0x0008` must carry an authenticated block number). Beyond its block, they need three things from the transaction or its block today, each of which an event can carry itself (Consequences): the L1 origin of the creation's and the registration's L2 blocks, which fixes the election's first segment `f` ([[contracts]], Board anchor, Known-weak; [[board]], Segments) and is compared with a retired version's cutoff ([[versioning]], Old versions stay verifiable; verifier 2.3); whether a forced ballot came through our L1 relay (verifier 4.5); and when an event's block became derivable from L1 (the close rule; verifier 5.6 and [[tally]]'s `tally-late` attribution).

So the question is what a contract-event record and its evidence are. It is one-way: the archive is permanent, so whatever evidence format we choose is kept forever and can't be withdrawn if it carries chosen bytes; the record's layout freezes with its first vector; and the accumulator's step is fixed in every deployed contract, which [[contracts]] makes immutable. Nothing is deployed yet ([[contracts]], Election registry: nothing may be deployed before P1-18 part 4), so this is the last cheap moment to change the step.

## Options

### A. Raw inclusion evidence (0005 as written)

Each `0x0008` record carries the decoded event; the archive keeps, per event, its transaction, its receipt, Merkle–Patricia proofs of both under the block's `transactionsRoot` and `receiptsRoot`, and the block header. The header ties to the L2 output root on L1 only through the chain of parent hashes from the event's block to the output root's block (`latestBlockhash` in the output root's preimage), or through the EIP-2935 block-hash history contract, which keeps the last 8,191 blocks (about 4.5 hours on Base), proven at the next output root. The accumulator storage proofs at each anchored period add completeness.

- **Pros:**
  - Self-contained per event: a verifier checks one event's place without replaying its contract's sequence.
  - Shows each transaction's sender and type, so a deposit can be told from an ordinary transaction (verifier 4.5).
- **Cons:**
  - **Chosen bytes, forever (T-17).** Every field of a transaction and receipt outside our event is free to the sender: about 120,000 bytes per forced deposit, and without bound per ordinary transaction but gas. Anything filtered out of the evidence breaks its proof, so it can't be stripped.
  - **Size and coupling.** A header is about 600 bytes. A bare parent-hash chain from an event's block to its output root's block is 1,800 headers an hour (about 1 MB); EIP-2935's history contract cuts that to one header and one storage proof per 8,191 blocks hopped, so size alone is small, but evidence then rests on an L2 upgrade's feature and its exact storage layout, per event.
  - It adds little the accumulator doesn't already carry: completeness still rests on the accumulator, and authenticity on each event's own evidence ([[0005-permanent-archive]]: "what makes each event trustworthy is the evidence it carries itself"), since a transaction proof is only as good as the output root it reaches (T-71).

### B. The accumulator alone, binding each event's block (recommended)

Each contract binds each log's L2 block number and timestamp into its accumulator step, and the record carries exactly what the step hashes: the contract's address, the log's index `n` in that contract's sequence, the block number and timestamp, its topics and its data. No transaction, receipt or header is archived. The evidence is the accumulator's account and storage proofs at every anchored period and at close, which 0005 already requires, proven against an L1 output root, plus the output-root preimage. A verifier replays each contract's archived records from genesis (or from the last proven value) and compares with each proof, so every record's block, timestamp, order and content are authenticated at once, and none can be missing ([[contracts]], Event accumulator, Verification).

- **Pros:**
  - **No chosen bytes beyond our own events (T-17).** The archive holds only what our contracts emit, and our contracts accept only records that decode strictly, with exact-length calldata ([[notation]]). The transaction, its access list, an outer call and any other contract's logs never reach the archive.
  - **Smaller and simpler.** About 10 KB of proofs per contract per period in which its count changed, independent of how many events it emitted or how many L2 blocks passed, and no header chain. A verifier needs one code path, which 4.4 needs anyway.
  - **Position is bound uniformly.** Every event of every contract carries its block, in the one routine every log already goes through, so no event can forget it.
- **Cons:**
  - **No per-event verification.** Checking one event means replaying its contract's records in that period from the last proven value, and waiting for the next proof (at most one anchoring period plus the output root's lag). A client checking its own direct submission at once trusts its L2 node until then.
  - **No sender, transaction type or L1 origin.** A deposit can't be told from an ordinary transaction, and an event's L1 origin isn't archived. Each check that needs one of them gets it from the event instead (Consequences): the creation and registration events carry their block's L1 origin, read from the `L1Block` predeploy, and a contract that accepts anything because of its caller (the relay of [[0004-l2-choice]]'s close rule) says so in its event, with what identifies the matching L1 call. A check found later to need a transaction field needs a new event version, not evidence.
  - **A changed accumulator step.** The step of [[contracts]] is frozen by its vectors, so binding the block is a new tag, and every contract changes before deployment.
  - Authenticity rests on the output root, as under A (T-71, unchanged).

### C. Receipt proofs without transactions

Each record carries its receipt and a proof under `receiptsRoot`, plus the header chain as in A, but no transaction.

- **Pros:** drops the transaction's own chosen bytes (access list, outer calldata, signature) and keeps per-event verification.
- **Cons:** a receipt carries every log of its transaction, so a sender's own contract still archives arbitrary bytes beside ours (T-17); the header-chain cost and the EIP-2935 coupling of A remain; and it still adds nothing to completeness.

## Recommendation

**Option B.** The archive is permanent, and of the three only B keeps it to bytes our contracts define. Everything a check needs from L2 (that the event happened, in which block, in what order, and that no other did) is already in, or can be put into, the accumulator that every option needs for completeness. A and C buy per-event verification and a transaction's sender, and pay for them with an unbounded, irrevocable chosen-bytes channel (T-17, T-52), and a header chain or an L2 feature per event: a second evidence path beside the accumulator. What the checks need from a transaction or its block (a relayed ballot's L1 call, a creation's L1 origin) the contract can record itself.

What would change it: an L2 that commits to its receipts or logs in a form provable without chosen bytes (for example a log-only accumulator in the protocol), or a check that genuinely needs a transaction's sender, which would first need an ADR, since [[notation]] says no caller restriction is relied on.

## Consequences

Specified and built in P1-18 part 4b (with the direct-submit contract), as one change with spec, code and vectors:

- **A new accumulator tag**, `abolish/v1/event-accumulator-2`, registered in [[domain-separation]]. Genesis is as before under the new tag; the step becomes

  ```
  acc_{n+1} = H(DS("abolish/v1/event-accumulator-2",
                   u8(1) ‖ acc_n ‖ u64(n) ‖ u64(block.number) ‖ u64(block.timestamp) ‖
                   u8(k) ‖ t_0 ‖ … ‖ t_{k−1} ‖ u32(len(d)) ‖ d))
  ```

  with `block.number` and `block.timestamp` read in the emitting call. A contract reverts if either is 2⁶⁴ or more. The ERC-7201 slots don't change. `abolish/v1/event-accumulator` stays frozen with its vectors and is used by no deployment; the board anchor on L1 moves to the new tag too, so every Abolish contract has one step.

- **The record `0x0008`, version 1.** Its payload, after the record header of [[notation]], is the step's input in canonical encoding: `bytes[20] contract ‖ u64(n) ‖ u64(l2_block) ‖ u64(l2_timestamp) ‖ u8(k) ‖ topics ‖ u32(len(d)) ‖ d`. Each contract's section fixes, per event signature, `k` and the exact length of `d` (or its maximum, for an event with a variable field), and the decoder enforces them, so a record is strict. The `chain_id` comes from the definition's `l2_chain_id`. Every event of each contract is archived in this form, boarded or not ([[contracts]], The shared event sequence); the board carries only those the election's checks use (4.4).
- **Replay rules** (4.4). Within one contract, `n` counts up from 0 with no gap, and `l2_block` and `l2_timestamp` never decrease. Replayed against a proof at block `B`, every record up to the proven count has `l2_block ≤ B`, and the next record, if any, has `l2_block > B`. A record of a contract the definition doesn't name, or breaking any of these, fails 4.4, naming the record. So neither a false root nor a crafted bundle can move an event across a period boundary without changing what the accumulator check sees.
- **The evidence** is, per contract and per anchored period in which its count changed, and at close: the contract's account proof and the storage proofs of `S` and `S + 1` at the first L2 block `B` at or after the period's end for which an output root is posted on L1, the output root's preimage (version, state root, message-passer storage root, latest block hash) and the L1 dispute game that carries it ([[0005-permanent-archive]]). Each is an archive object of its own, listed in the period's manifest (P4-3). Nothing else per event is archived. How much the state root at `B` is worth is unchanged from [[0004-l2-choice]] (Finality, History beyond blob expiry): a verifier that derives `B` from finalized L1 while the data is retrievable, or trusts a node that did, checks the proof against that; afterwards only the output root vouches for it, and 4.4 annotates which proof type settled it (TEE-only or ZK) and whether its game had resolved. Under A it was the same root, reached through headers.
- **Events carry what the transaction did.** `ElectionCreated` and `DefinitionRegistered` carry their block's L1 origin (`L1Block.number()`, `timestamp()` and `hash()`) as event fields, so the accumulator authenticates them, and the verifier still checks the hash against finalized L1 ([[contracts]], Board anchor, Known-weak, for `f`; [[versioning]] for a retired version's cutoff). A relayed forced ballot's event carries the relay's L1 sequence number and the hash of what was relayed, and the relay keeps its own accumulator on L1, so the verifier matches each relayed event to exactly one relay call from L1 state alone, after L1 receipts expire too (EIP-4444); the relay itself is part 4c's.
- **Amends [[0005-permanent-archive]]**, Consequences, "L2 events" and "What is archived": no L2 header, transaction or receipt proof, and no calldata, is archived. The verifier recomputes our contracts' state from their events, so every event MUST carry every input that changes state (the contracts skill already asks for this).
- **Amends [[0004-l2-choice]]**, Consequences: "the verifier recomputes our contracts' state transitions from the events and calldata it holds" becomes "from the events it holds"; and "any deposit or delayed-message transaction that reaches our contracts is suspect: the verifier checks that its L1 source is…" applies to events a contract accepted because of its caller, which name their L1 source; any other deposit is checked by its own evidence like any other transaction, since nothing trusts its sender (T-71). Finality is unchanged: a ballot counts only once its block is derived from finalized L1 data, and verifier 5.5 reads its block and timestamp from the record.
- **Pages part 4b rewrites with the spec**, so none states evidence that is never archived: [[notation]] (Result-critical fields: the inclusion-evidence residual closes, T-17), [[contracts]] (Event accumulator: Values, Verification, Known-weak; Election registry: The shared event sequence; Board anchor, Known-weak, `f` from the creation's L1 origin), [[verifier]] (Principles, 4.4, 4.5, 5.6), [[board]] (record types, Open items), [[versioning]] (the `0x0008` row, and the cutoff's L1 origin), [[domain-separation]] (the new tag) and [[tally]] (`tally-late`'s settlement overrun).
- **The close rule and derivation time** (P1-18 part 4c, with its own ADR if a one-way choice remains). The close rule (5.5), and the attribution of a late or missing direct-submitted ballot to the board operator rather than to a settlement overrun (5.6, [[tally]], Tally window), need when an event's block became derivable from finalized L1, which the record doesn't carry and L1 prunes with the blobs. An output root posted on L1 in time at or after the block is one candidate, but it is only an upper bound, and proposals come from the allowlisted proposer, the party T-50 fears; the event's own L1 origin is a lower bound. That part decides.
- **Costs.** Sixteen more bytes per accumulator step: at most one more SHA-256 word (12 gas) plus the two opcodes, and no storage. The two registry events that read `L1Block` pay one more external read each. Per period, about 10 KB of proofs per contract whose count changed: with five L2 contracts, at most about 440 MB a year of archive, independent of elections and events.

Known-weak:

- **Checking one event waits for the next proof.** Until the next anchored period's storage proof, a direct submitter's client sees its own event only through an L2 node it trusts (T-25), and must not stand down on it ([[delivery]], Client rules, apply unchanged).
- **The output root is the root of trust for position, as for completeness, once L1 data has expired** (T-71). A false, unchallenged TEE-only root can rewrite blocks and timestamps as it can rewrite the sequence; the verifier still reports TEE-only roots (4.4).
- **Derivation time isn't evidenced yet** (5.5, 5.6; T-50, T-25): until part 4c decides, a late or missing direct-submitted ballot can't be told from a settlement overrun after the L1 data has expired, and any answer that rests on output-root proposals rests on the proposer's liveness and cadence.
- **Proof size depends on the L2's state trie.** A move to another state commitment (a verkle or binary trie) changes the proof format; the accumulator doesn't, so a new evidence version covers it.

## Decision

Option B, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto means archiving inclusion evidence as [[0005-permanent-archive]] has it (A), with its chosen-bytes residual stated in T-17; that decision must come before P1-18 part 4b freezes `0x0008`.
