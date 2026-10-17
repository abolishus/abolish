# ADR 0024: Tier 0 registration

- Status: Accepted (agent) — owner may veto (2026-10-12, rule A): option B, with option D as the direct path
- Date: 2026-10-12
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-01, T-06, T-10, T-11, T-13, T-16, T-18, T-20, T-25, T-46, T-49, T-52, T-67, T-69 (see [[THREAT_MODEL]])

## Context

[[contracts]], Group registry (P3-2 part 1, #104) adds a Tier 0 member only with EIP-712 approvals from `t` registrars, and leaves to a signing service, P3-2 part 4, the decision of which commitments to approve: "Duplicate commitments and the batch queue are the signing service's to manage." The brief gives these constraints and no design:

- "Tier 0: passkey (open polls)", and "Cloudflare in front of Railway, with Turnstile on Tier 0 actions."
- "Accounts and voting identity are strictly separate", and "The server never holds both an account and a ballot linkage. A test asserts no table or log can join them."
- "Gas sponsorship covers registration only; voters never transact to vote."
- "Direct-submit path: anyone can post their own registration or ballot commitment straight to the contracts if our servers refuse."
- Phase 2: "open polls end to end at Tier 0 with accounts".

Part 1's registry doesn't meet the direct-submit rule for Tier 0: every addition needs the registrars' signatures, so if our service refuses, a registrant has no other way in. No registry is deployed yet, so the contract can still change.

What a registration request carries, and what the signing service may know about who sent it, is the open question. It decides whether the operator can join an account to a voting identity's commitment, which is the public half of the identity: the commitment is on L2 for good with the time it joined its group (T-13), and since [[0019-regional-cells]] with the region the registrant declared. A Semaphore proof doesn't reveal which commitment made it, so the commitment alone links no ballot; but whoever later learns the secret behind a commitment (a stolen device, T-18; a compelled voter, T-46) can recompute every nullifier it made, and an account-to-commitment table turns that into a named voter. The same reasoning made [[0017-identity-recovery-backup]] keep the backup off the account (T-20).

What the cost of a Tier 0 identity is today: T-01 is **Not mitigated** by design. An account costs one passkey ceremony, which anyone can script with a software authenticator, and one Turnstile solve, which paid solving services sell cheaply (P2-5 part 2). Tier 0 results are labelled as not Sybil-resistant everywhere.

What is one-way: once commitments are registered under a rule that records who registered them, that record can't be taken back from a copy, a seizure or a log. A looser rule can be tightened later (new registrations only); a linked history can't be unlinked.

## Options

### A. One commitment per account

The ballot client sends the commitment with proof of an account session (a token `apps/web` mints for it, since the ballot client runs on another registrable domain and gets no account cookie, [[0020-entry-points]]). The signing service checks the session, refuses an account that already registered, and records that it did.

- Pros: one identity per account, so the Sybil cost of a Tier 0 identity is that of an account. Familiar, and the most literal reading of Phase 2's "at Tier 0 with accounts".
- Cons:
  - The service sees the account and the commitment in one request, and must keep at least a per-account flag to refuse a second registration. Even with no column joining them, the request, its timing against the group's batch on L2, and any log join them; one malicious or compelled deploy (A-2, A-1, T-69) records account → commitment for every registrant from then on. That is the linkage the brief's separation forbids, one step from T-20's.
  - It buys nothing against T-01: an account costs the same passkey ceremony and Turnstile solve as a registration under B. One-per-account only means a Sybil makes accounts first.
  - The voter needs an account to vote at Tier 0, which the brief doesn't ask for (accounts are for poll creation, moderation and notifications), and losing the account loses re-registration after a lost identity (T-18).
  - The ballot client must accept a credential minted by `apps/web`, the larger codebase with the account system and analytics (T-67), on its registration path.

### B. Anonymous registration through the ballot path, each paid for by a fresh Turnstile solve

1. **Request.** The ballot client sends the commitment, the group it asks for (its tier and region, [[0019-regional-cells]]) and a Turnstile token, on the ballot path: no account session, cookie or token, refused rather than ignored if present, as for every API route (T-10). The registration table and queue are on the board side of the no-join tests, with no account column and no address.
2. **Turnstile.** The token must be solved for a dedicated `tier0-register` action and is verified once, without `remoteip` (T-11). The ballot client ships no third-party code (AGENTS.md), so the widget runs on a separate challenge page: a static page on its own host, serving no account cookie and no analytics, which hands the token back to the ballot client (in a fragment or by `postMessage`, never a query string a gateway would see) and never sees the commitment. The page and the handoff are specified in P3-2 part 4b and built with P2-8. Turnstile was kept off the ballot path so far because ballot submission must work without our domain (T-25); registration through our service needs our domain anyway, and D is the path that doesn't.
3. **Refusals.** The service refuses a forbidden commitment ([[membership]], Commitments and removals), one already live in any group of the same tier ([[0019-regional-cells]]), and, by this ADR's own rule, one already queued, with answers that don't depend on which. Per-address rate limits sit at the edge (P2-11, [[railway]]).
4. **Batches.** Accepted commitments wait in a queue that keeps no arrival time. On a fixed schedule (a period of at most 10 minutes, fixed in the spec) the service takes every queued commitment for a group, shuffles them with a CSPRNG, signs one batch at the group's next position, and submits it through the registration paymaster (P3-2 part 4c). To anyone reading the chain, a batch's order and timing then say nothing finer than "registered in this period", among that period's registrations in that group, which at low volume or in a small regional group may be one (T-13); 4b weighs a minimum batch or a longer period when the queue is short. The queue keeps nothing once the batch lands.
5. **Answer.** The client learns the outcome by reading the group's records from the chain or an indexer copy it downloads in full, never by asking about its commitment (T-11), as [[0017-identity-recovery-backup]] already requires for recovery.

- Pros:
  - The service never holds an account and a commitment together, because a registration involves no account. The request carries only what the chain will show anyway, plus a spent Turnstile token and the sender's network address (Cons).
  - The Sybil cost is the same as A's: one Turnstile solve per identity, against one passkey ceremony and one solve per account. T-01 stays **Not mitigated**, and Tier 0 stays labelled so.
  - No account is needed to vote, and a voter who loses their identity and its backup registers a new one (T-18). The old commitment stays in the group; at Tier 0 that changes nothing T-01 doesn't already allow.
  - The ballot client trusts nothing from `apps/web`.
- Cons:
  - **Our proxy sees each registration whole.** Cloudflare terminates TLS in front of the API, so it sees the registration request's address, its token (and through it the solve's browser signals) and the commitment together, and keeps a rate-limit match as a security event with the address and time; Railway's HTTP logs may record the address too ([[railway]], T-11). Batching hides nothing from them. A malicious or compelled deploy of our own service (A-2, A-1, T-69) can likewise log the address with the commitment, and join it to an account by address through `apps/web`'s traffic, which passes the same proxy. So B removes the account from the registration, not the possibility of a join by address: that is T-11's residual, as for ballots, and an anonymity network (Tor) is its only mitigation, so the challenge page and the registration route must work over one. What B does guarantee is that no table, log or credential of ours joins them by design, and the no-join tests check that.
  - **Registration needs a third-party challenge.** If Cloudflare refuses a voter, or is unreachable, they can't register through our service. On its own, B leaves the brief's direct-submit rule unmet at Tier 0, since every addition needs the registrars' signatures (T-25). D closes that.
  - **Anyone can queue registrations** at the price of a solve (T-52). Each is a 32-byte commitment; the period's batch is bounded by the gas the paymaster will sponsor, and the spec fixes what happens to the excess (carried to the next period, never dropped silently).
  - **A one-period wait.** A commitment joins its group up to one period after it is accepted, so a voter who registers just before an election's root block may miss it.

### C. Account-gated anonymous tokens

The account (in `apps/web`) obtains a blind-issued token, one per account per period, from an issuer key we hold: a verifiable OPRF (RFC 9497) as in Privacy Pass issuance (RFC 9578). The ballot client blinds the token's input, `apps/web` relays it with the account's session, and the ballot client unblinds the answer and redeems it with its commitment on the ballot path. The issuer learns which accounts took a token, never which token was redeemed with which commitment.

- Pros: one identity per account per period with no account-to-commitment linkage, if the blinding is done by the ballot client and not by `apps/web`.
- Cons:
  - The same Sybil cost as A and B, since accounts cost one solve: the protocol buys nothing over B while accounts are free.
  - A new protocol, issuer key and cross-origin handoff between `apps/web` and the ballot client, with every piece inside the `crypto-review` gate, and a key whose compromise mints Tier 0 identities. The handoff's timing joins the issuing account to the redeeming request unless redemptions are delayed and batched too (T-11).
  - Voting at Tier 0 requires an account.

### D. A direct Tier 0 path paid with the registrant's own gas, beside B or A

The group registry gains a second way to add a Tier 0 member: anyone may call it with their own commitment and pay the gas themselves, with no registrars' signatures, the forbidden-commitment refusal and an event record marked as self-paid. A self-paid addition must never make a signed batch revert, since a dead batch must be re-signed at a later position ([[contracts]], Group registry), and anyone could then stall Tier 0 registration for the price of one cheap transaction per period. There are two ways it could:

- **The position.** A signed batch binds its group's member count (`first_index`). A self-paid addition to the same group would move that count, killing every batch in flight. So self-paid additions go only into **self-paid groups**, created as such (per tier and region, like any group) and never signed against; a signed group never takes one. A definition lists self-paid groups in its regions like any other group.
- **Duplicates.** A contract-level check refusing a commitment already live in the tier would let anyone self-add a commitment from a signed batch first. So the contract checks no duplicates across the two kinds of group, and duplicates are left to the verifier (or to a commitment-to-live-index mapping, whose gas and removal cost part 5 weighs, provided it never refuses a signed batch).

The verifier's rule for duplicates must change with D. Today [[membership]]'s first-occurrence rule (Cell tree) keeps a repeated commitment's occurrence in the lowest `group_id` and zeroes the rest, so a repeat placed in a lower-numbered group of another region moves a voter to a cell they didn't register in ([[0019-regional-cells]], Consequences), which only registrars breaking the no-repeat rule can do (T-06). With D, anyone with gas could copy any registrant's public commitment into a lower-numbered self-paid group and do the same (T-16). So part 5 changes the walk: every signed group's occurrence wins over every self-paid group's, and among self-paid groups the occurrence added first in chain order (block, transaction and log index) wins, whatever the `group_id`. A self-paid copy made after the registration it copies then loses. Three residuals remain, stated in part 5, and the client checks where its commitment landed:

- a self-paid copy that lands before a self-paid registration (front-running its transaction) puts that registrant in the copier's cell;
- a signed copy always wins, even one landing later, so the registrars or a compromised signing service (T-06, T-69) can move any self-paid registrant, the very voters D exists for, into another cell, as they can already move signed registrants. An honest service never signs one: it checks self-paid groups against the latest chain state, unfinalized included, when a request arrives and again just before signing (4b, 4d), so a Turnstile solve can't buy a signed copy through a lagging view. Ranking both kinds of group by chain order instead was rejected, since a cheap self-paid copy front-running a signed batch's transaction would then displace signed registrants, who are most voters. Gas is then the Sybil cost, and it is below a Turnstile solve: a self-paid addition checks no signatures, and one transaction can make many.
- a party that sees a B request before its batch is signed (Cloudflare, which terminates TLS; Railway's logs; a malicious or compelled deploy, T-11, T-69) can self-add the queued commitment, for the price of gas, into a self-paid group of a region it chooses while the request waits up to one period. The honest service's check before signing then finds the copy and drops the commitment from the batch, so the registrant's only occurrence is in the copier's cell. The client detects it by checking where its commitment landed, and can register again only with a new commitment. Part 4d decides whether the service still signs a commitment whose self-paid copy appeared after it accepted the request, which would put the registrant back in its own cell at the cost of the arrival-time state the queue otherwise doesn't keep.

- Pros: meets the brief's direct-submit rule at Tier 0: if our service or Cloudflare refuses, a registrant still gets in. It needs no server, so it works with our domain gone (T-25, T-49).
- Cons: until part 5 changes the first-occurrence rule (above), anyone, not only the registrars, could move a voter between regional cells by copying their commitment (T-16, T-06); D waits for that rule. The address that pays the gas is on L2 next to the commitment, and funding it can link the registrant (T-11, T-25's existing residual for direct-submitted ballots; voters are told so). Its additions carry no approvals, so verifier 2.4 counts them under a rule of their own. A Sybil adds identities more cheaply than through B, with no challenge, which at Tier 0 changes nothing T-01 doesn't already allow.

D isn't an alternative to B or A but a fallback beside either; its contract and verifier rules need a design of their own before any registry is deployed.

## Recommendation

**Option B, with D as the direct path.** While an account costs one Turnstile solve, A and C charge a Sybil exactly what B charges, so the only difference between them is what the operator can learn: A records account → commitment for everyone, C adds a protocol and an issuer key to avoid it, and B never sees an account at all. B meets the brief's "Turnstile on Tier 0 actions" literally, and its separation of accounts from voting identity by design. D meets the direct-submit rule, which none of A, B or C does alone.

This reads two lines of the brief in a way the owner may not. "Tier 0: passkey" is read as the kind of credential that makes a Tier 0 identity free, not as a requirement: under B a registration needs no passkey (the voter's passkey is the recovery backup's, [[0017-identity-recovery-backup]], which voters without PRF support don't get). B could meet the line as written by requiring a user-verified passkey on the ballot client's RP ID at registration, with no account and no linkage; that is left out because it adds no Sybil cost (software authenticators are free) and turns away voters whose platform can't make one, and the owner may ask for it. Phase 2's "at Tier 0 with accounts" is read as accounts for creating polls, not as eligibility to vote. If the owner reads either line as "a Tier 0 voter has an account", C replaces B (never A), with D beside it.

What would change it: accounts becoming costly in a way a solve isn't (then C keeps that cost without A's linkage); the owner's reading above; or Cloudflare's view of solvers being judged worse than the account linkage (then a proof-of-work challenge inside the ballot client, at a much lower Sybil cost, or C).

## Consequences

- P3-2 part 4 continues in parts on `claude/p3-2`:
  1. 4a: this ADR.
  2. 4b: the registration spec (the request, the refusals and their answers, the period, shuffling, a minimum batch, the excess rule, the queue's retention) and the challenge page's handoff to the ballot client (how the client keeps its state across it: a frame needs the challenge host in the client's CSP, a navigation needs the identity kept across it); [[contracts]]' Known-weak, which still says Tier 0 registration is "a passkey account behind Turnstile", is corrected; `packages/crypto` gains nothing, since the batch format and approvals are part 1's.
  3. 4c: our own registration paymaster (ERC-4337, [[0004-l2-choice]]), sponsoring only the registry's `addMembers` from the signing service.
  4. 4d: the signing service: the ballot-path route in `packages/api-contract` and `apps/api` with the `tier0-register` Turnstile action in `packages/core` (whose rationale comment, "never on the ballot path", is updated to the reason above, and whose `hostname` check gains the challenge page's host), the queue in `apps/worker` on the board side of the T-10 tests, the scheduled batch job, and tests that a request with an account credential is refused, that no log line or Redis key holds an address, a token or an arrival time, and that a batch's order is independent of arrival order. BullMQ's events stream keeps job IDs and times until trimmed; job IDs must not derive from the commitment.
  5. Part 5: D, the self-paid Tier 0 addition in self-paid groups, its rule in verifier 2.4, and the changed first-occurrence rule in [[membership]], before any registry is deployed.
- `TurnstileAction` gains `tier0-register`; the ballot client's bundle policy is unchanged, since the widget never runs in it.
- T-01 stays **Not mitigated**; its history records that a Tier 0 identity costs one solve and needs no account. T-10 gains the registration path as a ballot-path route. T-11 records that our proxy and hosting see each registration request whole. T-13 gains the period as the finest registration time on L2. T-25 records that Tier 0 has no direct path until part 5. T-52 records the queue's flooding bound.
- The removal path (part 1's `removeMembers`) is used by nothing yet: a voter can't ask to remove a commitment without proving they hold it, which needs a design of its own (T-18's revocation, [[P2-6]]'s follow-up).

## Decision

Under rule A (`AGENTS.md`): option B, with D as the direct path, status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. A veto in favour of C, or of A, is taken before part 4d builds the route; nothing is registered meanwhile, since no group registry is deployed until Tier 1 and Tier 2 additions, and D, exist.

## Amendment 1 (2026-10-17, P3-2 part 5a)

[[contracts]] (Group registry, Self-paid additions) specifies option D's call and settles the three questions this ADR left to part 5. Each is `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].

**The record.** Options weighed:

- **A. A batch with a signed-style position**, `group_id ‖ first_index ‖ count ‖ commitments`, like `addMembers` without approvals. Rejected: with no signature to bind the position, anyone can land one addition to the group first and kill every pending one, at the price of gas (T-25).
- **B. A batch with no position.** Cheaper per member for bulk additions, which only a Sybil makes; a registrant adds one commitment.
- **C. One commitment, no position** (chosen): `group_id ‖ commitment`, exactly 40 bytes. The registry assigns the index and logs it as a topic, and the verifier replays the indices against its own count, so no addition reverts because another landed first.

**Duplicates.** Options weighed:

- **A. A commitment-to-index map refusing a held commitment.** Rejected: refusing signed batches over it would let anyone kill a batch in flight by self-adding one of its commitments (T-25), refusing only self-paid additions would still need every signed commitment written (about 22,000 gas each, 5.6 million for a full batch), and a copier who lands first keeps the place either way.
- **B. No contract check; the verifier ranks occurrences** (chosen): [[membership]]'s first-occurrence rule walks signed groups by `group_id`, then self-paid groups' additions in chain order, as option D above requires.

**Removals.** Options weighed:

- **A. Registrar-signed removals in self-paid groups.** Rejected: the registrars could remove every self-paid member, undoing the path that exists so joining Tier 0 doesn't rest on them (T-25, T-06).
- **B. No self-paid removals, and removed signed occurrences keep their precedence**, so a removal keeps its commitment out of the tier. Rejected: the registrars could then shut any self-paid registrant out of the tier by signing a copy of their commitment and removing it, which is exclusion rather than the move a signed copy already allows.
- **C. No self-paid removals, and removed leaves are 0 before the walk** (chosen): a self-paid group can't be shrunk by anyone, and a commitment removed from a signed group can be self-added again and counts.

What C costs: no Tier 0 removal revokes a commitment in a tier that lists a self-paid group, so a lost or stolen Tier 0 secret stays usable by whoever holds it (T-18, T-69), as at Tier 1 ([[0014-tier1-vouching]], Amendment 2). Revocation at Tier 0 needs a proof by the secret's holder, which neither removal path gives; it waits on T-18's design.
