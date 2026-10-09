# ADR 0002: Everlasting privacy of the public board

- Status: needs-decision
- Date: 2026-10-09
- Deciders: owner (one-way door)
- Threats addressed: T-15 (primary), T-14, T-11, T-16, T-18, T-25, T-26, T-27, T-28, T-29, T-30, T-32, T-33, T-36, T-37, T-38, T-39, T-40, T-45 (see [[THREAT_MODEL]])

## Context

Every ballot is published on the bulletin board. The board is mirrored to IPFS, written to the permanent archive (P1-6) and partly posted on the L2, and nothing published can be withdrawn. Whatever the board says about a vote today, an adversary can read in thirty years with whatever cryptanalysis exists then (A-11, "harvest now, decrypt later"). The brief requires an ADR on perfectly hiding commitments versus standard threshold ElGamal, with a post-quantum analysis, before the tally is built (P1-12).

The decision is one-way twice over:

- **Published data is permanent.** If an election's ballots are published under a computationally hiding scheme, a later switch to a perfectly hiding one doesn't help them. Their privacy is fixed on the day they're published.
- **It shapes the ballot format, the trustee ceremony and the tally.** Ballot bytes are anchored (see [[0001-canonical-encoding]]). P1-12 (ballot encryption), P1-14 (ceremony), P1-15 (tally) and P1-4 (tally scheme per election type) all build on the answer.

What a future break reveals depends on what links a vote to a person, not only on the ciphertext:

- **What the board holds.** Nullifiers are Poseidon hashes of the voter's secret and the poll scope (Semaphore v4). Identity commitments are published as the leaves of the on-chain group, but each is a hash of a public key that is never published itself. Linking a nullifier to a commitment needs the voter's secret or a hash preimage.
- **Participation privacy is computational.** An unbounded adversary could invert Poseidon for each identity commitment, recompute nullifiers and so link "commitment C voted in poll P", and from there link to a person through registration metadata. A quantum adversary gets only Grover's square-root speedup against preimages, so this needs a break of Poseidon itself, a younger design than SHA-2 or Keccak. No option here changes that. What the options decide is whether the _vote_ can be read.
- **Votes plus metadata.** A broken ballot ciphertext reveals "nullifier N voted X", not "Alice voted X", unless something else links N to Alice. Such links are realistic for a state adversary (A-1):
  - network metadata recorded at submission time (T-11);
  - small per-tier counts (T-16);
  - a stolen device (T-18);
  - direct submits from a funded address (T-25).

  Harvested votes plus harvested metadata are the real everlasting-privacy threat. In a coercive state, that is also the threat that matters most.

Some limits hold whatever we choose:

- **Hiding and binding can't both be perfect.** A commitment that is perfectly hiding is only computationally binding. Under A and B, a future discrete-log break also lets someone forge alternative openings and proofs for historical elections. Under C, a lattice break does the same. Historical verification then rests on what was anchored to L1 before the break. That depends on the hash functions and on Ethereum's own history resisting rewrites, including long-range attacks on validator signature keys by a quantum adversary. P1-16 must make sure every verification transcript is anchored.
- **Trustees always see what they decrypt.** No option here stops k colluding trustees from reading individual ballots during the election (T-14). The question is only what the _public_ can read later.
- **Membership proofs must be statistically zero-knowledge.** A proof that is only computationally zero-knowledge would let A-11 later extract the voter's secret and link every ballot. Semaphore's Groth16 proofs are perfectly zero-knowledge. Our Noir circuits (P1-17) must use bb's zero-knowledge UltraHonk flavour, and P1-17 must show its zero knowledge is statistical or perfect. If it can't, membership proofs fall back to Semaphore's Groth16 circuit.

## Options

### A. Threshold exponential ElGamal on the public board

The classic design: Helios (Adida, USENIX Security 2008), Belenios, and ElectionGuard (Design Specification 2.0, Benaloh and Naehrig).

- Trustees run a DKG for a joint public key `K` (P1-14).
- Each ballot publishes, per option, an exponential ElGamal ciphertext `(g^r, g^v · K^r)` with disjunctive Chaum–Pedersen validity proofs (Cramer, Damgård and Schoenmakers, "CDS", CRYPTO 1994).
- Ciphertexts are multiplied homomorphically, and k trustees publish decryption shares of the aggregate with Chaum–Pedersen proofs.

- **Pros:**
  - The best-studied design for verifiable voting, with published specs and test vectors (ElectionGuard) to follow and check against.
  - Everything needed to tally sits on the public board, so the wipe-and-rebuild invariant and direct submit are simple: a ballot is self-contained.
  - Smallest ballots: two group elements and one proof per option.
  - Works for both tally schemes P1-4 compares: homomorphic for plurality and approval, and well-known verifiable mixnets for ranked choice (Terelius–Wikström, Bayer–Groth).
- **Cons:**
  - **Privacy is only computational (DDH).** A discrete-log break decrypts every ballot ever published, for every election, at once. That includes a cryptographically relevant quantum computer running Shor's algorithm. Each ciphertext can even be broken on its own, without recovering the joint key, because `g^r` is public.
  - **There is no way to fix this later:** already-published ciphertexts stay breakable.
- **Threats:** T-15 is **not mitigated**. T-14, T-29 and T-40 are handled as P1-14 and P1-15 already plan.

### B. Perfectly hiding commitments on the board; openings shared to trustees off the board

"Everlasting privacy towards the public". The base construction is Cramer, Franklin, Schoenmakers and Yung, "Multi-Authority Secret-Ballot Elections with Linear Work" (EUROCRYPT 1996): the voter shares the vote among the authorities with Pedersen verifiable secret sharing (Pedersen, CRYPTO 1991), only perfectly hiding commitments are public, and no joint key or DKG is needed. Related work:

- Moran and Naor (CRYPTO 2006) define everlasting privacy for voting.
- Demirel, van de Graaf and Araújo (EVT/WOTE 2012) apply it to Helios.
- Cuvelier, Pereira and Peters, "Election Verifiability or Ballot Privacy: Do We Need to Choose?" (ESORICS 2013), reach it instead with commitment-consistent encryption under a threshold key, which needs a DKG. Their framework also covers mixnets.
- Haines, Mosaheb, Müller and Pryvalov, "SoK: Secure E-Voting with Everlasting Privacy" (PoPETs 2023), survey the field.

Here, the CFSY96 construction is combined with a hybrid post-quantum KEM for the private channel.

How it works:

1. **Group.** A prime-order group with no cofactor: ristretto255 (RFC 9496) or a prime-order Weierstrass curve, chosen in P1-11. `h` is a second generator with no known discrete log relative to `g`, derived by hash-to-curve (RFC 9380) with a registered domain tag. Trustees have fixed nonzero evaluation points `1..n`.
2. **Public part.** For each option, the client publishes:
   - a Pedersen commitment `C = g^v · h^r`;
   - the Pedersen VSS commitments to the sharing polynomials of `(v, r)`, with threshold k, whose constant term is `C`;
   - disjunctive CDS proofs that each `C` commits to 0 or 1, plus a proof that the sum is allowed (T-28).

   It also publishes `H(ct_i)` for each trustee's share ciphertext. The Fiat–Shamir challenge binds the full statement: every commitment, every VSS commitment, every `H(ct_i)`, the nullifier, the poll and the version (T-30, T-32, T-38). Everything here is perfectly hiding:
   - Every `v` is equally consistent with the commitments.
   - The CDS proofs are witness-indistinguishable, and both branches are true statements.
   - `H(ct_i)` is statistically hiding in the random-oracle model, because each ciphertext carries more fresh entropy than the digest length.

3. **Private part.** Trustee i's shares `(f(i), g(i))` for every option are encrypted to that trustee with a hybrid KEM and an AEAD. The associated data binds the poll, nullifier, trustee index, version and the hash of the public part.
   - The KEM combines ML-KEM-768 (FIPS 203) with Diffie–Hellman in the commitment group. It uses the combiner construction of X-Wing (`draft-connolly-cfrg-xwing-kem`, revision pinned in the spec at P1-12; generally, Giacon, Heuer and Poettering, "KEM Combiners", PKC 2018).
   - Using the commitment group instead of X25519 is deliberate. It lets a trustee prove what it decrypted (step 4) with a standard Chaum–Pedersen proof.
   - The client uses fresh randomness and keeps no encapsulation seeds. Seeds would be proof of the vote for a coercer or a device thief (T-18, T-45, T-46).
   - The ciphertexts go to the trustees' intake, not onto the public board.
4. **Counting rule: a ballot counts unless it is publicly proven invalid.** Each trustee checks its share against the public VSS commitments.
   - **Invalid share.** If the share is invalid, or the ciphertext doesn't decrypt, the trustee publishes a complaint with publicly verifiable decryption. It reveals the ML-KEM message `m`; anyone re-encapsulates (FIPS 203 `Encaps_internal`, used here only to verify, never to generate randomness) and compares with `ct`. It also reveals the Diffie–Hellman shared secret with a Chaum–Pedersen proof against its registered key. Anyone can then recompute the key, decrypt, and confirm the share is bad. A proven complaint excludes the ballot. Only a cheating client's share is ever revealed.
   - **False complaint.** A complaint about a valid share fails publicly. It reveals only a share the complaining trustee already holds, which is no more than the trustee could leak anyway (T-14).
   - **Delivery.** Each trustee signs a receipt for `H(ct_i)` when it receives the ciphertext. A ciphertext that isn't acknowledged by the voting deadline is re-delivered publicly through the board. That one share then has only post-quantum computational privacy. Forcing a ballot's privacy down to computational therefore takes k refusing trustees, who could read the ballot anyway.
   - **Tally liveness.** The complaint window closes, and the counted set is fixed and anchored, before any sum is published. Every trustee that contributes a sum has then either a valid share of every counted ballot or a proven complaint that excluded the ballot. Any k honest trustees can therefore tally, whatever the voters did. Offline trustees simply don't contribute.
   - **Re-voting (T-33, T-38, T-45).** "Last ballot" is decided by board order alone. If a nullifier's last ballot is proven invalid, that nullifier counts nothing. It never falls back to an earlier ballot. Only a cheating client can produce a provably invalid share, so honest voters are never affected, and an attacker can't use complaints to revert a re-vote.
5. **Tally.** Over the counted set, each trustee publishes its summed shares per option. Anyone checks each trustee's sums against the product of the public VSS commitments, so a wrong sum is attributed to its trustee (T-29). Any k correct sums interpolate to the aggregate `(Σv, Σr)`, which must open the product of the public commitments.
   - Publishing two aggregates over ballot sets that differ by a few ballots would reveal those ballots' openings, permanently. So exactly one aggregate is published per disjoint partition (per tier, and per region where results are regional), over the anchored counted set, and it is never re-published (T-16).

- **Pros:**
  - **The public board is information-theoretically hiding.** Nothing on it reveals any individual vote, even to an adversary with unbounded computation or a quantum computer. That covers the commitments, VSS commitments, ciphertext hashes, validity proofs and the tally transcript. T-15 is mitigated for everything published.
  - **No DKG.** Trustees only need a KEM key and a signing key each, and the threshold comes from voter-side sharing. That removes the DKG's key-bias and rogue-key attacks (T-40). The ceremony becomes key registration, with proofs of possession: a challenge encapsulated to the KEM key that the trustee must answer, and a signature.
  - **Attributable trustee errors.** Each trustee's contribution to the tally is checked individually against public data (T-29).
  - **Only group operations come from a library.** The group operations, hash-to-curve and the AEAD come from audited `@noble/*` libraries. Pedersen commitments, VSS, CDS proofs, Lagrange interpolation and the KEM combiner are our own compositions of published protocols. No published vectors exist for this composition, so `docs/spec/vectors/` and `crypto-review` carry the weight (T-36).
- **Cons:**
  - **The private part is only computationally hiding.** Suppose someone records the share ciphertexts in transit (A-1 recording traffic to us or to the trustees) and later breaks both ML-KEM and discrete log. Shares for k trustees then reveal the vote. Privacy against that adversary is post-quantum conjectured (Module-LWE), not everlasting. Hybrid post-quantum TLS on every intake endpoint, and never publishing the ciphertexts, reduce the exposure.
  - **The brief's "election key" doesn't exist under B.** The brief says the election key is split across k-of-n trustees. Under B there is no single election key: the k-of-n threshold applies to each ballot's opening instead. The trust property is the same (no k−1 trustees can read a ballot or alter the tally undetected), but the owner should accept this deviation explicitly.
  - **Trustees take on operational duties:** running intake, keeping ciphertexts until the tally, checking every ballot, and complaining within the window. That means being online during voting and the complaint window, not only at the tally. These duties belong to the trustee decision (P1-7), which is never defaulted. Default adoption of this ADR doesn't decide them.
  - **More parties see network metadata.** Each trustee's intake endpoint sees submission metadata, so up to n more parties can correlate IPs (T-11).
  - **Direct submit exposes the private part.** A voter who bypasses our servers (T-25) sends the share ciphertexts straight to the trustees' intake, and the contracts take only the public part. If every trustee endpoint is also unreachable, the last resort is posting the ciphertexts on-chain. That ballot then has only post-quantum computational privacy, not everlasting, and costs more gas (T-27). The client must say so before the voter uses that path.
  - **Availability of the private part.** Until the tally is published, the election depends on k trustees keeping their ciphertexts. They aren't on the public board, so they can't be rebuilt from chain and IPFS. Each trustee keeps its own, and our operational store keeps a non-authoritative copy (encrypted to the trustees). Once the tally transcript is published, the wipe-and-rebuild invariant holds again for the result. T-40's "losing or leaking a share" now applies to per-ballot ciphertexts.
  - **Larger ballots, more trustee work.** Rough estimate for 10 options, k = 4 and n = 7:
    - public part about 3.2 KB: 1.3 KB of VSS commitments, 1.4 KB of CDS proofs, 0.2 KB of ciphertext hashes, plus the trustees' signed receipts;
    - private part about 12.4 KB: seven ciphertexts of 1,120 bytes, plus 640 bytes of shares and an AEAD tag each.

    Trustees decapsulate and check every ballot, not only the aggregate.

  - **Ranked choice is harder.** Homomorphic tallying covers plurality and approval directly. Ranked choice needs a mixnet over commitment-consistent ciphertexts (Cuvelier–Pereira–Peters), which is less established than ElGamal mixnets and needs a threshold key for the mix. P1-4 has to settle this per election type.
  - **Trustee key substitution still breaks secrecy.** Replacing k trustees' KEM keys lets whoever holds the replacements read every ballot (T-37). Key registration needs the same public, anchored transcript that the joint key would have had.
  - **ML-KEM needs an audited library.** In the `@noble/*` family, ML-KEM lives in `@noble/post-quantum`, and the brief allows only audited cryptographic libraries. **Owner question:** if it has no independent audit when P1-12 starts, either:
    - (a) wait for an audit; or
    - (b) ship Diffie–Hellman-only share encryption, whose private-part privacy is then classical (Shor-breakable), with T-15's residual stated as such.

    An agent never ships the unaudited ML-KEM code on its own authority, and default adoption of this ADR doesn't decide this question.
- **Threats:** T-15 is **mitigated for the public board**. The residual is harvested private-part ciphertexts (post-quantum conjectured, or classical under (b)) and direct-submit fallback ballots. Other effects:
  - T-14 is unchanged: k trustees read ballots during the election.
  - T-29 is improved: errors are attributable.
  - T-40 trades DKG bias for per-ballot custody.
  - T-25 and T-26 now depend on trustee intake.
  - T-11 gains up to n more observers.

### C. Post-quantum (lattice-based) encryption on the public board

Keep a single public, self-contained ciphertext as in A, but under a lattice assumption. For example: the lattice-based verifiable mixnet and distributed decryption of Aranha, Baum, Gjøsteen and Silde (ACM CCS 2023), or lattice-based homomorphic encryption with lattice zero-knowledge proofs.

- **Pros:**
  - Resists Shor's algorithm.
  - A ballot stays self-contained on the public board, so direct submit and wipe-and-rebuild stay as simple as in A.
- **Cons:**
  - **Not everlasting.** Privacy is still computational. It rests on lattice assumptions that are younger than discrete log, and whose parameters have moved more. A future lattice break would reveal every published ballot, exactly as in A.
  - **No audited library.** Nothing in `@noble/*`, or any audited JavaScript library, implements threshold lattice encryption with the zero-knowledge proofs voting needs. We would have to implement the primitives ourselves, which the brief forbids.
  - **Heavy ballots.** Ciphertexts and proofs are tens to hundreds of kilobytes per ballot, which is heavy for the L2 and for the ballot client.
- **Threats:** T-15 moves from "breaks under quantum" to "breaks if lattices break"; it isn't closed. It also fails the audited-libraries rule (T-39).

## Recommendation

**Option B: perfectly hiding commitments on the public board, with openings shared to the trustees under a hybrid post-quantum KEM, off the board.**

- **It is the only option whose published data stays private against any future adversary.** The board is permanent and is mirrored to IPFS and an archive, so its privacy has to last as long as the data does.
- **What B leaves computational isn't permanent or public.** That is the share ciphertexts, in transit and at the trustees: they are never published, they travel under post-quantum hybrid encryption, and they can be deleted after the tally. Under A or C, the computational part _is_ the permanent public record.
- **It removes the DKG** (T-40) and makes each trustee's tally contribution checkable on its own (T-29).
- **It is built only from published protocols** (CFSY96, Pedersen VSS, CDS, a KEM combiner) over group operations from audited `@noble/*` libraries.

The costs are real, and P1-12 to P1-15 must carry them:

- trustee intake endpoints, the complaint procedure and its window;
- a direct-submit fallback with weaker privacy, disclosed to the voter;
- availability of the private part until the tally;
- the ML-KEM audit question, which the owner answers;
- a less established mixnet for ranked choice.

What would change the recommendation:

- **No mixnet for ranked choice.** If P1-4 finds that no commitment-consistent mixnet can be built from audited primitives, use B for plurality and approval and decide ranked choice separately. Running A only for ranked choice would knowingly accept T-15 for those elections, so it needs the owner's explicit sign-off and a warning shown to voters.
- **Trustees can't take on the duties.** If trustees can't run independent intake, retention and attestation, B's direct-submit and availability costs would apply to every ballot rather than only to the fallback path. A would then be simpler for the same practical privacy against A-1. When P1-7 lands, this re-evaluation is mandatory, not optional.
- **A ready-made primitive appears.** If an audited library offered threshold encryption with everlasting public privacy, prefer it for new election versions.

## Consequences

If B is accepted:

- **P1-11** picks the prime-order group, derives the second generator `h` by hash-to-curve (RFC 9380) with a registered domain tag, and publishes vectors that let anyone check `h` was derived as specified, so no one could have chosen it.
- **P1-12** becomes "ballot commitments, VSS commitments, validity proofs and hybrid-KEM share encryption", with ciphertext hashes in the public part and the full Fiat–Shamir statement binding. The client generates all randomness through `packages/crypto` and keeps no encapsulation seeds (T-39, T-18). The format follows [[0001-canonical-encoding]]. P1-12 also pins the X-Wing draft revision the combiner follows.
- **P1-13** covers:
  - trustee receipts, the complaint procedure (publicly verifiable decryption), the complaint window and public re-delivery;
  - the counting rule, including re-voting by board order with no fallback;
  - how Benaloh challenges open both the commitments and the shares (a spoiled ballot reveals its own vote and is never counted).
- **P1-14** becomes trustee key registration instead of a DKG: a hybrid KEM key and a signing key per trustee, each with proof of possession, in a public, anchored transcript. The STATUS item ("Pedersen/Feldman DKG") is rewritten to match.
- **P1-15** publishes per-trustee summed shares checked against the public VSS commitments, the opening of the aggregate commitment, and exactly one aggregate per disjoint partition.
- **P1-4** must say, per election type, how the tally works over commitments, in particular ranked choice.
- **P1-12 prerequisite:** the audit status of `@noble/post-quantum` is checked and recorded in STATUS, and the owner answers the ML-KEM question above.
- **P1-17** shows that the membership proofs are statistically or perfectly zero-knowledge, or falls back to Semaphore's Groth16 circuit.
- **P2-3 and P2-11:** every ballot intake endpoint (ours and the trustees') negotiates hybrid post-quantum TLS (`X25519MLKEM768`), and logs never retain share ciphertexts beyond the tally.
- **P1-16, P1-20 and P4-1** anchor every verification, complaint and tally transcript to L1.
- **[[THREAT_MODEL]]** changes:
  - T-15 becomes "Partial by design". The residual is harvested private-part ciphertexts and direct-submit fallback ballots.
  - The T-28, T-29, T-37 and T-40 mitigation texts are rewritten for commitments, summed shares and key registration in place of ElGamal, decryption shares and the DKG.
  - The not-mitigated list keeps T-14 and records that participation privacy rests on Poseidon.

If A is chosen instead, T-15 stays in the not-mitigated list as "every ballot on the board becomes readable after a discrete-log break". Every election page and the verifier must state this.

## Default

Opened 2026-10-09 20:00 UTC. If the owner hasn't answered by **2026-10-12 20:00 UTC**, option B is adopted and this ADR is marked `Status: accepted by default — revisit`. Default adoption does not decide the trustees' duties (P1-7) or the ML-KEM audit question; both wait for the owner. Tally work (P1-12 onwards) doesn't start before then.
