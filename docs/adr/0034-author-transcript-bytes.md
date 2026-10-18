# ADR 0034: The author transcript's chosen bytes

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-18
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-17, T-37, T-54, T-53 (see [[THREAT_MODEL]])

## Context

A poll with an author panel ([[0027-trustee-panels-and-live-results]], Part 1) has two key ceremonies, and the board carries both transcripts whole, so the permanent archive ([[0005-permanent-archive]]) keeps them. The author panel's transcript is a channel for bytes its seats choose ([[ceremony]], Author panel, Residuals):

- Each seat's ML-KEM-768 `ek` is `t ‖ ρ`. FIPS 203's modulus check passes any `t` whose coefficients are below `q`, about 1.1 KB per seat, and `ρ` is 32 free bytes.
- Each challenger's revealed `μ` is 32 free bytes per ordered pair of seats.
- Possession ([[0018-ceremony-possession]]) binds `ek` to a key someone holds only when an honest seat challenges it. The author picks every author trustee, so all of them can collude, and with `n_A = 1` nobody challenges at all.

That is up to about 1.2 KB with one author seat and about 25 KB at `MAX_TRUSTEES` (16) seats, signed by the author trustees' identity keys. A second, smaller channel rides with it: rule 7 lets one seat be unqualified, so when `n_A − 1 ≥ k_A` a creator can list one author key nobody holds, whose `x` coordinate (about 32 bytes) it chose, and the definition carries it.

The default panel's transcript has the same room. Its seats are pinned trustees bound by [[0006-trustees]], though, while the author's are anyone the author names. [[ceremony]] (Residuals) left the choice to [[P2-16]] before part 5 lets the election registry accept author panels. Until then [[verifier]] 2.3 fails every definition with an author panel (`profile-combination`), and rule 9 refuses to register one ([[contracts]], Election registry), so no author transcript reaches the archive.

The choice is one-way. Whatever the first author-panel poll boards stays in the archive for good, and the transcript's place on the board decides what a verifier can check decades later.

## Options

### A. Default seats challenge every author key

The default seats join the author run's challenge rounds: each sends each author seat an ML-KEM challenge, as a seat of the run does ([[ceremony]], Rounds 2 to 4). An honest default seat's challenge then forces each author `ek` to decapsulate correctly, so `t` must be close to `A·s` for a secret `s` its seat holds.

- **It doesn't close the channel.** A seat that sets `s = 0` publishes its noise `e` as `t`, in the clear, and any `e` small enough decrypts every challenge correctly: decryption reads `v − sᵀu = eᵀr + e₂ + ⌈q/2⌋·m`, whose noise is no larger than an honest key's. Coefficients of a few bits each across 768 of them leave a few hundred chosen bytes per seat, plus `ρ`'s 32 and the author challengers' own `μ`. A cuts the channel to roughly a third and doesn't remove it.
- **It couples the panels.** The author run comes first, on a stub with both transcript hashes zeroed ([[0027-trustee-panels-and-live-results]], How the ceremonies compose), and every default seat would have to be live in it. An outage of one default seat then stalls the author run as well as its own (T-54). The context, the messages, the transcript check, both ceremonies' vectors and `apps/trustee-node` would all change.
- Mitigates T-17 partly. Adds a liveness dependency (T-54).

### B. Keep the author transcript off the archive

Board only the author panel's key set (each seat's `kem_key_hash` and signing key, [[ceremony]], Key set hash) and leave the transcript itself to the author's nodes and voluntary pins. Clients and seats fetch the `ek`s off the archive, by hash.

- **Closes the channel** in the archive: a key-set entry is a hash and a P-256 point.
- **Loses later checks.** A verifier reading the archive alone, which is the property [[P4-6]] builds, can no longer run 3.1 and 3.2 for the author panel. It loses each seat's possession proofs and the challenges that bind `ek` to a holder (T-37). It also loses every author seat's `dh`, which the complaint check reads ([[share-encryption]], Complaints; [[delivery]], Version 2), so an author-seat complaint would become unverifiable once the off-archive copies go (T-53). The election's evidence would then depend on copies nobody is bound to keep, which [[0005-permanent-archive]] exists to avoid.
- Mitigates T-17. Weakens T-37 and T-53 for good.

### C. Accept the channel, bounded and attributable

Keep the transcript whole on the board and in the archive, and record the channel as a residual of T-17 with its bounds: about 1.2 KB with one author seat, at most about 25 KB per election at 16, plus the one unheld key's 32 bytes in the definition.

- **It is small beside what the archive already admits.** A voter can archive about `n · (64·m + 36)` chosen bytes per ballot and re-vote in share postings, about 66 KB per ballot at `MAX_OPTIONS` and `n = 16`, anonymously and for gas alone (T-17, Status; [[delivery]], Direct submit). The author transcript is at most one per election, and smaller than one such ballot.
- **It is attributable.** Every round message is signed under an identity key the definition lists, and for a poll created on our website the author's account is recorded on the account side ([[0032-poll-creation-operations]]). The posting channel is anonymous.
- **It has one gate.** The author transcript has no contract path ([[board]], Allowed payloads): it reaches the board only when the operator boards it, before `opens_at` ([[ceremony]], Author approvals record, Boarding). An operator that refuses one keeps it out of the archive, at the cost of that poll never opening. It can already do that (the Residuals' "operator can keep an author-panel poll from opening"), so C adds no new power. It only means the power is also the last point where a transcript can be stopped.
- Every check stays: 3.1 and 3.2 for the author panel, possession and complaints, from the archive alone.
- Leaves T-17's residual larger by at most one transcript per election. Keeps T-37 and T-53 as built.

## Recommendation

**C.** A doesn't close the channel and costs a liveness dependency. B closes it by giving up the archive-only verification the system is built around. C keeps every check, and the bytes it leaves fit inside a residual T-17 already carries for every ballot, at a fraction of one ballot's size, attributable where that one is anonymous.

What would change this: a decision that the archive must hold no chosen bytes beyond a fixed small bound per election. That would have to close the posting channel first, since it is far larger. Or a cheap proof that an ML-KEM key was generated honestly (from a seed under a public randomness beacon, say), which would close `t` without A's liveness cost. Neither is planned.

## Consequences

- [[ceremony]], Author panel, Residuals: both channels are accepted under this ADR, with their bounds, and the default panel's transcript keeps its own room as before.
- T-17's Status gains the residual: the author transcript, up to about 25 KB per election, signed by the author trustees, and the one unheld author key's 32 bytes.
- [[verifier]] 2.3 may now pass a sealed version-6 definition with an author panel. The rule in `packages/crypto` still fails it until a later P2-16 part lifts that refusal. That part waits for [[P2-15]] part 3b-3, which changes the same rule for live definitions. The release that lifts it must keep [[verifier]] (Definition, step 2) true: no registry a release pins registers such a definition before then.
- [[P2-16]] part 5 (contracts) no longer waits on this choice. Rule 9 keeps refusing author panels until part 5 gives the board contract the author panel's key set and ballot version 4's checks.
- Moderation doesn't change ([[moderation-policy]] acts on display text and listing only). Hiding a poll doesn't remove a boarded transcript, as it doesn't remove a posting.

## Decision

Under rule A (`AGENTS.md`): option C, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto in favour of A or B reopens [[P2-16]] part 5's gate, and nothing that this decision unblocks is deployed before part 5.
