# Tier 0 tokens

How an account obtains the right to register one Tier 0 voting identity per group without the operator learning which identity it registered, as [[0024-tier0-registration]] (Owner decision, option C) and [[0039-tier0-token-issuance]] decide: the issuer's keys and their periods, the group a token admits to, the token's input, issuance (RFC 9497's POPRF mode over ristretto255-SHA512), the client's and the issuer's checks, redemption by the signing service, and the client's timing. Notation is from [[notation]], `H` and `DS` from [[group]] and [[domain-separation]], groups from [[registration]] (Groups), the commitment from [[membership]]. Threats: T-74, T-10, T-11, T-01, T-13, T-16, T-52, T-69.

A token is operational data, never part of an election: it is never on the board, the chain, IPFS or the archive, and no verifier reads it. The ballot client computes every client-side value on this page with the `packages/crypto` functions that implement it (AGENTS.md, Architecture), and only it ever holds a token's blind, input or output.

What this page doesn't cover:

- **Where the issuer's public keys are published:** the deployment record lists them (Keys) from its version 2, as `tier0_token_keys` ([[deployment]], Record (version 2)).
- **The routes:** the issuance route behind `apps/web`'s account session and its relay to the ballot client (P2-30 parts 3 and 4), and the registration request's `token` in place of its Turnstile token (P2-30 part 5, which updates [[registration]], Request and Answers).
- **Who may take a token:** an account verified by email, and by phone where the deployment turns phone verification on ([[P2-31]]; [[0038-verified-accounts]], Owner decision (2026-10-22)), and the issuer's rate limits (P2-30 part 3).

## Sources

- [RFC 9497](https://www.rfc-editor.org/rfc/rfc9497), Oblivious Pseudorandom Functions (OPRFs) Using Prime-Order Groups: the POPRF mode (`modePOPRF = 0x02`, Section 3.3.3), its proof (Section 2.2) and the ristretto255-SHA512 suite (Section 4.1), unchanged.
- [RFC 9578](https://www.rfc-editor.org/rfc/rfc9578), Privacy Pass Issuance Protocols, Section 5: the shape this page follows (a token bound to its key's identifier and to a client-chosen value, redeemed by the issuer's own `Evaluate`), not its token type, which is a VOPRF over P-384 ([[0039-tier0-token-issuance]], option A).
- POPRF's security: Tyagi, Celi, Ristenpart, Sullivan, Tessaro and Wood, "A Fast and Simple Partially Oblivious PRF, with Applications", EUROCRYPT 2022 (the 3HashSDHI construction RFC 9497 specifies).

## Suite

Every POPRF step is RFC 9497's, with the ristretto255-SHA512 suite and `contextString = "OPRFV1-" ‖ I2OSP(0x02, 1) ‖ "-ristretto255-SHA512"`, so its own DSTs (`HashToGroup-`, `HashToScalar-`, `Seed-`, `Composite`, `Challenge`, `Info`, `Finalize`) apply unchanged. They aren't registered tags: RFC 9497 is an external format with its own domain separation ([[domain-separation]], Applying a tag). Elements and scalars are encoded as [[group]] encodes them, which is RFC 9497's `SerializeElement` and `SerializeScalar` for this suite. `packages/crypto` checks the suite against RFC 9497 Appendix A.1.3 (vendored in `packages/crypto/test-vectors/rfc/`).

RFC 9497's names are used below: `Blind`, `BlindEvaluate`, `Finalize` and `Evaluate` of Section 3.3.3, with the server's key `skS` and public key `pkS`, and the batch size always 1.

## Values

| Name                 | Value     | Meaning                                                                                                                                              |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_KEY_PERIOD`   | 2,592,000 | Seconds in a key period (30 days). Key period `q` is `[2,592,000 · q, 2,592,000 · (q + 1))` in UNIX time.                                            |
| `TOKEN_VERSION`      | 1         | The version of the token input's layout (Token input). A different layout is a new version, and a service accepts only the versions this page lists. |
| `TOKEN_REDEEM_DELAY` | 86,400    | Seconds (one day) over which the client spreads its redemption after `Finalize` (Timing).                                                            |

They are values of this page, not of any record: changing one changes the issuer, the signing service and the ballot client, never an election.

## Keys

The issuer holds one key pair per key period: `skS` a uniformly random non-zero scalar from a CSPRNG (RFC 9497 `GenerateKeyPair`), `pkS = skS · g`. A key **issues** new tokens only during its own period `q` (it also answers a retry while it redeems, Issuance, step 2.5), and **redeems** during `q` and `q + 1`, so a token taken late in a period can still be redeemed; at the end of `q + 1` its `skS` is destroyed. The current period is `floor(now / TOKEN_KEY_PERIOD)`, with `now` the UNIX time in seconds.

The key's identifier is

```
key_id = H(DS("abolish/v1/tier0-token/key", u32(q) ‖ pkS))
```

with `pkS` its 32-byte encoding.

**Every client sees the same key.** A client takes `pkS` for period `q` only from the deployment record of the release it runs, which lists the key of each period the release covers, published before that period starts (but for the periods up to and including the one the first such release is published in, which no earlier release could list, [[deployment]], Token keys in a release); it never accepts a key the API offers alone. An issuer that answered one account under a key of its own would otherwise mark that account's token, and through it the commitment it registers (T-74, T-10). A release carries the keys of the periods it may run in, so the issuer generates keys ahead, as far as [[deployment]] (Token keys in a release) sets.

**A period has one key, for good.** Once a release lists a key for period `q`, every later release lists the same `pkS` for `q` or none; a key retired early (T-74) is never replaced within its period, which then issues nothing. A retired key no longer redeems, nor does a key past period `q + 1`, so tokens issued under it and not yet redeemed are dead (a ballot client is a web page and redeems only while it is open, so a voter away for a month can hold one), and since the issuer can't tell which were redeemed, it can't simply issue again (an account that had redeemed would get a second identity). Instead such an account re-issues: with its session, it sends the dead token's `key_id`, `C` and `blind` (the token itself proves nothing once its key is gone, and isn't sent), and a new request for a fresh commitment that the client draws from a new identity secret (its `key_id'` and `B'`, made as in Issuance, step 1). The issuer then:

1. runs Issuance, steps 2.1 to 2.4, on the new request, whose region must be the record's (moving region stays refused until P2-30 part 3 defines it); step 2.5 is replaced by what follows;
2. checks that `key_id` names a key that no longer redeems, and that the account's record, for its region, either names that `key_id` (a key retired early) or is marked dead (Issuance, step 3; the binding in item 3 then shows which key it was);
3. decodes `blind` as a non-zero scalar below `l` and `C` as a `field<bn254>` below `r` that isn't forbidden ([[group]], Encodings; [[membership]]), refusing any other encoding, then checks that `blind · HashToGroup(input)` is the `B` the record holds, with `input` from `key_id` and `C`, so only the account that blinded this token can show it (another account's dead token, bought or borrowed, fails here);
4. in one atomic step with the queue: checks, against the chain's history of Tier 0 addition events (not current membership), that `C` has never been added to any Tier 0 group (signed or self-paid, removed since or not) and is in no queue or in-flight batch, adds `C` to a list the signing service consults at redemption and refuses (needed only until `key_id`'s redemption window ends on the signing service's clock, since the issuer's and the service's clocks can disagree at that boundary), and replaces the record's `key_id` and `B` with `key_id'` and `B'`, so neither the account nor the dead token is shown twice;
5. evaluates `B'` as in Issuance, step 4.

A failed check in items 2 to 4 refuses with `reissue-refused`, and a retry of a lost answer is then an ordinary retry of `B'` (Issuance, step 2.5); the old `C` is abandoned: a `C` shown at re-issuance is never redeemed or voted with, whatever the answer. After a natural expiry the client re-issues only some margin after `q + 1` ends on its own clock (P2-30 part 4 sets it), so clock skew doesn't refuse it; after an early retirement, which the release lists, it re-issues as soon as it sees the retirement; and after `reissue-refused` it keeps `C`, `blind` and its new request and may repeat the re-issuance later rather than lose its token, with a fresh new request under the then current key if the period has changed (`key-not-issuing` otherwise). It stores the sent-record atomically with `C` and `blind`, so partial storage loss can't separate them. Revealing `blind` for an abandoned `C` costs nothing. Showing an unregistered `C` that the client then discards joins the account to nothing, but only if `C` is never registered, so the client shows a dead token only if it has never sent a redemption for that `C`, and, as a second guard against a lost or raced sent-record (two tabs, partial storage loss), only after it finds `C` in no Tier 0 group addition on chain, read from the L2 by a light client or several independent RPC endpoints under the verifier's rules, never from Abolish's own API or indexer, by reading every Tier 0 group's addition history in full as [[registration]]'s Outcome does, never by asking an endpoint about one commitment (T-11), holding one lock across tabs around the sent-record and the re-issuance; a redemption sent with an unknown outcome (a timeout, a crash, a retirement crossing it in flight) counts as sent. A client that has sent one keeps its token and waits for `C` to appear in its group or be moved (Outcome), and if neither happens it is shut out like a client whose service never signs (Security notes). Item 4 is atomic with the queue, and the signing service's check of the list at redemption and its queueing of `C` are one serialisable step with item 4, so neither a redemption at the key's boundary nor a batch the issuer's view of the chain hasn't caught up with can slip between them: a batch counts as in flight until the issuer has seen its addition final on L2, so a reorg can't drop it from both sets. So a redemption accepted just before can't register `C` while the account takes a second token. Without this, retiring a key, or claiming a compromise, would shut out every account that took a token under it and hadn't redeemed.

Why one key per period: two keys for one period would split its tokens into two sets the issuer chose, and a release served to one account would mark it. The releases are on L1 ([[release]]), so anyone can check this across them; [[verifier]]'s keys run checks it (Token keys across releases, by [[deployment]]'s Across releases).

## Group info

A token admits to one Tier 0 group, the published group of the region the account asked for ([[registration]], Groups). The group enters as POPRF's public `info`:

```
info = H(DS("abolish/v1/tier0-token/info", u64(chain_id) ‖ bytes[20](group_registry) ‖ u64(group_id)))
```

with `chain_id` the L2's chain ID, `group_registry` the group registry's address and `group_id` the group's identifier ([[contracts]], Group registry), all from the deployment record. The issuer sees `info`, and gives an account tokens for one group only (Issuance); the client can't turn a token for one group into one for another, since POPRF's evaluation and `Finalize` both depend on `info` (T-16).

## Token input

The client chooses its identity first, and binds its commitment `C` ([[membership]], Commitments and removals) into the input:

```
input = H(DS("abolish/v1/tier0-token/input", u8(TOKEN_VERSION) ‖ key_id ‖ field<bn254>(C)))
```

`C` MUST be below `r` (`non-canonical` otherwise) and MUST NOT be forbidden ([[membership]]; `forbidden-commitment` otherwise); the client checks both before it blinds. Binding `C` means a token registers only that commitment: anyone who sees a redemption in transit (T-11) can't register another commitment with it, and a token redeemed twice registers the same commitment twice, which the queue already treats as one ([[registration]], Answers, step 8), so the service keeps no set of spent tokens.

## Issuance

An account takes tokens for **one Tier 0 group**, the first region it asks for: a tier's electorate is the union of its regional groups ([[0019-regional-cells]]), so a token per group would give one account an identity, and a vote, per region. Moving to another region is not defined yet and is refused; it needs a rule that retires the old identity (P2-30 part 3).

The client takes its token once the account is verified and the voter has an identity, not when the voter first wants to vote, so the redemption delay (Timing) has usually passed before the first poll.

1. **Blind.** The client checks that `T = HashToScalar("Info" ‖ I2OSP(len(info), 2) ‖ info) · g + pkS` isn't the identity (`tweaked-key-identity`; RFC 9497's `Blind` checks it too), then computes `(blind, B) = Blind(input, pkS, info)` with a fresh random `blind` from a CSPRNG. It stores `key_id`, `C`, the region, `blind` and `B` durably **before** it sends anything, so a crash or a lost answer can be retried with the same `B`, then sends the issuer `key_id`, the region and `B` (32 bytes), with the account's session.
2. **The issuer's checks.** The issuer answers only:
   1. an account that may take a token ([[P2-31]]; P2-30 part 3), else `account`;
   2. for `key_id` the key that issues now (Keys), or, for a retry (item 5), the stored key while it still redeems, else `key-not-issuing`;
   3. for a region with a published group, whose `info` it computes, else `region-unknown`;
   4. for `B` that decodes ([[group]], Encodings) to an element other than the identity, else `blinded-element`;
   5. if the account has no token yet, or has one whose stored region, `key_id` and `B` are exactly these and whose key still redeems: a retry, so a client whose answer was lost or corrupted doesn't lose its token. Anything else is refused (`token-taken`).
3. **Record.** Before evaluating, the issuer records the account's token, its region, `key_id` and `B`, on the account's side of the no-join tests (T-10), with no time, in one atomic insert-if-absent keyed on the account and the deployment (its `chain_id` and `group_registry`, a unique key, say), so a redeployed registry starts afresh while an account still holds one token per deployment, so two concurrent requests with different `B` can't both pass item 5 (T-01). `B` is `blind · HashToGroup(input)` with `blind` uniform, so it reveals nothing about `input` or `C`; at the end of period `q + 1` the issuer replaces `key_id` with a mark that the record's key is dead, and keeps `B` with the account's record for as long as the record exists, since re-issuance (Keys) needs it: a perfectly hiding `B` joins the account to nothing, and with `key_id` gone the record keeps no period either.
4. **Evaluate.** The issuer computes `(Z, proof) = BlindEvaluate(skS, B, info)` with fresh proof randomness, and answers `Z` (32 bytes) and `proof` (`c ‖ s`, 64 bytes). If `skS + m = 0` for this `info` (`inverse`, RFC 9497's `InverseError`, probability about 2⁻²⁵²), the issuer answers no token under this key and removes its record. That happens exactly when `T` is the identity, which the client refused at step 1 and then waits for the next period's key; so a client whose `T` check passed treats an `inverse` answer as a failed answer, keeps its stored values and retries as at step 5, never moving to another key.
5. **Finalize.** The client decodes `Z` ([[group]], Encodings: canonical and not the identity, else `evaluation-element`) and `c` and `s` as scalars below `l` (else `proof`), then computes `token = Finalize(input, blind, Z, B, proof, info, T)` (64 bytes), which checks `proof` against `T` and fails on any other key, group or evaluation (`proof`). On failure it tells the voter the issuer's answer didn't check, and keeps its stored values to retry with the same `B` under the same published key (item 2.5), which reveals nothing new; it never asks under another key.

Once `Finalize` succeeds, the client discards `Z`, and keeps `key_id`, `C`, the region, `token` and `blind` until it sees `C` in the group on chain ([[registration]], Outcome): `blind` is what proves the token its own if its key stops redeeming first (Keys).

## Redemption

Before it sends anything, the client durably records that the redemption of `C` is sent, so a crash between sending and recording can never let it show `C` for re-issuance later (Keys). A client that restarts with a redemption recorded as sent and no outcome sends the same redemption again while its key still redeems, which the queue treats as one, so a crash between recording and sending doesn't strand it. The ballot client then sends `key_id`, `C`, the region and `token` on the ballot path, with no account credential ([[registration]], Request, in P2-30 part 5). The signing service:

1. finds the key `key_id` names among the keys it holds, and refuses an unknown one (`key-unknown`) or one that doesn't redeem now (`key-period`);
2. computes `info` from the region's published group (`region-unknown` if it has none), and `input` from `key_id` and `C` (Token input);
3. computes `expected = Evaluate(skS, input, info)` and accepts only if `token` is 64 bytes equal to `expected`, compared in constant time (`token`).

**The commitment is sealed to the signing service.** Anyone who saw `C` while it waited in the queue could copy it into a self-paid group ([[contracts]], Group registry, Self-paid additions); [[registration]] (The batch, step 2) then drops it, keeping its public rule that no signed batch carries a commitment live in any Tier 0 group, which is what makes a registrar's signed copy of a self-paid commitment visible and attributable (T-06, T-16; [[membership]], Why signed groups first). Under Turnstile the client recovered with a new identity (Outcome, Moved); under this page a new identity needs a new token, which the issuer refuses (Issuance, step 2.5), so a copy would shut the account out for one self-paid fee. So the redemption's body is sealed to a key of the signing service with a hybrid KEM, as [[nullifier-transport]] seals a Tier 2 request, and the proxy and platform that terminate TLS (T-11) never see `C` before its batch is on chain. P2-30 part 5 specifies the sealing and its key, and registration's drop rule stands unchanged. Only the operator, which decrypts the request, can still copy `C` before it's signed, and it can as well refuse to sign (T-69): an account it shuts out this way sees its commitment moved (Outcome, Moved) and has no second token (Security notes).

It logs and stores nothing about a redemption but what [[registration]] already keeps (the queued commitment). The issuer and the signing service hold the same `skS`, so they are the same trust domain: the operator.

## Timing

The account's issuance and the commitment's redemption must not be joinable by when they happened (T-11, T-13). A commitment's addition is on L2 with its batch's time for good (T-13), so the redemption's time is public to within a registration period or two ([[registration]], The batch), and any record of when an account took its token (a request log, the account's verification) is a candidate to join it with:

- The client sends the redemption at an instant drawn uniformly from the `TOKEN_REDEEM_DELAY` after `Finalize` succeeded, with a CSPRNG (`crypto.getRandomValues`, by rejection sampling, never `Math.random`), since the draw is all that hides the issuance time. Someone who knows when every account took its token and when a commitment joined its group can narrow the commitment to the accounts of that region that took a token in the day before: in a busy region many, in a quiet one few (Security notes). A client offline at its instant redeems when it next can, within its key's redemption window.
- The issuer's record keeps no time (Issuance, step 3), nor does the queue ([[registration]], Queue). Account-side records that do (the account's creation and verification, [[P2-31]]) are the join's input, and P2-30 part 5's tests check that no record keeps the time of issuance itself.
- What this can't hide is the request times and addresses the API's proxy and platform see in transit: the same address at issuance and at redemption a day later links them (T-11), unless the voter changes networks or uses Tor.

The cost is latency: a new voter's identity joins its group up to a day after their token, plus the batch's wait, which is why the client takes its token at verification (Issuance).

## Errors

The codes the checks above use, which the vectors label:

| Code                   | Where                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `non-canonical`        | Token input: `C` isn't below `r`.                                                                          |
| `forbidden-commitment` | Token input: `C` is forbidden ([[membership]]).                                                            |
| `tweaked-key-identity` | Issuance, step 1: `T` is the identity.                                                                     |
| `account`              | Issuance, step 2.1: the account may not take a token.                                                      |
| `key-not-issuing`      | Issuance, step 2.2: the key named doesn't issue now and the request isn't a retry.                         |
| `region-unknown`       | Issuance, step 2.3, and Redemption, step 2: the region has no published group.                             |
| `blinded-element`      | Issuance, step 2.4: `B` isn't 32 bytes encoding an element other than 0.                                   |
| `reissue-refused`      | Keys: a re-issuance after its key stops redeeming (retired early or past `q + 1`) fails one of its checks. |
| `token-taken`          | Issuance, step 2.5: the account has its token and this isn't a retry of it.                                |
| `inverse`              | Issuance, step 4: `skS + m = 0` for this `info`.                                                           |
| `evaluation-element`   | Issuance, step 5: `Z` isn't 32 bytes encoding an element other than 0.                                     |
| `proof`                | Issuance, step 5: `c` or `s` isn't below `l`, or the proof doesn't check against `T`.                      |
| `key-unknown`          | Redemption, step 1: no key held has this identifier.                                                       |
| `key-period`           | Redemption, step 1: the key doesn't redeem now.                                                            |
| `token`                | Redemption, step 3: `token` isn't 64 bytes equal to the issuer's output.                                   |

## Test vectors

`docs/spec/vectors/tier0-token.json` ([[vectors/README|vectors]], Tier 0 token vectors) covers key identifiers, group info, token inputs, issuances end to end, the client's `Finalize` checks, the issuer's decoding of `B`, key periods and redemptions, from an independent Python implementation (`packages/crypto/scripts/tier0-token-vectors.py`) checked against RFC 9497 Appendix A.1.3; `packages/crypto`'s own token code (`src/tier0-token.ts`) is checked against the file and against Appendix A.1.3 itself.

## Security notes

- **What the operator learns.** Which accounts took their token, for which region, and which re-issued after their key expired, which shows they registered nothing under it (slightly narrowing the anonymity set of that window's commitments in their region); and, separately, which commitments were redeemed for which region. POPRF's blinding makes the two unlinkable whatever the issuer does, as long as every client uses the published key (Keys) and checks the proof; timing is the remaining link (Timing): in a region where few accounts take tokens in a day, the day-long delay leaves few candidates for each new commitment. The issuer can also shrink that set on purpose: it decides when each account gets its answer, so by stalling every other account of a quiet region for a day and answering only a target, it makes the target's commitment the region's next new one (T-13, T-74). Tokens don't replace Turnstile until P2-30 part 5 specifies a client-side guard against this and tests it ([[0039-tier0-token-issuance]], Consequences). A plain floor (redeem only once the region shows `k` new joins since `Finalize`) deadlocks a region where every new member is waiting on the others, so the guard needs a way out, such as redeeming anyway after a longer bound, which must end inside the key's redemption window (or a waiting token dies, re-issues and waits again), and states what the stall then costs the issuer.
- **A stolen key mints identities.** Whoever holds `skS` computes tokens for any commitment and any group, with no account, until the key stops redeeming. The keys are held apart from every other secret, and the number of commitments newly queued by redemption per key and group, which the service can count without linking anything, must not exceed the tokens issued per key and group by more than the commitments dropped from the queue and redeemed again ([[registration]], The batch), a slack the service also counts; a larger count is a compromise (T-74).
- **One identity per account, for good.** The issuer refuses a second token, so a voter who loses an identity before backing it up ([[identity-backup]]) and after redeeming can't register another from the same account (T-18), nor move to another region. A token lost after `Finalize` and before redemption is lost too, unless the client kept `blind` and `C` and re-issues once its key stops redeeming (Keys); retries cover only a lost or corrupted answer (Issuance, step 2.5).
- **What a token can't recover from.** A commitment moved by a signed copy in another group (the registrars breaking the no-repeat rule, T-06), copied into a self-paid group by the operator before its batch (the only party that sees `C` then, Redemption), or never signed (T-69) leaves the account without a counted identity and no second token. Each is the operator's own misbehaviour, which a token doesn't make worse than refusing to register; the first is visible on chain, and the others only to the voter's client.
- **A token can be sold.** An account holder can blind a buyer's commitment and hand the buyer the token; nothing on this page stops it. A token costs a verified account, so a Sybil pays what a verified account costs ([[P2-31]], T-01).
- **POPRF's assumption.** POPRF's obliviousness and one-more unpredictability rest on the 3HashSDHI assumption (Tyagi et al., above), a q-type assumption stronger than the one-more Gap DH that VOPRF mode rests on ([[0039-tier0-token-issuance]], Cons).
