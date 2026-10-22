# Tier 0 token keys

How the operator makes, loads, rotates, retires and destroys the Tier 0 token issuer's keys ([[tier0-token]], Keys; [[0039-tier0-token-issuance]]; [[P2-30]]). Whoever holds a period's `skS` can mint Tier 0 identities with no account until that key stops redeeming (T-74), and a key that differs from the one a release lists marks the accounts it answers (T-10), so these steps keep three things true: each period has one key for good, each key is published before its period begins, and each key is gone once its window ends.

## The keys

One key per 30-day period `q` ([[tier0-token]], Values). A key issues during its own period and redeems during it and the next, so it lives from the release that first lists it until the end of `q + 1`, after which every copy is destroyed.

| Where                            | Holds                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The key directory, offline       | One file per period, `tier0-key-<q>.txt`, from the moment it is made until the end of `q + 1`              |
| `apps/web`'s `TIER0_ISSUER_KEYS` | Two periods' keys: the previous and current until the period's last-week deploy, then the current and next |
| Each release's deployment record | Every key's public half, `pkS`, with its period and whether it was retired early (never `skS`)             |

`TIER0_ISSUER_KEYS` is the files' contents joined by commas, `q:hex,q:hex` (`packages/core`, `parseTier0IssuerKeys`). It goes with `TIER0_CHAIN_ID`, `TIER0_GROUP_REGISTRY`, `TIER0_GROUP` and `TIER0_DEPLOYMENT_RECORD`, the version-2 deployment record the release names, as lowercase hex: all five or none (`apps/web`, `src/node/main.ts`). Keep the key directory on a machine you trust, encrypted and offline, apart from every other secret (the account keys of [[account-keys]] included), never in the repository, the database, a log, a ticket or a chat. Keys for later periods stay there until they are near: an `apps/web` environment that leaks hands over only the keys it holds.

Make keys only with the command line, on that machine. A random 32 bytes is not a key: about fifteen in sixteen are not a scalar below `l`, which `apps/web` refuses. From `apps/admin-cli`:

- `vp node src/main.ts tier0-keys period [--at <ISO time>]` prints the period now (or at that time), when it starts and ends, and when its key stops redeeming.
- `vp node src/main.ts tier0-keys generate --from <q> --count <n> --dir <dir>` makes keys for `n` consecutive periods from `q` (at most 16), each in its own new owner-only file, and prints each period's times, `publicKey` (`pkS`) and `keyId`, which go into the next release's deployment record. It refuses a period that has begun (`period-started`), since a release could then list its key only late; `--first` allows the current one, for the first release only (First keys), and any period whose file already exists (`key-exists`), writing nothing.

## Rules

- **A period has one key, for good.** Once any release lists a key for `q`, every later release lists the same `pkS` or none, and a key retired early is never replaced ([[deployment]], Across releases; `token-key-changed`, `token-key-reused`, `token-key-unretired`). So never make a second key for a period a release has listed, even after its file is lost or destroyed: the period issues nothing instead. A key no release has listed yet may be thrown away and made again.
- **Published before its period.** The first release to list `q` must be published on L1 before `q` begins, except the first version-2 release's own period and the one before ([[verifier]], Token keys across releases, `token-key-late`).
- **Six ahead.** A release lists the key of the period it is signed in, the period before it, and at least the six after it, at most 16 in all ([[deployment]], Token keys in a release). Before a release is signed, make sure the key directory holds keys that far ahead.
- **Gone at the end of `q + 1`.** Destroy every copy of a period's key once its `redeemsUntil` passes. `apps/web` refuses to start holding one ([[tier0-token]], Keys).
- **Never fix a mismatch by editing the record.** If `apps/web` says a held key isn't the record's, the file is the wrong one: the record is what every client trusts.

## First keys

1. Run `tier0-keys period`; call its `period` `q`.
2. Run `tier0-keys generate --first --from <q> --count 7 --dir <dir>`. The first release may list its own period ([[deployment]], Token keys in a release), and no earlier period has a key.
3. The release's signers put the printed `period`, `publicKey` and `retired: false` of each into the deployment record's `tier0_token_keys`, in ascending period, and check each `keyId`. No tool assembles a deployment record yet ([[P4-4]]).
4. Once the release is published, set `apps/web`'s variables: `TIER0_ISSUER_KEYS` to the files of `q` and `q + 1` joined by a comma, `TIER0_DEPLOYMENT_RECORD` to the release's deployment record, and the other three from the same record. Deploy. `apps/web` doesn't start unless every held key is listed in that record for its own period, under its own `pkS`, and not retired.

## Every period

In the last week of period `q` (see `tier0-keys period`'s `ends`):

1. **Load the next key and drop the old one.** Set `TIER0_ISSUER_KEYS` to the files of `q` and `q + 1` only, and deploy. From `q + 1`'s start that is the previous key, which answers retries, and the current one, which issues: a restart stays valid until `q + 2` begins. The deploy also drops `q − 1`'s `skS` from memory, where it would otherwise stay until the next restart. Dropping `q − 1` about a week before it stops redeeming means a client retrying a lost answer under it in that week is refused (`KEY_NOT_ISSUING`) and takes a token under `q + 1` instead: the price of never holding three keys.
2. **Destroy the old key.** Once `q + 1` has begun, `q − 1`'s key no longer redeems: destroy every copy of `tier0-key-<q − 1>.txt`.
3. **Keep six ahead.** If the next release is near, make the missing keys with `generate --from <first period with no file> --count <n>`, and give their public keys to the signers.

**When a release is published**, set `TIER0_DEPLOYMENT_RECORD` (and the other three, if they changed) to its record and deploy. Since every release lists the next six periods, the running record lists `q + 1` as long as a release was published in the last six periods; otherwise `apps/web` refuses to start with `q + 1`'s key, and a release is overdue.

**If the period's deploy was missed**, `apps/web` doesn't hold `q + 1`'s key, so nobody can take a token from `q + 1`'s start (`KEY_NOT_ISSUING`), and any restart after `q + 1` begins fails while `TIER0_ISSUER_KEYS` still holds `q − 1` (see Start-up errors): fail-closed by choice ([[P2-30]], Known-weak). Do step 1 at once.

## Retiring a key early

Retire a key on any suspected exposure: of its file, the key directory or its machine, `apps/web`'s environment, a host that ran it, or a backup of any of these. Retire every key the exposure could have reached: every key the environment held when exposed (the previous or the next period's as well as the current one), and after a leak of the key directory, every key in it. Each retired period that a release has listed issues nothing for its whole length, so a directory leak can stop Tier 0 issuance for up to seven months; only keys no release has listed yet may be thrown away and made again.

1. **Stop issuing.** Remove the retired keys from `TIER0_ISSUER_KEYS` and deploy at once. If the current period's key is among them, nobody takes a token until the next period begins (`KEY_NOT_ISSUING`): a period's key is never replaced.
2. **Publish the retirement.** The next release lists each retired key with its own period and `pkS` and `retired: true`. Never list a new key for its period, and never lift the mark later. Clients take a retirement from the release and re-issue their tokens under the next key ([[tier0-token]], Keys; [[P2-30]] parts 3 and 4, not built yet).
3. **Load the new record.** Set `TIER0_DEPLOYMENT_RECORD` to that release's record and deploy. An instance that still holds a retired key doesn't start.
4. **Destroy the retired keys**, every copy, and leave in the key directory a file of each one's name holding `retired`, so `generate` refuses the period.
5. If the exposure reached the account tables too, follow [[account-keys]].

What it buys: from the deploy in step 1 no token is issued under the key, and from the release in step 2 no client takes one. What it doesn't: a thief who copied a key can mint tokens under it until it stops redeeming at the signing service, and the counts that show a theft (redemptions beyond issuances per key and group) are not built yet ([[P2-30]], part 3 must). Until re-issuance is built, retiring a key strands every token issued under it and not yet redeemed (T-74).

## Start-up errors

`apps/web` names the variable and a period or rule, never a key:

- `TIER0_ISSUER_KEYS: issuer key entry <n> …`: entry `n` isn't `q:` and 64 lowercase hex digits of a non-zero scalar below `l`, or repeats a period. Use the file as `generate` wrote it.
- `TIER0_ISSUER_KEYS, TIER0_CHAIN_ID or TIER0_GROUP: the issuer key of period <q> no longer redeems`: a stale list after a period boundary. Remove that entry and destroy the key.
- `TIER0_DEPLOYMENT_RECORD: the deployment record lists no key for period <q>`: the record isn't the latest release's, or the key directory runs ahead of the releases. Load the right record, or hold only listed keys.
- `TIER0_DEPLOYMENT_RECORD: the issuer key of period <q> isn't the deployment record's`: the wrong file for that period. Find the right one; if it is lost, the period issues nothing (retire it).
- `TIER0_DEPLOYMENT_RECORD: the deployment record lists the key of period <q> retired`: remove the key and destroy it.
- `TIER0_DEPLOYMENT_RECORD: …` with a decoding code, `version 1`, `ill formed`, another chain, registry or group: the record isn't this deployment's version-2 record.

## Checking the releases

`abolish-verify keys` ([[verifier]], Token keys across releases) checks, from L1 alone, that no release changed a period's key, moved a key to another period or lifted a retirement, and that each key was first listed before its period. Until a release registry is deployed and pinned, every run reports `release-registry-unpinned` and is unverifiable, so meanwhile those are the signers' checks.

## Known-weak

- Redemption at the signing service isn't built yet ([[P2-30]] part 5); when it is, its copy of each key follows the same windows and these steps gain it.
- The operator supplies `TIER0_DEPLOYMENT_RECORD`: nothing yet checks it is the record a published release names ([[P4-4]] part 2c).
- `TIER0_ISSUER_KEYS` shares `apps/web`'s environment with its other secrets; a leak of that environment exposes both, which is why the environment holds two periods' keys at most.
