# ADR 0021: Receipt evidence

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-12
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-26, T-25, T-24, T-23, T-45, T-11, T-41, T-42, T-53, T-69 (see [[THREAT_MODEL]])

## Context

[[0013-ballot-receipts]] gave the voter a receipt: the board operator's P-256 signature on the board state it showed, with the voter's entry last, checked for inclusion at cast ([[receipts]]). What that receipt is evidence of later, to the voter and to anyone else, was split out to P1-13b after reviews of a first draft found five problems that have to be solved together ([[receipts]], Later checks):

- **Time.** A receipt carries no time. Whoever obtains a receipt key after an election (a leak, a seizure, a compelled hand-over, T-69) could otherwise forge evidence against that election for good, so evidence must be bounded in time, and a voter's evidence of a real drop must survive the bound.
- **Withheld boards.** The anchoring authority can anchor a fork that no checkpoint contradicts from L1 alone and withhold the board until any bound has passed ([[board]], Residuals).
- **Keys.** The receipt keys that judge an election must be fixed before voting starts, so a later release can't void receipts and a key not bound to the election can't forge against it.
- **Presence.** A dropped ballot is shown only by a valid ballot that no admitted entry of the anchored board carries by content, `(tier, ν, M)`; a rejected or re-randomised copy proves nothing ([[revoting]], Owned elsewhere).
- **Privacy.** Anything a voter posts or fetches to keep or check evidence must not name the entry to the operator or to the source (T-45, T-11).

Two more requirements come from elsewhere: the voter's later check must show the ballot's admission verdict and whether it is the selected ballot of its tier and nullifier, since Benaloh's challenge doesn't audit the L1 reference or `M` ([[revoting]], Owned elsewhere; T-41, T-42); and after any bound, the voter's client still shows its own result, marked as no longer evidence (G-7).

What is one-way: where the receipt keys are bound becomes a field of the election definition or a contract every verifier reads; the commitment format and the dispute window become constants every verifier applies to every past election; and the verdicts a third party reaches are what the dispute runbook and the public rely on.

## Options

Each option answers three questions: where the keys that judge an election are fixed, how evidence is bounded in time, and how a client checks its receipt without naming it.

### A. Keys in the definition, a dispute window kept by salted L1 commitments, and whole-board hash lists

- **Keys.** The election definition gains `receipt_keys`, a short sorted list of P-256 keys (at most 4, so a key can rotate during an election), in the next definition version not yet frozen. It is fixed before the ceremony, bound by the stub hash, and registered on L2 before voting opens, so no later release or operator can change it. A receipt is evidence for an election only under a key its definition lists. The verifier release pins an append-only list of the operator's receipt keys, never removing one, and attributes evidence to the operator only under a key both lists hold; under a key only the definition lists (a creator who lists a key of their own to frame the operator), evidence is attributed to that key's holder, never to the operator. At cast, the client accepts a receipt only under a key in both lists.
- **Time.** Each election has a dispute end, `t_E = end of the seal's anchoring window + DISPUTE_WINDOW`, with `DISPUTE_WINDOW` a constant of the receipt's record version (30 days). A receipt is evidence for a judge whose latest finalized L1 block is before `t_E`; after that, only if its **commitment** was on L1 in a finalized block whose timestamp is at most `t_E`. The commitment is `C = H(DS("abolish/v1/receipt-commitment", salt ‖ encode(receipt)))` with a fresh 32-byte CSPRNG salt, carried as one 32-byte word of the calldata of any L1 transaction whose calldata is a whole number of 32-byte words, to any address. The voter keeps the transaction and its inclusion proof in the block's transaction trie, so the evidence survives L1 history expiry ([EIP-4444](https://eips.ethereum.org/EIPS/eip-4444)) on the block hash alone. A key obtained after `t_E` forges nothing, since no new commitment can predate `t_E`; a commitment made before `t_E` keeps the receipt evidence for good, however long the board is withheld.
- **When the client commits.** The client commits a receipt once it is **in doubt**: any later-check outcome other than `included` (below), or no outcome yet within 7 days of `t_E`. It may commit every receipt at cast if the voter chooses. It sends the commitment through a relayer that batches many voters' words into one transaction (community nodes, P4-5; any relayer, since the word reveals nothing), or from its own funded address, and retries through another if the word isn't on L1 within an hour. An honest receipt never needs one.
- **Privacy of the check.** The client fetches the entry-hash list of **every** segment of its election (32 bytes per entry, from any source by content address, P4-3, or a community node it runs, P4-5) checks them against every counted checkpoint's root, and computes every proof itself, so what it fetches is the same for every voter and names no entry. For admission and selection it reads a whole verifier report ([[verifier]], 8) by the same route, never a query for its own nullifier.
- **Verdicts.** A third party holding the receipt, the payload it covers and, after `t_E`, the commitment's opening, judges it from the definition, L1 and, for some verdicts, the board:
  - `not-evidence`: it doesn't decode; the key isn't in the definition's `receipt_keys`; the signature fails; `entry_hash` isn't the entry built from `election_id`, `index`, `segment` and the payload; or the judge is past `t_E` with no admissible commitment.
  - `board-failed`: the board checks from L1 alone ([[board]], Board checks, steps 1, 2 and 6) already fail the election; the receipt adds nothing to that verdict, which is attributed already.
  - `pending`: segment `s`'s anchoring window hasn't closed.
  - `forked`, attributable to the receipt key's holder (the operator, under a pinned key): the operator signed a board state that isn't a prefix of the anchored board. From L1 alone: `s` is outside the election's segments (before its first, or after `lastSegment`), a counted checkpoint for a segment before `s` has a size above `index`, or a counted checkpoint for `s` or later has a size at most `index`. With board data: a consistency proof from `(index + 1, r′)` to segment `s`'s counted checkpoint, with `r′ ≠ root`, which anyone holding the entry-hash list can produce and which is binding under collision resistance of the tagged tree hashes.
  - `included`: a consistency proof from `(index + 1, root)` to segment `s`'s counted checkpoint verifies, so entry `index` of the anchored board is the voter's entry.
  - `unresolved`: neither proof can be made, because no copy of the anchored board up to segment `s`'s checkpoint is available; the election is then unverifiable ([[board]], Residuals: withheld tails), and the receipt stays evidence, committed, until a copy is found.
- **Drops.** A `forked` receipt is also a **drop** if its payload is a ballot record that passes every admission check that depends only on the record, the definition and finalized L1 ([[verifier]] 5.1 to 5.4, and the L1-reference checks of [[revoting]]), and no admitted entry of the anchored board carries its `(tier, ν, M)`, whatever its selection outcome. A copy with the same `(tier, ν, M)` (a re-randomised proof, a direct-submitted copy, the client's resubmission) means the ballot wasn't lost, so `forked` stands and the drop doesn't; an entry carrying it that is rejected doesn't count as present. Judging a drop needs the whole anchored board, which every verifier holds anyway.
- **What the voter sees.** After `t_E`, a client holding an uncommitted receipt still shows its own outcome, marked as no longer evidence. For an `included` receipt it shows the ballot's admission verdict and whether it is the selected ballot of its tier and nullifier, from the report it fetched; a ballot that isn't admitted, or a tier and nullifier whose selected ballot isn't the latest one the voter cast, is an alarm.

- **Pros:**
  - **Every requirement has a mechanism:** a time bound that leaked keys can't cross, committed evidence that withholding can't outlast, keys fixed before voting and readable by any verifier from the definition alone, presence by content, and fetches that name nothing.
  - **No new contract and no new trust.** The commitment needs only L1 calldata and the block hash; the keys ride in a record the stub hash, the ceremony and the registry already bind.
  - **The honest path costs nothing on chain:** only receipts in doubt are committed.
  - `included` and the L1-only `forked` cases need a proof of logarithmic size, so a dispute can be judged without the whole board; only a drop needs it.
- **Cons:**
  - **Before `t_E`, a leaked or compelled key forges evidence** against the operator, indistinguishably from the operator's own signature (T-69, T-53). The operator answers for its keys' custody; the dispute window is what bounds this.
  - **A voter whose client doesn't check before `t_E` loses evidence** unless it committed at cast.
  - **Committing costs L1 gas,** paid by a relayer or the voter, and a relayer can refuse (the client then uses another, or its own address, whose funding can link it to having a receipt in doubt, though never to which).
  - **The full hash list is 32 bytes per entry** (32 MB for a million ballots), heavy for a phone on a weak connection; a community node the voter runs (P4-5) or a later private-retrieval scheme is the alternative.
  - **Admission and selection come from a report** that the client didn't compute itself; it trusts the verifier it chose, and can compare two.
  - A definition version, a parameter and a domain tag to add.

### B. Keys from the release current when the election opens; no time bound; proofs fetched per receipt

The ballot client's release pins the receipt keys, and an election is judged under the release current at its `opens_at`, read from the signed release history (P0-3). Receipts stay evidence for good. The client asks a mirror for the consistency proof from its own receipt.

- **Pros:** no definition change, no commitments, no gas, and small fetches.
- **Cons:** fails three requirements. Release history is an off-chain record that a later release can rewrite or contest, so the key set isn't fixed by anything a verifier reads from the election itself. A key leaked or compelled after the election forges evidence forever (T-69). A proof request for one size names the voter's entry to the mirror, and so its nullifier and every re-vote (T-45, T-11).

### C. As A, but every receipt committed at cast through an L2 contract

The client commits every receipt at cast through a contract on the L2, which stamps it with the block time. Evidence is bounded by the L2 timestamp.

- **Pros:** every receipt is evidence for good, whether or not the client ever checks again; L2 gas is cheap.
- **Cons:** one transaction per ballot, which someone pays for, and the commitment's timing reveals when each voter cast, to the second, beside the ballot's own L1 block (T-11). The L2's sequencer can delay or censor a commitment (T-25), and its timestamps are the sequencer's within drift. L1 calldata needs neither the sequencer nor a contract, and in-doubt commitments are rare.

## Recommendation

**A.** It is the only option that meets all five requirements together. B fixes no key set a verifier can read from the election, gives forgers unbounded time and names the entry on every check; C pays for every ballot and puts the commitment behind the sequencer.

What would change it: a private-retrieval scheme cheap enough for phones, which would replace the full hash-list fetch; a dispute contract that judges evidence on chain, which would move the commitment into that contract; or the owner choosing to commit every receipt at cast and fund it.

## Consequences

- **Spec (P1-13b part 2):**
  - [[receipts]], Later checks: the dispute end, the commitment and its opening, the client's check from whole-board hash lists, the verdicts and the drop rule, with codes.
  - [[election-definition]]: `receipt_keys` (`list<p256-key, 4>`, non-empty, strictly ascending, each a canonical key) in the next definition version not yet frozen. P1-15 part 4b is writing version 2 for regional cells; whichever of the two lands second adds its field to the other's draft, and version 2 is frozen only with both.
  - [[receipts]], Checks at cast: step 2 becomes "in the definition's `receipt_keys` and the release's pinned operator keys".
  - [[board]], client rule 2: replaced by the later checks; the rest of its alarms become `forked` and `unresolved`.
  - [[parameters]]: `DISPUTE_WINDOW` (2,592,000 seconds); [[domain-separation]]: `abolish/v1/receipt-commitment`.
- **Code (part 3):** the commitment, the opening's check and the verdicts in `packages/crypto`, with vectors in `docs/spec/vectors/` and a negative test per verdict; `packages/verifier` judges evidence from the board it already holds; the reference election gains a dropped receipt and a forked one.
- **Ballot client (P2-8):** commits in doubt through relayers, fetches whole hash lists and reports, and shows the outcome before and after `t_E`.
- **Runbook:** the dispute procedure, for anyone holding evidence (T-26).
- **Known-weak:** before `t_E`, whoever holds a receipt key can forge evidence against the operator; a client that never checks before `t_E` and didn't commit at cast loses its evidence; a withheld board leaves committed evidence `unresolved` and the election unverifiable, until P4-3 binds content addresses into anchors so non-publication is itself attributable; the full hash list is heavy on weak connections; the admission verdict comes from a report the client trusts; a receipt shown as evidence names the voter's entry and nullifier, as before (T-45).

## Decision

Option A, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. Nothing is specified, signed or frozen under it yet, so a veto changes this ADR and P1-13b's later parts only.
