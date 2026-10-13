# ADR 0028: What the board contract checks, and where its inputs come from

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-13
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-25, T-05, T-17, T-52, T-31, T-37, T-14, T-71, T-53 (see [[THREAT_MODEL]])

## Context

The `board` contract on L2 is the direct-submit path ([[0004-l2-choice]]): a voter who bypasses our servers submits a ballot there (T-25), and every share receipt, complaint and posting has a contract path there too, which MUST exist before any election registry is deployed ([[delivery]], Direct submit). Its events reach the board as contract-event records ([[contracts]], Contract-event record; [[0025-contract-event-evidence]]). The specs already say what it MUST check:

- a ballot: strict decoding, the Groth16 membership proof under the pinned depth-32 key against the root registered with the election's definition, with `ŝ` recomputed on chain and the identity refused in `A`, `B` and `C` ([[membership]], Owned elsewhere), and before it the cheap admission checks `ballot-stray`, `ballot-tier` (`ballot-cell` under ballot version 2), `validity-shape` and `share-hash-unqualified` ([[ballot-validity]], Residuals); never the L1 reference ([[revoting]], Owned elsewhere);
- a share receipt or complaint: it names the definition and is signed by the registered per-election key of its seat; a posting: its ciphertext hashes to the ballot's `share_hashes[seat]` and `sealed` has the definition's length; any number of each per seat and ballot, refusing only a byte-identical repeat ([[delivery]], Direct submit).

Four inputs to those checks aren't settled, and each is one-way, since the contract is immutable ([[contracts]]) and whatever it accepts is archived for good (T-17):

1. **Where the contract gets an election's parameters.** The election registry stores only `definition_hash` per election ([[contracts]], Election registry), but the checks need the tiers' (or cells') roots, the option count and the shape of the committed vote, `k` and `n`.
2. **Where it gets the registered key set.** Signing keys are needed for receipts and complaints, and the qualified seats for `share-hash-unqualified`. The key set is the output of the transcript check ([[ceremony]], Transcript check), which runs ML-KEM re-encapsulation; the trustee registry stores only the transcript hash a quorum approved.
3. **How strictly it decodes.** [[verifier]] (Principles) says our contracts accept a direct submission only if it decodes strictly. The committed vote, a complaint's `D` and a posting's ephemeral are ristretto255 elements. Decoding one needs a square root in the field of 2²⁵⁵ − 19, and no audited Solidity code for that exists.
4. **Which Groth16 verifier.** Semaphore ships a Solidity verifier, and snarkjs generates one per key. [[0009-membership-proof]] (Consequences) forbids admitting ballots through "a stock Semaphore verifier contract that accepts any depth", and [[membership]] requires the identity to be refused in every point, which stock verifiers accept.

## Options

### 1. An election's parameters

- **A. Every call carries the definition.** The contract hashes it, compares the hash with the registry's, and decodes it on each call. It is stateless, but a definition can run to tens of kilobytes under versions 3 to 5, paid for in calldata on every ballot and receipt and counted against the forced-deposit size ([[0004-l2-choice]], Forced-deposit limits).
- **B. A permissionless load call.** Anyone sends the definition once; the board checks it against the registry and caches what its checks need. One extra transaction and event per election, and a window between registration and loading in which nothing can be submitted, which any party (the voter included) closes by loading.
- **C. The registry records the parameters at registration.** The registry already decodes the definition and checks it against this deployment. It also stores, per definition hash, exactly what the board's checks need (each tier's or cell's tier and root, the option and question limits, `k` and `n`), and the board reads them with a view call. No extra transaction, event or window; registration costs a few more storage writes, once per election.

### 2. The registered key set

- **A. Seats' round-1 messages, sent to the board.** Anyone submits a seat's signed round-1 message; the board checks its identity signature. It needs no new statement, but it can't tell a qualified seat from one the transcript check disqualified, or from a seat of an abandoned run, so it accepts keys the election never registered and can't run `share-hash-unqualified`.
- **B. The quorum also signs the key set.** The ceremony registration statement ([[trustee-identity]], Ceremony registration) gains a hash of the registered key set (each qualified seat's index, KEM key and signing key, in order), under a new tag. Each seat computes the set itself from the transcript before signing ([[ceremony]], Approval and re-runs), the trustee registry records the set with the transcript hash once a quorum has signed, and [[verifier]] 3.1 fails an election whose recorded set isn't the one its transcript gives. The board takes signing keys and the qualified seats from the trustee registry.
- **C. The whole transcript on chain.** About 303 KB at 16 seats ([[ceremony]], Transcript), above the limits of one transaction and of a forced deposit, and qualification still needs ML-KEM, which the contract can't run.

### 3. Decoding strictness

- **A. Full decoding on chain.** Every ristretto255 element decoded and checked canonical, as `packages/crypto` does. It needs a field square root and the ristretto255 decoding formulas written in Solidity, which is implementing a primitive (AGENTS.md: never roll our own), with no audited code to vendor.
- **B. Framing on chain, elements by the verifier.** The contract checks everything that needs no curve arithmetic: every length, count and offset, every `u8` and enum, scalars below `ℓ`, `field<bn254>` values below `r`, the membership proof's strict decoding (BN254, through the EVM's precompiles), and each element's encoding being below `2²⁵⁵ − 19` with its low bit clear (the cheap part of RFC 9496's decoding). An element that is still not a valid ristretto255 encoding reaches the board, where [[verifier]] rejects the record as it decodes it (a rejected entry, never an election failure). A member can already hide chosen bytes in random-looking fields ([[ballot-validity]], Residuals), so what reaches the archive is unchanged in kind (T-17).

### 4. The Groth16 verifier

- **A. Semaphore's `SemaphoreVerifier.sol`, vendored.** Audited with Semaphore, but it takes the tree depth as an argument and holds every depth's key, accepts the identity in every point, and has no decode step to report a broken point, so it needs a wrapper either way. [[0009-membership-proof]] rules out admitting ballots through a verifier that accepts any depth.
- **B. snarkjs's generated verifier for the pinned key.** One key only, but generated code we would vendor and then wrap for the same decoding rules, and its assembly is a second implementation of what C below does in a few lines.
- **C. Groth16's equation over the EVM's BN254 precompiles.** `ecAdd`, `ecMul` and `ecPairing` (EIP-196, EIP-197) with the pinned key as constants, the equation of [[membership]] (Verification), and the strict decoding of Proof encoding before it. This is the composition the owner confirmed for `packages/crypto` on 2026-10-12 ([[0009-membership-proof]], Decision): the curve arithmetic, the pairing and the G2 subgroup check are the precompiles', and the contract evaluates a published equation over them.

## Recommendation

- **1C.** The parameters are fixed when the definition is registered, by the code that already decodes and checks it, so there is no window in which a registered election can't take a direct ballot, and nothing extra for a censored voter to send (T-25). The board pins the registry at deployment and trusts only what the registry stored for a definition hash, never a caller's copy.
- **2B.** Only the quorum knows which seats qualified, and only after running the transcript check, so the set has to come from them. Signing it in the statement they already sign costs one hash and binds it with the same quorum rule, so a set no quorum approved is never recorded (T-37, T-14). The verifier still recomputes it, so a corrupt quorum's false set fails the election rather than passing (3.1).
- **3B.** It keeps us within audited code and costs no property: an element the contract can't check is checked where every other record is, and the record is set aside, with nothing counted and nothing failed (T-53). [[verifier]] (Principles) is amended to say so.
- **4C.** It is the smallest code that does exactly what [[membership]] specifies, with one fixed key, every point strictly decoded and every signal below `r`, and it is the same equation, over the same kind of primitive, as the verifier's, so the contract and the verifier accept exactly the same proofs. A G2 point that is off the twist or outside the order-`r` subgroup makes `ecPairing` fail (EIP-197), which the contract reports as a decode failure; every other decoding rule it checks itself.

What would change it: an audited Solidity ristretto255 decoder (3A then becomes possible in a new contract); an L2 precompile for ristretto255 or for Groth16; or a definition so large that storing its parameters at registration no longer fits a block, which the registry's own decoding would hit first.

## Consequences

The board is specified and built in parts of P1-18 part 4b-3, in [[contracts]], Board:

- **4b-3a (this ADR):** the on-chain membership check ([[contracts]], Board, Membership proofs) and `MembershipProofLib` in `packages/contracts`, tested against `vectors/membership-proof.json` and `vectors/membership.json`, so the contract and `packages/crypto` give the same verdict on every real, tampered and malformed proof.
- **4b-3b:** the ballot check (framing per 3B, the cheap admission checks, the ballot hash, `M` and the proof), with vectors; the registry's stored parameters (1C), including definition versions after 1.
- **4b-3c:** the key set (2B): the new registration statement and its tag in [[trustee-identity]] and [[domain-separation]], the trustee registry recording the set, [[verifier]] 3.1's comparison, and vectors.
- **4b-3d:** the `Board` contract: ballots and the delivery paths of [[delivery]], with repeats refused as a no-op (a byte-identical resubmission succeeds and emits nothing, so a client's retry never reads as a failure and nothing is archived twice), receipts batched in one call with one event each, and its events in the contract-event record's next version.

Other consequences:

- **Amends [[verifier]], Principles,** with 4b-3b: a direct submission is accepted only if it passes the contract's framing checks and its membership proof; an element the contract can't check that fails to decode makes the record a rejected entry. Until then the Principles line stands as written, and no board contract is deployed.
- **Gas.** A membership check costs about 200,000 gas, mostly `ecPairing` with four pairs (EIP-1108 prices); registration costs one more storage word per tier or cell and a few for the limits.
- **Deployment order.** The board pins the election and trustee registries, and the registry pins the board, so the addresses are fixed before deployment (CREATE addresses from the deployer's nonces, or CREATE2). The deploy script is P4-1 part 2's, and verifier 1.2's binding of creation code ([[contracts]], Board anchor, Known-weak) covers the board too.

Known-weak:

- **A key set a corrupt quorum signs is recorded.** The board then accepts receipts from keys that aren't the transcript's, until verifier 3.1 fails the election; a quorum of `max(k, n − 1)` corrupt seats can already break the election's secrecy, so this adds failure, not a new attack (T-14).
- **Elements reach the archive unchecked** by the contract (3B), as random-looking chosen bytes, bounded by each record's length (T-17).
- **A repriced pairing.** A failed precompile call consumes all the gas it was given, so the pairing gets a fixed 600,000 gas, over three times what four pairs cost under EIP-1108 (181,000); a repricing above that would fail every proof, and the board would need replacing ([[contracts]], Board, Known-weak). A larger cap costs a successful call nothing, since the precompile consumes only its price, but every submission needs that much gas limit, which a forced deposit buys on L1.

## Decision

Under rule A (`AGENTS.md`): **1C, 2B, 3B and 4C**, with status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto of 4C means vendoring a verifier and wrapping it (4A or 4B); of 3B, writing or waiting for a ristretto255 decoder in Solidity before the board is deployed; of 1C or 2B, the corresponding option A, with its window or its weaker key check stated in T-25 and T-37.
