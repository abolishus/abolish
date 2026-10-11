# Tally: summed shares and cell openings

How the result of a plurality or approval election is computed from the board, and how anyone checks it: the aggregate commitments of each cell of the tally partition, each trustee's summed shares and their check against the public VSS commitments, and the combination of any `k` valid summed shares into the opening of each aggregate. This is the tally of [[0002-everlasting-privacy]] (option B, accepted by the owner) for the homomorphic scheme of [[0003-tally-scheme]] (`tally_scheme` 1, [[election-definition]]). Notation is from [[notation]], the group from [[group]], the committed vote and shares from [[ballot-validity]]. Threats: T-29, T-14, T-16, T-54, T-36, T-15.

What this page doesn't cover yet, by the part of P1-15 that owns it:

- **The tally transcript** (`0x0006`, part 2): the record a trustee posts with its summed shares, signed with its per-election signing key ([[trustee-identity]], Which key signs what; P1-14 part 2), the transcript hash (`abolish/v1/tally-transcript`), and the window in which summed shares must be boarded ([[election-definition]], The seal). This page defines the values and the checks; part 2 defines the bytes that carry them, and the per-cell attribution of [[verifier]] 7.4.
- **Destruction** (part 3): each trustee's signed statement that it destroyed its per-election KEM key and stored share ciphertexts after the tally is anchored ([[0002-everlasting-privacy]], Consequences; T-14, T-69).

## Sources

- **Summing Pedersen VSS sharings** and checking each sum against the product of the VSS commitments: R. Cramer, M. Franklin, B. Schoenmakers and M. Yung, "Multi-Authority Secret-Ballot Elections with Linear Work", EUROCRYPT 1996, Section 3 (each authority publishes the sum of its shares over the counted ballots; the sum is checked against the product of the ballots' commitments, and any `k` of them interpolate the tally). The commitments and the check are Pedersen's (T. P. Pedersen, CRYPTO 1991, Section 4), as in [[ballot-validity]], Shares.
- **Lagrange interpolation at 0** over the scalar field: A. Shamir, "How to Share a Secret", CACM 1979.

No new primitive: the group operations are `@noble/curves`' ristretto255, and the scalar arithmetic is modulo `ℓ` ([[group]]).

## Context

| Value                  | Source                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `m`                    | The registered definition's `option_count`                                                                                                     |
| `k`, `n`               | Its `threshold` and `panel_size` ([[verifier]] 2.5)                                                                                            |
| The partition          | Its cells ([[verifier]] 2.8): in version 1, one cell per `electorate` entry, in that order, holding that tier's ballots                        |
| `S_c`, the counted set | For cell `c`, the ballots [[revoting]] selects for that cell's tier from the anchored board, each admitted (validity included, [[verifier]] 5) |

The counted set is fixed and anchored before any trustee publishes a summed share ([[0002-everlasting-privacy]], Tally liveness). Every ballot in `S_c` passed `validity-shape`, so each has exactly `m` options of exactly `k` VSS commitments.

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

A trustee sums over exactly the anchored `S_c`, never over a set it chooses: a sum over any other set fails the check below against the aggregates of `S_c`, and is attributed to it ([[verifier]] 7.2, 7.4). A trustee publishes summed shares only for the cells of the registered partition, once per cell (T-14, T-16; [[0002-everlasting-privacy]], Tally).

## Summed-share check

Anyone checks trustee `i`'s summed shares for cell `c` against the aggregates, as a trustee checks a ballot's shares ([[ballot-validity]], Shares):

```
g^{V_{c,i,j}} · h^{R_{c,i,j}} = Ê_{c,j,0} · Ê_{c,j,1}^{i} · … · Ê_{c,j,k−1}^{i^{k−1}}   for every j
```

The check passes when the list has exactly `m` entries and every option's equation holds. A trustee's summed shares that pass are the evaluations at `i` of `F_{c,j}` and `G_{c,j}` (binding, under discrete log in ristretto255). Summed shares that fail are excluded from the combination and reported with their trustee (`tally-share`); they don't fail the election on their own ([[verifier]] 7.2; T-29). No Fiat–Shamir proof accompanies a summed share: the check is a deterministic equation over public values, so `abolish/v1/fs/tally-share` ([[domain-separation]]) isn't needed, and part 2 retires it with the transcript.

## Combination and opening

For each cell, let `Q` be the `k` lowest seats among the trustees whose summed shares for that cell pass the check. If fewer than `k` pass, the cell has no result and the election fails (`tally-quorum`, [[verifier]] 7.2; T-54). Any trustee whose summed shares pass may be combined, including one that missed the complaint window and so isn't tally-eligible in [[0002-everlasting-privacy]] (Tally liveness): summed shares that pass are correct points of the cell's summed polynomials whoever computed them, and a trustee that couldn't sum every counted ballot correctly fails the check, so eligibility needs no separate filter, which would only make `tally-quorum` likelier. Otherwise, with the Lagrange coefficients at 0

```
λ_i = Π_{l ∈ Q, l ≠ i} l · (l − i)^{−1}   (mod ℓ)     for i ∈ Q
```

the cell's opening of option `j` is

```
V_{c,j} = Σ_{i ∈ Q} λ_i · V_{c,i,j}   (mod ℓ)
R_{c,j} = Σ_{i ∈ Q} λ_i · R_{c,i,j}   (mod ℓ)
```

and the verifier checks, for every option, in option order:

| Code            | Check                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `tally-opening` | `g^{V_{c,j}} · h^{R_{c,j}} = Ĉ_{c,j}`: the opening opens the product of the cell's ballot commitments           |
| `tally-range`   | `V_{c,j}`, read as an integer from 0 to `ℓ − 1`, is at most `\|S_c\|`, the number of the cell's counted ballots |

The first failure, in cell order and then option order, fails the election. `V_{c,j}` is option `j`'s count in cell `c`, the published result ([[verifier]] 7.2, 8.1).

Notes:

- **Any `k` valid summed shares give the same opening.** Every passing summed share lies on the same polynomials `F_{c,j}`, `G_{c,j}` (binding), and `k` points fix a polynomial of degree `k − 1`, so `V_{c,j} = F_{c,j}(0)` and `R_{c,j} = G_{c,j}(0)` whichever `k` are combined. `Q` is fixed (the `k` lowest passing seats) only so that every verifier does the same work and reports the same seats as combined ([[verifier]] 8.4).
- **`tally-opening` can't fail when the summed-share checks pass,** even if binding is broken: `Σ_{i∈Q} λ_i · i^t` is 1 for `t = 0` and 0 for `0 < t < k`, so `Π_{i∈Q} (Π_t Ê_{c,j,t}^{i^t})^{λ_i} = Ê_{c,j,0}` holds in the exponent. `tally-range` can't fail while binding holds, since option proofs bound every counted `v^{(b)}_j` to 0 or 1; binding is what ties the count to the votes. They are checked anyway, because they are what the result rests on, and because a verifier that skips them trusts its own interpolation (T-29, T-36). So no vector can fail `tally-opening` with summed shares that pass; `tally-range` fails only for a counted ballot that no validity check should have admitted.
- **The opening reveals the count and nothing about any ballot, given what the board already shows.** `(V_{c,j}, R_{c,j})` is the opening of the product of the cell's commitments, and the summed shares of `k` or more trustees also reveal the summed polynomials' other coefficients, which are sums of independent uniform coefficients and independent of every vote. A cell with one counted ballot reveals that ballot: that is the cell's size, flagged by [[verifier]] 8.2, and why openings are only ever per cell of one partition (T-16, [[0002-everlasting-privacy]], Tally). This holds unconditionally only for ballots whose shares were all receipted; see Residuals for ballots whose shares were posted under the fallback.

## Coarser totals

A total over several cells (per tier where cells are regions, or overall) is the sum, per option, of those cells' `V_{c,j}`. It is derived, never opened from a separate aggregate: a second opening over a set overlapping a cell would let anyone subtract the two and isolate the ballots in their difference ([[0002-everlasting-privacy]], Tally; T-16). In version 1 each cell is one tier, so the per-tier result is the cell's opening, and the overall result is the sum over every cell.

## Residuals

- **`k` colluding trustees can still open any single ballot** from the shares they hold (T-14). The tally doesn't change that; deletion after the tally (part 3) limits how long they can.
- **The result rests on binding, which is computational.** Someone who can compute discrete logs in ristretto255 could publish summed shares that pass the check but interpolate to another count, for an election verified after the break. The record anchored on L1 before the break is what historical verification rests on ([[0002-everlasting-privacy]], Context; [[ballot-validity]], Residuals).
- **Posted shares turn summed shares into a classical-only sub-aggregate.** Once `k` summed shares of a cell are public, `F_{c,j}` and `G_{c,j}` are fixed, so their value at every seat is public. For a ballot whose share for seat `i` was posted under the fallback of [[0002-everlasting-privacy]] (classical privacy only), an adversary who later breaks that encryption (A-6, harvest now) learns `f^{(b)}_j(i)` and subtracts it, leaving `Σ f^{(b)}_j(i)` over the ballots receipted at seat `i`. If the same set `T` of the cell's ballots was receipted at `k` or more seats, interpolating those values opens `Σ_{b∈T} v^{(b)}_j`; if `T` is one ballot, its vote. Whoever runs the relay (A-2) can try to arrange this by letting every other ballot of a small cell fall back to posting while the target's shares are receipted; the target's own checks show nothing unusual. So the tally is information-theoretically hiding only for cells with no posted shares; with posted shares, privacy against a future adversary falls to the sub-aggregate of receipted ballots per set of seats. Decoy ballots don't hide it: a ballot with `k` or more posted shares is fully recoverable after the break and can be subtracted at every seat, so only ballots with fewer than `k` posted shares protect a target. Not mitigated yet: [[verifier]] 8.2a flags, per cell, the smallest sub-aggregate such an adversary could isolate (counting only those ballots), and whether trustees withhold summed shares for such a cell is a decision for part 2 (T-15, T-16, T-14).
- **Liveness needs `k` trustees.** A cell with fewer than `k` passing summed shares has no result and fails the election (T-54); a trustee that withholds its sums is visible but not compellable.
- **Small cells reveal votes.** An opening over one ballot, or over a cell where every ballot chose the same option, reveals those votes; [[verifier]] 8.2 flags small counts, and nothing here prevents them (T-16).

## Test vectors

`docs/spec/vectors/tally.json` ([[vectors/README|vectors]]): cells with their ballots' VSS commitments, every trustee's shares per ballot, the aggregates, each trustee's summed shares and check verdict, the seats combined, the Lagrange coefficients and the opening; cells with a failing trustee (a share off by one, a sum missing a ballot, options swapped, a short list), an empty cell, a cell with one ballot, a cell at `MAX_TRUSTEES`, a cell short of `k` passing trustees (`tally-quorum`), a cell whose only ballot holds a vote of 2 and so fails `tally-range` (a ballot no admission check would let through, to exercise the check), and an election with two cells and its derived overall total. They are printed by `packages/crypto/scripts/tally-vectors.py`, an implementation of this page in Python's integers that reuses `ballot-validity-vectors.py` to make the ballots, and so shares nothing with `packages/crypto`. It finds each opening by solving the Vandermonde system for every coefficient of the summed polynomials, not by Lagrange coefficients, and checks the two agree.
