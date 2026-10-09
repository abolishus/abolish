# ADR 0003: Ballot tally scheme per election type

- Status: needs-decision
- Date: 2026-10-09
- Deciders: owner (one-way door)
- Threats addressed: T-28, T-14, T-29, T-30, T-36, T-45, T-54, T-70 (new), with T-15 deferred to the everlasting-privacy ADR (see [[THREAT_MODEL]])

## Context

The brief requires counted-as-recorded verifiability "by homomorphic tally or verifiable mixnet with ZK proofs", for three election types: plurality, approval and ranked choice. The tally scheme fixes:

- what a ballot on the public board is (one ciphertext per option, or one ciphertext per ballot);
- what the validity proofs prove, and whether they can be checked before the tally (T-28);
- what the trustees decrypt: one aggregate per option and tier, or every individual ballot (T-14);
- which trustees must be online, when, and in what order (T-54);
- how much a third-party verifier has to implement (T-36).

It is one-way because ballots and tally transcripts are anchored: once an election has been run under a scheme, every verifier must keep supporting that scheme's records forever. A new election type can add a scheme later as a new record type, so the door is one-way per election type, not for the platform as a whole.

The privacy model (perfectly hiding commitments vs threshold ElGamal on the board) is P1-3's decision, not this one. Both options below have commitment-consistent variants that keep the board perfectly hiding (Cuvelier, Pereira and Peters, "Election Verifiability or Ballot Privacy: Do We Need to Choose?", ESORICS 2013; Cuvelier and Pereira, "Verifiable Multi-Party Computation with Perfectly Private Audit Trail", ACNS 2016), so this ADR doesn't constrain P1-3, and P1-3 doesn't settle this one. The group (curve) and hash are P1-11's decision. Below, "ElGamal" means ElGamal over the prime-order group P1-11 picks.

Ranked choice here means instant-runoff voting (IRV), the form US civic ranked-choice elections use (Maine, Alaska, New York City primaries). Reporting a Borda count or Condorcet winner instead would change what the result means, so it isn't an acceptable substitute.

## Options

### A. Homomorphic exponential ElGamal for every election type

A ballot is one exponential-ElGamal ciphertext `(g^r, g^v · h^r)` per option. The tally multiplies the last valid ballot of each nullifier, per option and per tier, and the trustees threshold-decrypt only those products, each share with a Chaum–Pedersen proof (T-29). The final discrete log is at most the number of voters, which baby-step giant-step finds in about √N group operations (about 13,000 for 160 million voters).

Validity (T-28), proved per ballot with disjunctive Chaum–Pedersen proofs (Cramer, Damgård and Schoenmakers, CRYPTO 1994) under a Fiat–Shamir challenge that hashes the whole statement (T-30):

- **Plurality:** each option encrypts 0 or 1, and the homomorphic sum encrypts 0 (blank) or 1. An over-vote can't be cast.
- **Approval:** each option encrypts 0 or 1; if the election sets an approval limit L, the sum is proved to lie in [0, L] (a disjunction over L + 1 values).
- **Ranked choice:** IRV can't be computed from per-option sums, because each round transfers ballots according to their next surviving preference. Two ways remain:
  - encrypt a rank matrix and report only pairwise or Borda totals, which is not IRV (rejected above);
  - tally IRV on encrypted ballots with a dedicated protocol such as Shuffle-Sum (Benaloh, Moran, Naish, Ramchen and Teague, IEEE TIFS 2009). It needs a shuffle per elimination round anyway, so it is a mixnet plus extra machinery, with no audited implementation and no published verifier spec.

This is the design of Helios 2.0 (Adida, de Marneffe, Pereira and Quisquater, EVT/WOTE 2009), Belenios's default mode, and ElectionGuard 2.0 (Benaloh and Naehrig), whose specification is written so that third parties can build a verifier from it alone.

- **Pros:**
  - Individual ballots are never decrypted, by anyone. Honest trustees learn only per-option totals per tier (T-14's exposure is limited to a collusion of k).
  - Invalid ballots are rejected before the tally, publicly, by anyone (T-28), and the server can't "fix" them.
  - Trustees act once, after close, and any k of n suffice, in any order (T-54).
  - The verifier is small: per-ballot proof checks, a product, and decryption-share checks. ElectionGuard's specification shows it can be specified completely enough for third parties (T-36).
  - Re-voting is simple: the tally takes the last ballot per nullifier (P1-13), which is public.
- **Cons:**
  - No IRV without the extra machinery above, which is a mixnet in disguise.
  - Ballot size and proof work grow linearly with the number of options (one ciphertext and one disjunctive proof per option), and with L for a limited approval sum.
  - No write-ins: every option must be fixed in the election definition.

### B. Verifiable re-encryption mixnet for every election type

A ballot is one ElGamal ciphertext (or a short fixed list of them) encoding the whole choice. After close, a sequence of mix servers each re-encrypts and permutes the list of last-per-nullifier ballots and publishes a proof of shuffle; the trustees then threshold-decrypt every ballot, and anyone computes the tally from the plaintexts. Shuffle proofs: Terelius and Wikström ("Proofs of Restricted Shuffles", AFRICACRYPT 2010, used by Verificatum and the CHVote protocol specification) or Bayer and Groth ("Efficient Zero-Knowledge Argument for Correctness of a Shuffle", EUROCRYPT 2012, used by Swiss Post). Wikström's "How to Implement a Stand-alone Verifier for the Verificatum Mix-Net" is the closest prior art for a third-party verifier spec. Belenios also offers a mixnet mode for complex ballots.

- **Pros:**
  - Any tally rule works on the decrypted ballots, IRV included, and write-ins become possible.
  - The ballot is small and constant in the number of options.
- **Cons:**
  - Every ballot is decrypted and published (unlinked from its voter by the shuffle). For ranked ballots with many candidates this enables the pattern ("Italian") attack: a coercer or vote buyer assigns a voter a rare full ranking and looks for it in the output (new threat T-70). It turns re-voting (T-45) from a defence into one that only works if the coercer can't see the output, which they always can.
  - Validity can be checked only after decryption, so invalid ballots are counted out after the fact (T-28 changes shape), unless each ballot also carries a range proof, which costs as much as A's proofs.
  - Privacy needs at least one honest mixer as well as fewer than k colluding trustees. Mixers act in sequence, so one offline mixer stalls the tally (T-54 is worse).
  - Shuffle proofs are the hardest part of the protocol to implement and verify correctly. The Swiss Post system's Bayer–Groth commitment parameters could be generated with a trapdoor that allowed proving a false shuffle (Haines, Lewis, Pereira and Teague, "How Not to Prove Your Election Outcome", IEEE S&P 2020). Our verifier and every third-party one must implement a shuffle verifier and derive its generators verifiably (T-36, T-39). `@noble/*` has no shuffle proof, so we would compose one from the published protocol.
  - Per-tier results mean mixing each tier separately, which shrinks each anonymity set to that tier's voters.

### C. Hybrid: homomorphic for plurality and approval, mixnet only for ranked choice

Option A for plurality and approval (every Phase 1–4 election type). Ranked choice uses option B's verifiable mixnet, with its own record types, spec and follow-up ADR (shuffle proof, generator derivation, mixer set) before P5-1 implements it. The board and tally transcript carry the scheme as part of the election definition (T-34), so one verifier handles both schemes and can't be pointed at the wrong one.

- **Pros:**
  - Each election type gets the scheme that fits it: no individual decryption where it isn't needed, IRV where it is.
  - Phase 1 builds and verifies only A, the simpler and better-studied scheme, so the reference election and the first independent verifiers don't depend on a shuffle verifier.
  - The mixnet decisions (Terelius–Wikström or Bayer–Groth, who mixes, how generators are derived, how to limit pattern attacks) are made later, with Phase 5 requirements known, without reopening plurality and approval.
- **Cons:**
  - Two tally schemes to specify, implement, test and verify, eventually.
  - Ranked-choice elections carry T-70 and the mixnet's weaker T-54, which plurality and approval don't. That difference must be stated on every ranked-choice result.
  - Ranked choice isn't available until the follow-up ADR and its implementation land.

## Recommendation

**Option C.** Homomorphic exponential ElGamal with disjunctive Chaum–Pedersen validity proofs for plurality and approval; a verifiable mixnet, specified by a follow-up ADR, for ranked choice only.

- A alone can't deliver IRV without becoming a mixnet anyway. B alone decrypts every ballot of every election to gain IRV for one type, and pays for it with pattern attacks, a weaker availability story and a much harder verifier for all of them.
- C keeps the two properties the brief weighs most for the common case: no individual ballot is ever decrypted (T-14), and every ballot's validity is publicly checkable before the tally (T-28). It is what ElectionGuard does for the same election types, which gives third-party verifier authors a familiar model (T-36).

Conventions that come with this choice, specified in P1-8 and P1-12:

- A blank plurality ballot is valid (the sum proof allows 0 or 1). An over-vote can't be cast.
- An approval limit, if any, is part of the election definition and proved by a range disjunction over the sum.
- The tally is computed per tier (each tier's products decrypted separately), so per-tier results never need individual decryption.
- Every Fiat–Shamir challenge binds the election definition hash, the joint public key, the ballot's nullifier, every ciphertext and every commitment (T-30, T-32, T-38).

What would change the recommendation:

- If the owner drops ranked choice, or accepts Borda or Condorcet in its place, A alone suffices and the mixnet never gets built.
- If an audited IRV-on-encrypted-ballots protocol with a published verifier spec appears before P5-1, the follow-up ADR should prefer it over a plain mixnet, because it avoids T-70.
- If write-ins become a requirement for plurality or approval, those elections need the mixnet too.

## Consequences

- P1-12 implements A for plurality and approval: exponential-ElGamal ballots, disjunctive Chaum–Pedersen per option and for the sum (or the approval range), with published-protocol citations in `docs/spec/`.
- P1-15 decrypts per-option, per-tier products only, with Chaum–Pedersen proofs on every share, and the verifier (P1-19) recomputes the products from the board itself.
- The election definition (P1-8, P1-10) carries the election type and tally scheme, so one record type can't be tallied under another's rules.
- A follow-up ADR on the ranked-choice mixnet is needed before P5-1: shuffle proof, verifiable generator derivation, who the mixers are, whether mixers are the trustees, pattern-attack limits (such as capping ranked positions) and how T-70 is reported. It touches a cryptographic protocol, so it is `needs-decision` too.
- Ballot size grows with the number of options. P1-18 must size on-chain direct-submit limits (T-52) and Noir-facing hashes (per [[0001-canonical-encoding]]) for the largest supported option count, which P1-8 states.
- Known-weak:
  - T-14 still holds: k colluding trustees can decrypt any individual ballot from the board, because the per-option ciphertexts are on it. Only P1-3 can change that.
  - T-16 still holds: per-tier totals over few voters reveal individual votes.
  - Ranked choice, once built, carries T-70.

## Default

Opened 2026-10-09 20:01 UTC. If the owner hasn't answered by **2026-10-12 20:01 UTC**, option C is adopted and this ADR is marked `Status: accepted by default — revisit`.
