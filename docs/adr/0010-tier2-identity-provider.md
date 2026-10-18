# ADR 0010: Tier 2 identity provider

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option A, with the conditions under Decision
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A). The owner-only questions (the nullifier's PII reading, bb.js in the verifier's trust base, and publishing proofs that are only computationally zero-knowledge) were answered on 2026-10-12: see Owner decision.
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

ICAO 9303 passports and ID cards, read over NFC by the zkPassport app (https://docs.zkpassport.id). Aztec Labs acquired its maker, Obsidion, in May 2026 (https://siliconangle.com/2026/05/27/aztec-labs-acquires-zkpassport-maker-obsidion-age-verification-pressure-mounts/).

- **Proof system:** Noir circuits proven with UltraHonk on the phone. Its tooling defaults to the zero-knowledge flavour (`cloud-prover/src/handler.ts`); unconfirmed for the exact outer proof that would be published, since EVM wrappers have used non-zero-knowledge flavours. There is no per-circuit trusted setup, only Aztec's universal SRS. The circuits pin Noir `1.0.0-beta.22`, our pin (`circuits/package.json` @5bd0f61). Proofs are recursively compressed into one outer proof (https://docs.zkpassport.id/faq).
- **Proving location:** client-side; personal data never leaves the phone (FAQ). The optional cloud prover, used only to wrap a proof for EVM verification, receives subproofs whose private inputs are already concealed (`cloud-prover/README.md`).
- **Verification:**
  - **Off-chain** in TypeScript with bb.js (`@zkpassport/sdk`, `verify()`). A local-only mode is available; without it, the SDK falls back to zkPassport's hosted verifier (https://docs.zkpassport.id/changelog).
  - **On-chain:** a root verifier at one address on Ethereum, Sepolia and Base, plus a root registry configured for Base (`registry-sdk/src/networks.ts`). **No third chain.** Unconfirmed: whether Base's roots are written there directly or bridged from Ethereum. That doesn't bear on the no-third-chain requirement, because our verifier doesn't trust zkPassport's contracts (Consequences).
  - **Admin keys:** an admin key can swap the root verifier's sub-verifiers (deployment JSON), and an oracle role updates the registry roots.
- **Trust roots:** the certificate, circuit and sanctions registries are Merkle roots on-chain. Each root carries a validity window, a revocation flag and the IPFS CID of the packaged certificate list. A third party can recompute a root from the list (`registry-contracts/src`, `registry-sdk/README.md`). The roots come from the ICAO and national master lists; the full curation pipeline isn't documented (unconfirmed).
- **Uniqueness nullifier:** `Poseidon2(private_nullifier, service_scope, service_subscope)`, where `private_nullifier = Poseidon2(dg1, eContent, SOD signature)`. It is per document, scoped to a domain and a scope, and unlinkable across scopes except by someone holding the chip data (`lib/commitment`).
  - **Non-salted** (the default): the issuing state, or anyone else who has read the chip, can recompute it.
  - **Salted:** adds a verifiable threshold-OPRF secret, which hides the nullifier from the issuer. It requires zkPassport's strict FaceMatch, which needs Apple App Attest or Play Integrity and refuses rooted and GrapheneOS devices (https://docs.zkpassport.id/examples/salted-identifiers).
- **Binding:** `bind.data` (up to 509 bytes) is committed into the public inputs (`lib/bind`). Our commitment, tier, chain ID and registry fit.
- **Coverage:** passports, national IDs and residence permits from countries that publish their CSCA certificates. US passports are supported, US ID cards aren't, and there is no mDL support (`document-support-rules.json`, https://docs.zkpassport.id/limitations).
- **Licence:** Apache-2.0 for the circuits, SDK and mobile app. Development is very active, with breaking SDK changes in 0.15–0.18.
- **Cons:**
  - **No public audit of the circuits yet.** They are "under internal and external review" (`SECURITY.md`). The OPRF circuits they use were audited by Least Authority in January 2026 (https://leastauthority.com/wp-content/uploads/2026/03/Least-Authority-TACEO-OPRF-Noir-Circuits-Final-Audit-Report.pdf).
  - **Passive authentication only:** no circuit checks Active or Chip Authentication, so cloned chip data (the SOD and data groups) is enough to prove. FaceMatch mitigates this only partly.
  - **"One ID, one account", not one person** (https://docs.zkpassport.id/examples/personhood). This is the T-03 residual that every option shares.
  - **Statistical zero knowledge of bb's UltraHonk isn't established** ([[0009-membership-proof]]). See Consequences.
  - **No mDL and no US state ID cards.** The brief's Tier 2 names both passports and ISO 18013-5 mDLs. With zkPassport, Tier 2 at launch covers only people who hold a US passport, roughly half of US citizens (unconfirmed for 2026). Adding mDLs later to the same tier would give a person with both a passport and an mDL two identities, unless the two credentials share a uniqueness mechanism (T-03).

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
  - ISO 18013-5 defines an optional `nationality` element, but US state mDLs are issued to non-citizens too and don't attest citizenship.
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
- the owner ruling that every available nullifier mode puts PII on-chain;
- longfellow-zk gaining a scoped nullifier and passport support.

## Consequences

### How Abolish uses zkPassport (P3-4)

These conditions are part of the decision (T-21, T-06, T-05, T-03). P3-4 writes them into [[verifier]] 2.4 and [[membership]], which today cover only the binding.

- **Verification.**
  - Our verifier never calls zkPassport's hosted verifier, its RPC endpoints, its cloud prover or its upgradeable root verifier.
  - The voter's side never routes subproofs through zkPassport's cloud prover either: their concealment may be only computational (T-15, T-19). Proving stays entirely on the device.
  - It verifies proofs locally with the bb.js that `AGENTS.md` pins, against verification keys vendored with their provenance (tag, commit, sha256, re-fetched in CI). Allowing that publisher needs a `ci:` PR first, under rule B.
  - P3-4 confirms that zkPassport's bb version matches ours, or moves the toolchain pins together, as `AGENTS.md` requires.
  - **`@aztec/bb.js` in the verifier's trust base.** `AGENTS.md` lets `packages/verifier` depend on gated packages, `@noble/*`, generated ABIs and circuit artifacts only. This ADR reads bb.js, already pinned as part of the proving toolchain, as the runtime for circuit artifacts. As with [[0009-membership-proof]]'s reading of Groth16, an agent ADR doesn't settle that reading: the owner confirmed it on 2026-10-12, on the conditions above (Owner decision).
- **Circuit root: a pinned set, never a parameter.** zkPassport's outer proof accepts any inner proof whose verification-key hash is in its circuit registry root, so that root decides soundness. Our verifier recomputes it from a vendored, reviewed set of inner-circuit verification keys, all of the zero-knowledge flavour (the `circuits` skill), and rejects a proof under any other root. Changing that set is a new protocol version. Neither the definition's author (A-2) nor zkPassport's oracle can choose it (T-05, T-06). If P3-4 finds that the proof isn't structured this way, it amends this ADR before building.
- **Trust anchors: the US issuer only.**
  - For a US-scope tier, the proof must show that the issuing state is the USA, as a predicate, and its document signer certificate must chain to a US CSCA certificate that the verifier release pins, with its provenance. The pins sit in a reviewed, public release, and a third-party verifier can substitute its own.
  - This keeps the trust set to one issuer. Accepting every CSCA on the ICAO or national master lists would let any of about a hundred issuing states, or one compromised CSCA, sign a document whose data page says "USA" and so mint US Tier 2 members.
  - It also means a certificate list our operator publishes (with a CSCA of its own) or one zkPassport's oracle publishes can't add an anchor. zkPassport's on-chain roots are at most reported for comparison, never required, so the oracle can't exclude genuine registrations by withholding or revoking a root (T-21, T-06).
  - The certificates, and the signed revocation lists from which the verifier derives validity, are archived with the board ([[0005-permanent-archive]]). P3-4 confirms that zkPassport's circuits prove an issuing-state predicate and bind the signer chain the verifier checks, and where the US CSCA certificates and revocation lists are published and how they are signed. If either is missing, P3-4 amends this ADR before building.
- **Validity over time.** Tier groups outlive elections, so each addition is checked against the anchors and revocation state that were valid at the addition's own L2 block, never against one set per election. Validity comes only from the certificates' own validity periods and the archived, signed revocation lists, never from zkPassport's validity windows or revocation flags.
- **Proof date.**
  - zkPassport's prover chooses the date its proof is checked against. The verifier requires that date to be within a stated bound of the addition's L2 timestamp, and the document to be unexpired then.
  - Without this, a holder could backdate a proof to register an expired or replaced document whose chip still reads, alongside the new one (T-03).
  - Renewal or replacement while the old chip still works remains a residual (T-03).
- **Binding.** The bound data is a canonical record that P3-4 specifies in `docs/spec/` under its own domain tag, decoded strictly. It carries the identity commitment, the tier group identifier, the chain ID and the registry address. The verifier attributes an addition by what the proof binds, never by the transaction (T-21, T-06, T-31).
- **Disclosure.** Only predicates are proven (issuing state USA, US nationality, age ≥ 18), never disclosed values. Each public input of the published proof is listed, and P3-4 shows that none is a deterministic, low-entropy function of document data (T-17).
- **Nullifier uniqueness.**
  - One scope for Tier 2 per deployment, not per group. If Tier 2 ever has several groups (state or district electorates), one document still registers once, and its region comes from a proven predicate under the same nullifier, which a later spec defines.
  - The nullifier type (non-salted, salted or MOCK) is fixed per deployment, and the verifier rejects any other type. Changing it needs a new Tier 2 group with full re-registration, never a second derivation alongside the first.
  - No election counts Tier 2 groups from two deployments.
  - The verifier counts one addition per scoped nullifier. A removal never frees a nullifier, so an operator can't remove a member and re-add them. A voter who loses their secret is recovered by the voting-identity backup (P2-6), or registers again only with a new document.
  - P3-2 defines who may authorise a Tier 2 removal.
- **Mock documents.**
  - The reference election (P1-20) uses zkPassport's mock documents, whose nullifier type is MOCK. Those stubs are clearly marked.
  - A verifier accepts MOCK only when the election definition carries an explicit test flag and its chain ID is on a pinned allow-list of local and test chains. It never accepts MOCK on a mainnet chain ID. This keeps the phase gate (a reference election on staging, which runs on Base Sepolia) passable.
  - P3-4 confirms that MOCK is fixed by the circuit (by the mock CSCA), not chosen by the prover, and that zkPassport's production list contains no mock CSCA.
- **Contracts.** No contract of ours trusts zkPassport's root verifier or registry for anything that affects a result: both are upgradeable by zkPassport's keys (T-62, T-71). An on-chain check, if P3-2 adds one, is spam control only.

### Before any real document: zero knowledge and the nullifier (T-15, T-17, T-13)

The verifier must re-check every Tier 2 addition (requirement 5). So each addition's proof and its public inputs, including the scoped nullifier, would be public: on the board and in the permanent archive. That raises two questions.

1. **Zero knowledge of the published proof.**
   - The proof's private inputs include the document's data groups (`dg1`: name, document number, date of birth, nationality). If the proof is only computationally zero-knowledge, a future adversary (A-11) could recover them. That would put personal data in the permanent public record, attached to an identity commitment. It wouldn't reveal votes, since membership proofs are perfectly zero-knowledge, but it would breach "No PII on-chain, ever".
   - [[0009-membership-proof]] found no published argument that bb's zero-knowledge UltraHonk is statistically zero-knowledge.
   - **Gate (P3-4):** a reviewed argument, for the exact bb version and the zkPassport circuits, that the published proof is statistically zero-knowledge.
   - **If the gate isn't met,** the agent's default is to keep proofs off the board and have a trustee threshold attest each Tier 2 addition, with signed attestations on the board. Tier 2 stuffing is then checkable only by trusting the attesters, as for Tiers 0 and 1 (T-06). That breaches no non-negotiable, so it is the agent's call under rule A. It gives the trustees a new duty, and lets them see each nullifier next to its identity commitment (T-13); the trustee role description ([[0006-trustees]], P1-7) must say so before it applies.
   - Publishing computationally zero-knowledge proofs anyway would rest "No PII on-chain" on a computational assumption. Only the owner can choose that.
2. **The scoped nullifier.**
   - In non-salted mode, anyone who has read the chip can recompute a document's nullifier and so map it to a named person and their identity commitment. That includes the issuing state, a malicious build of the proof app (T-19) and anyone holding leaked chip dumps.
   - Whether such a value counts as PII on-chain is a reading of a non-negotiable. The owner answered on 2026-10-12: it is PII, so it never goes on the board (Owner decision).
   - The alternatives each have a trust cost:
     - zkPassport's salted mode: a third-party threshold OPRF network, plus mandatory Apple or Google device attestation, which excludes privacy-focused devices (T-19, T-27);
     - a nullifier keyed by a threshold VOPRF that the trustees run (needs design, P3-4);
     - keeping nullifiers off the board with the attesters, as under question 1's fallback.

**No real document is registered on any public chain, testnet included, until both questions are settled.** Tier 2 works end to end on mock documents meanwhile, and Tier 0 and Tier 1 work proceeds.

### Residuals, stated in the threat files

- **T-03:** passive authentication only, so cloned chip data proves. The US issuer can mint identities. A person with two documents gets two identities, including a renewed or replaced document whose old chip still reads.
- **T-21, T-03: nullifier burning.**
  - Anyone holding a passport's chip data can register it first, under their own identity commitment. That includes a hotel or border reader, a leaked chip dump, a malicious proof-app build (T-19) and the issuing state, which could do it at scale to its own citizens.
  - The binding stops front-running a relayed proof, not this. Since a removal never frees a nullifier, the holder is then excluded from Tier 2 for that document, and their only recourse is a new document.
  - P3-2 and P3-4 design a dispute path that doesn't reopen double registration, for example one that requires a proof a clone can't make (chip or active authentication, if zkPassport adds it). Until then this is stated as a residual.
- **T-05, T-07:** soundness rests on zkPassport's unaudited circuits, on passive authentication, and on Aztec's universal SRS.
- **T-21:**
  - zkPassport's oracle and its circuit-registry admin decide which certificates and circuits their own roots admit. Our verifier pins the circuit set and the US anchors itself, so neither can add a circuit or a certificate the verifier accepts, or exclude a genuine registration by withholding a root.
  - What remains is the US issuer itself (it can mint identities), the release author who chooses the pinned anchors (public and reviewed; a third-party verifier can substitute its own), and an operator who omits genuine certificates, which can only exclude people.
- **T-19:** the voter runs zkPassport's app until P5-3 and P5-4 ship ours. The app is open source, but the binary the voter installs isn't checked against it.
- **Coverage:** Tier 2 at launch covers US passport holders only (no mDLs, no state ID cards).

### Follow-ups

- **P3-4** (Tier 2 QR handoff): the conditions above, the spec edits to [[verifier]] 2.4 and [[membership]], the bound-data record, and the gate.
- **P3-2** (groups): the on-chain addition path, and Tier 2 removals.
- **P5-3 and P5-4:** reuse zkPassport's circuits in our own app.
- Threat files T-03, T-05, T-06, T-07, T-13, T-17, T-19 and T-21 name this decision.

## Decision

Under rule A (`AGENTS.md`): **option A, zkPassport**, used on the conditions above, with status `Accepted (agent) — owner may veto`, and listed under Decisions to review in [[STATUS]].

The agent's fallback if the zero-knowledge gate fails is attested additions. The owner's answers to the two owner-only questions follow.

## Owner decision (2026-10-12)

- **The nullifier is PII.** A nullifier that anyone holding the chip's data can recompute (the issuing state included) would let them list which named people registered, so it never goes on the board or into the archive, in any mode. zkPassport's salted mode is rejected: it rests on a third-party OPRF network and on Apple or Google device attestation, which shuts out rooted and privacy-focused devices (T-19, T-27).
- **Tier 2 additions are trustee-attested until a trustee-keyed nullifier exists.** Whatever the zero-knowledge gate's outcome, real documents use the fallback above: proofs and nullifiers stay off the board, a threshold of the panel ([[0006-trustees]]) checks each proof and the nullifier's uniqueness and signs the addition, and only the signed attestation and the identity commitment are boarded. Tier 2 stuffing is then checkable only by trusting the attesters (T-06), and the attesters see each nullifier next to its commitment (T-13).
- **Later: a nullifier keyed by a threshold VOPRF that the trustees run** (P3-4 designs it, with an ADR), so neither the chip data alone nor any single trustee can recompute it. When it exists, proofs may be boarded if the zero-knowledge gate is also met; until then, attestation.
- **No computationally zero-knowledge proofs on the board.** If the gate isn't met, proofs stay off the board; "No PII on-chain, ever" never rests on a computational assumption.
- **bb.js in the verifier's trust base: confirmed,** on the conditions under Verification (the pinned version, vendored keys with provenance re-checked in CI, local verification only, never zkPassport's hosted verifier, cloud prover or contracts). P3-4 may add `@aztec/bb.js` to `packages/verifier`.

## Amendment (P3-4 part 2b-4d, 2026-10-18): what the identity chain proves

Status: Accepted (agent) — owner may veto (rule A). Specified in [[identity-chain]]. Threats: T-03, T-05, T-06, T-17, T-21.

**Sources read**, pinned by commit: `zkpassport/circuits` at `c7da418` (the sub-circuits A to D in `src/noir/lib/commitment/`, their binaries in `src/noir/bin/`, the leaf, tree and root formulas, the date, age and country checks) and `zkpassport/zkpassport-packages` at `2cfe793` (`packages/zkpassport-utils/src/registry`). The Consequences asked P3-4 to confirm several points before building; this is what they show, and what changes.

**The circuit root: none.** The Consequences assumed the panel would verify zkPassport's outer proof and recompute its circuit registry root. The attesters can verify the five sub-proofs directly instead (the DSC, ID-data and integrity links, and two disclosure proofs), each under a verification key in a pinned list for its role. No outer circuit, recursive verifier or registry root then enters soundness, and the condition it served (no one but a release chooses the circuits, T-05, T-06) holds through the lists. The keys are built by us: `bb write_vk` of each circuit compiled from zkPassport's source at the pinned commit by the toolchain `AGENTS.md` pins. So zkPassport's own bb version (`@aztec/bb.js` 5.0.0 at `c7da418`, against our pinned nightly) doesn't enter, and no zkPassport-published key is fetched: the source is vendored with its tree hash, as TACEO's gadgets were (P3-4 part 2b-3b-1), together with every Nargo dependency it reaches, which zkPassport pins only by tag, each by commit and tree hash. A floor on the algorithms keeps out RSA-1024, curves below 256 bits and SHA-1 ([[identity-chain]], Circuit set).

**Trust anchors: the issuing-state predicate holds; the signer's binding is narrower than assumed.** Sub-circuit A proves a CSCA leaf, holding the CSCA's country, is in the tree under a public root and that the CSCA's key signed some DER element, which it doesn't check is a document signer certificate; B uses a public key found in that element, not one taken from its SubjectPublicKeyInfo. What that leaves open is recorded with the soundness question [[0022-tier2-keyed-nullifier]]'s Amendment holds for the owner, and option B below must close it for real documents. As for the state: B takes the issuing state from `dg1`, and the same commitment forces it to equal that country. So an anchor set holding only US CSCAs proves "issuing state USA" without disclosing it. The root is zkPassport's version-1 certificate registry root computed over our leaves only, per validity interval ([[identity-chain]], Anchor sets), never read from zkPassport's registry or an operator's list. Where the US CSCA certificates and revocation lists are published, and how they are signed, is still to confirm: a later part does it before a release pins any `USA` set.

**Validity over time: met for CSCAs, not for document signers.** An anchor set covers an interval in which each of its CSCAs is valid, and the chain names the set its proof date falls in. But no sub-circuit reads the document signer certificate's validity period, and none reads a revocation list: zkPassport's root binds a revocation tree whose contents sub-circuit A doesn't check. So a document signed under a revoked or expired document signer proves. Options:

- **A. Accept it as a residual.** The issuing state's revocation of a compromised signer then has no effect on Tier 2.
- **B. Real documents also need a document-signer proof of our own,** which parses the signed element as a Certificate TBS, takes the signer's key from its SubjectPublicKeyInfo at a fixed ASN.1 path and proves it equal to the key B used, written with our app (P5-3, P5-4), which runs the identity chain on the device anyway (Amendment of [[0022-tier2-keyed-nullifier]]). It would show the signer certificate valid on the proof date and its serial absent from a revocation tree that the anchor set binds, built from the issuer's signed lists, over the same commitment as `comm_dsc`.
- **C. Show the attesters which document signer signed the document,** so they check its validity and revocation outside the circuit. A signer issues documents for weeks or months, so this tells a seat when the document was issued, next to its identity commitment (T-17, T-13).

**Decision: B.** Real documents already wait for our own app and for the question held for the owner on the sub-circuits, so B delays nothing, and it keeps the anchor-only view that A and C would weaken. MOCK documents, on test chains, use the chain as zkPassport ships it. Until B exists, [[identity-chain]] states the residual.

**Proof date.** The disclosure proofs take `current_date` as a public input and check the document's expiry and the holder's age against it. The chain requires it to be a UTC midnight within a day of the seat's clock; the attesters' bound against the addition's L2 timestamp is a later part's.

**Disclosure.** The public inputs and outputs a seat sees are listed in [[identity-chain]] (The chain). None is a deterministic, low-entropy function of document data: the disclosure proofs MUST open the private nullifier's slot in zkPassport's hash-only form, so their nullifier output is 0 and their type `NONE`; their scopes are 0; their parameter commitments are constants; and the three links' commitments are salted. What the seat does learn is the circuit choice: the CSCA's algorithm, key size and hash (which single out the CSCA where a set's CSCAs differ in them), the document signer's algorithm, key size and TBS size bucket, and the SOD's hash algorithms, which tell the signer generation (T-17).

**Mock documents.** MOCK is fixed by the circuit, not chosen by the prover: `nullify` reports a mock type exactly when `dg1`'s issuing state is `ZKR`, and A and B force that state to be the CSCA leaf's country. So a deployment whose anchor sets hold only US CSCAs can't accept a ZKR document, and a MOCK deployment, whose sets hold only zkPassport's ZKR test CSCAs, can't accept a US one. Whether zkPassport's production list holds a mock CSCA no longer matters, since no list of theirs is used.

**What else the chain shows,** stated in [[identity-chain]], Residuals: the nationality predicate admits US non-citizen nationals, whom `dg1` doesn't tell apart from citizens; any certificate the CSCA signed can serve as the document signer (an issuer's key in every case); and a holder aged 100 or more can't register, since `dg1`'s birth year has two digits.
