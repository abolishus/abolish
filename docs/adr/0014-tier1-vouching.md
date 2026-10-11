# ADR 0014: Tier 1 vouching

- Status: Accepted (agent) — owner may veto (2026-10-11, rule A): option C
- Date: 2026-10-11
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-02, T-06, T-22, T-13, T-10, T-12, T-15, T-17, T-25, T-27 (see [[THREAT_MODEL]])

## Context

The brief's Tier 1 is "vouched/web-of-trust", between Tier 0 (a passkey, no Sybil resistance, T-01) and Tier 2 (a government-signed document, [[0010-tier2-identity-provider]]). Results are reported per tier, so Tier 1 needs a rule a reader can state in one line, and a verifier can check, for who is in it.

Today nothing defines that rule. [[verifier]] 2.4 counts a Tier 1 addition when our Safe's owners sign it (EIP-712, [[0004-l2-choice]]), so the operator can add any number of Tier 1 members with no external check (T-06, listed as not mitigated). Two threats wait on this item: T-02 (colluding vouchers vouch for fake people) and T-22 (the vouching graph is sensitive personal data).

What a Tier 1 scheme has to do:

1. **Bound Sybils** by a rule stated in advance, so a reader knows what "Tier 1" means and how far collusion can stretch it (T-02).
2. **Be checkable** from the board alone, so the operator can't add members the rule doesn't allow (T-06, G-9).
3. **Keep the social graph private:** who vouched for whom must not be public, and the server must not learn it either (T-22, G-4). Vouching for someone reveals that the two know each other, and a Tier 1 graph published permanently would be a map of real relationships attached to voting identities.
4. **No PII and no wealth gate:** no names, contacts or deposits (T-17, G-12, T-27).
5. **Survive our servers refusing,** like every other registration (T-25).

What is one-way: every Tier 1 member is admitted under one rule, and the rule's records become part of the permanent board. Changing it later means either re-admitting every Tier 1 member, or letting two rules admit into one group, which would let one person be admitted twice (once under each) and would make the tier's label mean two things.

## Options

Prior art, read from each project's public documentation (not re-checked in this session; part 2 re-checks anything it relies on): Duniter's Ğ1 web of trust (https://duniter.org), in which members certify each other publicly with signatures, with a minimum number of certifications, a per-member certification stock, an expiry and a maximum distance to well-connected members; BrightID (https://brightid.org), whose nodes hold a social graph and score it for Sybil clusters; and Proof of Humanity (https://proofofhumanity.id), where a registered human vouches for a new one, backed by a deposit and a public challenge period.

### A. Operator-held vouching

Tier 1 members vouch for new people in our app, signed in with their accounts. The server keeps the vouch graph, applies the rules (a number of vouches, per-member limits, graph analysis as in BrightID), and our Safe signs the addition as [[verifier]] 2.4 already allows.

- **Pros:** simple and quick to build. The graph can be analysed, and a voucher whose vouchees turn out to be fake can be cut off along with them, so vouchers are accountable.
- **Cons:**
  - The rule is unverifiable: the verifier sees only the Safe's signature, so Tier 1 stuffing stays exactly as unchecked as it is today (T-06).
  - The operator holds the whole social graph, keyed by account. That graph is what T-22 says not to store. It can be seized or compelled (T-69), and with network data or the recovery backup it links accounts to Tier 1 membership (T-10, T-20).
  - Any graph analysis is only as good as an operator nobody can audit.

### B. Public signed web of trust

Each member holds a vouching key and signs certifications that go on the board, as in Duniter. The verifier recomputes membership from the public graph.

- **Pros:** fully checkable (T-06), accountable, and well studied.
- **Cons:**
  - It publishes the social graph permanently, on the board and in the archive. Each certification links two identities, and anyone who knows a few people's relationships can deanonymise much of the graph. That fails requirement 3 outright (T-22, G-4).
  - The vouching key, or a certification, also links a member's identity commitment to a public key that signs other records (T-12, T-13).

### C. Anonymous vouching by Tier 2 members, checked from the board

A vouch is a pair of Semaphore proofs from a member of the Tier 2 group (document-verified, [[0010-tier2-identity-provider]]), using Semaphore v4's circuit and keys unchanged ([[0009-membership-proof]]). A Tier 1 addition counts only if it carries vouches from at least `k` distinct Tier 2 members, each of whom has a lifetime budget of `L` vouches. The verifier checks all of it from the board.

- **Distinct vouchers.** One proof has a scope per vouchee: `S_V = H(DS("abolish/v1/vouch", binding ‖ C_V))`, where `C_V` is the commitment being added and `binding` is the Tier 1 group identifier, the chain ID and the registry address, the binding [[verifier]] 2.4 already uses for additions. Its nullifier `Poseidon2(F(S_V), s)` is one value per voucher and vouchee. `k` distinct nullifiers mean `k` distinct Tier 2 secrets, by Semaphore's soundness ([[membership]], Security notes).
- **Budget.** The other proof has a scope per slot: `S_j = H(DS("abolish/v1/vouch-slot", binding ‖ u16(j)))` for `j < L`. Its nullifier is one value per voucher and slot, so each Tier 2 member has `L` slots in the Tier 1 group, ever. A slot nullifier counts in at most one counted vouch.
- **Cross-binding.** Each proof's message binds `C_V` and the other proof's nullifier. Both nullifiers are known before proving, since each depends only on the secret and a public scope. So a relay or operator can't pair someone's slot proof with another proof, or move either one to another vouchee. Groth16 proofs can be re-randomised, but only for the same public inputs, so a copy is the same vouch and counts once ([[membership]], Malleability).
- **What is public.** The vouchee's commitment (as for every addition), and `k` or more pairs of nullifiers, each unrelated to the voucher's other vouches, to their votes and to their Tier 2 commitment. Nobody, including us, learns who vouched (T-22).

**Pros:**

- The rule is checkable (T-06) and its Sybil bound is a number: a ring of `c ≥ k` colluding Tier 2 members can admit at most `c·L/k` Tier 1 identities, ever.
- The graph never exists in any record (T-22).
- It reuses the membership machinery a ballot already needs: no new circuit or trusted setup, perfectly zero-knowledge proofs ([[0009-membership-proof]]), and the same verification code (P1-17b).
- No account, deposit or contact detail is involved (T-10, T-27).

**Cons:**

- **Tier 1 rests on Tier 2.** Only Tier 2 members can vouch, so Tier 1 can't admit real people before Tier 2 can: that waits on the owner's questions in [[0010-tier2-identity-provider]]. It is a web of trust one step deep, not a transitive one.
- **No accountability.** Vouchers are anonymous, so a voucher who vouches for fakes can't be identified, cut off, or have their other vouches undone. The budget is the only limit.
- **Vouchers can't see double registration.** A person with two disjoint groups of `k` vouchers gets two Tier 1 identities. Each honest voucher sees one real person and can't check whether that person already has a Tier 1 identity.
- **Cost.** Each vouch is two Groth16 proofs, so an addition carries `2k` proofs. That is about 1.5 KB at `k = 3`, plus on-chain verification if P3-2 adds it.

**Transitive variant (C′).** Letting Tier 1 members vouch too would make Tier 1 a true web of trust, and it could start before Tier 2. But Sybils it admits could then vouch for more Sybils. With per-member budgets, each generation multiplies the fake identities by `L/k`. That is unbounded over time if `L > k`, and if `L ≤ k` honest growth is capped at a small multiple of the seed set, with the seeds chosen by the operator (T-06). Depth-limited schemes (Duniter's distance rule) need a public graph or one group per depth. C′ is rejected for this version.

## Recommendation

**C, anonymous vouching by Tier 2 members**, with `k = 3` and `L = 12`.

It is the only option that meets requirement 3 and requirement 2 together. A fails requirement 2 and stores what T-22 says not to store. B fails requirement 3.

It also gives Tier 1 a meaning a voter can read: "vouched for by three document-verified people". The cost is that Tier 1 needs Tier 2.

The numbers:

- **`k = 3`** needs a ring of three document holders before any fake identity is admitted. It also caps what one person with a single document can do: they hold one of the three distinct nullifiers a vouchee needs.
- **`L = 12`** lets each Tier 2 member vouch for up to 12 people. That makes Tier 1 at most `12/3 = 4` times the size of Tier 2. About half of US citizens hold a passport (unconfirmed for 2026, see [[0010-tier2-identity-provider]]), so 4× leaves room for every citizen without one. It also bounds collusion at 4 fake identities per colluding document.

Both are constants of the Tier 1 group, fixed for the deployment. Changing either needs a new Tier 1 group with full re-admission, never a second rule alongside the first, so a budget can't be spent twice.

What would change it:

- the owner ruling Tier 2 out for real documents for good (see Consequences);
- a published, analysable scheme for private, depth-limited transitive vouching;
- evidence that 4× is too small, or that real vouching rings are larger than the bound assumes.

## Consequences

### Rules for P3-3 part 2 (spec and `packages/crypto`)

These are part of the decision. Part 2 writes them into a new [[membership]] section (or its own spec page), [[verifier]] 2.4, [[domain-separation]] (the two tags and the message tag), [[parameters]] (`k`, `L` and the root window) and [[versioning]] (the vouch record). It does so with cross-language vectors and the in-session `crypto-review`.

- **Authorisation.** A Tier 1 addition counts only if it carries at least `k` valid vouches for its own commitment, with `k` distinct per-vouchee nullifiers. Each vouch has both proofs, both of them valid under the pinned depth-32 key, its slot nullifier not used by any earlier counted vouch in the group, `j < L`, and both scopes recomputed by the verifier from the group's binding, never taken from the record. This replaces the Safe's signature for Tier 1 in [[verifier]] 2.4. Tier 0 keeps the Safe.
- **No authorisation by transaction.** The vouches travel with the addition, and the verifier attributes the addition by what they bind, as it does for Tier 2 ([[verifier]] 2.4; T-21, T-71).
- **Order.** "Earlier" is the group's addition order. Only the voucher's own secret can produce a slot nullifier, so reordering can only choose which of one voucher's own double-spent vouches counts, never cancel an honest vouch.
- **Tier 2 root.** Each proof names a Tier 2 group root by its L2 block. The verifier recomputes that tier tree ([[membership]], Tier tree) and requires the block to be at or before the addition's block and within a window `W` of it, so a removed Tier 2 member stops vouching after `W`. Clients prove against the root at the latest anchored period boundary, never a root that is current only briefly, such as one taken just after a registration (T-13).
- **Forbidden commitments.** A vouch for a forbidden commitment ([[membership]], Commitments and removals) counts for nothing. The client refuses to make one.
- **Slots are chosen at random.** The client picks an unused `j` uniformly from `[0, L)` rather than counting up, so `j` doesn't reveal how many vouches its voucher has made. The client has to remember which slots it used: a lost record costs a slot, never a double count.
- **Scopes stay separate.** The vouch tags are distinct from `abolish/v1/nullifier-scope`, so vouch nullifiers are unrelated to vote nullifiers for the same secret ([[membership]], Chosen-scope linkage).
- **One Tier 1 group per deployment.** A second Tier 1 group, a regional one say, would give every voucher another `L` slots. So any regional split of Tier 1 comes from a proven predicate under the same slots, specified later.

### Rules for P3-2 (groups), P2-6 and P2-8 (clients) and P2-3 (API)

- **Device to device.** The vouchee shows their commitment to each voucher in person or over a channel they choose (a QR code), and the voucher's device proves and submits. No account, contact list or phone number is involved, and no server sees who is standing next to whom (T-22, T-10).
- **No account on submission.** Vouches and the addition are submitted without an account, like ballots, through the API or straight to the contract (T-25, T-10).
- **Contract checks are spam control.** The Tier 1 group contract may check the vouches on chain (P3-2), but only as spam control. The verifier's recomputation from the board is the authority.
- **Fresh commitment for Tier 1.** A person who is also in Tier 2 should register a Tier 1 commitment distinct from their Tier 2 one (P2-6). Otherwise the same commitment, public in both groups, links their two memberships (T-13).
- **Removals.** Who may remove a Tier 1 member is P3-2's. A removal never refunds its vouchers' slots.

### What becomes harder, and what is now known-weak

- **Tier 1 waits for Tier 2.** No real person is admitted to Tier 1 before real documents are admitted to Tier 2 ([[0010-tier2-identity-provider]], Before any real document). The reference election (P1-20) uses mock Tier 2 members, with the stubs clearly marked. If Tier 2 used the trustee-attested fallback, Tier 1's bound would rest on the attesters too.
- **T-02** (now stated, not removed):
  - a colluding ring of `c ≥ 3` document holders admits at most `4c` fake identities;
  - one person with two disjoint groups of three vouchers gets two identities;
  - vouchers can't be held to account;
  - every Tier 2 residual (cloned chips, an issuing state minting documents, T-03) carries over, multiplied by up to 4.
- **T-06 for Tier 1** becomes checkable: the operator can no longer add a Tier 1 member without `k` real vouches. It can still refuse to post them, but direct submit covers that (T-25).
- **T-22:** no record of the graph exists. What remains:
  - **Timing:** `k` vouches arriving with an addition show that their vouchers acted around then.
  - **The network** (T-11): a server or relay that sees a voucher's IP address next to a vouch learns that this address vouched, though not for whom beyond the public commitment. Voters who need more submit directly through an anonymity network.
- **T-15:** vouch proofs are perfectly zero-knowledge. Linking vouch nullifiers to each other or to a commitment needs a Poseidon preimage, so the graph's privacy is computational, like the privacy of participation ([[membership]], Nullifier privacy).
- **T-46:** a Tier 1 identity can be sold like any other voting identity.

### Follow-ups

- **P3-3 part 2:** the spec and `packages/crypto` (scopes, messages, the vouch record, the counting rule) with vectors. It needs P1-17b's Groth16 verification, which waits on the owner's confirmation listed under [[0009-membership-proof]] in [[STATUS]].
- **P3-3 part 3:** the vouching flow in the ballot client (P2-8), and the Tier 1 group contract's addition path (P3-2, P1-18).
- **P3-6:** label Tier 1 results "vouched for by three document-verified people", with the group size, and state its bound where results are shown.
- **Threat files:** T-02, T-06 and T-22 name this decision.

## Decision

Under rule A (`AGENTS.md`): **option C**, anonymous vouching by Tier 2 members, with `k = 3` and `L = 12`, on the conditions above. Its status is `Accepted (agent) — owner may veto`, and it is listed under Decisions to review in [[STATUS]].

No owner-only question is raised. Tier 1 for real people waits on the owner's existing Tier 2 questions, and nothing else does.
