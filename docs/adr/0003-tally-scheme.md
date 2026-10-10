# ADR 0003: Ballot tally scheme per election type

- Status: Accepted (agent) — owner may veto (2026-10-10, rule A): option C
- Date: 2026-10-09
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-28, T-14, T-29, T-30, T-32, T-33, T-36, T-38, T-39, T-45, T-54, T-70 (new), with T-15 deferred to the everlasting-privacy ADR (see [[THREAT_MODEL]])

## Context

The brief requires counted-as-recorded verifiability "by homomorphic tally or verifiable mixnet with ZK proofs", for three election types: plurality, approval and ranked choice. The tally scheme fixes:

- what a ballot on the public board is (one ciphertext per option, or one ciphertext per ballot);
- what the validity proofs prove, and whether they can be checked before the tally (T-28);
- what the trustees decrypt: one aggregate per option and tier, or every individual ballot (T-14);
- which trustees must be online, when, and in what order (T-54);
- how much a third-party verifier has to implement (T-36).

It is one-way because ballots and tally transcripts are anchored: once an election has been run under a scheme, every verifier must keep supporting that scheme's records forever. A new election type can add a scheme later as a new record type, so the door is one-way per election type, not for the platform as a whole.

The privacy model (perfectly hiding commitments vs threshold ElGamal on the board) is P1-3's decision, not this one. Both options below have commitment-consistent variants that keep the board perfectly hiding (Cuvelier, Pereira and Peters, "Election Verifiability or Ballot Privacy: Do We Need to Choose?", ESORICS 2013; Cuvelier and Pereira, "Verifiable Multi-Party Computation with Perfectly Private Audit Trail", ACNS 2016), so this ADR doesn't constrain P1-3, and P1-3 doesn't settle this one. The group (curve) and hash are P1-11's decision. Below, "ElGamal" means ElGamal over the prime-order group P1-11 picks.

Ranked choice here means single-winner instant-runoff voting (IRV), the form most US civic ranked-choice elections use (Maine, Alaska, New York City primaries). Multi-winner STV (Cambridge MA, Portland OR) is out of scope for this ADR. Reporting a Borda count or Condorcet winner instead would change what the result means, so it isn't an acceptable substitute.

## Options

### A. Homomorphic exponential ElGamal for every election type

A ballot is one exponential-ElGamal ciphertext `(g^r, g^v · h^r)` per option. The tally multiplies the counted ballot of each nullifier (the re-vote rule under Recommendation), per option and per tier, and the trustees threshold-decrypt only those products, each share with a Chaum–Pedersen proof (T-29). The final discrete log is at most the number of voters, which baby-step giant-step finds in about √N group operations (about 13,000 for 160 million voters).

Validity (T-28), proved per ballot with disjunctive Chaum–Pedersen proofs (Cramer, Damgård and Schoenmakers, CRYPTO 1994; applied to ElGamal ballots by Cramer, Gennaro and Schoenmakers, EUROCRYPT 1997) under a Fiat–Shamir challenge that hashes the whole statement (T-30; Bernhard, Pereira and Warinschi, "How Not to Prove Yourself", ASIACRYPT 2012, is the Helios precedent for getting this wrong):

- **Plurality:** each option encrypts 0 or 1, and the homomorphic sum encrypts 0 (blank) or 1. An over-vote can't be cast.
- **Approval:** each option encrypts 0 or 1; if the election sets an approval limit L, the sum is proved to lie in [0, L] (a disjunction over L + 1 values).
- **Ranked choice:** IRV can't be computed from per-option sums, because each round transfers ballots according to their next surviving preference. Three ways remain:
  - encrypt a rank matrix and report only pairwise or Borda totals, which is not IRV (rejected above);
  - encrypt a one-hot histogram over every possible ranking and tally it homomorphically. That gives exact IRV for very few candidates, but the ballot grows with m! and the decrypted histogram exposes every ranking pattern (T-70), so it has a mixnet's privacy cost without its flexibility;
  - tally IRV on encrypted ballots with a dedicated protocol: Shuffle-Sum (Benaloh, Moran, Naish, Ramchen and Teague, IEEE TIFS 2009), or the verifiable MPC IRV count of Ramchen, Culnane, Pereira and Teague ("Universally Verifiable MPC and IRV Ballot Counting", FC 2019). They use shuffles but reveal only round totals, never individual rankings, so they avoid T-70. Neither has an audited implementation or a published stand-alone verifier spec, and both are far more complex than A or B.

This is the design of Helios 2.0 (Adida, de Marneffe, Pereira and Quisquater, EVT/WOTE 2009), Belenios's default mode, and ElectionGuard 2.0 (Benaloh and Naehrig), whose specification is written so that third parties can build a verifier from it alone.

- **Pros:**
  - Individual ballots are never decrypted, by anyone. Honest trustees learn only per-option totals per tier (T-14's exposure is limited to a collusion of k).
  - Invalid ballots are rejected before the tally, publicly, by anyone (T-28), and the server can't "fix" them.
  - Trustees act once, after close, and any k of n suffice, in any order (T-54).
  - The verifier is small: per-ballot proof checks, a product, and decryption-share checks. ElectionGuard's specification shows it can be specified completely enough for third parties (T-36).
  - Re-voting is simple: the nullifier is public, so the tally selects each nullifier's counted ballot before multiplying (P1-13).
- **Cons:**
  - No IRV without one of the protocols above, each of which needs shuffles anyway and is far more complex than a plain mixnet.
  - Ballot size and proof work grow linearly with the number of options (one ciphertext and one disjunctive proof per option), and with L for a limited approval sum.
  - No write-ins: every option must be fixed in the election definition.

### B. Verifiable re-encryption mixnet for every election type

A ballot is one ElGamal ciphertext (or a short fixed list of them) encoding the whole choice. After close, a sequence of mix servers each re-encrypts and permutes the list of last-per-nullifier ballots and publishes a proof of shuffle; the trustees then threshold-decrypt every ballot, and anyone computes the tally from the plaintexts. Shuffle proofs: Terelius and Wikström ("Proofs of Restricted Shuffles", AFRICACRYPT 2010, used by Verificatum and the CHVote protocol specification) or Bayer and Groth ("Efficient Zero-Knowledge Argument for Correctness of a Shuffle", EUROCRYPT 2012, used by Swiss Post). Wikström's "How to Implement a Stand-alone Verifier for the Verificatum Mix-Net" is the closest prior art for a third-party verifier spec. Belenios also offers a mixnet mode for complex ballots.

- **Pros:**
  - Any tally rule works on the decrypted ballots, IRV included, and write-ins become possible (though a unique write-in is itself a pattern, T-70).
  - The ballot is small: about log2 of the number of possible choices (log2(m!) bits for a full ranking), packed into one or a few ciphertexts.
- **Cons:**
  - Every ballot is decrypted and published (unlinked from its voter by the shuffle). Plurality has only m patterns, but approval has 2^m and ranked choice up to m!, enough for the pattern ("Italian") attack: a coercer or vote buyer assigns a voter a rare full ranking and looks for it in the output (new threat T-70). It turns re-voting (T-45) from a defence into one that only works if the coercer can't see the output, which they always can.
  - Every ballot still needs a proof of knowledge of its plaintext and randomness, bound to its nullifier. Without one, another voter can re-randomise a target's ballot, cast it, and find the duplicate in the decrypted output, learning the target's vote (T-32; Cortier and Smyth, "Attacking and Fixing Helios", CSF 2011). Well-formedness is either proved per ballot too, at a cost comparable to A's proofs, or checked only after decryption, so invalid ballots are counted out after the fact (T-28 changes shape).
  - Encoding a whole choice as a group element needs a message-to-point encoding that `@noble/*` doesn't provide, so it would be the one piece of the scheme at risk of being hand-rolled (T-39).
  - Privacy needs at least one honest mixer among those that actually mixed, as well as fewer than k colluding trustees. Mixers act in sequence: an absent mixer can be skipped (the next one mixes the last verified output), but each skip weakens the honest-mixer assumption, and the tally waits on sequential rounds (T-54 is worse).
  - Shuffle proofs are the hardest part of the protocol to implement and verify correctly. The Swiss Post system's Bayer–Groth commitment parameters could be generated with a trapdoor that allowed proving a false shuffle (Haines, Lewis, Pereira and Teague, "How Not to Prove Your Election Outcome", IEEE S&P 2020). Our verifier and every third-party one must implement a shuffle verifier and derive its generators verifiably (T-36, T-39). `@noble/*` has no shuffle proof, so we would compose one from the published protocol.
  - Per-tier results mean mixing each tier separately. Tier membership is public in every scheme, so this costs nothing extra for secrecy in general, but smaller output lists make T-70 easier.

### C. Hybrid: homomorphic for plurality and approval, mixnet only for ranked choice

Option A for plurality and approval (every Phase 1–4 election type). Ranked choice uses option B's verifiable mixnet, with its own record types, spec and follow-up ADR (shuffle proof, generator derivation, mixer set) before P5-1 implements it. The board and tally transcript carry the scheme as part of the election definition (T-34), so one verifier handles both schemes and can't be pointed at the wrong one.

- **Pros:**
  - Each election type gets the scheme that fits it: no individual decryption where it isn't needed, IRV where it is.
  - Phase 1 builds and verifies only A, the simpler and better-studied scheme, so the reference election and the first independent verifiers don't depend on a shuffle verifier.
  - The mixnet decisions (Terelius–Wikström or Bayer–Groth, who mixes, how generators are derived, how to limit pattern attacks) are made later, with Phase 5 requirements known, without reopening plurality and approval.
- **Cons:**
  - Two tally schemes to specify, implement, test and verify, eventually.
  - Ranked-choice elections carry T-70 and the mixnet's sequential mixing (T-54), which plurality and approval don't. That difference must be stated on every ranked-choice result.
  - Ranked choice isn't available until the follow-up ADR and its implementation land.

## Recommendation

**Option C.** Homomorphic exponential ElGamal with disjunctive Chaum–Pedersen validity proofs for plurality and approval; a verifiable mixnet, specified by a follow-up ADR, for ranked choice only.

- A alone can't deliver IRV without becoming a mixnet anyway. B alone decrypts every ballot of every election to gain IRV for one type, and pays for it with pattern attacks on approval as well as ranked choice, sequential mixing and a much harder verifier for all of them.
- C keeps the two properties the brief weighs most for the common case: no individual ballot is ever decrypted (T-14), and every ballot's validity is publicly checkable before the tally (T-28). It is what ElectionGuard does for the same election types, which gives third-party verifier authors a familiar model (T-36).

Conventions that come with this choice, specified in P1-8 and P1-12:

- A blank plurality ballot is valid (the sum proof allows 0 or 1). An over-vote can't be cast.
- An approval limit, if any, is part of the election definition and proved by a range disjunction over the sum.
- The tally is computed per tier (each tier's products decrypted separately), so per-tier results never need individual decryption.
- Every Fiat–Shamir challenge binds everything T-30 lists (domain-separation tag, election definition hash, which covers the poll ID, chain ID and contract address, the joint public key, every ciphertext and every commitment), plus the ballot's nullifier and the proof's position (which option, or the sum), so a proof can't be moved to another option, ballot or election (T-30, T-32, T-38).
- Re-vote rule: a nullifier's counted ballot is its last ballot, in the board order P1-13 specifies, whose membership and validity proofs verify. A ballot whose proofs fail is rejected, never counted and never displaces an earlier one. P1-13 owns the details, including what the receipt shows when a submission is rejected (T-33, T-38).

What would change the recommendation:

- If the owner drops ranked choice, or accepts Borda or Condorcet in its place, A alone suffices and the mixnet never gets built.
- If an IRV-on-encrypted-ballots protocol (such as the FC 2019 MPC count above) gains an audited implementation and a published stand-alone verifier spec before P5-1, the follow-up ADR should prefer it over a plain mixnet, because it avoids T-70.
- If write-ins become a requirement for plurality or approval, those elections need the mixnet too, and inherit T-70.

## Consequences

- P1-12 implements A for plurality and approval: exponential-ElGamal ballots, disjunctive Chaum–Pedersen per option and for the sum (or the approval range), with published-protocol citations in `docs/spec/`.
- P1-15 decrypts per-option, per-tier products only, with Chaum–Pedersen proofs on every share, and the verifier (P1-19) recomputes the products from the board itself.
- The election definition (P1-8, P1-10) carries the election type and tally scheme, so one record type can't be tallied under another's rules.
- A follow-up ADR on the ranked-choice tally is needed before P5-1. Its inputs: Shuffle-Sum and the FC 2019 MPC count as T-70-free alternatives; shuffle proof (Terelius–Wikström or Bayer–Groth) and verifiable generator derivation; who the mixers are and whether they are the trustees; mandatory per-ballot proofs of knowledge bound to the nullifier, and well-formedness proofs; the message-to-point encoding (T-39); pattern-attack limits such as capping ranked positions, with the prior art from the vVote deployment (Victoria, 2014); and how T-70 is reported. It touches a cryptographic protocol, so it is an ADR under rule A (`Accepted (agent) — owner may veto`), except that naming the mixers, if they are trustees, is the owner's.
- Ballot size grows with the number of options. P1-18 must size on-chain direct-submit limits (T-52) and Noir-facing hashes (per [[0001-canonical-encoding]]) for the largest supported option count, which P1-8 states.
- Known-weak:
  - T-14 still holds and is inherent to any k-of-n scheme: k colluding trustees can decrypt any individual ballot. Even a commitment-consistent board (P1-3) only stops everyone else from reading ballots later (T-15); the openings still reach the trustees, encrypted under the threshold key.
  - T-16 still holds: per-tier totals over few voters reveal individual votes.
  - Ranked choice, once built, carries T-70.

## Default

Opened 2026-10-09 20:01 UTC. If the owner hasn't answered by **2026-10-12 20:01 UTC**, option C is adopted and this ADR is marked `Status: accepted by default — revisit`.

Superseded on 2026-10-10 by rule A (`AGENTS.md`): the owner's update replaced the 72-hour default, and the recommendation was adopted as `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
