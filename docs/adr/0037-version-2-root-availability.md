# ADR 0037: Who judges a version-2 obligation root available

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-18
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-25, T-54, T-14, T-29, T-52 (see [[THREAT_MODEL]])

## Context

An election that commits roots ([[0031-national-delivery-obligation]]) delivers a seat's receipts and complaints to L1 as one signed obligation root per seat and kind, whose leaves count only if the root is **available**: named, in counted-extent attestations that count, by enough seats that a leaf object no honest seat holds can't be passed off as held ([[delivery]], Leaf availability; [[availability]], The roots). Under ballot versions 1 to 3 every root is a default seat's and the default panel judges it: `q − k + 1` of its `q` qualified seats must name it, so withholding an honest seat's root takes `k` seats refusing to name it, a coalition that can already open ballots.

Ballot versions 4 and 5 add an author panel ([[0027-trustee-panels-and-live-results]], Part 1): every ballot's opening is split additively between the default panel and the author panel, and opens only with both thresholds ([[ballot-validity]], Residuals (version 4)). Version-2 roots name their seat's panel ([[delivery]], Records (version 2)), so a rule must say whose attestations make a root of either panel available. Whatever it says is fixed in the board's `availability-root` check, the attestation's bounds and the verifier's delivery check once any registry is deployed.

Withholding a root drops, before any result, every ballot whose only delivery to that seat was a leaf, on the refusing seats' signed word (`root-withheld`); with an operator that refuses the chosen ballots' board-path receipts, the refusing seats choose which ballots drop. The voter's client, which keeps sending its receipts through every path until one is anchored and never stands down on a leaf ([[delivery]], Client rules), is what still delivers them. Making a root available whose leaves no honest seat holds stops honest seats from summing, since every seat must hold every available root's leaves first ([[delivery]], Summing): a stall, not a wrong count.

The availability attestation (version 1) is specified with a list of at most `32 = 2 · MAX_TRUSTEES` roots, each of the attesting seat's own panel ([[availability]], Records, The roots), and the board's availability call and the record's codec are built on it ([[P4-3]] parts 2c-1 and 2c-2); the trustee node attests only the ballot extent so far, and its counted-extent attestation, the one that names roots, is still to come.

## Options

### A. Each panel judges its own seats' roots

A version-2 root of panel `P` is available if at least `q_P − k_P + 1` of panel `P`'s qualified seats name it. A seat names only its own panel's roots.

- Pros: the default panel, which during launch is the operator alone ([[0027-trustee-panels-and-live-results]], the transitional panel), can't withhold an honest author seat's root, which would hand it the ballots only that root delivers (T-25, T-54). The attestation keeps version 1's format and its 32-root bound, so neither the record nor the board's built availability call changes (T-52). Naming a root falsely takes `q_P − k_P + 1` seats of its panel, which can already stall the tally by withholding their summed shares or partial openings.
- Cons: beside an author panel, `k_A` author seats can withhold an honest author seat's root, and `k` default seats an honest default seat's, and neither coalition can open ballots: unlike version 1, a coalition that can't read ballots can choose which ballots drop (T-25, T-54).

### B. The default panel judges every root

As version 1: `q − k + 1` default seats must name a root of either panel.

- Pros: one availability threshold, as version 1 has.
- Cons: the default panel, the operator alone during launch, can withhold any author seat's root, so an author panel protects nothing from it on this path (T-25, T-54). Default seats must name author roots too, so an attestation's list grows to `2 · MAX_TRUSTEES` per panel for both panels (64), under a new attestation version.

### C. A root is available if either panel's threshold names it

A version-2 root of either panel is available if `q − k + 1` default seats or `q_A − k_A + 1` author seats name it. Every seat names the roots of both panels whose leaf objects it holds.

- Pros: withholding any honest seat's root takes `k` default and `k_A` author seats together, exactly the coalition that can read ballots, as in version 1 (T-25, T-54). Naming a root falsely still only stalls, and each coalition that could do it can already stall: `q − k + 1` default seats by withholding their summed shares or partial openings, `q_A − k_A + 1` author seats by withholding partial openings. Under the transitional panel the default panel gains only the power to make roots available, never to withhold them.
- Cons: an attestation's list grows to `4 · MAX_TRUSTEES` (64 roots), so the attestation needs a new version, the board's built availability call and its `availability-root` check accept roots of either panel, and the verifier's reading changes with it (T-52). Every seat must fetch and check every root of both panels before attesting, which it must already do for every available root before summing, so the fetch moves earlier and grows only by the other panel's roots that end up withheld.

## Recommendation

A, for now. It closes what matters most during launch, the operator's power over author roots, with no change to the availability attestation's format, which the board's availability call is built on, and its residual is confined to elections that both commit roots and have an author panel: none can be registered until [[P2-16]] part 5 lifts the registry's refusal of ballot version 4, and nodes refuse every election that would commit roots until the counted extent's contract path and check are built ([[delivery]], Capacity). C is the stronger rule and the one to move to if the residual matters for a real election: it restores version 1's bound at the price of an attestation version.

What would change it: an owner veto in favour of C (or B), or an author-panel election that commits roots becoming registrable before C is built.

## Consequences

- [[delivery]] (Leaf availability (version 2)) and [[availability]] (The roots; Availability check) specify A, and [[contracts]] (Board, Availability records) has the board refuse an attestation naming a root of the other panel.
- [[delivery]] (Residuals) states the residual for both panels: `k_A` author seats, or `k` default seats beside an author panel, can drop the ballots only an honest root of their own panel delivers, without being able to open any.
- A veto in favour of C changes [[delivery]], [[availability]] and [[contracts]] and adds an attestation version before any registry that reads ballot version 4 is deployed; nothing built from this decision is deployed before the rest of [[P2-16]] part 5.

## Decision

Under rule A (`AGENTS.md`): option A, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
