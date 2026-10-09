# ADR 0002: Everlasting privacy of the public board

- Status: needs-decision
- Date: 2026-10-09
- Deciders: owner (one-way door)
- Threats addressed: T-15 (primary), T-14, T-11, T-28, T-29, T-25, T-26, T-40, T-39, T-30 (see [[THREAT_MODEL]])

## Context

Every ballot is published on the bulletin board, which is mirrored to IPFS, written to the permanent archive (P1-6), and partly posted on the L2. Nothing published can be withdrawn. Whatever the board says about a vote today, an adversary can read in thirty years with whatever cryptanalysis exists then (A-11, "harvest now, decrypt later"). The brief requires an ADR on perfectly hiding commitments versus standard threshold ElGamal, with a post-quantum analysis, before the tally is built (P1-12).

The decision is one-way twice over:

- **Published data is permanent.** If an election's ballots are published under a computationally hiding scheme, a later switch to a hiding scheme doesn't help them. Their privacy is fixed on the day they're published.
- **It shapes the ballot format, the trustee ceremony and the tally.** Ballot bytes are anchored (see [[0001-canonical-encoding]]). P1-12 (ballot encryption), P1-14 (ceremony), P1-15 (tally) and P1-4 (tally scheme per election type) all build on the answer.

What a future break reveals depends on what links a vote to a person, not only on the ciphertext:

- Nullifiers are Poseidon hashes of the voter's secret and the poll scope (Semaphore v4). Identity commitments are hashes of a public key that we never publish. Linking either one to a person needs the voter's secret or a preimage, which hash functions resist even against a quantum adversary (Grover gives only a square-root speedup).
- So a broken ballot ciphertext reveals "nullifier N voted X", not "Alice voted X", unless something else links N to Alice. Such links exist and are realistic for a state adversary (A-1): network metadata recorded at submission time (T-11), small per-tier counts (T-16), a stolen device (T-18), and direct submits from a funded address (T-25). Harvested votes plus harvested metadata are the real everlasting-privacy threat. In a coercive state, that is also the threat that matters most.

Some limits hold whatever we choose:

- **Hiding and binding can't both be perfect.** A commitment that is perfectly hiding is only computationally binding (and vice versa). Under every option, a future discrete-log break also lets someone forge "alternative" openings and proofs for historical elections. Historical verification then rests on what was anchored to L1 before the break, which depends on hash functions only. This is the same for every option here, so it doesn't separate them; P1-16 must make sure every verification transcript is anchored.
- **Trustees always see what they decrypt.** No option here stops k colluding trustees from reading individual ballots during the election (T-14). The question is only what the _public_ can read later.
- **Membership proofs.** Semaphore's Groth16 proofs are perfectly zero-knowledge, so they leak nothing even to an unbounded adversary. Our Noir circuits (P1-17) must use bb's zero-knowledge UltraHonk flavour; whether its zero knowledge is statistical or only computational must be confirmed in P1-17 and stated in the spec.

## Options

### A. Threshold exponential ElGamal on the public board

The classic design: Helios (Adida, USENIX Security 2008), Belenios, and ElectionGuard (Design Specification 2.0, Benaloh and Naehrig). Trustees run a DKG for a joint public key (P1-14). Each ballot publishes, per option, an exponential ElGamal ciphertext `(g^r, g^v · K^r)` with disjunctive Chaum–Pedersen validity proofs (CDS, CRYPTO 1994). Ciphertexts are multiplied homomorphically, and k trustees publish decryption shares of the aggregate with Chaum–Pedersen proofs.

- **Pros:**
  - The best-studied design for verifiable voting, with published specs and test vectors (ElectionGuard) that we can follow and check against.
  - Everything needed to tally sits on the public board, so the wipe-and-rebuild invariant and direct submit are simple: a ballot is self-contained.
  - Smallest ballots: two group elements and one proof per option.
  - Works for both tally schemes P1-4 compares: homomorphic for plurality and approval, and well-known verifiable mixnets for ranked choice (Terelius–Wikström, Bayer–Groth).
- **Cons:**
  - Privacy is only computational (DDH). A discrete-log break, including a cryptographically relevant quantum computer running Shor's algorithm, decrypts every ballot ever published, for every election, at once. Each ciphertext can be broken on its own; the joint key doesn't even need to be recovered, because `g^r` is public.
  - There is no way to fix this later: already-published ciphertexts stay breakable.
- **Threats:** T-15 is **not mitigated**. T-14 and T-29 are mitigated as P1-14 and P1-15 already plan.

### B. Perfectly hiding commitments on the board; openings shared to trustees off the board

"Everlasting privacy towards the public": Moran and Naor (CRYPTO 2006); applied to Helios by Demirel, van de Graaf and Araújo (EVT/WOTE 2012); generalised by Cuvelier, Pereira and Peters, "Election Verifiability or Ballot Privacy: Do We Need to Choose?" (ESORICS 2013), with a survey in Haines, Mosaheb, Müller and Pryvalov, "SoK: Secure E-Voting with Everlasting Privacy" (PoPETs 2023). The construction below combines published parts: Pedersen commitments, Pedersen's verifiable secret sharing (CRYPTO 1991), CDS proofs and a hybrid KEM.

How it works:

1. **Public part.** For each option, the client publishes a Pedersen commitment `C = g^v · h^r`, where `h` is a second generator with no known discrete log relative to `g` (derived by hash-to-curve, RFC 9380, in P1-11). It also publishes disjunctive CDS proofs that each `C` commits to 0 or 1 and that the sum is allowed (T-28). Pedersen commitments are perfectly hiding: every `v` is equally consistent with `C`, so no amount of computation reveals the vote. The proofs are honest-verifier perfect zero-knowledge Σ-protocols made non-interactive with Fiat–Shamir, binding the full statement (T-30).
2. **Private part.** The client splits `(v, r)` for each option into Shamir shares for the n trustees with threshold k, using Pedersen VSS. It publishes the VSS commitments, which are also perfectly hiding (their constant term is `C` itself). Each trustee's shares are encrypted under that trustee's public key with a hybrid post-quantum KEM: X-Wing (ML-KEM-768 per FIPS 203 combined with X25519; `draft-connolly-cfrg-xwing-kem`), or an equivalent combiner fixed in the spec. These share ciphertexts go to the trustees, not onto the public board.
3. **Validity of shares.** Each trustee checks its shares against the public VSS commitments. A ballot counts only if at least k trustees attest (signed, on the board) that their share is consistent. If a share is disputed, the voter can prove what was sent by revealing that one ciphertext's encapsulation seed: X-Wing encapsulation, ML-KEM and X25519 parts alike, is deterministic given its seed, so anyone can recompute the ciphertext and decrypt that share. That reveals one share, fewer than k, which by Shamir's perfect secrecy says nothing about the vote. The full dispute procedure is P1-13's.
4. **Tally.** Over the counted ballots (last ballot per nullifier, T-33), each trustee sums its shares and publishes the sums. Anyone can check each trustee's published sums against the product of the public VSS commitments, so a wrong share is attributed to its trustee (T-29). Any k correct sums interpolate to the aggregate `(Σv, Σr)`, and anyone checks that this opens the product of the public commitments. Only totals are ever revealed.

- **Pros:**
  - **The public board is information-theoretically hiding.** Commitments, VSS commitments, validity proofs and the tally transcript reveal nothing about any individual vote, even to an adversary with unbounded computation or a quantum computer. T-15 is mitigated for everything published.
  - **No DKG.** Trustees only need a KEM key and a signing key each; the threshold comes from voter-side sharing. That removes the key-bias and rogue-key problems of the DKG (T-40), and the ceremony becomes key registration with proofs of possession.
  - **Attributable trustee errors.** Each trustee's contribution to the tally is checked individually against public data (T-29).
  - Built from primitives in `@noble/curves` (Pedersen, Schnorr/CDS proofs, hash-to-curve, X25519) plus ML-KEM.
- **Cons:**
  - **The private part is only computationally hiding.** Anyone who records the share ciphertexts in transit (A-1 recording traffic to us or to trustees) and later breaks both ML-KEM and X25519 learns shares. With shares for k trustees, they learn the vote. Privacy against that adversary is post-quantum conjectured (Module-LWE), not everlasting. Two things reduce the exposure: hybrid post-quantum TLS on every intake endpoint, and the ciphertexts never being published.
  - **Direct submit exposes the private part.** A voter who bypasses our servers (T-25) has to get the share ciphertexts to the trustees some other way. Each trustee can run its own intake endpoint, independent of us, and the contracts take only the public part. If every trustee endpoint is also unreachable, the last resort is posting the share ciphertexts on-chain, and then that ballot is only post-quantum-computationally private, not everlasting. The client must say so before the voter uses that path.
  - **Availability of the private part.** Until the tally is published, the election depends on at least k trustees keeping their share ciphertexts. They aren't on the public board, so they can't be rebuilt from chain and IPFS. Each trustee keeps its own; our operational store keeps a copy, which is encrypted to the trustees and non-authoritative. Once the tally transcript is published, the wipe-and-rebuild invariant holds again for the result.
  - **Larger ballots, more trustee work.** Per option, a ballot carries k VSS commitments and, per trustee, two scalars inside a KEM ciphertext. Rough estimate for 10 options, k = 4 and n = 7: about 1.3 KB of public commitments plus about 12 KB of share ciphertexts (seven 1,120-byte X-Wing ciphertexts plus payload). Trustees decapsulate and check every ballot, not only the aggregate.
  - **A new drop path.** If n − k + 1 trustees falsely claim a ballot's shares are invalid, they can exclude it. The attestations are public, so the drop is visible, and the voter's seed-reveal dispute refutes it.
  - **Ranked choice is harder.** Homomorphic tallying covers plurality and approval directly. Ranked choice needs a mixnet over commitment-consistent ciphertexts (Cuvelier–Pereira–Peters cover this), which is less established than ElGamal mixnets. P1-4 has to settle this per election type.
  - **Less prior art to copy.** No deployed system with published vectors matches this exact composition, so we write more spec and more of our own vectors (T-36), and `crypto-review` carries more weight.
  - **ML-KEM's library status.** In the `@noble/*` family, ML-KEM lives in `@noble/post-quantum`. Before P1-12 depends on it, we must confirm whether it has an independent audit (the brief allows only audited cryptographic libraries). If it hasn't, the hybrid still has X25519's classical security from audited `@noble/curves`, and the post-quantum layer is recorded as known-weak until an audit exists.
- **Threats:** T-15 is **mitigated for the public board**; the remaining risk is harvested private shares (computational, post-quantum conjectured) and the direct-submit fallback. T-14 is unchanged (k trustees read ballots during the election). T-29 and T-40 are improved. T-25 and T-26 get a new dependency on trustee intake.

### C. Post-quantum (lattice-based) encryption on the public board

Keep a single public, self-contained ciphertext, as in A, but under a lattice assumption: for example, the lattice-based verifiable mixnet and distributed decryption of Aranha, Baum, Gjøsteen and Silde (ACM CCS 2023), or lattice-based homomorphic encryption with lattice zero-knowledge proofs.

- **Pros:**
  - Resists Shor's algorithm. A ballot stays self-contained on the public board, so direct submit and wipe-and-rebuild stay as simple as in A.
- **Cons:**
  - **Not everlasting.** Privacy is still computational, now resting on lattice assumptions that are younger and whose parameters have moved more than discrete log's. A future lattice break would reveal every published ballot, exactly as in A.
  - **No audited library.** Nothing in `@noble/*` or any audited JavaScript library implements threshold lattice encryption with the zero-knowledge proofs voting needs. We would have to implement the primitives ourselves, which the brief forbids.
  - Ciphertexts and proofs are tens to hundreds of kilobytes per ballot, which is heavy for the L2 and for the ballot client.
- **Threats:** T-15 moves from "breaks under quantum" to "breaks if lattices break"; it isn't closed. It also fails the audited-libraries rule (T-39).

## Recommendation

**Option B: perfectly hiding commitments on the public board, with openings shared to the trustees under a hybrid post-quantum KEM, off the board.**

- It is the only option whose published data stays private against any future adversary. The board is permanent and is mirrored to IPFS and an archive, so its privacy has to last as long as the data does.
- What B leaves computational (the share ciphertexts in transit and at the trustees) is not published, travels under post-quantum hybrid encryption, and can be deleted after the tally. Under A or C, the computational part _is_ the permanent public record.
- It removes the DKG, a source of real attacks (T-40), and makes each trustee's tally contribution checkable on its own (T-29).
- It is built only from published protocols and the primitives `@noble/*` provides.

The costs are real, and P1-12 to P1-15 must carry them:

- trustee intake endpoints and the dispute procedure;
- a direct-submit fallback with weaker privacy, disclosed to the voter;
- availability of the private part until the tally;
- the ML-KEM audit question;
- a less established mixnet for ranked choice.

What would change the recommendation:

- If P1-4 finds that no commitment-consistent mixnet for ranked choice can be built from audited primitives, use B for plurality and approval, and decide ranked choice separately. Running A only for ranked choice would knowingly accept T-15 for those elections; it needs the owner's explicit sign-off and a warning shown to voters.
- If trustees can't operate independent intake and retention, B's direct-submit and availability costs would apply to every ballot rather than only to the fallback path. A would then be simpler for the same practical privacy against A-1. This would need re-evaluating with the trustee ADR (P1-7).
- If an audited library offered threshold encryption with everlasting public privacy as a ready-made primitive, prefer it for new election versions.

## Consequences

If B is accepted:

- **P1-11** derives the second Pedersen generator `h` by hash-to-curve (RFC 9380) with a registered domain tag, and publishes vectors proving that no one chose it.
- **P1-12** becomes "ballot commitments, validity proofs, Pedersen VSS shares and hybrid-KEM share encryption". The client generates all the randomness through `packages/crypto` (T-39). The specified format is fixed per [[0001-canonical-encoding]].
- **P1-13** covers trustee share attestations, the seed-reveal dispute, and how Benaloh challenges open both the commitments and the shares (a spoiled ballot reveals its own vote and is never counted).
- **P1-14** becomes trustee key registration (a hybrid KEM key and a signing key per trustee, each with proof of possession), with a public transcript, instead of a DKG. T-40's mitigation text changes to match.
- **P1-15** publishes per-trustee summed shares, checked against the public VSS commitments, and the opening of the aggregate commitment.
- **P1-4** must say, per election type, how the tally works over commitments, in particular ranked choice.
- **P1-9/P1-12** confirm the audit status of `@noble/post-quantum` before depending on it, and record the result in STATUS.
- **P1-17** confirms bb's zero-knowledge UltraHonk flavour and states its zero-knowledge property in the spec.
- **P2-3 and P2-11**: every ballot intake endpoint (ours and the trustees') negotiates hybrid post-quantum TLS (`X25519MLKEM768`), and logs never retain share ciphertexts beyond the tally.
- **P1-16, P1-20 and P4-1** anchor every verification and tally transcript to L1, so historical verification doesn't depend on discrete log surviving.
- **[[THREAT_MODEL]]**: T-15 becomes "Partial by design". The residual is harvested share ciphertexts (post-quantum conjectured) and direct-submit fallback ballots. The not-mitigated list keeps T-14 and changes T-15 accordingly.

If A is chosen instead, T-15 stays in the not-mitigated list as "every ballot on the board becomes readable after a discrete-log break". Every election page and the verifier must state this.

## Default

Opened 2026-10-09 20:00 UTC. If the owner hasn't answered by **2026-10-12 20:00 UTC**, option B is adopted and this ADR is marked `Status: accepted by default — revisit`. Tally work (P1-12 onwards) doesn't start before then.
