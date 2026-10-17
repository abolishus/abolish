# ADR 0027: Trustee panels and live results

- Status: Accepted (owner, 2026-10-12) for the owner's decisions (Context). Design choices made within them are marked **(agent)** and are `Accepted (agent) — owner may veto`.
- Date: 2026-10-12
- Deciders: owner (trustees and the brief's non-negotiable properties: decisions 1 to 4); agent, owner may veto (rule A), for everything marked (agent)
- Threats addressed: T-14, T-16, T-45, T-54, T-15, T-11, T-13, T-10, T-01, T-25, T-29, T-37, T-34, T-36, T-50, T-53, T-61, T-69 (see [[THREAT_MODEL]])

## Context

On 2026-10-12 the owner made four decisions, now in [[PROJECT_BRIEF]] (Non-negotiable properties: Threshold trust; Architecture: Election types):

1. **Trustees are invisible infrastructure in everyday polls** (automatic trustee nodes, [[0006-trustees]]; the everyday UI mentions them only in the evidence view) and are **shown in full on the civic record**.
2. **Live results.** A poll's author may choose live results instead of sealed-until-close: running totals decrypted and published at intervals during voting, "never for fewer new ballots than a minimum batch, so no published difference reveals one ballot". Civic referendums are always sealed.
3. **Author-added trustees.** An author may add any number of named trustees of their own, even to an everyday poll. They only add protection: a ballot opens only with the default panel's threshold and the author's trustees' threshold together. The author chooses their panel's `k`-of-`n`.
4. **The transitional panel** (as revised by the owner later the same day). At launch, until independent trustees are named ([[P1-7]]), the default panel is the operator's alone, so for polls under it ballot secrecy does not hold against us. Every page and receipt says so; only everyday polls run under it; our seats sit on separate machines, providers and keyholders, and shares are destroyed after each poll's final count, stated as an unverifiable commitment; authors can add their own trustees to protect their poll from us; seats hand over to named independent trustees before the first civic poll, and a handover protects only later polls.

Each touches something one-way. The panel structure and the ballot's sharing go into every ballot on the permanent board; anything a running total publishes can never be withdrawn ([[0015-tally-publication]], Context); and ballots cast under a panel stay readable by any `k` of it for as long as its key material survives ([[0006-trustees]], Context). So this ADR fixes how each decision is built, and records where the build narrows or departs from what earlier ADRs say.

Two facts from earlier ADRs shape everything below:

- **There is no election key.** Under [[0002-everlasting-privacy]] (option B, accepted by the owner) each ballot's opening is shared by the voter with Pedersen VSS to the panel's seats, and only perfectly hiding commitments are public. The trust property is "no `k − 1` trustees can open a ballot", per ballot ([[0002-everlasting-privacy]], Decision, answer 3).
- **Openings are published once per cell of one partition** over the anchored counted set, and never re-published, because two aggregates over sets that differ by a few ballots reveal those ballots ([[0002-everlasting-privacy]], Tally; [[tally]], Coarser totals; T-16). Live results deliberately publish more than one aggregate per cell, so the rule that replaces "never re-published" is this ADR's main work.

## Part 1: author-added trustees (the composed panel)

### The coordinator's construction, evaluated

The proposed construction was: the election key is the combination of two independently generated threshold keys, so secrecy holds if either panel is honest, and liveness needs both. For threshold ElGamal that is sound and standard: with `K = K_D · K_A`, a ciphertext under `K` decrypts only with both panels' decryption shares, each proved with Chaum–Pedersen against its own panel's key.

It doesn't apply as written, because [[0002-everlasting-privacy]] has no election key to combine. The property it aims at, an AND of two thresholds, is still exactly right, and the closest sound construction under option B gives it per ballot (option A below). The literal construction remains the right one for a ranked-choice mix key, if the follow-up ADR of [[0003-tally-scheme]] needs one: each panel runs its own DKG and the mix key is the product.

### Options

#### A. Split each ballot's opening in two, and share each half within its own panel (agent)

The textbook way to realise an AND of two threshold access structures (Benaloh and Leichter, "Generalized Secret Sharing and Monotone Functions", CRYPTO 1988; Ito, Saito and Nishizeki, 1987): split the secret additively 2-of-2, then share each part with its own threshold.

For each option `j`, the client keeps today's commitment `C_j = g^{v_j} · h^{r_j}` and its validity proofs unchanged ([[ballot-validity]]), and additionally:

1. draws `(a_j, s_j)` uniformly from `Z_ℓ²` with the CSPRNG (through `packages/crypto`, like every other ballot randomness);
2. shares the **default half** `(v_j − a_j, r_j − s_j)` to the default panel with Pedersen VSS of threshold `k_D` (polynomials `f^D_j`, `g^D_j`, commitments `E^D_{j,t}`, `t < k_D`);
3. shares the **author half** `(a_j, s_j)` to the author panel with threshold `k_A` (`f^A_j`, `g^A_j`, `E^A_{j,t}`, `t < k_A`);
4. publishes both commitment vectors, and the share hashes for all `n_D + n_A` seats. Anyone checks `E^D_{j,0} · E^A_{j,0} = C_j`, a group equation over public values that needs no proof.

Each seat is identified by its panel and its index in that panel (both panels evaluate at `1 … n_P`). Share ciphertexts, receipts, postings and complaints work per seat exactly as [[share-encryption]] and [[delivery]] specify, with the panel bound in: the AEAD's associated data and every signed statement name the seat's `panel_id` as well as its index, so a seat of one panel can never stand for the same index of the other. The Fiat–Shamir statement of the validity proofs binds both commitment vectors and every share hash (T-30, T-32).

As built (P2-16 part 2a, agent, owner may veto; [[ballot-validity]], Ballot record (version 4)): `C_j` is not carried but defined as `E^D_{j,0} · E^A_{j,0}`, so the check above holds by construction and a ballot has no extra element to fill with chosen bytes or to fail; and a seat's panel is named by one byte (`panel`, 1 default, 2 author) beside the definition hash, which fixes both panels' identifiers, rather than by the 32-byte `panel_id`, so every signed statement and delivery record keeps a fixed length.

**Secrecy (only adds).** A ballot opens only to a coalition holding at least `k_D` default seats **and** at least `k_A` author seats. The halves are independent, and each half on its own is a uniformly random pair under a perfectly hiding commitment. A coalition missing either threshold learns nothing about `v_j` from shares, even with unbounded computation. In particular the author's trustees, even all of them, know `a_j` and learn nothing about `v_j − a_j`, which stays shared exactly as an author-free ballot's opening is. So every coalition that can read a composed ballot could already read it under the default panel alone: the author panel can never lower secrecy below the default panel's (T-14). Against a future cryptanalyst (A-11), reading a ballot needs `k_D` default shares and `k_A` author shares broken, more than before, never fewer (T-15).

**Tally.** Per cell and panel, the panel's seats sum their shares over the counted set and exchange summed shares only among themselves, as [[0015-tally-publication]] (option C) has them do today; one seat of each panel publishes that panel's **partial opening** `(V^P_{c,j}, R^P_{c,j})`, which must open `Ê^P_{c,j,0}`, the product of the counted ballots' `E^P_{j,0}`. The cell's count is `V_{c,j} = V^D_{c,j} + V^A_{c,j} mod ℓ`. A partial opening reveals nothing: `V^D` is the count minus a sum of uniform values the author panel holds, and vice versa. Each partial opening is signed with its seat's per-election key and checked against its own panel's aggregate, so a wrong one is attributed to its panel's signer (T-29), and summed shares never cross between panels.

**Verifier checks**, added to [[verifier]]:

- **2.5** The default panel equals a panel the release pins, as today. The author panel is not pinned: its keys, `k_A` and `n_A` come from the definition (below), and its identifier is recomputed from them under its own tag.
- **3.1 and 3.2, per panel.** Each panel's ceremony transcript is checked against its own panel (the default panel's from the pins, the author panel's from the definition), each with at least `max(k_P, n_P − 1)` qualified seats (rule 7 applied to the author panel too, agent: an outage at open shouldn't silently shrink the author panel's margin), and the author panel's approvals checked against its own keys.
- **5.x, per ballot.** Both commitment vectors have the right shape (`k_D` and `k_A` per option), `E^D_{j,0} · E^A_{j,0} = C_j` for every option, and delivery (receipt or passing posting) holds for every qualified seat of both panels.
- **7.x, per cell.** Each panel's partial opening opens that panel's aggregate; their sum is in range (`0 ≤ V ≤ |S_c|`, as `tally-range`); a cell lacking either panel's partial opening fails `tally-missing`.
- **8.4.** The report names both panels, which seats of each signed, and the author panel's names as the author declared them, labelled as the author's claim.

Pros: exactly the owner's property; only published protocols (Pedersen VSS, additive splitting) over the same group, proofs and KEM; the validity proofs, the counted-set rules and the tally rules carry over per panel; the default panel's work is unchanged.

Cons: a new ballot version (two sharings, a longer share-hash list), a new receipt and tally-opening version (the panel field), more data per ballot (`k_A` commitments per option and `n_A` share hashes public, about 1.8 KB per author seat private at 10 options, [[0002-everlasting-privacy]], Cons), and every cost of B's intake now also falls on the author's trustees.

#### B. Two threshold ElGamal keys, multiplied (the construction as proposed)

Sound for ElGamal, but it reintroduces a public ciphertext under a computational assumption on the permanent board, which [[0002-everlasting-privacy]] rejected (T-15), plus a DKG per panel (T-40). Kept only for a future ranked-choice mix key (above). Rejected for plurality and approval.

#### C. One sharing over both panels' seats

The voter shares once over `n_D + n_A` seats. With an ordinary threshold, any threshold either lets author seats stand in for default seats (a threshold of `k_D` over the union lets `k_A` author trustees and `k_D − k_A` default trustees open ballots, which lowers secrecy) or demands all of one panel. An "at least `k_D` here and `k_A` there" structure over one polynomial needs hierarchical secret sharing with Birkhoff interpolation (Tassa, "Hierarchical Threshold Secret Sharing", J. Cryptology 2007), whose verification and parameter conditions are far less established and would need their own review (T-36). Rejected: A gives the same structure with two ordinary sharings.

### Decision on the construction (agent)

**A.** It is the coordinator's construction transposed to per-ballot sharing, with the same guarantee: secrecy holds if either panel is short of its threshold, and liveness needs both.

### How the ceremonies compose

- **The definition binds both panels (agent).** A new definition version adds, beside the default panel's fields: `author_threshold` (`k_A`), `author_keys` (the author trustees' identity keys, `list<p256-key, MAX_TRUSTEES>`, `n_A` of them, empty when there is no author panel), `author_transcript_hash`, and the author panel's display names in the display text only. The author panel's identifier is `H(DS("abolish/v1/author-panel", u8(k_A) ‖ u8(n_A) ‖ Q_1 ‖ … ‖ Q_{n_A}))`, under its own tag, so an author panel can never be taken for a pinned default panel with the same keys.
- **Author panel validity (agent).** `1 ≤ k_A ≤ n_A ≤ MAX_TRUSTEES`, distinct keys, and no key equal to a default seat's. `k_A = 1` is allowed, unlike a default panel ([[trustee-identity]], Panel identifier, rule 2): an author panel is never alone, so one author trustee holding a whole half lowers nothing. "Any number" is therefore any number up to `MAX_TRUSTEES` (16) at this protocol version; more needs a new version and must fit direct submission (P1-18; T-50, T-27). The owner may veto this bound.
- **Two ceremonies, one after the other** (amended in P2-16 part 1a, agent, owner may veto; [[election-definition]], Stub hash and the ceremony). The author panel's ceremony runs first, on a stub with both transcript hashes zeroed; the default panel's runs on a stub that keeps the author transcript's hash, so the default seats' on-chain registration binds it. With one shared stub nothing on chain would bind `author_transcript_hash`, and the creator could register any 32 bytes there, or pick among author transcripts, after the default panel approved. The cost is two ceremonies' time before a poll with an author panel opens. Each panel runs its own ceremony as [[ceremony]] specifies, with `panel_id` in the ceremony context recomputed for the author panel from the stub's `author_keys`, never from the coordinator. Default seats lend their keys to an election whatever its author panel; author seats run [[ceremony]]'s stub checks and also check that the stub names them as the author panel.
- **Registration.** The default panel registers with the trustee registry as today. The author panel's approvals ([[trustee-identity]], Ceremony registration, under the author panel's identifier) go on the board with its transcript, and are checked off chain by the verifier, the ballot client and every default seat before any share is made (agent). The registry pins panels at deployment and can't hold arbitrary author panels; an on-chain check would add nothing the verifier doesn't already do, because a bad author panel can only stop a poll, never weaken it. As built (P2-16 part 3a, agent, owner may veto; [[ceremony]], Author panel): the approvals travel in their own record, author approvals (`0x0019`), which only board-entry version 7 allows and only a definition with an author panel may pin; the approval quorum is `max(k_A, n_A − 1)`, as for the registry's own panels; and the default seats check the transcript and approvals from the coordinator before the default ceremony, since the board has no entries until the definition is registered.
- **Key substitution.** Anyone who substitutes the author panel's keys in the stub (the operator, which assembles it, A-2) gets at most the default panel's protection, never less: secrecy still needs the default threshold. But the author would believe their trustees protect the poll when they don't (T-37). So the creation flow shows each author key's visual fingerprint, each author trustee's node checks the registered definition names its own key, and the evidence view lists the fingerprints.

### Liveness

Both panels' nodes must be online: during voting for intake ([[0002-everlasting-privacy]], Delivery), at the tally, and at every live release (Part 2). If fewer than `k_A` author seats can take part at the tally, **the poll can never be counted, by anyone, including us**: every cell fails `tally-missing` and there is no recovery by design, as for the default panel (T-54). An author panel that fails its ceremony stops the poll before voting opens, which loses nothing.

The UI says this plainly (agent):

- **Creation flow.** Adding trustees asks for their `k`-of-`n`, shows their key fingerprints, and needs an explicit confirmation (the shared confirm dialog, never a native prompt) of: "If fewer than `k` of these trustees take part when the poll closes, the poll can never be counted, by anyone, including us. Each of them must run a trustee node that stays online while the poll is open."
- **Poll page.** In the everyday register the default panel stays invisible, but an author panel gets one plain line, since it changes whether the poll can be counted: "Also held by `n_A` trustees the author chose. If `k_A` of them don't take part at the close, this poll can't be counted."
- **Results.** A poll that fails this way says so on its results page: "This poll can't be counted: `x` of the author's `n_A` trustees took part, and `k_A` are needed."

### What an author panel does weaken

- **Network metadata (T-11, T-13).** Author trustees run intake, so each sees every ballot record (membership-checked intake, [[P1-12c]]) with the network address that delivered it. An author's trustee can link addresses to nullifiers and re-votes, though not to votes. The creation flow and the poll's evidence view say who the extra intake parties are.
- **The posting fallback.** An offline author seat has its shares posted, with classical privacy only ([[0002-everlasting-privacy]], Cons). That weakens only the author half, which is worthless without the default half. As built ([[P2-16]] part 3b, [[tally]], Residuals of author panels): that holds only against an adversary that reads no default half; because each panel's partial opening is published on its own, a future adversary that reads one ballot's posted default half and every other ballot's posted author half can recover that ballot's vote, and [[verifier]] 8.2 flags readable ballots per panel. The partial openings stay unmasked (amended in P2-16 part 3c-2, agent, owner may veto): publishing only the sum would mean sending the author's partial opening privately to the default seats, a channel between the panels that takes the author's commitment off the board, so who sent in time and who failed would no longer be judged from boarded records; and the exposure needs a future break and fallback postings that differ between the panels; a masked tally-opening version can still replace version 3 before any poll with an author panel runs ([[tally]], Residuals of author panels).
- **Liveness**, above (T-54), and selective failure: an author can refuse to take part at the tally of a poll whose running totals it dislikes, and nothing distinguishes that from an outage.

## Part 2: live results

### The risk: differencing

Publishing the running sum at `t1` and `t2` reveals the sum of the ballots that entered or left between them. If one ballot entered, it is revealed. Re-voting makes it worse: a superseded ballot leaving the running sum is also a difference, and its departure next to its replacement's arrival reveals how one voter changed their vote, which is exactly what re-voting as the defence against observed coercion must hide (T-45). Small cells make it worse again: a regional cell of 1,000 registered members may see few ballots an hour.

Every running total is an opening of an aggregate commitment, as the final tally is, so it reveals counts and nothing else, information-theoretically. But a disclosure by differencing is permanent the moment it is published: no future cryptanalysis is needed, and nothing can withdraw it.

### What a running total counts (agent)

The **running set** of a cell at snapshot `S` (a board prefix covered by an anchored checkpoint) holds, for each (tier, nullifier) in the cell, the nullifier's ballot if and only if:

1. among the admitted ballots in `S` ([[revoting]], Admission, with every named L1 block finalized), the nullifier has **exactly one distinct ballot** (one `M`; repeats are one ballot, [[revoting]], Selection, step 1); and
2. that ballot holds a valid-share receipt from **every qualified seat of every panel**, with no posted share.

Everything else is **held out** of running totals until the final tally, which is computed exactly as for a sealed poll ([[tally]]).

Why each condition:

- **Condition 1 (hold out re-voters).** A nullifier that re-votes (or voids itself with a tie) leaves running totals at its second ballot and comes back only in the final tally. The departure reveals at most its first ballot, mixed into a batch, which a coercer who watched that ballot already knows. The re-vote's content appears only in the final tally, never in a batch an adversary can time or pad. Re-voting stays as strong against observed coercion as in a sealed poll, short of padding the whole final difference (Residuals).
- **Condition 2 (only fully receipted ballots).** A receipted share can't be complained about ([[delivery]]), so a ballot in a running set can't later be excluded. Running totals need no complaint window, and [[0002-everlasting-privacy]]'s rule that the counted set is fixed before any sum is published still holds for the final tally, where postings and complaints are settled. It also keeps posted shares, and with them [[0015-tally-publication]]'s posted-share leak, out of every running set.

Options considered for re-votes:

- **Current selection** (running totals follow the re-vote rule, superseded ballots leave, replacements enter). Gives the most faithful running count, but every re-vote's content enters a batch at a time the voter can't hide, so a coercer who knows the nullifier (re-votes are public to them, [[revoting]], Residuals) learns the new vote whenever that batch is otherwise known or padded (T-45, T-01). Rejected.
- **Count every ballot ever cast.** Wrong numbers, and counts coerced ballots the voter has replaced. Rejected.
- **Count only ballots whose status is settled.** No ballot is settled before close, since any voter can re-vote until then, so this is a sealed poll. Rejected as live results.
- **Hold out re-voters** (above). Chosen: re-voting keeps its sealed-poll protection; the cost is that running totals undercount voters who changed their mind, and the results page says so.

### The minimum batch (agent)

For a cell, the **change** between two running sets is the number of nullifiers whose running-set entry differs between them: entered, left, or (impossible by condition 1, but counted if it ever happens) replaced. The empty set counts as a release made at opening.

A tier's running totals are released only together, every cell at once, so a tier total derived from cells always refers to one snapshot. Tiers are released independently, since they are never blended ([[PROJECT_BRIEF]], Design direction). Every ballot carries every question, one flat option vector with blanks as encrypted zeros ([[0026-multi-question-ballots]]), so a cell's change is the same for each question; a ballot version that lets a ballot omit a question must apply the rule per question.

**The rule.** At each scheduled time (below), with `S_p` the snapshot of that time, the trustee nodes release the running totals of the latest earlier snapshot `S_q` (a scheduled one, after the last published release) such that, in **every cell** of the tier:

1. the change between `S_q` and **every** earlier published release of the tier, and the empty set, is at least `B`; and
2. the change between `S_q` and `S_p` is at least `B`.

If no `S_q` qualifies, nothing is released for that tier at that time. The rule is a deterministic function of the anchored board and the definition, so every node computes the same choice and any verifier rechecks it.

- Rule 1 makes every difference between two published running totals an aggregate over at least `B` changed nullifiers. Each nullifier is in a running set over one unbroken run of snapshots (it enters once and, by condition 1, can't come back after leaving), so what an observer can learn from the releases is, up to that structure, their pairwise differences. Whether a combination of three or more releases can isolate fewer than `B` nullifiers when the same nullifiers enter and leave between releases is for the spec to settle with a proof or a stronger check (P2-15 part 1, inside the `crypto-review` gate).
- Rule 2 **lags each release by one batch.** Without it, a release just before close followed by a handful of late ballots would make the final tally minus the last release an aggregate over those few ballots, and the final tally can't be withheld. With it, at least `B` changes already follow every published release, and they survive into the final tally, except where a nullifier that entered later voids itself with a tie or has its ballot excluded. The verifier flags a final tally that differs from any release by fewer than `B` in a cell (`live-final-batch`, with T-16's warning); it is never withheld, because the brief requires the result.
- A tier split into regional cells shows running totals only when every cell has its batch, so small cells delay live results for the whole tier. That is the price of not releasing a small cell early; a creator who wants faster live results draws coarser regions ([[0019-regional-cells]]).

**`B`, the floor and the default.** Protocol floor `MIN_LIVE_BATCH = 20`, a constant of the definition version that adds live results ([[parameters]]); default `B = 50`; an author may set any `B` at or above the floor, fixed in the definition before opening. The risk a batch leaves is unanimity: a batch in which everyone chose the same option reveals each of their votes. If an option has share `p`, a batch of `B` is unanimous for it with probability `p^B`: below 1% for `p ≤ 0.79` at `B = 20` and for `p ≤ 0.91` at `B = 50`. Ten, the common cell-suppression floor in official statistics, leaves a 2⁻¹⁰ chance of a unanimous batch even in a perfectly split poll and over 10% at `p = 0.8`; a hundred would keep most everyday polls (tens of voters) from ever showing a running total. The floor may be raised by a new version, never lowered in place.

**Fixed release times, never on demand.** The definition fixes the schedule as every `live_every` anchoring periods ([[board]], Timing) from opening, `live_every ≥ 1`. Snapshots are anchored checkpoints, so a release is over a board prefix every verifier sees anchored on L1, and nodes check it against L1 before releasing, as for the final tally ([[P2-13]]). A release missed by its next scheduled time is skipped for good, never made later over another set. No one, the author and the operator included, can trigger a release, because choosing when to release is choosing which ballots fall into a batch.

**The nodes' completeness check.** An honest node releases nothing for a snapshot that lacks a ballot it receipted at least one anchoring period before that snapshot's cutoff, unless the ballot is held out by condition 1. An operator that withholds honest ballots from the board to leave a target alone in a batch with ballots it knows (A-2 with T-01) then stalls the release instead, provided fewer than `k` seats of either panel collude with it (a release needs both panels). Under the transitional panel this check is the operator's own and protects nothing against it; under an independent or author panel it does.

### Interaction with everlasting privacy and the tally

- **What is published.** Each release is, per cell, per option and per panel, a partial opening of the running set's aggregate, signed by a seat's per-election key, in a new record type: the **running opening**, with the release's scheduled period and its snapshot, under a new signature tag. Like the final openings, it reveals counts and summed randomness only. The board stays perfectly hiding apart from the aggregates, as [[0002-everlasting-privacy]] requires; the aggregates are the disclosure, and the batch rule bounds it.
- **[[0002-everlasting-privacy]] (Tally) and [[tally]] (Coarser totals)** say openings are published only over one partition and never re-published. For a live poll this becomes: the final openings as today, plus running openings under this ADR's rules, and nothing else. A coarser total is still derived from cells, never opened. A sealed poll is unchanged.
- **[[0015-tally-publication]] (option C)** carries over per release: summed shares travel only among a panel's seats, never via the board. Each release's summed shares and summed-share messages are destroyed once its openings are boarded and anchored (agent), so a release adds no long-lived material. The corrupt-trustee residual ([[tally]], Residuals) gets a smaller target: a trustee that knows the summed polynomials of the final set and of the last release knows them over the trailing set, at least `B` ballots, which may include posted shares. Not mitigated beyond the batch.
- **Keys stay in use until close.** Live results use the shares during voting, at every release, so the nodes keep their per-election keys and stored shares live and in use until close, and destruction comes only after the final count, as for a sealed poll ([[tally]], Destruction). In a live poll the keys are also exercised online during voting, which widens the window in which a compromised node can be made to act (T-14, T-61).
- **Verifier.** It recomputes each scheduled snapshot's running set from the anchored board, checks the release choice and the batch rule, checks each running opening against its aggregate, and reports any running opening outside the rule (wrong snapshot, too small a batch, unscheduled) as a disclosure attributed to its signer. Such a release can't change the result, so it never fails the election; it is a privacy breach, reported as one (T-16, T-29).

### Influence

Early results sway later voters: towards the leader (bandwagon), towards the underdog, or into tactical voting, and they let anyone mobilise against a running count. At Tier 0 they also invite a cheap Sybil flood early on to manufacture momentum (T-01, T-53). That is why civic referendums are always sealed. Within the owner's decision (agent):

- **Sealed is the default;** live must be chosen at creation and is fixed in the definition before opening.
- **Civic-record polls.** A civic referendum is always sealed, and the definition's poll class (Part 3) makes that a well-formedness rule the verifier, the ballot client and the election registry check.
- **The voter is told before answering** that running totals are public while the poll is open.
- **Calm display.** Running totals update only at release times, labelled with their snapshot time, their ballot count per tier and "votes changed since they were first cast are counted at the close". No live ticker, countdown or animation that suggests urgency ([[PROJECT_BRIEF]], Calm and unmanipulative). Tiers are shown separately, as always.

### Residuals of live results

- **Padding (T-16, T-01, T-45).** The batch counts nullifiers, not people. An adversary who can cast `B − 1` ballots whose votes it knows into a release interval in which a target is the only other new voter learns the target's vote. At Tier 0 that costs `B − 1` cheap identities per target and interval, and it works best in quiet polls and quiet hours. Not mitigated; Tiers 1 and 2 raise the cost, and the completeness check stops an operator from making an interval quiet by withholding. Condition 1 keeps re-votes out of reach of this attack; only the final tally holds them.
- **Small batches still disclose.** A unanimous batch reveals its votes; `B` makes that unlikely, not impossible.
- **Combinations of releases.** Rule 1 bounds pairwise differences; the general case is an open obligation on the spec (above).
- **Late voids.** A final tally can differ from a release by fewer than `B` when later entrants void themselves with ties or are excluded; flagged, never withheld.
- **Relay delay.** If voters deliver shares through an operator relay, the operator can hold a ballot's intake back past a release so the nodes never receipted it; voters would see it as a slow cast. Direct delivery to trustee intake removes this ([[P2-13]]).
- **Influence**, above: a property of live results, not a flaw to fix.

## Part 3: the transitional panel

### What the owner decided, plainly

At launch the default panel is ours alone. For every poll under it, **ballot secrecy does not hold against us**: our nodes hold every share and can open any ballot, during voting and until the shares are destroyed (T-14, A-2). The brief's "no single party, including us, can decrypt individual ballots" is suspended for those polls, by the owner's decision, and every page says so.

What that exposes, stated accurately:

- **What a decryption reveals.** Voting identities are anonymous Semaphore identities, so opening a ballot reveals what one anonymous identity (a nullifier in one poll) answered, not who answered. Linking a nullifier to a person needs metadata on our side: the network address and timing a ballot arrived with (T-11), registration metadata that narrows who an identity is (T-13), or a link between an account and a ballot, which the server must never hold but which an operator acting as A-2 could start logging (T-10).
- **We hold that metadata by default.** Our trustee nodes run intake, which receives each ballot record, and so its nullifier, together with the delivering network address, and could decrypt it on the spot. Against an operator that chose to log intake, secrecy is effectively gone for a voter who doesn't hide their network address. The commitment not to log is ours, and unverifiable.
- **For good, unless destroyed.** Ballots cast under the transitional panel stay readable with our shares for as long as any copy of them survives. We destroy them after each poll's final count, but no one can verify destruction ([[tally]], Residuals). A handover protects only polls opened after it.
- **Compulsion.** A state that can compel us (A-1, T-69) can compel a decryption, and a seizure before destruction yields the shares.

### Rules for the period

1. **The label (owner).** Every page of such a poll (question, ballot, results, evidence) and every receipt says: "During launch, Abolish alone holds the key for this poll." In the everyday register too: this is the one fact about trustees that is never only in the evidence view. The verifier's report says it as well. When the poll also has an author panel (rule 6), that sentence would be false, so the label becomes (agent): "During launch, Abolish holds the default key for this poll. Ballots open only with the author's trustees too."
2. **Everyday polls only (owner), made checkable (agent).**
   - The release pins each default panel with a **panel kind**: `independent` (meets [[0006-trustees]] rules 1 to 7, named by the owner) or `transitional`, and, per seat, its holder and whether the seat is ours. The trustee registry logs the kind in `PanelPinned` at deployment.
   - The definition gains a **poll class**: everyday, organisational vote or civic referendum. The last two are on the civic record.
   - A definition whose class is on the civic record and whose default panel isn't `independent` fails [[verifier]] 2.5 (`panel-kind`); the ballot client refuses to cast in it, and the election registry refuses to register it, reading the kind the trustee registry logged.
   - A creator could label a civic question as everyday; it then runs and displays as an everyday poll, with the transitional label. The class decides the register a poll is shown in, so mislabelling can't put a transitional poll on the civic record.
3. **Separate machines, providers and keyholders (owner), shaped like the panel it hands over to (agent).** The transitional panel has the decided shape, 4-of-7 with rule 7, so the ceremony, node and registry code are the same and seats can hand over one at a time. No machine, no hosting or cloud provider and no keyholder (a person who can reach a seat's identity key or node) holds `k` = 4 seats, so at least three providers and three keyholders, applying [[0006-trustees]] rule 2's `k − 1` bound to our own seats. This defends against one compromise (a breached provider, one rogue or coerced employee) and against one loss; it does nothing against compulsion of the operator, which reaches every seat. A runbook records the layout, and it is published.
4. **Destruction after each final count, as a commitment (owner).** Each seat destroys its material as [[tally]] (Destruction) requires and signs its destruction statement. We state, on every transitional poll's evidence view, that this is a commitment no one can verify.
5. **Live results** keep the shares in use until close (Part 2); destruction comes only after the final count.
6. **Authors can protect their poll from us (owner).** Under Part 1, a ballot opens only with both panels, so an author who adds trustees we don't control makes the poll's ballots unreadable by us alone, with the costs of Part 1: their trustees must run nodes, and their failure makes the poll uncountable. The creation flow offers this during launch with that trade-off stated. It doesn't hide intake metadata from us (above) and doesn't help against a malicious ballot client (T-41; the client is a signed reproducible build, T-61).

### Handover (agent, within the owner's rule)

- **When.** Before the first poll on the civic record, which rule 2 enforces, and as soon as the owner has named independent trustees ([[P1-7]], [[0006-trustees]], Panel).
- **How.** The trustee registry is immutable and pins its panels at deployment ([[contracts]], Trustee registry), and a release pins panels by key. So a handover is a new panel, pinned in a new trustee registry deployment and a new verifier and client release; polls opened after the release's activation name it. Seats may move one at a time, each step a new pinned panel whose label states how many seats are ours ("During launch, Abolish holds `x` of the 7 seats for this poll; any 4 can open a ballot."); the panel becomes `independent` only when it meets every rule of [[0006-trustees]], rule 3 included (at most one seat ours).
- **What it protects.** Only polls opened after it. Polls already open finish under the panel they named, and their ballots stay readable with that panel's shares until destroyed (T-14). Nothing re-shares old ballots: proactive resharing is out of scope ([[0006-trustees]], Consequences), and it couldn't reach copies already made.
- **Tier 2 attestation.** [[0006-trustees]] (Owner decision, Tier 2 attestation) has trustees attest Tier 2 additions, seeing each nullifier beside its identity commitment (T-13). Under the transitional panel that is us alone. Tier 2 arrives in Phase 3; whether its attestation waits for an independent panel is for the owner (Open questions).

## Recommendation

- **Composed panel:** option A, the per-ballot AND of two thresholds, with the definition binding the author panel and the verifier checking it off chain.
- **Live results:** running sets of first ballots that are fully receipted, re-voters held out until the final tally; a minimum batch of changed nullifiers per cell, pairwise against every earlier release and lagged by one batch; floor 20, default 50; releases only at scheduled anchors, with the nodes' completeness check.
- **Transitional panel:** the decided 4-of-7 shape, all seats ours across at least three providers and three keyholders, panel kind and poll class making "everyday only" checkable, handover by new pinned panels before the first civic-record poll.

What would change it: a proof that pairwise differences don't bound combinations of releases would strengthen rule 1 (a stronger check, or forbidding re-entry patterns); a verifiable noise mechanism with audited primitives would answer padding, which nothing here does; and an owner decision that author panels may exceed `MAX_TRUSTEES`, or must be registered on chain, changes the definition and registry work.

## Consequences

- **Statements this ADR narrows.** [[0002-everlasting-privacy]] (Tally) and [[tally]] (Coarser totals): "never re-published" holds for sealed polls; live polls add running openings under Part 2. [[0006-trustees]] rule 3 (at most one seat ours) is suspended for the transitional panel, by the owner, with the label above. [[trustee-identity]] (Panel identifier) rule 2 (`k ≥ 2`) applies to default panels; author panels allow `k_A = 1`. [[ceremony]] (Ceremony context): `panel_id` is recomputed from the pins for the default panel and from the definition for the author panel.
- **New versions.** A definition version (poll class; results mode, `live_every` and `B`; the author panel); a ballot version (two sharings); receipt, posting and complaint versions binding the panel; a tally-opening version with a panel field; the running opening record; `MIN_LIVE_BATCH` in [[parameters]]; the panel kind in the release pins and the trustee registry. Nothing is deployed yet, so the registry change costs no migration.
- **Work items.** [[P2-15]] (live results) and [[P2-16]] (author-added trustees and the transitional panel), each with parts inside the `crypto-review` gate; [[P2-13]]'s node gains author-panel mode, scheduled releases and the completeness check.
- **Known-weak:** padding of live batches at Tier 0 (T-16, T-01); multi-release combinations pending proof; author intake metadata (T-11); author-panel liveness (T-54); and, for every transitional poll, no ballot secrecy against the operator (T-14, T-10, T-11), with destruction unverifiable.
- **[[THREAT_MODEL]] and threat files** (in the items' PRs): T-14 and T-54 for the composed panel and the transitional period; T-16 and T-45 for live results; T-11 for author intake.

## Open questions for the owner

- **Tier 2 attestation during the transitional period:** should Tier 2 additions wait for an independent panel, as civic polls do, since attesters see nullifiers beside identity commitments?
- **Whether organisational votes may be live.** The brief seals civic referendums only; this ADR lets organisational votes choose live while keeping them off the transitional panel.
- **The `MAX_TRUSTEES` bound on author panels** and the batch floor of 20 are agent choices; the owner may veto either.
- **The independent trustees' names** remain the owner's ([[0006-trustees]], Panel), and decide when the transitional period ends.

## Decision

The owner's decisions 1 to 4 (2026-10-12) are accepted as written in [[PROJECT_BRIEF]]. Everything marked (agent) is `Accepted (agent) — owner may veto`, for listing under Decisions to review in [[STATUS]]: the composed-panel construction (option A) and its definition, registration and UI rules; the running-set rule (re-voters held out, fully receipted ballots only); the batch rule with its lag, `MIN_LIVE_BATCH = 20` and default 50; scheduled releases at anchors and the completeness check; the transitional panel's shape and seat spread, the panel kind and poll class checks, and the handover procedure.
