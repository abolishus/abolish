# ADR 0042: Who sends a share posting and pays its gas

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-22
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-11, T-13, T-25, T-52, T-17, T-15, T-18, T-54, T-69 (see [[THREAT_MODEL]])

## Context

When no route receipts a seat, the voter may choose to post that seat's `ct_i` and `m_i` publicly ([[delivery]], Client rule 4). A posting delivers only through the contract path: `submitPosting(bytes posting, bytes ballot)` on the board ([[contracts]], Board, Calls), about 434,000 to 544,000 gas with its ballot's check and membership proof, and 1.5 to 5.4 KB of posting beside the ballot record ([[contracts]], Board, Gas). The ballot client already offers a posting and checks the shares before it ([[P2-8]] part 3c-1b-2b-2b-2d-2b-1, #578), but no build can make one: `ElectionSource.post` is absent, so the offer is only to try again or leave the ballot.

Someone has to send that L2 transaction and pay for it, and the brief constrains who:

- "Gas sponsorship covers registration only; voters never transact to vote" ([[PROJECT_BRIEF]], Chain). [[0004-l2-choice]] reads the one exception: a voter may transact when they choose to submit directly because our servers refuse (T-25).
- "Direct-submit path: anyone can post their own registration or ballot commitment straight to the contracts if our servers refuse."
- The server never holds both an account and a ballot linkage.

And the spec constrains how ([[delivery]], Direct submit): a contract-path record names its ballot hash, and its ballot record carries the tier and nullifier, so the address that pays is publicly linked to the ballot and, through the nullifier, to the voter's re-votes; the client MUST pay from a fresh, privately funded address or through a relay that can't link it to the voter (T-11, T-13). A posting must also be sent by `c_D = t_D − F`, so that forced through L1 its submission time is at or before `t_D` (Windows).

What is one-way about it: the payer's address is on the permanent archive beside every posting it sends (T-17), so a scheme that puts a per-voter address there can't be taken back; and the client's `post` and its `recorded` judgement are built around whoever answers it.

## Options

### A. The operator's posting relay, paying from its own account

The client sends the posting record and its ballot record to an unauthenticated route of the API, no cookies or credentials, as it sends a ballot. The relay checks them and submits `submitPosting` from the **posting key**, an externally owned account used for nothing else, which pays its own gas, as the creation key does for poll creation ([[0032-poll-creation-operations]], The creator and who pays) and the API's account does for Tier 1 additions ([[0014-tier1-vouching]], Who pays). The client never trusts the relay's answer: it judges `recorded` itself, from the board's `SharePosted` events read through its own L2 endpoint at the finalized head, so a relay that lies or drops a posting can only make the client fall back, never make it send an undelivered ballot.

Pros: voters never transact, and need no funds, wallet or chain knowledge, so the posting is usable by everyone the offer reaches. It isn't gas sponsorship of a voter's transaction: the voter signs nothing on-chain and has no address; the operator transacts for itself, as it already does to create polls. Every posting the relay sends has the same payer, so the chain links the posting key to nothing but the postings it sent, which are public anyway (T-13). The relay learns the voter's network address beside the ballot, which the ballot route already sees when the same client sends that ballot, and no account (T-11, the account/ballot separation). Its cost is bounded by checks before it pays (Decision, rules 3 and 4).

Cons: the operator can refuse or delay a posting (T-25, T-69), so this can't be the only route. The relay holds `m_i` before the chain does: one that runs the public check and then never sends has read that seat's share, which the voter had agreed to make public, but which now stays readable by the operator alone if the voter declines and re-votes (T-15). It costs the operator gas for every posting, which a member who makes up ballots can spend (T-52).

### B. The voter's own fresh, privately funded address

The client asks the voter's wallet (EIP-1193, the browser's provider; no third-party code in `apps/ballot`) to send `submitPosting`, as the direct-submit docs tell a voter to submit a ballot ([[0004-l2-choice]], Consequences).

Pros: no operator in the path at all; the brief's direct-submit path in its plainest form (T-25).

Cons: it makes the voter transact to vote, which the brief allows only as the voter's own choice when our servers refuse. Almost no voter holds a funded address that isn't linked to them: one funded from a KYC'd exchange links the voter to the ballot and their re-votes forever (T-13, T-17). As the only route it would leave posting to the few who can do it safely.

### C. A trustee node relays it

A trustee seat's node, which already sends receipts through the contract path, sends a voter's posting for another seat and pays for it.

Pros: the operator is out of the path; nodes already hold L2 accounts and pay for contract-path records.

Cons: a node has no inbound port, by design ([[0032-poll-creation-operations]], Decision, rule 5; T-14), so it can't take a request from a client; during the transitional panel every seat is ours, so it adds no independence from the operator ([[0027-trustee-panels-and-live-results]]); and it adds a payer whose gas no capacity check sizes ([[delivery]], Capacity; T-54).

## Recommendation

**A, with B as the voter's own fallback.** A is the only option that lets every voter who needs a posting make one without transacting, and its weakness is refusal, which the client detects (it judges `recorded` itself) and which B answers: when the relay refuses or doesn't record a posting in time, the client may offer the voter's own wallet, with the warning [[0004-l2-choice]] requires, because that is the brief's direct-submit path, chosen by the voter when our servers refuse. C waits until independent trustees exist and a node can take requests without an inbound port.

What would change it: a privacy-preserving relay network anyone runs (a client could then send through one we don't control), or the brief's sponsorship rule changing, which is the owner's.

## Consequences

- **[[P2-8]] part 3c-1b-2b-2b-2d-2b-2 splits**: 2a is this ADR; 2b, the posting relay (the API's route and the worker that holds the posting key); 2c, the client's `post` through it, with `recorded` judged from the board's events at the L2's finalized head and one lock per election from the check through the posting, taken by delivery too (part 2b-1's Known-weak, two tabs); 2d, the voter's own wallet (option B) once the relay refuses.
- **A new key to keep.** The posting key gets the creation key's custody rules: only in a dedicated worker deployment, a float of a few days' postings topped up by hand, and on mainnet only once the owner funds it (real funds, owner-only). Its runbook comes with part 2b.
- **The operator learns `m_i` before the chain.** A relay that checks a posting and never sends it has read that seat's share (T-15). The client treats a relay that doesn't record as having seen it, and says so when it offers the fallback; a voter who then declines still has every other seat private, and fewer than `k` seats read nothing ([[tally]], Residuals).
- **Re-votes beyond the cap go direct.** A voter who needed postings for more ballots of one nullifier than rule 4 allows can still post through their own wallet (option B).
- **Known-weak until part 2d:** the relay is the only route a build has, so an operator that refuses postings leaves the voter to try again or leave the ballot, as today (T-25).

## Decision

Under rule A (`AGENTS.md`): option A, with option B as the voter's fallback, `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]]. The rules:

1. **The route.** `POST` to one path of the API, a JSON body of the posting record and its ballot record as hex, nothing else, at most what the largest ballot record a definition allows and the largest posting take as hex (about 108 KB for their 54 KB); no cookie, credential or account is read, and CORS allows the ballot client's origins with no credentials, as the ballot route does. Nothing about the request is logged beyond the election and an outcome code: never the record, `m`, the ballot hash or the network address (T-11, T-18).
2. **The answer is a hint.** The relay answers `sent` (with the transaction hash), `refused` with a code, or `busy`. The client never stands down on it: a posting is `recorded` only once the client finds its exact bytes in a `SharePosted` event of the board, read with the posting's `definition_hash` and `ballot_hash` as topics at the L2's finalized head, through the L2 endpoint the build already uses. Only then is the ballot sent ([[delivery]], Client rule 4).
3. **What the relay checks before it pays** (T-52, T-17), in order, refusing on the first failure:
   1. the posting decodes strictly as a share posting of its definition's version, and the ballot as a ballot record (`packages/crypto`);
   2. the election is registered in the deployment's election registry, and it is before `c_D` by the L2's finalized time;
   3. the posting passes the public check (`checkPosting` and its version-4 counterpart, `packages/crypto`), so the relay pays only for postings that deliver;
   4. a simulated `submitPosting` at the latest block succeeds, so the board's own checks (the ballot's membership proof, the posting's hash against the ballot's `share_hashes`, its length) pass before any gas is spent.
4. **Caps.** A posting whose bytes the relay already sent is answered `sent` with the same transaction, never paid twice (the board treats it as a no-op anyway). Per election and (`tier`, `ν`), the relay sends postings for at most two ballot hashes, the number of ballots per (`tier`, `ν`) delivery can select from or a node owes for ([[delivery]], What a node owes), and per election at most a gas budget set in the worker's configuration; past either it answers `refused`, and the client falls back to option B. The API's ordinary per-address rate limit applies too.
5. **Sending.** The worker sends from the posting key at once. If the transaction isn't in an L2 block within a worker setting (10 minutes to start), it is forced through L1 by a deposit to the portal, paid by the posting key on L1, while the deposit can still reach L2 by `c_D` ([[delivery]], Windows; [[0004-l2-choice]], Forced inclusion); past that the relay answers `refused`. A posting is only relayed, never stored beyond what the worker needs to send it, and its queue entry is dropped once sent or refused (T-18).
6. **The fallback (part 2d).** When the relay refuses or doesn't record a posting before the client's own deadline, the client may offer the voter's own wallet, saying that the address that pays is published beside the ballot and their re-votes, and that it should be a fresh one funded privately (T-13). It is never the default and never offered while the relay may still record.
