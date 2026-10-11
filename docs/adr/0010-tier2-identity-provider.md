# ADR 0010: Tier 2 identity provider

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option A, with the conditions under Decision
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A). Owner-only, if the gate in Decision isn't met: anything that would put document data, or proofs from which it could later be extracted, on-chain or on the board (the brief's "No PII on-chain, ever").
- Threats addressed: T-03, T-05, T-06, T-07, T-13, T-15, T-17, T-19, T-21 (see [[THREAT_MODEL]])

## Context

Tier 2 is "ZK proof of personhood over government-signed documents". It proves citizenship, age and uniqueness without revealing identity (brief, Identity). It launches through a QR handoff to an existing proof app; our own native app comes later (P5-3, P5-4). The brief requires this ADR to compare zkPassport, Self and longfellow-zk, and to confirm that Tier 2 proofs verify off-chain or on our chain, Base ([[0004-l2-choice]]), with no third-chain dependency.

What a Tier 2 registration has to do, from the brief, [[membership]] and [[verifier]] 2.4:

1. **Prove a valid, issuer-signed document,** against public trust roots that a third party can recompute (T-21, T-36).
2. **Derive a per-document uniqueness nullifier** scoped to Abolish, so one document registers once, and the value can't be linked to the same document's use in other applications (T-03, T-12, T-13).
3. **Bind the proof to the Semaphore identity commitment it registers,** to the tier group, to the chain and to the registry. Then a relayed proof can't be front-run to register someone else's commitment, or replayed into another tier or deployment (T-21, T-06).
4. **Prove on the voter's device.** Document data never reaches us, the proof app's operator or any other server (T-19, G-12).
5. **Verify without our servers and without a third chain.** The verifier recomputes every Tier 2 addition from the board alone (T-06, [[verifier]] 2.4).
6. **Disclose only the predicates the tier needs** (for US civic votes: US citizenship, age ≥ 18).

What is one-way: every Tier 2 identity commitment is registered under one provider's proof format, trust roots and nullifier derivation. Changing provider later means either re-registering every Tier 2 member, or accepting two nullifier derivations, which would let one document register twice (once under each derivation; T-03). The registration proofs also become part of the permanent public record (below), so their privacy properties last as long as the archive does.

## Options

Facts below were read on 2026-10-11 from each project's documentation and public repositories. They are cited by URL or by file at the commit read: `zkpassport/circuits` @5bd0f61, `selfxyz/self` @be761b3, `google/longfellow-zk` @d5e6be7. Anything we couldn't confirm is marked unconfirmed. P3-4 re-checks all of it before building.

### A. zkPassport

ICAO 9303 passports and ID cards, read over NFC by the zkPassport app (https://docs.zkpassport.id). Aztec Labs has owned it since May 2026.

- **Proof system:** Noir circuits proven with UltraHonk on the phone. The zero-knowledge flavour is the default, and there is no per-circuit trusted setup, only Aztec's universal SRS. The circuits pin Noir `1.0.0-beta.22`, our pin (`circuits/package.json`). Proofs are recursively compressed into one outer proof (https://docs.zkpassport.id/faq).
- **Proving location:** client-side; personal data never leaves the phone (FAQ). The optional cloud prover, used only to wrap a proof for EVM verification, receives subproofs whose private inputs are already concealed (`cloud-prover/README.md`).
- **Verification:**
  - **Off-chain** in TypeScript with bb.js (`@zkpassport/sdk`, `verify()`). A local-only mode is available; without it, the SDK falls back to zkPassport's hosted verifier (https://docs.zkpassport.id/changelog).
  - **On-chain:** a root verifier at one address on Ethereum, Sepolia and Base, plus a root registry configured for Base (`registry-sdk/src/networks.ts`). **No third chain.** Unconfirmed: whether Base's roots are written there directly or bridged from Ethereum.
  - **Admin keys:** an admin key can swap the root verifier's sub-verifiers (deployment JSON), and an oracle role updates the registry roots.
- **Trust roots:** the certificate, circuit and sanctions registries are Merkle roots on-chain. Each root carries a validity window, a revocation flag and the IPFS CID of the packaged certificate list. A third party can recompute a root from the list (`registry-contracts/src`, `registry-sdk/README.md`). The roots come from the ICAO and national master lists; the full curation pipeline isn't documented (unconfirmed).
- **Uniqueness nullifier:** `Poseidon2(private_nullifier, service_scope, service_subscope)`, where `private_nullifier = Poseidon2(dg1, eContent, SOD signature)`. It is per document, scoped to a domain and a scope, and unlinkable across scopes except by someone holding the chip data (`lib/commitment`).
  - **Non-salted** (the default): the issuing state, or anyone else who has read the chip, can recompute it.
  - **Salted:** adds a verifiable threshold-OPRF secret, which hides the nullifier from the issuer. It requires zkPassport's strict FaceMatch, which needs Apple App Attest or Play Integrity and refuses rooted and GrapheneOS devices (https://docs.zkpassport.id/examples/salted-identifiers).
- **Binding:** `bind.data` (up to 509 bytes) is committed into the public inputs (`lib/bind`). Our commitment, tier, chain ID and registry fit.
- **Coverage:** passports, national IDs and residence permits from countries that publish their CSCA certificates. US passports are supported, US ID cards aren't, and there is no mDL support (`document-support-rules.json`, https://docs.zkpassport.id/limitations).
- **Licence:** Apache-2.0 for the circuits, SDK and mobile app. Development is very active, with breaking SDK changes in 0.15–0.18.
- **Cons:**
  - **No public audit of the circuits yet.** They are "under internal and external review" (`SECURITY.md`). The OPRF circuits they use were audited by Least Authority in January 2026.
  - **Passive authentication only:** no circuit checks Active or Chip Authentication, so cloned chip data (the SOD and data groups) is enough to prove. FaceMatch mitigates this only partly.
  - **"One ID, one account", not one person** (https://docs.zkpassport.id/examples/personhood). This is the T-03 residual that every option shares.
  - **Statistical zero knowledge of bb's UltraHonk isn't established** ([[0009-membership-proof]]). See Consequences.

### B. Self (formerly OpenPassport)

- **Proof system:** Circom and Groth16, with per-circuit trusted setups (about 38 circuits) run through PSE's p0tion. zkSecurity audited it in 2025 (https://docs.self.xyz/docs/self-pass/architecture/zk-proof-architecture).
- **Proving isn't client-side.** The registration proof "is generated in a TEE rather than on the user's mobile phone": the app sends encrypted passport data, and the user's secret, to an attested enclave (`packages/mobile-sdk-alpha/src/proving/provingMachine.ts`). That fails requirement 4 (T-19).
- **Celo is a third chain.**
  - Every contract is on Celo. The off-chain `SelfBackendVerifier` calls the Celo identity registry for every proof (`sdk/core/src/SelfBackendVerifier.ts`).
  - The commitment tree that a disclosure proof refers to exists only there. Reaching Base means verifying on Celo and relaying through LayerZero or Hyperlane.
  - That fails requirement 5 and the brief's explicit condition.
- **Uniqueness and admin powers:**
  - Uniqueness per document lives only in a global nullifier on Celo, which the issuer can recompute.
  - A 3/5 multisig can add, update or remove identity commitments in the registry with no proof (`IdentityRegistryImplV1.sol`, the `dev*` functions). That trust assumption over the whole set can't be checked (T-06).
- **Licence and status:** the mobile app is BUSL-1.1, so it isn't open source until 2029. Self Pass is now marked "legacy" in favour of a managed, billed enterprise product (https://docs.self.xyz/docs/self-pass/).

### C. longfellow-zk (Google; ISO 18013-5 mDL)

- **Proof system:** Ligero plus a zero-knowledge sumcheck, with no trusted setup. It is specified in draft-google-cfrg-libzk-03 (an individual draft, not adopted by the CFRG) and has had reviews by Trail of Bits and ISRG and an academic analysis (https://google.github.io/longfellow-zk/docs/reviews/).
- **Deployment:** in Google Wallet through the Digital Credentials API. Proving runs in the wallet on the device, and device-key binding makes cloning harder than with passports.
- **No uniqueness nullifier exists in the circuits,** and Google Wallet accepts only its own pinned circuit. That fails requirement 2: Tier 2 would have no Sybil resistance.
- **Verification and coverage:**
  - Verifiers exist in C++, Rust and Go. There is none in TypeScript or WASM, and none on the EVM.
  - mDL data has no citizenship field.
  - US coverage is a growing set of state mDLs (unconfirmed for 2026).

## Recommendation

**A, zkPassport.** It is the only option that meets every requirement:

- client-side proving;
- verification off-chain or on Base, with no third chain;
- a per-document nullifier scoped to Abolish;
- binding to arbitrary data;
- US passport support;
- an Apache-2.0 licence for the circuits and the app, so P5-3 and P5-4 can run the same circuits in our own app later and drop the third-party app without changing the nullifier derivation.

It also sits on our proving stack (Noir `1.0.0-beta.22`, bb), so the gated packages can verify its proofs with the pinned bb.js, without a second proving system.

B fails two hard requirements. C fails uniqueness. C stays a candidate for a later, separate mDL-based tier, or an age-only predicate, paired with its own uniqueness mechanism: that would be its own ADR.

What would change it:

- an audit finding that breaks zkPassport's circuits;
- zkPassport moving its registries off Base, or making verification depend on a hosted service;
- a licence change;
- the zero-knowledge gate below failing with no acceptable fallback;
- longfellow-zk gaining a scoped nullifier and passport support.

## Consequences

### How Abolish uses zkPassport (P3-4)

Conditions on using zkPassport (T-21, T-06, T-05):

- **Verifier.**
  - Our verifier never calls zkPassport's hosted verifier, its RPC endpoints or its upgradeable root verifier.
  - It verifies proofs locally with the bb.js that `AGENTS.md` pins, against circuit verification keys vendored with their provenance (tag, commit, sha256, re-fetched in CI). Allowing that publisher needs a `ci:` PR first, under rule B.
  - It checks each proof's certificate and circuit roots against roots the election definition fixes at an L2 block, as it does for tier roots.
  - It recomputes those roots from the IPFS-packaged certificate lists, which we mirror and archive (T-21, T-36, [[0005-permanent-archive]]).
  - P3-4 confirms that zkPassport's bb version matches ours, or moves the toolchain pins together, as `AGENTS.md` requires.
- **Contracts.** No contract of ours trusts zkPassport's root verifier or registry for anything that affects a result: both are upgradeable by zkPassport's keys (T-62, T-71).
  - A Tier 2 addition counts only if the verifier's own check of its proof passes ([[verifier]] 2.4).
  - An on-chain check, if P3-2 adds one, is spam control only.
- **Binding.** The bound data is fixed by [[membership]] and P3-4: the identity commitment, the tier group identifier, the chain ID and the registry address, under an Abolish domain tag. The verifier attributes an addition by what the proof binds, never by the transaction (T-21, T-06).
- **Nullifier.**
  - The scope is a constant per deployment: an Abolish domain and a scope that names the tier group. The verifier rejects a second counted addition with the same scoped nullifier (T-03).
  - **Non-salted mode** for now. With it, an issuing state can test whether a document it issued registered at Abolish's Tier 2 (it learns registration, never a vote: membership proofs are perfectly zero-knowledge, [[0009-membership-proof]]). This is stated under T-13 and T-19.
  - The salted mode would add a third-party OPRF network to the uniqueness guarantee, and mandatory Apple or Google device attestation to registration. That excludes privacy-focused devices and gives two more parties a say in who can register (T-19, T-27). A later ADR can adopt it.
- **Mock documents.** The reference election (P1-20) uses zkPassport's mock documents, whose nullifier type is MOCK. Those stubs are clearly marked, and verifiers reject MOCK nullifiers outside a local chain.

### The zero-knowledge gate (T-15, T-17)

The verifier must re-check every Tier 2 addition (requirement 5). So each addition's document proof has to be public, on the board and in the permanent archive, along with its public inputs. The proof's private inputs include the document's data groups (`dg1`: name, document number, date of birth, nationality). If the published proof is only computationally zero-knowledge, a future adversary (A-11) could recover those inputs. That would put personal data in the permanent public record, attached to an identity commitment. It would not reveal votes, since membership proofs stay perfectly zero-knowledge, but it would breach "No PII on-chain, ever".

[[0009-membership-proof]] found no published argument that bb's zero-knowledge UltraHonk is statistically zero-knowledge. So:

- **Gate (P3-4, before any real document is registered on any public chain, testnet included):** establish, with a reviewed argument for the exact bb version and the zkPassport outer circuit, that the published proof is statistically zero-knowledge.
- **If the gate is met:** document proofs are published, and T-06's Tier 2 mitigation is complete.
- **If it isn't met,** the agent doesn't pick between the two remaining options, because each crosses a line the owner owns. P3-4 labels the question `needs-decision`, and Tier 2 stays off real documents until the owner answers. The two options:
  - (a) Publish the proofs anyway, with T-15 and T-17 stating that document data is protected only computationally. This changes "No PII on-chain, ever" to a computational reading.
  - (b) Keep proofs off the board, and have an operator or the trustees attest each Tier 2 addition. Then Tier 2 group stuffing is checkable only by trusting the attesters (T-06), as for Tiers 0 and 1.
- Meanwhile Tier 0 and Tier 1 work proceeds, and Tier 2 works end to end on mock documents.

### Residuals, stated in the threat files

- **T-03:** passive authentication only, so cloned chip data proves. A person with two documents gets two identities, and an issuing state can mint identities.
- **T-07, T-05:** soundness rests on zkPassport's unaudited circuits and Aztec's universal SRS.
- **T-21:** zkPassport's oracle controls which certificates its roots admit. Our verifier recomputes the roots from the published lists, so it can detect a bad list but not the oracle's choice of which genuine certificates to include.
- **T-19:** the voter runs zkPassport's app until P5-3 and P5-4 ship ours. The app is open source, but the binary the voter installs isn't checked against it.

### Follow-ups

- **P3-4** (Tier 2 QR handoff) carries the conditions and the gate above, and the hand-off to [[membership]] for the bound-data layout.
- **P3-2** (groups) carries the on-chain addition path.
- **P5-3 and P5-4** reuse zkPassport's circuits in our own app.
- Threat files T-03, T-06, T-13, T-19 and T-21 name this decision.

## Decision

Under rule A (`AGENTS.md`): **option A, zkPassport**, used on the conditions above, with status `Accepted (agent) — owner may veto`, and listed under Decisions to review in [[STATUS]]. The zero-knowledge gate is P3-4's. If it fails, the choice between (a) and (b) goes to the owner, and nothing in this ADR decides it.
