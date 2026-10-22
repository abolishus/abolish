# ADR 0039: Tier 0 token issuance: RFC 9497's POPRF over ristretto255

- Status: Accepted (agent) — owner may veto
- Date: 2026-10-22
- Deciders: agent, owner may veto (rule A)
- Threats addressed: T-74, T-10, T-11, T-01, T-16, T-13 (see [[THREAT_MODEL]])

## Context

The owner decided on 2026-10-21 that voting at Tier 0 needs an account, and that an account registers at most one Tier 0 voting identity per group through a blind-issued token, so the issuer learns which accounts took a token and never which commitment redeemed it ([[0024-tier0-registration]], Owner decision, option C). The decision names "VOPRF, RFC 9497, as in Privacy Pass, RFC 9578" and leaves the rest to [[P2-30]]: the group and the mode, how a token is bound to its group, how the client knows the issuer's key, and what a token is bound to at redemption.

What is one-way: a token's group, mode and input layout are frozen once the ballot client of a signed release takes tokens under them, since a later change strands every token issued and must be carried by every client. Choosing a group and a proof system is a red flag that needs an ADR (the `crypto-review` skill).

Two requirements decide most of it:

- **One token per account, for one group.** The owner's line says one identity per account per group. Tier 0 has one published group per region, and a tier's electorate is the union of its regional groups ([[0019-regional-cells]]), so one identity per group would give an account a vote per region in any poll that spans regions. This ADR reads the owner's intent (one person can't vote again from another device) as one token per account, for the group of its region, which is the same rule while only region 0 is served. The issuer must know which group a token is for, or one account's token registers in every group. In plain OPRF or VOPRF mode the input is hidden from the issuer, so a group written into it binds nothing the issuer can check.
- **The same key for everyone.** If the issuer can answer one account under a key of its own, that account's token is recognisable at redemption, and with it the commitment registered (T-10). Verifiability helps only if the client checks the proof against a key it got from somewhere every client sees.

## Options

### A. Privacy Pass's privately verifiable token, unchanged (RFC 9578 type `0x0001`)

VOPRF mode over P-384 with SHA-384, the token `token_type ‖ nonce ‖ challenge_digest ‖ token_key_id ‖ authenticator`, one key per group per period so the issuer knows the group from the key.

- Pros: an existing standard token type, with interoperable implementations (Cloudflare's, Apple's).
- Cons:
  - P-384 is a second group in the ballot client and in `packages/crypto`, beside ristretto255 ([[group]]), with its own vectors and review; nothing else in the protocol uses it.
  - A key per group per period multiplies the keys the deployment record must publish by the number of regions ([[0019-regional-cells]]), and each key is an anonymity set of its own.
  - The interoperability is unused: Abolish's tokens are issued and redeemed by Abolish only, and bound to its groups, so no other issuer or origin reads them. RFC 9578's challenge and origin binding have no counterpart here.

### B. RFC 9497 VOPRF mode over ristretto255-SHA512, one key per group and period

The issuer derives a key per group from one secret (`DeriveKeyPair(seed, info = group)`) and publishes every public key; the client verifies against its group's key.

- Pros: the owner's literal "VOPRF"; the mode's security rests on the one-more Gap Diffie–Hellman assumption, the weakest of RFC 9497's.
- Cons: the same multiplication of published keys and anonymity sets as A, and key consistency must be checked per group.

### C. RFC 9497 POPRF mode over ristretto255-SHA512, the group as public `info`, one key per period

POPRF is RFC 9497's verifiable, partially oblivious mode: the input is hidden and a public `info` string, which both sides know, tweaks the key (`skS + HashToScalar(info)`), with a proof against the tweaked public key. The group's identifier is `info`; one key per period serves every group.

- Pros:
  - One published key per period for all groups, so every token issued in a period is in one anonymity set, and the client checks one key against the deployment record.
  - The issuer knows the group at issuance and can enforce one token per account, for one group; a token for one group is useless for another.
  - ristretto255-SHA512 is the protocol's group already, and `packages/crypto` already checks RFC 9497 Appendix A.1's vectors for all three modes ([[group]], Test vectors), so no new primitive or group is added.
  - Still RFC 9497, and still Privacy Pass's model: the issuer redeems with its own `Evaluate`.
- Cons:
  - POPRF's security rests on the 3HashSDHI assumption (Tyagi et al., EUROCRYPT 2022), a q-type assumption stronger than B's.
  - It isn't the mode the owner's line names. The difference is the `info` argument; the owner may prefer B, at the cost above.

What all three share, and this ADR fixes too:

- **The token is bound to the commitment it registers.** The client chooses its identity first and puts its commitment in the token's input with the key's identifier, as RFC 9578 binds a client nonce. A token seen in transit (T-11) registers nothing else, and a token presented twice registers the same commitment twice, which the queue already treats as one, so the service keeps no spent-token set.
- **The key comes from the release.** The deployment record of the signed release lists each period's public key, so every client of a release checks the proof against the same key ([[deployment]], extended by P2-30 part 3).
- **Blind RSA** (RFC 9474, Privacy Pass type `0x0002`) was not taken: its public verifiability isn't needed, since the issuer is the redeemer, and `@noble/*` doesn't implement it.

## Recommendation

C. It meets both requirements with one key per period, adds no group, and reuses RFC 9497 code paths and vectors already checked in `packages/crypto`. The stronger assumption is the cost; POPRF is standardised, analysed and deployed, and the value it protects (an account-to-commitment link, and the Sybil cost of a Tier 0 identity) is not an election secret on the public board, so a break of the assumption wouldn't reach ballot secrecy.

What would change it: if the owner wants VOPRF mode literally, B is a drop-in replacement for the issuance steps, with one key per group and period in the deployment record.

## Consequences

- [[tier0-token]] specifies the keys and their periods (30 days; a key issues in its period and redeems in it and the next), the group's `info`, the token input, issuance with the issuer's one-token-per-account rule, its atomic record and retry, redemption, timing and errors, with vectors from an independent Python implementation.
- The redemption delay: a client redeems at a uniformly random instant of the day after it got its token, and takes its token at verification rather than at its first vote. A commitment's join time is public on L2 (T-13), so the anonymity set of a new commitment is the accounts of its region that took a token in the day before it: large in a busy region, small in a quiet one (T-11, T-10).
- A period has one key for good: a later release never lists another key for a period an earlier one listed, and a key retired early isn't replaced in its period, so the issuer can't split clients by release (T-74).
- A new threat, T-74: the issuer key mints identities if stolen, and a per-account key would link accounts to commitments if clients didn't check it.
- One identity per account for good: a token lost before redemption, or an identity lost without a backup after it, isn't replaced from the same account (Known-weak in [[tier0-token]]).
- **Precondition:** tokens must not replace Turnstile in [[registration]] until the redemption is sealed to the signing service ([[tier0-token]], Redemption), or a self-paid copy of a waiting commitment, made by anyone who sees it in transit, would shut its account out for good.
- Follow-ups in [[P2-30]]: `packages/crypto` (part 2), the issuer, its keys and the deployment record's key list (part 3), the relay and the ballot client (part 4), and redemption in the signing service in place of Turnstile (part 5).

## Decision

Under rule A (`AGENTS.md`): option C, with status `Accepted (agent) — owner may veto`, listed under Decisions to review in [[STATUS]].
