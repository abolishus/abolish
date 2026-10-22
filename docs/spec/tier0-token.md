# Tier 0 tokens

How an account obtains the right to register one Tier 0 voting identity per group without the operator learning which identity it registered, as [[0024-tier0-registration]] (Owner decision, option C) and [[0039-tier0-token-issuance]] decide: the issuer's keys and their periods, the group a token admits to, the token's input, issuance (RFC 9497's POPRF mode over ristretto255-SHA512), the client's and the issuer's checks, redemption by the signing service, and the client's timing. Notation is from [[notation]], `H` and `DS` from [[group]] and [[domain-separation]], groups from [[registration]] (Groups), the commitment from [[membership]]. Threats: T-74, T-10, T-11, T-01, T-13, T-16, T-52, T-69.

A token is operational data, never part of an election: it is never on the board, the chain, IPFS or the archive, and no verifier reads it. The ballot client computes every client-side value on this page with the `packages/crypto` functions that implement it (AGENTS.md, Architecture), and only it ever holds a token's blind, input or output.

What this page doesn't cover:

- **Where the issuer's public keys are published:** the deployment record lists them (Keys), in a version that P2-30 part 3 adds to [[deployment]].
- **The routes:** the issuance route behind `apps/web`'s account session and its relay to the ballot client (P2-30 parts 3 and 4), and the registration request's `token` in place of its Turnstile token (P2-30 part 5, which updates [[registration]], Request and Answers).
- **Who may take a token:** an account verified by email and phone ([[P2-31]]), and the issuer's rate limits (P2-30 part 3).

## Sources

- [RFC 9497](https://www.rfc-editor.org/rfc/rfc9497), Oblivious Pseudorandom Functions (OPRFs) Using Prime-Order Groups: the POPRF mode (`modePOPRF = 0x02`, Section 3.3.3), its proof (Section 2.2) and the ristretto255-SHA512 suite (Section 4.1), unchanged.
- [RFC 9578](https://www.rfc-editor.org/rfc/rfc9578), Privacy Pass Issuance Protocols, Section 5: the shape this page follows (a token bound to its key's identifier and to a client-chosen value, redeemed by the issuer's own `Evaluate`), not its token type, which is a VOPRF over P-384 ([[0039-tier0-token-issuance]], option A).
- POPRF's security: Tyagi, Celi, Ristenpart, Sullivan, Tessaro and Wood, "A Fast and Simple Partially Oblivious PRF, with Applications", EUROCRYPT 2022 (the 3HashSDHI construction RFC 9497 specifies).

## Suite

Every POPRF step is RFC 9497's, with the ristretto255-SHA512 suite and `contextString = "OPRFV1-" ‖ I2OSP(0x02, 1) ‖ "-ristretto255-SHA512"`, so its own DSTs (`HashToGroup-`, `HashToScalar-`, `Seed-`, `Composite`, `Challenge`, `Info`, `Finalize`) apply unchanged. They aren't registered tags: RFC 9497 is an external format with its own domain separation ([[domain-separation]], Applying a tag). Elements and scalars are encoded as [[group]] encodes them, which is RFC 9497's `SerializeElement` and `SerializeScalar` for this suite. `packages/crypto` checks the suite against RFC 9497 Appendix A.1.3 (vendored in `packages/crypto/test-vectors/rfc/`).

RFC 9497's names are used below: `Blind`, `BlindEvaluate`, `Finalize` and `Evaluate` of Section 3.3.3, with the server's key `skS` and public key `pkS`, and the batch size always 1.

## Values

| Name               | Value     | Meaning                                                                                                                                              |
| ------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TOKEN_KEY_PERIOD` | 2,592,000 | Seconds in a key period (30 days). Key period `q` is `[2,592,000 · q, 2,592,000 · (q + 1))` in UNIX time.                                            |
| `TOKEN_VERSION`    | 1         | The version of the token input's layout (Token input). A different layout is a new version, and a service accepts only the versions this page lists. |

They are values of this page, not of any record: changing one changes the issuer, the signing service and the ballot client, never an election.

## Keys

The issuer holds one key pair per key period: `skS` a uniformly random non-zero scalar from a CSPRNG (RFC 9497 `GenerateKeyPair`), `pkS = skS · g`. A key **issues** only during its own period `q`, and **redeems** during `q` and `q + 1`, so a token taken late in a period can still be redeemed; at the end of `q + 1` its `skS` is destroyed. The current period is `floor(now / TOKEN_KEY_PERIOD)`, with `now` the UNIX time in seconds.

The key's identifier is

```
key_id = H(DS("abolish/v1/tier0-token/key", u32(q) ‖ pkS))
```

with `pkS` its 32-byte encoding.

**Every client sees the same key.** A client takes `pkS` for period `q` only from the deployment record of the release it runs, which lists the key of each period the release covers, published before that period starts; it never accepts a key the API offers alone. An issuer that answered one account under a key of its own would otherwise mark that account's token, and through it the commitment it registers (T-74, T-10). A release carries the keys of the periods it may run in, so the issuer generates keys ahead; P2-30 part 3 sets how far.

## Group info

A token admits to one Tier 0 group, the published group of the region the account asked for ([[registration]], Groups). The group enters as POPRF's public `info`:

```
info = H(DS("abolish/v1/tier0-token/info", u64(chain_id) ‖ bytes[20](group_registry) ‖ u64(group_id)))
```

with `chain_id` the L2's chain ID, `group_registry` the group registry's address and `group_id` the group's identifier ([[contracts]], Group registry), all from the deployment record. The issuer sees `info`, and refuses a second token for the same account and group (Issuance); the client can't turn a token for one group into one for another, since POPRF's evaluation and `Finalize` both depend on `info` (T-16).

## Token input

The client chooses its identity first, and binds its commitment `C` ([[membership]], Commitments and removals) into the input:

```
input = H(DS("abolish/v1/tier0-token/input", u8(TOKEN_VERSION) ‖ key_id ‖ field<bn254>(C)))
```

`C` MUST be below `r` (`non-canonical` otherwise) and MUST NOT be forbidden ([[membership]]); the client checks both before it blinds. Binding `C` means a token registers only that commitment: anyone who sees a redemption in transit (T-11) can't register another commitment with it, and a token redeemed twice registers the same commitment twice, which the queue already treats as one ([[registration]], Answers, step 8), so the service keeps no set of spent tokens.

## Issuance

1. **Blind.** The client checks that `T = HashToScalar("Info" ‖ I2OSP(len(info), 2) ‖ info) · g + pkS` isn't the identity (`tweaked-key-identity`; RFC 9497's `Blind` checks it too), then computes `(blind, B) = Blind(input, pkS, info)` with a fresh random `blind` from a CSPRNG, and sends the issuer `key_id`, its region and `B` (32 bytes), with the account's session.
2. **The issuer's checks.** The issuer answers only:
   1. an account that may take a token ([[P2-31]]; P2-30 part 3);
   2. for `key_id` the key that issues now (Keys), or, for a retry (item 5), the stored key while it still redeems;
   3. for a region with a published group, whose `info` it computes;
   4. for `B` that decodes ([[group]], Encodings) to an element other than the identity (`blinded-element`);
   5. if the account has no token for this group, or has one whose stored `key_id` and `B` are exactly these and whose key still redeems: a retry, so a client whose answer was lost doesn't lose its token. Any other request for a group the account has a token for is refused.
3. **Record.** Before answering, the issuer records, on the account's side of the no-join tests (T-10), that the account took a token for this group, with `key_id` and `B`, and no time finer than the key period. `B` is `blind · HashToGroup(input)` with `blind` uniform, so it reveals nothing about `input` or `C`.
4. **Evaluate.** The issuer computes `(Z, proof) = BlindEvaluate(skS, B, info)` with fresh proof randomness, and answers `Z` (32 bytes) and `proof` (`c ‖ s`, 64 bytes). If `skS + m = 0` for this `info` (`inverse`, RFC 9497's `InverseError`, probability about 2⁻²⁵²), the issuer answers no token for the group under this key; the client waits for the next period's key.
5. **Finalize.** The client computes `token = Finalize(input, blind, Z, B, proof, info, T)` (64 bytes), which checks `proof` against `T` and fails on any other key, group or evaluation (`proof`). On failure it keeps nothing and tells the voter the issuer's answer didn't check; it never retries with another key.

The client keeps `key_id`, `C`, the region and `token` until it sees `C` in the group on chain ([[registration]], Outcome), and nothing else: `blind`, `input` and `Z` are discarded once `Finalize` succeeds.

## Redemption

The ballot client sends `key_id`, `C`, the region and `token` on the ballot path, with no account credential ([[registration]], Request, in P2-30 part 5). The signing service:

1. finds the key `key_id` names among the keys it holds, and refuses an unknown one (`key-unknown`) or one that doesn't redeem now (`key-period`);
2. computes `info` from the region's published group, and `input` from `key_id` and `C` (Token input);
3. computes `expected = Evaluate(skS, input, info)` and accepts only if `token` is 64 bytes equal to `expected`, compared in constant time (`token`).

It logs and stores nothing about a redemption but what [[registration]] already keeps (the queued commitment). The issuer and the signing service hold the same `skS`, so they are the same trust domain: the operator.

## Timing

The account's issuance and the commitment's redemption must not be joinable by when they happened (T-11, T-13):

- The client sends the redemption at a uniformly random instant of the registration period (`REGISTRATION_PERIOD`, [[registration]], Values) after the one in which `Finalize` succeeded, never sooner, so every token issued in one period for a group is redeemed in the next, in an order unrelated to issuance. A client offline then redeems when it next can, within its key's redemption window.
- Neither the issuer's record nor the queue keeps a time (Issuance, step 3; [[registration]], Queue), so a copy of either can't be timed against the other.
- What this can't hide is the request times the API, its proxy and the platform see in transit, which P2-30 part 5 tests and T-11 records.

## Errors

The codes the checks above use, which the vectors label:

| Code                   | Where                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| `non-canonical`        | Token input: `C` isn't below `r`.                                        |
| `tweaked-key-identity` | Issuance, step 1: `T` is the identity.                                   |
| `blinded-element`      | Issuance, step 2: `B` isn't 32 bytes encoding an element other than 0.   |
| `inverse`              | Issuance, step 4: `skS + m = 0` for this `info`.                         |
| `proof`                | Issuance, step 5: the proof doesn't check against `T`.                   |
| `key-unknown`          | Redemption, step 1: no key held has this identifier.                     |
| `key-period`           | Redemption, step 1: the key doesn't redeem now.                          |
| `token`                | Redemption, step 3: `token` isn't 64 bytes equal to the issuer's output. |

## Test vectors

`docs/spec/vectors/tier0-token.json` ([[vectors/README|vectors]], Tier 0 token vectors) covers key identifiers, group info, token inputs, issuances end to end, the client's `Finalize` checks, the issuer's decoding of `B`, key periods and redemptions, from an independent Python implementation (`packages/crypto/scripts/tier0-token-vectors.py`) checked against RFC 9497 Appendix A.1.3; `packages/crypto` also checks the file against `@noble/curves`' RFC 9497 implementation.

## Security notes

- **What the operator learns.** Which accounts took a token, for which region, in which key period; and, separately, which commitments were redeemed for which region. POPRF's blinding makes the two unlinkable whatever the issuer does, as long as every client uses the published key (Keys) and checks the proof; timing is the remaining link (Timing).
- **A stolen key mints identities.** Whoever holds `skS` computes tokens for any commitment and any group, with no account, until the key stops redeeming. The keys are held apart from every other secret, and the number of commitments redeemed per key and group, which the service can count without linking anything, must not exceed the tokens issued per key and group; a larger count is a compromise (T-74).
- **One identity per account and group, for good.** The issuer refuses a second token for a group, so a voter who loses an identity before backing it up ([[identity-backup]]) and after redeeming can't register another in that group from the same account (T-18). A token lost before redemption is lost too; retries cover only a lost answer (Issuance, step 2.5).
- **A token can be sold.** An account holder can blind a buyer's commitment and hand the buyer the token; nothing on this page stops it. A token costs a verified account, so a Sybil pays what a verified account costs ([[P2-31]], T-01).
- **POPRF's assumption.** POPRF's obliviousness and one-more unpredictability rest on the 3HashSDHI assumption (Tyagi et al., above), a q-type assumption stronger than the one-more Gap DH that VOPRF mode rests on ([[0039-tier0-token-issuance]], Cons).
