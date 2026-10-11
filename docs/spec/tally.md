# Tally: summed shares and cell openings

How the result of a plurality or approval election is computed, and how anyone checks it from the board: the aggregate commitments of each cell of the tally partition; each trustee's summed shares, which go only to the other trustees, and their check against the aggregates; the combination of any `k` valid summed shares into the opening of each aggregate; and the checks on the published opening. What is published follows [[0015-tally-publication]] (option C): the opening, never a trustee's summed shares. This is the tally of [[0002-everlasting-privacy]] (option B, accepted by the owner) for the homomorphic scheme of [[0003-tally-scheme]] (`tally_scheme` 1, [[election-definition]]). Notation is from [[notation]], the group from [[group]], the committed vote and shares from [[ballot-validity]]. Threats: T-29, T-14, T-15, T-16, T-54, T-36.

What this page doesn't cover yet, by the part of P1-15 that owns it:

- **The messages and the tally transcript** (part 2): the private message carrying a trustee's summed shares to the other trustees (encrypted under the hybrid KEM of [[0002-everlasting-privacy]], signed with the sender's per-election key), and the tally transcript (`0x0006`, `abolish/v1/tally-transcript`) carrying each cell's opening, signed by the trustee that combined it ([[trustee-identity]], Which key signs what; P1-14 part 2), with the window in which it must be boarded ([[election-definition]], The seal). This page defines the values and the checks; part 2 defines the bytes, and [[verifier]] 7.3 and 7.4.
- **Destruction** (part 3): each trustee's signed statement that it destroyed its per-election KEM key and stored share ciphertexts after the tally is anchored ([[0002-everlasting-privacy]], Consequences; T-14, T-69).

## Sources

- **Summing Pedersen VSS sharings** and checking each sum against the product of the VSS commitments: R. Cramer, M. Franklin, B. Schoenmakers and M. Yung, "Multi-Authority Secret-Ballot Elections with Linear Work", EUROCRYPT 1996, Section 3 (each authority publishes the sum of its shares over the counted ballots; the sum is checked against the product of the ballots' commitments, and any `k` of them interpolate the tally). The commitments and the check are Pedersen's (T. P. Pedersen, CRYPTO 1991, Section 4), as in [[ballot-validity]], Shares.
- **Lagrange interpolation at 0** over the scalar field: A. Shamir, "How to Share a Secret", CACM 1979.

No new primitive: the group operations are `@noble/curves`' ristretto255, and the scalar arithmetic is modulo `ℓ` ([[group]]).

## Context

| Value                  | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m`                    | The registered definition's `option_count`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `k`, `n`               | Its `threshold` and `panel_size` ([[verifier]] 2.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The partition          | Its cells ([[verifier]] 2.8): in version 1, one cell per `electorate` entry, in that order, holding that tier's ballots                                                                                                                                                                                                                                                                                                                                                                                  |
| `S_c`, the counted set | For cell `c`, the ballots [[revoting]] selects for that cell's tier from the anchored board, each admitted (validity included, [[verifier]] 5), less every ballot that by the delivery deadline lacks, for some seat, a valid-share receipt matching its public part or a posting that passes the public check, and every ballot excluded by a proven complaint ([[0002-everlasting-privacy]], Private part: Deadline, Complaints; a selected ballot excluded this way counts nothing, with no fallback) |

The counted set is fixed and anchored before any trustee sends a summed share ([[0002-everlasting-privacy]], Tally liveness). Every ballot in `S_c` passed `validity-shape`, so each has exactly `m` options of exactly `k` VSS commitments.

## Aggregates

For cell `c`, option `j` and `t = 0, …, k − 1`, the aggregate VSS commitment is the product of the selected ballots' VSS commitments:

```
Ê_{c,j,t} = Π_{b ∈ S_c} E^{(b)}_{j,t}
```

`Ê_{c,j,0} = Ĉ_{c,j}` is the aggregate commitment of option `j` in cell `c`: it commits to `Σ_b v^{(b)}_j`, the number of the cell's counted ballots that select option `j`, with randomness `Σ_b r^{(b)}_j`. For an empty cell every aggregate is the identity. An aggregate is computed, never decoded, so it may be the identity; it is encoded, where an encoding is needed, as `element` with the identity allowed ([[group]]).

## Summed shares

Trustee `i` (its seat, `1 ≤ i ≤ n`) holds, for every ballot `b` in `S_c`, its shares `(f^{(b)}_j(i), g^{(b)}_j(i))` for every option, each checked when it received them ([[ballot-validity]], Shares). Its summed share for cell `c` and option `j` is

```
V_{c,i,j} = Σ_{b ∈ S_c} f^{(b)}_j(i)   (mod ℓ)
R_{c,i,j} = Σ_{b ∈ S_c} g^{(b)}_j(i)   (mod ℓ)
```

the evaluation at `i` of the summed polynomials `F_{c,j} = Σ_b f^{(b)}_j` and `G_{c,j} = Σ_b g^{(b)}_j`, whose coefficients `Ê_{c,j,t}` commits to. A trustee's summed shares for a cell are a `list<share, MAX_OPTIONS>` of `m` entries, one per option in order, with `share` as in [[ballot-validity]] (`v`, `r`, both `scalar`). For an empty cell every summed share is `(0, 0)`.

A trustee sums over exactly the anchored `S_c`, never over a set it chooses, and only for the cells of the registered partition, once per cell (T-14, T-16; [[0002-everlasting-privacy]], Tally). It sends its summed shares only to the other trustees, encrypted to each under the hybrid KEM, and never posts them on the board ([[0015-tally-publication]]). Summed shares from `k` seats fix `F_{c,j}` and `G_{c,j}`, and so their value at every seat; with shares posted under the fallback of [[0002-everlasting-privacy]], those values let anyone who later breaks the posted shares' classical encryption complete ballots that have fewer than `k` posted shares (the attack in [[0015-tally-publication]], Context). A summed share found on the board is a disclosure by its signer ([[verifier]] 7.4).

## Summed-share check

A trustee checks every summed share it receives, from seat `i`, against the aggregates, as it checks a ballot's shares ([[ballot-validity]], Shares):

```
g^{V_{c,i,j}} · h^{R_{c,i,j}} = Ê_{c,j,0} · Ê_{c,j,1}^{i} · … · Ê_{c,j,k−1}^{i^{k−1}}   for every j
```

The check passes when the list has exactly `m` entries, each a canonical `scalar`, and every option's equation holds. Summed shares that pass are the evaluations at `i` of `F_{c,j}` and `G_{c,j}` (binding, under discrete log in ristretto255). Summed shares that fail are excluded from the combination; the trustees know which seat sent them, but nothing on the board attributes them (T-29, [[0015-tally-publication]]). No Fiat–Shamir proof accompanies a summed share: the check is a deterministic equation over public values, so `abolish/v1/fs/tally-share` ([[domain-separation]]) isn't needed, and part 2 retires it with the transcript.

## Combination

A trustee holding passing summed shares from `k` or more seats for a cell combines them. Let `Q` be the `k` lowest seats among them. With fewer than `k`, it can't (`tally-quorum`), and waits for more. Any trustee whose summed shares pass may be combined, including one that missed the complaint window and so isn't tally-eligible in [[0002-everlasting-privacy]] (Tally liveness): summed shares that pass are correct points of the cell's summed polynomials whoever computed them, and a trustee that couldn't sum every counted ballot correctly fails the check, so eligibility needs no separate filter, which would only make a missing opening likelier. With the Lagrange coefficients at 0

```
λ_i = Π_{l ∈ Q, l ≠ i} l · (l − i)^{−1}   (mod ℓ)     for i ∈ Q
```

the cell's opening of option `j` is

```
V_{c,j} = Σ_{i ∈ Q} λ_i · V_{c,i,j}   (mod ℓ)
R_{c,j} = Σ_{i ∈ Q} λ_i · R_{c,i,j}   (mod ℓ)
```

and the trustee publishes, per cell, the list of `(V_{c,j}, R_{c,j})` for `j = 0, …, m − 1`, each a canonical `scalar` (part 2 defines the record). Any `k` passing summed shares give the same opening: they lie on the same polynomials (binding), and `k` points fix a polynomial of degree `k − 1`, so `V_{c,j} = F_{c,j}(0)` and `R_{c,j} = G_{c,j}(0)` whichever are combined. Before publishing, the trustee runs the checks below on its own opening.

## Opening checks

The verifier recomputes `Ĉ_{c,j}` from the counted ballots ([[verifier]] 7.1) and checks each cell's published opening, in cell order and then option order:

| Code            | Check                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `tally-missing` | The cell has a published opening with exactly `m` entries                                                       |
| `tally-opening` | `g^{V_{c,j}} · h^{R_{c,j}} = Ĉ_{c,j}`: the opening opens the product of the cell's ballot commitments           |
| `tally-range`   | `V_{c,j}`, read as an integer from 0 to `ℓ − 1`, is at most `\|S_c\|`, the number of the cell's counted ballots |

The first failure fails the election ([[verifier]] 7.2; T-29, T-54). `V_{c,j}` is option `j`'s count in cell `c`, the published result ([[verifier]] 8.1). An opening that fails `tally-opening` is attributed to the trustee whose signature it carries (part 2); one that passes is correct whoever computed it.

Notes:

- **The opening is what makes the result verifiable.** Under binding, no one can publish `(V, R)` opening `Ĉ_{c,j}` with `V` other than the cell's real count. `tally-range` can't fail while binding holds, since option proofs bound every counted `v^{(b)}_j` to 0 or 1; it is checked anyway, as it is what the result rests on (T-29, T-36), and a vector exercises it with a ballot no validity check would admit.
- **An honest combination always passes `tally-opening`,** even if binding is broken: `Σ_{i∈Q} λ_i · i^t` is 1 for `t = 0` and 0 for `0 < t < k`, so `Π_{i∈Q} (Π_t Ê_{c,j,t}^{i^t})^{λ_i} = Ê_{c,j,0}` holds in the exponent.
- **The opening reveals the count and nothing else about any ballot.** `V_{c,j}` is the count. `R_{c,j}` is the sum of the counted ballots' randomness, which each perfectly hiding commitment leaves uniform; even with discrete logs in ristretto255, `V + x·R` already follows from `Ĉ_{c,j}`. A ballot with fewer than `k` posted shares stays hidden: no per-seat value of the summed polynomials is published ([[0015-tally-publication]], Context). A cell with one counted ballot reveals that ballot: that is the cell's size, flagged by [[verifier]] 8.2, and why openings are only ever per cell of one partition (T-16, [[0002-everlasting-privacy]], Tally).

## Coarser totals

A total over several cells (per tier where cells are regions, or overall) is the sum, per option, of those cells' `V_{c,j}`. It is derived, never opened from a separate aggregate: a second opening over a set overlapping a cell would let anyone subtract the two and isolate the ballots in their difference ([[0002-everlasting-privacy]], Tally; T-16). In version 1 each cell is one tier, so the per-tier result is the cell's opening, and the overall result is the sum over every cell.

## Residuals

- **`k` colluding trustees can still open any single ballot** from the shares they hold (T-14). The tally doesn't change that; deletion after the tally (part 3) limits how long they can.
- **A trustee learns the summed polynomials at every seat.** Any trustee that receives `k` passing summed shares can evaluate `F_{c,j}` and `G_{c,j}` anywhere. With a relay that shapes which shares are posted (A-2) and a later break of the posted shares' classical encryption (A-11), one corrupt trustee can complete a ballot with fewer than `k` posted shares, as anyone could if summed shares were public ([[0015-tally-publication]], option C, Cons). Not mitigated: re-randomising the summed polynomials (option B there) would close it at the cost of a new round (T-14, T-15).
- **Wrong summed shares aren't publicly attributable.** The trustees see which seat sent a failing sum, but nothing on the board records it; the published opening is still checked by everyone, so the result can't be wrong undetected (T-29). A trustee that sends nothing, or nothing valid, only delays the tally (T-54).
- **Summed shares in transit are harvestable** like ballot shares: a later break of both X25519 and ML-KEM reads them ([[0002-everlasting-privacy]], T-15).
- **The result rests on binding, which is computational.** Someone who can compute discrete logs in ristretto255 could publish an opening of another count, for an election verified after the break. The record anchored on L1 before the break is what historical verification rests on ([[0002-everlasting-privacy]], Context; [[ballot-validity]], Residuals).
- **Liveness needs `k` trustees.** A cell with no opening on the board fails the election (`tally-missing`, T-54); a trustee that withholds its sums is visible to the other trustees but not compellable.
- **Small cells reveal votes.** An opening over one ballot, or over a cell where every ballot chose the same option, reveals those votes; [[verifier]] 8.2 flags small counts, and nothing here prevents them (T-16).

## Test vectors

`docs/spec/vectors/tally.json` ([[vectors/README|vectors]]): cells with their ballots' VSS commitments, every trustee's shares per ballot, the aggregates, each trustee's summed shares and check verdict, the seats combined, the Lagrange coefficients and the opening; cells with a failing trustee (a share off by one, a sum missing a ballot, options swapped, a short list), an empty cell, a cell with one ballot, a cell at `MAX_TRUSTEES`, a cell short of `k` passing trustees (`tally-quorum`), a cell whose only ballot holds a vote of 2 and so fails `tally-range` (a ballot no admission check would let through, to exercise the check), and an election with two cells and its derived overall total; and published openings checked by the verifier: each valid opening, a count or randomness off by one (`tally-opening`), a short or missing opening (`tally-missing`), and the vote-of-2 cell's opening (`tally-range`). They are printed by `packages/crypto/scripts/tally-vectors.py`, an implementation of this page in Python's integers that reuses `ballot-validity-vectors.py` to make the ballots, and so shares nothing with `packages/crypto`. It finds each opening by solving the Vandermonde system for every coefficient of the summed polynomials, not by Lagrange coefficients, and checks the two agree.
