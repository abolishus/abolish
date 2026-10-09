# ADR 0006: Trustees, k-of-n and named trustees

- Status: needs-decision (owner decides; never defaulted)
- Date: 2026-10-09
- Deciders: owner (one-way door)
- Threats addressed: T-14, T-54, T-37, T-69, T-15, T-11, T-29 (see [[THREAT_MODEL]])

## Context

The brief splits the election key "across k-of-n independent named trustees (I'll name them via ADR)" so that "no single party, including us, can decrypt individual ballots or alter a tally undetected", and its example simulation runs "7 trustees, two offline". AGENTS.md says trustee selection is never defaulted: this ADR proposes a structure and the rules a panel must meet, and leaves the names, and the choice between the options, to the owner. Until then, development and the reference election use a test ceremony with simulated trustees (P1-14, P1-20).

What trustees can and can't do, whatever the tally and privacy schemes:

- **Integrity doesn't rest on them.** Every decryption share carries a proof (Chaum–Pedersen under [[0003-tally-scheme]], or a check against public VSS commitments under P1-3's option B), so a wrong share is detected and attributed to its trustee (T-29). Trustees can't alter a tally undetected.
- **Privacy does.** Any k colluding trustees can read any individual ballot of an election they hold shares for (T-14). That includes k trustees compelled by one state (A-1, T-69) or k trustee machines compromised through one shared provider.
- **Liveness does.** If more than n − k trustees are unavailable after close, the tally can never be decrypted (T-54). Under P1-3's recommended option B, trustees must also be online during voting (synchronous intake); an offline trustee's shares get posted publicly, which weakens post-quantum privacy for those ballots (P1-3, #8).

So choosing k and n trades privacy (collusion needs k) against liveness (failure needs n − k + 1), and choosing who sits trades how independent those k really are.

It is one-way because:

- Every ballot cast under a panel's key stays readable by any k of that panel's members, for good. Changing the panel later protects only future elections (T-14, T-15).
- Trustees' public keys are registered on L2 and bound into election definitions (T-37). Their identities are public commitments the project makes to voters.

A second constraint shapes the options: the brief has open polls that anyone can create (Phase 2) as well as civic referendums (Phase 5). Open polls may close many times a day, so their trustees can't be people who act by hand at each close. Their shares must sit in **trustee nodes**: services each trustee runs on infrastructure it controls, which take part in ceremonies, accept shares during voting (under P1-3 option B), and publish decryption shares for exactly the aggregates the spec allows (one per disjoint partition over the anchored counted set) and nothing else.

## Options

### A. One panel, 3-of-5

Five named trustees run trustee nodes; any three decrypt.

- **Pros:**
  - Easiest to recruit and operate. Five independent organisations willing to run a node are realistic for a new project.
  - Tolerates two unavailable trustees, which covers the brief's "two offline".
- **Cons:**
  - Collusion needs only three. With the jurisdiction rule below (at most k − 1 = 2 trustees per jurisdiction), at least three jurisdictions are needed, and two jurisdictions compelling one trustee each plus one more trustee break privacy (T-14, T-69).
  - Two unavailable trustees is also the limit: a third outage (a compelled shutdown, a lost key) ends every tally in progress (T-54).

### B. One panel, 4-of-7

Seven named trustees run trustee nodes; any four decrypt. This is the brief's simulation shape.

- **Pros:**
  - Collusion needs four; at most three per jurisdiction, so at least three jurisdictions, and in practice more.
  - Tolerates three unavailable trustees: the brief's "two offline" plus one more failure.
  - Under P1-3 option B, the extra trustees cost bytes per ballot (roughly 1.8 KB per trustee per ballot, by P1-3's estimate), not protocol complexity. Under option A (threshold ElGamal) they cost only ceremony and tally messages.
- **Cons:**
  - Seven independent, competent node operators are harder to find and to keep than five.
  - More intake endpoints see network metadata (T-11 under P1-3 option B).
  - Every trustee must stay online and patched for every election, on its own infrastructure.

### C. Two panels by election class

An **open-poll panel** of trustee nodes (as in B, 4-of-7) for open polls, and a separate **civic panel** with a larger threshold (for example 6-of-11) for referendums and anything the election definition marks as civic. The civic panel's members may hold their shares offline and act by hand at each close, since civic elections are rare and scheduled.

- **Pros:**
  - High-stakes elections get a higher collusion bar and people who never keep a share online.
  - A compromise of the always-online open-poll nodes doesn't touch civic ballots.
- **Cons:**
  - Twice the recruitment, ceremonies and key management.
  - The civic panel's hand-run process adds human delay and error at every close (T-54), and under P1-3 option B its members must still accept shares during voting, which an offline member can't do. Then every civic ballot's shares to that member are posted publicly.
  - Nothing civic exists before Phase 5, so the civic panel would be chosen long before it is needed.

## Rules for any panel

Whatever the owner chooses, a panel is valid only if:

1. **Jurisdiction.** No more than k − 1 trustees are subject to any one state's legal compulsion (by seat, incorporation or residence of the people who hold the share), so no single state can compel a decryption (A-1, T-69). At most two trustees in the US for k = 3, at most three for k = 4.
2. **Infrastructure.** No more than k − 1 trustee nodes on any one hosting, cloud or hardware-security provider, so one provider's compromise or compulsion can't reach k shares (T-14, A-6).
3. **Us.** Abolish, its operators and anyone it pays hold at most one seat, and that seat is labelled as ours on every result page and in the verifier output (A-2).
4. **Independence.** No two trustees share an employer, a controlling owner or a funder that pays them for this role.
5. **Public identity and keys.** Each trustee is named publicly, registers its keys on L2 through the public ceremony transcript (P1-14, P1-18), and checks its own registered key itself (T-37). Results name the panel that held the key.
6. **Key custody.** Each node keeps its share in hardware it controls (an HSM or TPM-sealed key), separate from any machine of ours, and publishes the node software release it runs, built from our signed, reproducible release (P0-3).
7. **Lifecycle.** Keys are per election (under P1-3 option B) or per election period (under option A); a retired key's share is deleted after its elections' tallies are published, and each trustee signs a statement that it did so. A trustee leaving the panel means a new ceremony for future elections; elections already open keep their panel.

## Recommendation

**Option B, one 4-of-7 panel of trustee nodes, under the rules above,** with Option C's civic panel revisited before Phase 5.

- It matches the brief's own example (7 trustees, 2 offline) and tolerates one failure beyond it, where A tolerates none.
- Raising the collusion bar from three to four costs recruitment, not protocol complexity.
- One panel is all Phases 1 to 4 need; a civic panel can be added later for civic elections without touching earlier ones, because every election definition binds its own panel.

What would change the recommendation:

- Fewer than seven trustees meeting the rules can be found: then A, with its lower bars stated on every result.
- P1-3 adopts option B and trustees can't sustain online intake during voting: then fewer, more reliable trustees (A) may protect privacy better than more, less available ones.
- Civic elections arrive earlier than Phase 5: then C.

## Consequences

- **Names.** The owner fills in the panel below (name, jurisdiction, hosting provider, contact for key verification). No agent picks or contacts trustees.
- **Development (P1-14, P1-20, P1-21).** The test ceremony uses seven simulated trustees with k = 4 by default, and simulations take k and n as parameters, including the brief's "two offline" run. Nothing simulated is ever registered on a mainnet contract.
- **Trustee node (new work).** A trustee node is a separate deployable (an app, or a mode of `apps/node`) that each trustee runs. It enforces the "one aggregate per disjoint partition over the anchored counted set" rule in code, checks the counted set against the L1 anchor before releasing any share, and exposes no API that decrypts a single ballot. A STATUS item for it is added once the owner decides.
- **Election definitions (P1-8, P1-18).** Each election definition binds its panel: trustee keys, k, n and the panel's identifier. The verifier reports which panel held the key and whether rule 3's seat took part.
- **Rotation.** Proactive resharing (changing the panel without a new key) is out of scope; a panel change means a new ceremony for future elections.
- **Known-weak:**
  - T-14: k colluding trustees can read every ballot of the elections their key covers. The rules raise the bar; they don't remove it.
  - T-54: if more than n − k trustees disappear after close, the tally of every open election is lost. There is no recovery by design.
  - T-69: a jurisdiction rule counts legal seats, not influence. A state can pressure a trustee abroad.
  - The rules can't be checked by contract or verifier; they are checked by the owner when the panel is chosen, and published so others can check them.

## Panel (owner to fill in)

| Seat | Trustee | Jurisdiction | Node hosting | Key verification contact |
| ---- | ------- | ------------ | ------------ | ------------------------ |
| 1    |         |              |              |                          |

## Default

Opened 2026-10-09 20:40 UTC. **This ADR is never adopted by default** (AGENTS.md): trustee selection waits for the owner. Development continues with the simulated test ceremony.
