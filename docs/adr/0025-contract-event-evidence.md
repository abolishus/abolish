# ADR 0025: Contract events are evidenced by the event accumulator alone

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-12
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-17, T-71, T-25, T-50, T-35, T-52, T-51, T-53, T-24 (see [[THREAT_MODEL]])

## Context

Every result-affecting event of our L2 contracts reaches the board as a contract-event record (`0x0008`, [[board]], [[versioning]]): direct-submitted ballots (T-25), share postings and contract-path receipts and complaints ([[delivery]]), the election registry's creations and registrations, the trustee registry's ceremony records and the group registry's additions and removals ([[verifier]] 4.4). Its layout and "its inclusion evidence" are P1-18's (part 4), and they are what is still open.

[[0005-permanent-archive]] (Consequences, "L2 events") answered the evidence question first: the archive keeps, for each event, the L2 block header and transaction and receipt inclusion proofs, plus an account and storage proof of each contract's event accumulator ([[contracts]], Event accumulator) at every anchored period and at close. Two later findings reopened it:

- **Raw evidence archives chosen bytes.** A transaction and its receipt carry far more than our event: the sender's signature, an access list, the calldata of an outer contract that called ours, and every other log in the receipt, including logs the sender's own contract emits. Anyone can put arbitrary bytes into the permanent, irrevocable archive for the price of gas ([[notation]], Result-critical fields; T-17). [[notation]] already names the alternative this ADR weighs, "only the decoded event plus the accumulator storage proofs", and says it would close the residual and amend 0005. The registry's shared event sequence ([[contracts]], Election registry) makes it worse: every junk creation's transaction would be archived.
- **The accumulator already carries completeness, and could carry position.** Inclusion proofs show that an event exists; only the accumulator shows that none is missing, added or reordered, and it does so for every event of a contract at once. What it doesn't bind today is where each event sits on L2: its block. The checks need that and nothing else from the transaction: the close rule (verifier 5.5, T-35, T-50) needs each ballot's L2 block and timestamp, and 2.4 compares group additions with each tier's `root_l2_block` (P1-10b recorded that `0x0008` must carry an authenticated block number).

So the question is what a contract-event record and its evidence are. It is one-way: the archive is permanent, so whatever evidence format we choose is kept forever and can't be withdrawn if it carries chosen bytes; the record's layout freezes with its first vector; and the accumulator's step is fixed in every deployed contract, which [[contracts]] makes immutable. Nothing is deployed yet ([[contracts]], Election registry: nothing may be deployed before P1-18 part 4), so this is the last cheap moment to change the step.

## Options

### A. Raw inclusion evidence (0005 as written)

Each `0x0008` record carries the decoded event; the archive keeps, per event, its transaction, its receipt, Merkle–Patricia proofs of both under the block's `transactionsRoot` and `receiptsRoot`, and the block header. The header ties to the L2 output root on L1 only through the chain of parent hashes from the event's block to the output root's block (`latestBlockhash` in the output root's preimage), or through the EIP-2935 block-hash history contract, which keeps the last 8,191 blocks (about 4.5 hours on Base), proven at the next output root. The accumulator storage proofs at each anchored period add completeness.

- **Pros:**
  - Self-contained per event: a verifier checks one event's place without replaying its contract's sequence.
  - Shows each transaction's sender and type, so a deposit can be told from an ordinary transaction (verifier 4.5).
- **Cons:**
  - **Chosen bytes, forever (T-17).** Every field of a transaction and receipt outside our event is free to the sender: about 120,000 bytes per forced deposit, and without bound per ordinary transaction but gas. Anything filtered out of the evidence breaks its proof, so it can't be stripped.
  - **Size.** A header is about 600 bytes and a block every 2 seconds is 1,800 headers an hour; a parent-hash chain from each event's block to its output root's block is up to 1 MB per hour of the archive, per period with events, whether or not the events are ours. EIP-2935 shortens it to one storage proof per event block, but only if the next output root is proposed within 4.5 hours, which [[0004-l2-choice]] doesn't promise, and couples evidence to an L2 upgrade's feature.
  - It adds little the accumulator doesn't already carry: completeness still rests on the accumulator, and authenticity on each event's own evidence ([[0005-permanent-archive]]: "what makes each event trustworthy is the evidence it carries itself"), since a transaction proof is only as good as the output root it reaches (T-71).

### B. The accumulator alone, binding each event's block (recommended)

Each contract binds each log's L2 block number and timestamp into its accumulator step, and the record carries exactly what the step hashes: the contract's address, the log's index `n` in that contract's sequence, the block number and timestamp, its topics and its data. No transaction, receipt or header is archived. The evidence is the accumulator's account and storage proofs at every anchored period and at close, which 0005 already requires, proven against an L1 output root, plus the output-root preimage. A verifier replays each contract's archived records from genesis (or from the last proven value) and compares with each proof, so every record's block, timestamp, order and content are authenticated at once, and none can be missing ([[contracts]], Event accumulator, Verification).

- **Pros:**
  - **No chosen bytes beyond our own events (T-17).** The archive holds only what our contracts emit, and our contracts accept only records that decode strictly, with exact-length calldata ([[notation]]). The transaction, its access list, an outer call and any other contract's logs never reach the archive.
  - **Smaller and simpler.** About 10 KB of proofs per contract per period in which its count changed, independent of how many events it emitted or how many L2 blocks passed, and no header chain. A verifier needs one code path, which 4.4 needs anyway.
  - **Position is bound uniformly.** Every event of every contract carries its block, in the one routine every log already goes through, so no event can forget it.
- **Cons:**
  - **No per-event verification.** Checking one event means replaying its contract's records in that period from the last proven value, and waiting for the next proof (at most one anchoring period plus the output root's lag). A client checking its own direct submission at once trusts its L2 node until then.
  - **No sender or transaction type.** A deposit can't be told from an ordinary transaction. Nothing depends on that today, except the relay of [[0004-l2-choice]]'s close rule, which accepts a forced ballot only from the relay's aliased address: under this option a contract that accepts anything because of its caller MUST say so in the event it emits, so the verifier knows to look for the matching L1 call (verifier 4.5 narrows to such events; Consequences).
  - **A changed accumulator step.** The step of [[contracts]] is frozen by its vectors, so binding the block is a new tag, and every contract changes before deployment.
  - Authenticity rests on the output root, as under A (T-71, unchanged).

### C. Receipt proofs without transactions

Each record carries its receipt and a proof under `receiptsRoot`, plus the header chain as in A, but no transaction.

- **Pros:** drops the transaction's own chosen bytes (access list, outer calldata, signature) and keeps per-event verification.
- **Cons:** a receipt carries every log of its transaction, so a sender's own contract still archives arbitrary bytes beside ours (T-17); the header-chain cost and the EIP-2935 coupling of A remain; and it still adds nothing to completeness.

## Recommendation

**Option B.** The archive is permanent, and of the three only B keeps it to bytes our contracts define. Everything a check needs from L2 (that the event happened, in which block, in what order, and that no other did) is already in, or can be put into, the accumulator that every option needs for completeness. A and C buy per-event verification and a transaction's sender, and pay for them with an unbounded, irrevocable chosen-bytes channel (T-17, T-52), a header chain or an L2 feature with a 4.5-hour horizon, and a second evidence path. The one thing a sender is needed for, a relayed forced ballot, the contract can record itself.

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

- **The record `0x0008`, version 1**, is the step's input in canonical encoding: `bytes[20] contract ‖ u64(n) ‖ u64(l2_block) ‖ u64(l2_timestamp) ‖ u8(k) ‖ topics ‖ u32(len(d)) ‖ d`, with `d` at most the contract's largest event, a bound each contract's section states. Every event of each contract is archived in this form, boarded or not ([[contracts]], The shared event sequence); the board carries only those the election's checks use (4.4). The `chain_id` comes from the definition's `l2_chain_id`. A record of a contract the definition doesn't name, or out of its contract's sequence, fails 4.4.
- **The evidence** is, per contract and per anchored period in which its count changed, and at close: the L1 dispute game (or output proposal) and its output root, the root's preimage (version, state root, message-passer storage root, latest block hash), and the contract's account proof and the storage proofs of `S` and `S + 1` under that state root, taken at the first L2 block at or after the period's end for which a root is posted on L1 ([[0005-permanent-archive]]). Each is an archive object of its own, listed in the period's manifest (P4-3). Nothing else per event is archived.
- **Amends [[0005-permanent-archive]]**, Consequences, "L2 events" and "What is archived": no L2 header, transaction or receipt proof, and no calldata, is archived. The verifier recomputes our contracts' state from their events, so every event MUST carry every input that changes state (the contracts skill already asks for this). [[notation]]'s Result-critical-fields residual on inclusion evidence closes once part 4b lands (T-17).
- **Amends [[verifier]] 4.4 and 4.5.** 4.4's "inclusion evidence" is the accumulator replay above. 4.5 applies to events a contract accepted because of its caller: the contract emits that fact in the event (for the relay, its L1 stamp), and the verifier finds the matching call on finalized L1; any other deposit is checked by its own evidence like any other transaction, since nothing trusts its sender.
- **The close rule** (P1-18 part 4c, with its own ADR if a one-way choice remains) can use each ballot's authenticated `l2_block` and `l2_timestamp`. How a verifier shows that an ordinary transaction's batch reached L1 by `closes_at + l1_inclusion_bound` without the batch data, which L1 prunes after about 18 days, is that part's question: an output root posted on L1 in time at or after the ballot's block is one candidate.
- **Costs.** Two more 8-byte words per accumulator step: 24 gas of SHA-256 and no storage. Per period, about 10 KB of proofs per contract whose count changed, in a deployment with five L2 contracts at most about 440 MB a year of archive, independent of elections and events.

Known-weak:

- **Checking one event waits for the next proof.** Until the next anchored period's storage proof, a direct submitter's client sees its own event only through an L2 node it trusts (T-25), and must not stand down on it ([[delivery]], Client rules, apply unchanged).
- **The output root is the root of trust for position, as for completeness** (T-71). A false, unchallenged TEE-only root can rewrite blocks and timestamps as it can rewrite the sequence; the verifier still reports TEE-only roots (4.4).
- **Proof size depends on the L2's state trie.** A move to another state commitment (a verkle or binary trie) changes the proof format; the accumulator doesn't, so a new evidence version covers it.

## Decision

Option B, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto means archiving inclusion evidence as [[0005-permanent-archive]] has it (A), with its chosen-bytes residual stated in T-17; that decision must come before P1-18 part 4b freezes `0x0008`.
