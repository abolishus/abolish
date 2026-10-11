# ADR 0012: Trustee identity signatures

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option B
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-37, T-14, T-29, T-31, T-30, T-71 (see [[THREAT_MODEL]])

## Context

Every trustee seat has a long-term **identity key**. The verifier's and the ballot client's releases pin the named trustees' identity keys together with `k` and `n` ([[verifier]], Pinned trust roots; [[0006-trustees]]). The identity key signs each trustee's ceremony registration and ceremony entry, which registers its per-election keys; every later share receipt, tally share and destruction statement is signed by the per-election signing key registered there, with the same scheme. Only a signed failure is attributed to a trustee ([[verifier]] 3.1; [[0002-everlasting-privacy]]). The trustee registry on L2 records a ceremony's outcome only with signatures by the pinned panel's identity keys, never on `msg.sender` alone, because a contract can't tell who really sent a transaction ([[notation]], Result-critical fields; T-71).

So the signature scheme has to work in three places: off-chain in `packages/crypto` and any third-party verifier, inside a contract on Base (and possibly on L1), and in whatever hardware a trustee keeps its key in.

What is one-way: identity keys and signatures go into ceremony transcripts, registry calls and receipts, all archived permanently ([[0005-permanent-archive]]). The scheme is part of every pinned release and of every contract that checks it, so changing it means new tags, new record versions and a second verifier path for as long as an election that used the first exists.

The ML-KEM audit question in [[0002-everlasting-privacy]] is about confidentiality of shares. It doesn't decide this one, but it rules out a post-quantum signature from `@noble/post-quantum` for now (option D).

## Options

### A. Ed25519 (RFC 8032), with strict verification

Pure Ed25519 over `DS(tag, m)`, verified under the rules of Chalkias, Garillot and Nikolaenko ("Taming the many EdDSAs", SSR 2020): canonical `A` and `R`, `S < L`, and `A` and `R` in the prime-order subgroup, so the cofactored and cofactorless equations agree.

- **Pros:** deterministic signing by construction; `@noble/curves`' `ed25519` is audited (Cure53 at 1.6.0, Trail of Bits at 2.3.0); fast; published vectors (RFC 8032 §7.1) and a known set of edge-case vectors.
- **Cons:**
  - **No EVM precompile and no audited Solidity verifier.** OpenZeppelin has none; the libraries that exist are unaudited, and the `contracts` and `crypto-review` skills forbid implementing a signature primitive in Solidity. The trustee registry couldn't check the panel's signatures, and would fall back to `msg.sender`, which the spec already rejects (T-71).
  - Verification rules differ across libraries (the reason for the paper above). Third-party verifiers built on libsodium, Go's `crypto/ed25519` or ZIP-215 libraries accept different sets, so our strict rule has to be re-implemented by hand in each (T-31, T-36).
  - Hardware support is narrower: recent YubiKey and YubiHSM firmware, some cloud KMS, little in FIPS-validated HSMs.

### B. ECDSA over P-256 with SHA-256 (FIPS 186-5), low-s

ECDSA on NIST P-256, signing `DS(tag, m)` with SHA-256 as the message digest, so the digest is exactly the protocol's `H(DS(tag, m))` ([[group]]). Keys are SEC1 compressed points; signatures are `r ‖ s`, each 32 bytes big-endian, and `s` must be in the lower half of the range.

- **Pros:**
  - **Checkable on chain.** Base has had the `P256VERIFY` precompile since the Fjord upgrade (RIP-7212), and Ethereum L1 since Fusaka (EIP-7951), at the same address and interface. OpenZeppelin Contracts' `P256` library (audited releases from 5.1) calls the precompile and has a Solidity fallback, so a contract can verify the panel's signatures with audited code, as [[0007-group-and-hash]] already noted.
  - **Hardware custody.** P-256 ECDSA is supported by every FIPS 140 HSM, PIV smart cards and YubiKeys, the AWS, Google and Azure KMS, TPM 2.0 and platform secure enclaves, and by WebCrypto with non-extractable keys. Trustees are independent institutions that pick their own custody ([[0006-trustees]], rule 6); the identity key is the one secret whose theft lets an attacker speak for a seat at every election (T-37).
  - `@noble/curves`' `p256` is covered by the Trail of Bits audit at 2.3.0 (scope: everything; no public report yet); the 0.7.3 audit covered the generic Weierstrass module it is built on, with secp256k1. Published vectors: RFC 6979 Appendix A.2.5 and NIST CAVP's ECDSA SigVer set, which CI and third parties can run. Project Wycheproof's P-256 sets exist too, but aren't vendored: the repository's formatter would rewrite a vendored JSON file, which the vendoring rules forbid.
  - P-256 has cofactor 1, so every point on the curve but the identity is in the prime-order group: no subgroup or torsion rules, and decoding a key is canonical by construction.
  - ECDSA verification is one equation. Implementations disagree on malleability, which the low-s rule fixes, and occasionally on two reductions modulo `n` (a digest at or above `n`, and an `R` whose x-coordinate is at or above `n`); [[trustee-identity]] fixes both and its vectors cover all three.
- **Cons:**
  - ECDSA signing needs a fresh, secret nonce per signature, and a biased nonce leaks the key (the PlayStation 3 and Bitcoin wallet failures). RFC 6979 deterministic nonces, which `packages/crypto` uses, remove the RNG from the picture; trustees signing in an HSM rely on its nonce generator.
  - **Malleable without a rule:** `(r, n − s)` verifies whenever `(r, s)` does. The low-s rule makes signatures strongly unforgeable in practice for anyone but the signer, but a signer can still produce many valid signatures on one message. A signature therefore never identifies a message, and nothing in the protocol depends on its bytes being unique.
  - Not post-quantum, like every option but D (below).
  - **Parameter provenance.** P-256's constants were derived from an unexplained seed, which some audiences distrust ([[0007-group-and-hash]] records this against P-256 as a group). No weakness is known, and ECDSA's standard security argument holds, but the identity keys are the root that registers every per-election KEM key: an adversary with an undisclosed P-256 break could forge `k` seats' ceremony entries, register KEM keys it holds and read every ballot, with a transcript that verifies everywhere (T-37, T-14). secp256k1 (C) has rigid curve parameters (its generator is unexplained too, which doesn't affect ECDSA's security).
  - The precompile takes an uncompressed key, so contracts hold the pinned keys as `(x, y)`, checked against the 33-byte encodings when the contract is deployed (P1-18).

### C. ECDSA over secp256k1 (Ethereum accounts)

Each trustee is an Ethereum account; the contract checks signatures with `ecrecover` (OpenZeppelin `ECDSA`), off-chain verifiers use secp256k1 ECDSA.

- **Pros:** works on every EVM chain with no precompile caveats; the same key type our Safe owners use for EIP-712 group additions ([[0004-l2-choice]]); hardware wallets (Ledger, Trezor) are cheap and common; `@noble/curves`' `secp256k1` is audited.
- **Cons:** no FIPS 140 HSM, PIV card or platform enclave support for secp256k1 signing beyond a few HSMs and cloud KMS; NIST SP 800-186 allows the curve only for blockchain use. A trustee that is a university or a civil-society body has fewer custody choices, and the custody of these keys is what T-37 rests on. `ecrecover` returns an address, so verification by key recovery hides a malformed signature as "some other signer" unless every caller checks the range rules; OpenZeppelin's `ECDSA` does.

### B∧C. Both: every identity-signed (ceremony-phase) message carries a P-256 and a secp256k1 signature

Each seat pins two identity keys, both bound into `panel_id`; a ceremony-phase statement counts only with both signatures, checked on chain through `P256VERIFY` and `ecrecover`.

- **Pros:** closes the residual recorded under B: forging `k` seats' ceremony entries would need an undisclosed P-256 break _and_ `k` secp256k1 keys (by theft or a separate break), and a custody thief would need both of a seat's keys.
- **Cons:** two keys and two custody processes per trustee, where the secp256k1 key has the narrower hardware choice that is C's main cost; a second key and signature encoding to specify and vector (a wider T-31 surface); about 3,000 more gas per signature on chain.

### D. A post-quantum or hybrid signature (ML-DSA-65, or Ed25519 + ML-DSA)

- **Pros:** signatures stay unforgeable against a quantum adversary.
- **Cons:** ML-DSA in the `@noble/*` family is `@noble/post-quantum`, whose audit status is the owner's question in [[0002-everlasting-privacy]]; an agent can't ship it on its own authority. No EVM precompile or audited Solidity verifier exists, so the registry couldn't check it. Signatures are 3.3 KB each.
- **Why post-quantum matters less here than for confidentiality:** a signature attests to a statement whose hash is registered on L2 and anchored on L1 at the time ([[board]]). A forger with a quantum computer decades later can't change what was anchored then, so the threat is a live forgery during an election, by an adversary who can already break P-256 at that time. A hybrid suite can then be added as a new set of tags and record versions without touching past elections.

## Recommendation

**B, ECDSA over P-256 with SHA-256, low-s.** Two options are checkable on chain with audited code, as the trustee registry needs (T-71, T-37): B through `P256VERIFY` and OpenZeppelin's `P256`, and C through `ecrecover` and OpenZeppelin's `ECDSA`. A and D aren't. Between B and C the choice is a trade-off, and it is close:

- **For B: custody.** The identity key is the one secret whose theft speaks for a seat at every election. Trustees are independent institutions picking their own hardware, and P-256 is what FIPS HSMs, PIV cards, cloud KMS and platform enclaves sign with; secp256k1 has a few HSMs, cloud KMS and hardware wallets. Theft through weak custody is the likelier way to lose an identity key (T-37).
- **For C: parameter provenance.** secp256k1's curve parameters are rigid; P-256's come from an unexplained seed. That matters only against an adversary holding an undisclosed break of P-256, which is speculative, while weak custody is not.

B is chosen for custody. B∧C would remove the provenance residual, but it gives every trustee a second root key whose custody is C's weak point, for protection against a speculative break; it stays open to the owner. B's known weaknesses, nonce generation and malleability, are handled by RFC 6979 and the low-s rule and covered by published vectors. The parameter-provenance residual is stated in [[trustee-identity]] (Security notes). A veto in favour of C is cheap while no identity key is pinned (Decision).

What would change it: an owner decision that trustees must hold Ethereum accounts, or that rigid curve parameters outweigh custody (C); an owner decision that the root statements should not rest on one curve at all (B∧C), at the cost of a second key per trustee; the owner answering the ML-KEM audit question in a way that also clears ML-DSA, which makes a hybrid suite (D, alongside B) the next step; or a practical break of P-256.

## Consequences

- [[trustee-identity]] specifies the identity key and signature encodings, signing and verification, the panel identifier `abolish/v1/panel`, and signature tags under `abolish/v1/sig/`. A signature's message is `DS(tag, m)` under a tag registered with the primitive Signature ([[domain-separation]]), so a signature made for one purpose never verifies for another (T-30, T-31).
- The first signed statement is the ceremony registration (`abolish/v1/sig/ceremony-registration`), which the trustee registry checks (P1-18). Further statements (KEM key possession, share receipts, tally shares, destruction) register their own tags in the items that define them (P1-12, P1-14, P1-15).
- `packages/crypto` signs with RFC 6979 deterministic nonces, and verifies with the low-s rule. Trustee nodes MAY sign in an HSM with random nonces; they normalise `s` before publishing.
- Contracts verify through OpenZeppelin's `P256` (vendored per the `contracts` skill) which checks the range and low-s rules before calling the precompile, and check them again themselves as defence in depth; the panel's keys are stored uncompressed at deployment (P1-18).
- The owner's panel decision ([[0006-trustees]]) supplies P-256 identity keys. A trustee that can only hold Ethereum keys can't take a seat without a new suite.
- **Known-weak:** not post-quantum (option D, above); an identity key, once stolen, speaks for its seat at every future election until a new verifier release unpins it (T-37).

## Decision

Option B, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto in favour of C changes [[trustee-identity]]'s encodings and the registry's verification, and nothing else. A veto in favour of B∧C also changes the panel identifier's layout (two keys per seat) and every ceremony-phase statement (two signatures). No identity key has been pinned or anchored yet.
