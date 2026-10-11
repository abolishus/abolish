# ADR 0015: What the tally publishes

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option C
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A). Option A would narrow a guarantee of [[0002-everlasting-privacy]], which the owner accepted, so choosing A is the owner's.
- Threats addressed: T-15, T-16, T-14, T-29, T-54 (see [[THREAT_MODEL]])

## Context

[[0002-everlasting-privacy]] (Tally) has each trustee publish its summed shares per cell and option, so anyone can check each one against the product of the public VSS commitments and attribute a wrong sum (T-29), and [[verifier]] 7.2 checks them. The same ADR lets a ballot's share for a trustee be posted on the board when synchronous intake fails, with classical (Diffie–Hellman only) privacy, and states the residual as: a ballot with `k` or more posted shares can be read by a future quantum adversary (A-11).

Publishing summed shares widens that residual, as `crypto-review` showed on P1-15 part 1 (#55). Once `k` trustees' summed shares of a cell are public, the summed polynomials `F_{c,j}`, `G_{c,j}` are fixed, so their value at every seat is public, including seats that never published. An adversary who later breaks the posted shares' encryption subtracts every posted share at a seat; where one ballot is the only one not posted at that seat, the difference is that ballot's own share there. Example with `k = 4`, `n = 6`: a relay (A-2) drops target `b*`'s deliveries to trustees 4, 5 and 6 (three posted shares, fewer than `k`, so ADR 0002 says `b*` stays protected) and every other ballot's delivery to trustee 1. After a DH break alone, `F_{c,j}(1)` minus every other ballot's posted share at seat 1 is `f^{(b*)}_j(1)`, a fourth point, and `b*`'s whole ballot is open. It needs no colluding trustee and no ML-KEM break, and it also happens with no attacker when different trustees are offline at different times. In general the sub-aggregate over a set `T` of ballots is exposed when evaluation at 0 lies in `∩_{b∈T} W(P_b) + ∩_{b∉T} W(P_b)`, where `W(P)` is the span of evaluations at the seats `P` where `b`'s share was posted (everything, once `|P| ≥ k`).

Without per-seat values, only `(F_{c,j}(0), G_{c,j}(0))` is public: the count and the summed randomness. With fewer than `k` points of each target ballot's polynomials, that reveals nothing beyond the count. Even with discrete logs in ristretto255, `F(i) + x·G(i)` at any seat already follows from the public commitments, so each posted share adds one independent equation and `k` are still needed per ballot.

What is one-way: what the tally record carries is permanent once an election is tallied, and a per-seat value published once can't be withdrawn.

## Options

### A. Publish each trustee's summed shares (ADR 0002 as written)

Anyone checks each trustee's summed shares against the aggregate VSS commitments, so wrong sums are attributed publicly, and anyone can combine any `k`.

- Pros: public attribution of every wrong sum (T-29), robust combination by anyone (T-54), the simplest verifier.
- Cons: the leak above. The tally transcript is information-theoretically hiding only for cells with no posted shares, contrary to ADR 0002's Consequences, and the only remedy left is a report flag. It narrows a property the owner accepted, so it is the owner's to choose.

### B. Re-randomise the summed polynomials before publishing them

Before the tally, each trustee deals, per cell and option, a Pedersen VSS sharing of `(0, 0)` (its constant-term commitment must be the identity) to the other trustees, encrypted under the hybrid KEM. Each trustee publishes `F(i) + Z(i)`, where `Z` is the sum of the zero-sharings it received, checked against `Ê_t · Π_d Ẑ_{d,t}`. The constant term is unchanged, and the per-seat values are masked as long as one dealer is honest. This is the standard share-refresh technique (Herzberg, Jarecki, Krawczyk and Yung, "Proactive Secret Sharing", CRYPTO 1995).

- Pros: keeps public per-trustee attribution and lets anyone combine.
- Cons: a new interactive round of private deliveries, with its own complaints and an agreed qualified set of dealers. That is the kind of DKG-like phase ADR 0002 removed (T-40), with its own liveness failure (T-54). A dealer excluded after others have published masked sums breaks the check for everyone, so the round needs an agreement step before any sum is published. Much more to specify, implement and verify (T-36).

### C. Publish only each cell's opening

Trustees send their summed shares only to the other trustees, encrypted under the hybrid KEM of [[0002-everlasting-privacy]] (as ballot shares are), and never post them on the board. Each trustee checks every summed share it receives against the public aggregates. Any trustee holding `k` passing summed shares combines them and publishes, per cell and option, the opening `(V_{c,j}, R_{c,j})`, signed with its per-election key. The verifier checks that the opening opens the aggregate commitment and that the count is in range.

- Pros: the board carries only the count and the summed randomness, so the leak above is gone for every external adversary, and ADR 0002's guarantee for the tally transcript holds again. The result is still fully verifiable: a wrong opening can't open `Ĉ_{c,j}` under binding, and its signer is attributed (T-29). It's the smallest verifier of the three (T-36).
- Cons:
  - A trustee that sends a wrong summed share is caught by the other trustees, who check it against public data, but not publicly attributable: publishing a failing sum as evidence could leak correct per-option values in it. The result stays correct; only public attribution of an unhelpful trustee is lost (T-29, T-54).
  - Every trustee that receives `k` summed shares learns the summed polynomials at every seat. A corrupt trustee, together with a relay that shapes the postings and a later break of their encryption, gains the leak above: the same extra points posted shares give it under ADR 0002, now at other seats too (T-14, T-15).
  - Summed shares in transit are as harvestable as ballot shares in transit: a future break of both X25519 and ML-KEM reads them, as it reads every harvested share ciphertext (ADR 0002's existing residual).

## Recommendation

**Option C.** It restores ADR 0002's everlasting-privacy guarantee for everything on the board, keeps the result verifiable by anyone, and adds no protocol round. B keeps public attribution but adds an interactive phase with its own agreement and liveness problems for a property, attributing an unhelpful trustee, that the brief doesn't require: the brief requires that no single party can alter a tally undetected, which C keeps. A is the owner's.

What would change it: if the owner wants public attribution of every trustee's contribution, B is the path that keeps it without the leak; a later version can add it as a new tally version. If the fallback posting goes away (no posted shares ever), A's leak disappears and A becomes safe again.

## Consequences

- [[tally]] specifies summed shares as private between trustees, the trustees' check and combination, and the published opening with `tally-opening` and `tally-range`; a cell with no opening on the board fails the election (`tally-missing`, T-54).
- [[verifier]] 7.2 checks the opening instead of per-trustee shares; 7.4 reports any summed share found on the board as a disclosure by its signer; 8.4 names the trustee that signed each opening.
- P1-15 part 2 defines the private summed-share message (encrypted under the hybrid KEM of P1-12 part 2, signed with the sender's per-election key) and the opening record in the tally transcript.
- T-29: wrong openings are attributed publicly; wrong summed shares only among trustees. T-14 and T-15 state the corrupt-trustee residual.
- [[0002-everlasting-privacy]] (Tally, item 5) reads with this substitution: "each trustee publishes its summed shares" becomes "each trustee sends its summed shares to the other trustees, and a trustee publishes the opening"; the public check is on the opening.

## Decision

Accepted by the agent under rule A on 2026-10-11 (owner may veto): **option C**. Listed under Decisions to review in [[STATUS]].
