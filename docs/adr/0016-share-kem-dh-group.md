# ADR 0016: The Diffie–Hellman half of the share KEM

- Status: needs-decision (owner-only): the brief's non-negotiable exception for unaudited ML-KEM names X25519. Recommended: option A
- Date: 2026-10-11
- Deciders: owner. [[PROJECT_BRIEF]] (Non-negotiable properties) allows unaudited ML-KEM from `@noble/post-quantum` only "inside a hybrid KEM with X25519 on testnets", and changes to the brief's non-negotiable properties are owner-only (rule A). Option A pairs it with Curve25519 DH in its ristretto255 encoding, not RFC 7748's X25519, so an agent's reading can't settle it.
- Threats addressed: T-15, T-39, T-41, T-36 (see [[THREAT_MODEL]])

## Context

[[0002-everlasting-privacy]] (option B, accepted by the owner) encrypts each trustee's shares under a hybrid KEM that combines ML-KEM-768 with "Diffie–Hellman in the commitment group, following the X-Wing pattern", and says why: a trustee complains about a posted ciphertext by publishing its Diffie–Hellman value with a Chaum–Pedersen proof against its registered key, and that proof is standard only in a prime-order group. On 2026-10-11 the owner answered the ML-KEM question with "a hybrid KEM (X25519 combined with ML-KEM-768 from `@noble/post-quantum`)", allowed on testnets only, with an audit before mainnet.

The two texts name the classical half differently. X25519 (RFC 7748) is Diffie–Hellman on the Montgomery form of Curve25519, over x-coordinates, with clamped scalars and a cofactor of 8. ristretto255 (RFC 9496), the commitment group of [[0007-group-and-hash]], is the prime-order quotient of the same curve's group. Both rest on the same discrete-log problem on Curve25519, so breaking either half is the same work. They differ in what can be proved about a DH value.

What is one-way: the trustee KEM key format, the ciphertext layout and the complaint proof become part of the ballot record (`0x0002`, version 1) and the trustee ceremony transcript, which are frozen once anything under them is anchored, testnet included.

## Options

### A. Diffie–Hellman in ristretto255, combined X-Wing-style (ADR 0002 as written)

The trustee's DH key is a ristretto255 element, the ciphertext's DH half an ephemeral ristretto255 element, and the shared secret the encoding of the DH value. The AEAD key is `H(DS(tag, ss_M ‖ ss_DH ‖ ct_DH ‖ pk_DH))`, the X-Wing combiner (`draft-connolly-cfrg-xwing-kem`) with SHA-256 under our tag in place of SHA3-256 under X-Wing's label.

- Pros: a complaint is a Chaum–Pedersen proof of equal discrete logs (Chaum and Pedersen, CRYPTO 1992) in the group every other proof uses, with the same `HashToScalar` and strict decoders ([[group]]). No cofactor, no clamping, no small-subgroup checks (T-39). One curve library path (`@noble/curves`' ristretto255) for commitments, proofs and the KEM.
- Cons: it isn't X-Wing, so X-Wing's vectors and library implementations (`@noble/post-quantum`'s `XWing` among them) don't apply; our own vectors and an independent implementation carry the weight (T-36). X-Wing's security argument transfers (its combiner proof needs only a DH-type KEM that is IND-CPA under the strong DH assumption in a prime-order group, plus ML-KEM's ciphertext second-preimage resistance), but no one has published that transfer for this instance.

### B. X25519 as RFC 7748 defines it, as X-Wing does

The DH half is X25519 exactly, and the KEM is X-Wing itself.

- Pros: a published, analysed KEM with vectors and an existing implementation.
- Cons: complaints need a proof that a revealed X25519 output is the trustee key's DH value. Montgomery x-coordinates lose the sign, clamped scalars are multiples of 8, and the curve has a cofactor, so a Chaum–Pedersen proof has to be rebuilt over the Edwards form with cofactor clearing and sign handling: a new proof composition, not a standard one, and exactly the kind of encoding ambiguity T-31 and T-39 warn about. Without a sound complaint proof, [[0002-everlasting-privacy]]'s rule that complaints are always proofs fails, and a trustee could exclude ballots by unproven claims.

### C. X-Wing for the KEM, with a second, ristretto255 key only for complaints

- Cons: the complaint would prove a DH value under a key the ciphertext never used, so it proves nothing about the posted share. Not viable.

## Recommendation

Option A. The owner's answer is about the post-quantum question: that ML-KEM-768 is used, combined with a classical Curve25519 Diffie–Hellman so a share falls only if both break. Option A meets that on the same curve and the same hardness assumption, and keeps the complaint proof ADR 0002 depends on standard. "X25519" in the answer is read as Diffie–Hellman on Curve25519, here in its prime-order ristretto255 encoding. A published, analysed X-Wing variant over a prime-order group with vectors, or a published complaint proof over X25519, would reopen the choice.

## Consequences

- [[share-encryption]] specifies the KEM, the AEAD (ChaCha20-Poly1305, RFC 8439, from `@noble/ciphers`), the trustee KEM key format, the ciphertext and its hash, the public check of a posting and the complaint proof. P1-14 part 2 registers the keys with their proofs of possession.
- `packages/crypto` depends on `@noble/post-quantum` (ML-KEM-768 only) and `@noble/ciphers` (ChaCha20-Poly1305 only). `@noble/post-quantum` is self-audited only, at version 0.6.1 (April 2026); the pinned 0.7.1 includes changes since that self-audit. The owner allowed it on testnets, and an independent audit of the code in use is a mainnet prerequisite ([[0002-everlasting-privacy]], Decision).
- Without published vectors for this KEM, `docs/spec/vectors/share-encryption.json` comes from an independent Python implementation of ML-KEM-768, ChaCha20-Poly1305 and the combiner, checked against the published accumulated ML-KEM-768 vectors and RFC 8439 (T-36).
- The AEAD's associated data binds the definition, ballot version, seat and VSS commitments, but not the tier or nullifier that [[0002-everlasting-privacy]] (Private part) lists: the validity proofs already bind both together with every ciphertext hash, and leaving them out lets a ballot's ciphertexts be made before its nullifier, as a challenged ballot needs ([[ballot-validity]], Proving; [[verifier]] 6.2). This narrows nothing ADR 0002 relies on ([[share-encryption]], Ciphertext).
- Every ciphertext carries a Schnorr proof of knowledge of its DH ephemeral, binding the whole ciphertext, seat, key and committed vote. The in-session review of P1-12 part 2 showed that without it, an attacker who copies a victim's ephemeral into its own posted ciphertext turns an honest trustee's complaint into a decryption of the victim's share. With it, a complaint reveals only a DH value its poster already knows, so complaints are no longer a static Diffie–Hellman oracle either.
- A veto choosing option B blocks share encryption until a complaint proof over X25519 is specified and reviewed.

## Decision

Waiting on the owner, listed under Waiting on the owner in [[STATUS]]. `crypto-review` on #58 found that this ADR first recorded option A as an agent decision, which reads the brief's non-negotiable "with X25519" as Diffie–Hellman on Curve25519 in any encoding. That reading is the owner's to make. Any one of these settles it:

- the owner amends the brief's exception (or confirms in [[0002-everlasting-privacy]], Decision) to cover Curve25519 DH in its ristretto255 encoding, which accepts option A as built in #58;
- the owner keeps X25519 as RFC 7748 defines it, and P1-12 part 2 is rebuilt on option B with a reviewed complaint proof over X25519.

The owner's answer should also cover a second, smaller departure from the owner-accepted [[0002-everlasting-privacy]] (Consequences, above): the AEAD's associated data leaves out the tier and nullifier that ADR 0002's Private part lists, so a challenged ballot's ciphertexts can be made before its nullifier. The same holds for the proof of knowledge of each ciphertext's DH ephemeral: its challenge leaves out the nullifier, which [[domain-separation]] (Fiat–Shamir) requires of every proof carried in a ballot ([[share-encryption]], Notes). No attack was found on either: moving the ciphertexts or their proofs to another nullifier needs new validity proofs over the same `vss`, which need the openings.

Until then, #58 doesn't merge and nothing builds on its formats (P1-14 part 2, P1-12 part 3, P1-15 parts 2 and 3).
