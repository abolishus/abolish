# ADR 0033: Succinct verification of a whole poll, and post-quantum signatures

- Status: Proposed (owner, 2026-10-17): exploratory, for after the Phase 2 end-to-end path. Not queued: no STATUS item builds any of it, and no agent session implements or accepts it until the owner moves it into the queue.
- Date: 2026-10-17
- Deciders: owner
- Threats addressed: T-05, T-15, T-36, T-39, T-71 (see [[THREAT_MODEL]])

## Context

Two directions in current proof-system work bear on Abolish, and neither is something we compete with: both are infrastructure that proves other things in bulk, while Abolish uses one proof system for one narrow job.

- **Succinct verification of a large computation.** zkVMs over RISC-V with hash-based STARKs now prove whole Ethereum blocks in seconds on one GPU. Applied here, the computation would be our own verifier ([[verifier]]) over a poll's board.
- **Aggregated post-quantum signatures.** Lattice-based SNARKs now aggregate thousands of Falcon-512 signatures into one proof on a laptop CPU, at tens of bytes per signature.

Where Abolish stands today:

- **Verifying a poll is linear in its ballots.** Every ballot carries a Groth16 membership proof ([[membership]]), so an independent verifier does at least one pairing check per ballot, plus the validity, delivery and tally checks. A million-ballot poll is hours of single-machine work for each person who checks it. Independent checking is the point of the system ([[PROJECT_BRIEF]]), and its cost limits how many people do it (T-36).
- **Privacy is built to outlast a quantum computer; integrity isn't.** The public board is information-theoretically hiding and Groth16 is perfectly zero-knowledge ([[0002-everlasting-privacy]]), and share encryption is hybrid with ML-KEM-768 ([[0016-share-kem-dh-group]], [[share-encryption]]). But membership soundness rests on BN254 pairings (about 100–110 bits classically, broken by Shor), and every signature the protocol relies on is classical: the board's receipts (P-256, [[0023-receipt-evidence]]) and trustee identities (P-256, [[0012-trustee-identity-signatures]], which ruled out `@noble/post-quantum` signatures for lack of an audit). A future quantum adversary can't read past ballots, but could forge proofs, receipts or trustee approvals for records whose integrity still matters then.

## Options

### A. Do nothing for now (the default)

Keep per-ballot verification and classical signatures; revisit when the end-to-end path and a real poll's numbers exist.

- Costs: verification cost grows with turnout; quantum forgery risk for evidence judged after a cryptographically relevant quantum computer exists.

### B. A succinct proof of the verifier's run

Compile `packages/verifier` (or a minimal core of it: selection, validity, delivery and the tally checks) for a RISC-V zkVM, and publish with each closed poll a STARK proving "this verifier release, run over the board with these anchors, gives this report". Anyone checks the report in seconds instead of re-running the verifier.

- Pros: checking a poll becomes cheap, so many more people can do it; STARKs are hash-based, so the proof itself is plausibly post-quantum; the full verifier still runs for anyone who wants to.
- Costs and open questions:
  - **It adds trust, it doesn't remove it.** The zkVM, its circuits and its STARK verifier become part of what a checker trusts, beside or instead of our own verifier (T-05, T-39). The Groth16 checks inside still rest on BN254 for soundness.
  - **Proving cost.** Pairings inside a RISC-V zkVM are expensive; proving a large poll may need GPUs we would run (an operator role) or a prover market. Unmeasured.
  - **Monoculture.** A single proved verifier could become the only one people run, the opposite of T-36's goal. The full verifier and independent implementations must stay first-class.
  - **Pinning.** The guest program's hash, the zkVM version and the STARK verifier must be pinned in the release record ([[P0-3]]) like the verifier itself.

### C. Post-quantum signatures, aggregated

Move the protocol's signatures (receipts, trustee identities, the creation and registrar keys where the chain allows) to a hybrid of the current scheme and a NIST post-quantum signature (ML-DSA or Falcon), and aggregate them on the board with a lattice-based SNARK so the board doesn't grow by kilobytes per signature.

- Pros: closes the forgery half of T-15 for evidence judged after a quantum break; hybrid keeps today's security if the new scheme falls.
- Costs and open questions:
  - **Audited libraries.** The brief allows only audited cryptographic libraries; [[0012-trustee-identity-signatures]] ruled out `@noble/post-quantum` signatures for that reason, and lattice-SNARK aggregation is newer still (T-39).
  - **Hardware custody.** Trustees hold P-256 keys in HSMs and smart cards today; post-quantum keys in that hardware are not yet widely available.
  - **On chain.** L1 and L2 verify ECDSA natively; verifying a post-quantum signature or an aggregate on chain is costly or unavailable.
  - **Membership soundness stays classical** under C alone: replacing Semaphore's Groth16 with a post-quantum membership proof is a separate, much larger change (a new ballot version).

## Recommendation

**A until the end-to-end path works and a real poll's verification time is measured; then B first.** Cheap independent checking matters to everyone now, and its value grows with turnout; quantum forgery is a later, narrower risk, and C's libraries and hardware aren't ready. When B is taken up, it starts as a measurement (prove the verifier's run over the reference election's board in one or two zkVMs, record proving time, proof size and what it adds to the trust base) before any ADR is accepted.

## Facts to establish before deciding

- Verifier time per ballot today, and for a million-ballot board ([[P1-20]]'s reference election can give the first number).
- For B: proving time and cost for the reference election's board in at least two zkVMs, with pairings; the guest program's size; how the guest reads the board, the anchors and the pinned trust roots.
- For C: the audit status of `@noble/post-quantum` signatures and of any aggregation scheme; HSM and smart-card support for ML-DSA or Falcon; on-chain verification cost on Base.

## Consequences

None yet: this ADR changes no protocol, code or queue. If the owner accepts B or C, each becomes its own STATUS item, inside the `crypto-review` gate, and a new verifier or record version where it changes what is published.
